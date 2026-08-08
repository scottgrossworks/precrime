// ApplyFactletWorker.js -- in-process APPLY_FACTLET (2026-07-19)
//
// Replaces the spawned goose apply-factlet.md agent. ONE direct LLM call applies
// a factlet to a BATCH of candidate clients (task.input.clientIds); the server
// writes results through pipelineSave, so verify-at-enrichment, service-area zip
// rules, and banned-term tombstones all still apply -- the LLM only PROPOSES.
// This removes the per-(factlet,client) goose session overhead (recipe + MCP
// connects + tool schemas + skill file per pair) and the ORPHAN failure mode
// (there is no worker process to forget its complete_task call).
//
// Decision rules are a faithful port of skills/apply-factlet.md Steps 3-5:
// lean RELEVANT (a false negative costs more than a false positive); a factlet
// describing a future dated event becomes a Booking; email/phone/zip/date are
// included only when verbatim in the factlet (the save path verifies and drops
// anything it cannot find in the factlet text); a sweep task (no candidates)
// may create a NEW client only for a real in-trade org with a dated future event.

const { prisma } = require('../db');
const { VALUE_PROP, RUNTIME_CONFIG } = require('../runtime');
const { llmComplete } = require('../factlets');
const { fillPrompt } = require('../promptLoader');
const APPLY_PROMPT = require('./APPLY_PROMPT.json');   // prompt text: edit the JSON, not this file

const APPLY_LLM_MAX_TOKENS = 2000;

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// Tolerant JSON extraction: strip code fences, take first '{' .. last '}'.
function extractJson(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/```(json)?/gi, '');
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    return safeParse(cleaned.slice(a, b + 1));
}

function vpSlice() {
    return {
        trade:            VALUE_PROP.trade            || RUNTIME_CONFIG.defaultTrade || '',
        geography:        VALUE_PROP.geography        || '',
        buyerRoles:       VALUE_PROP.buyerRoles       || [],
        audienceSegments: VALUE_PROP.audienceSegments || [],
        notBuyer:         VALUE_PROP.notBuyer         || [],
        relevanceSignals: VALUE_PROP.relevanceSignals || []
    };
}

// Compact per-client card for the prompt: identity + dossier tail + live bookings.
function clientCard(c) {
    return {
        clientId: c.id,
        name:     c.name    || null,
        company:  c.company || null,
        website:  c.website || null,
        notes:    (c.clientNotes || '').slice(0, 200) || null,
        dossierTail: (c.dossier || '').slice(-800) || null,
        bookings: (c.bookings || []).slice(0, 3).map(b => ({
            id: b.id, title: b.title, location: b.location, zip: b.zip,
            startDate: b.startDate ? new Date(b.startDate).toISOString().slice(0, 10) : null
        }))
    };
}

function buildPrompt(factlet, cards, vp) {
    const sweep = cards.length === 0;
    return fillPrompt(APPLY_PROMPT.lines, {
        trade:            vp.trade,
        geography:        vp.geography,
        buyerRoles:       JSON.stringify(vp.buyerRoles),
        audienceSegments: JSON.stringify(vp.audienceSegments),
        notBuyer:         JSON.stringify(vp.notBuyer),
        factletSource:    factlet.source,
        factletDate:      new Date(factlet.createdAt).toISOString().slice(0, 10),
        factletContent:   String(factlet.content).slice(0, 3000),
        clientsLine:      sweep ? APPLY_PROMPT.clientsNone
                                : fillPrompt(APPLY_PROMPT.clientsSome, { cards: JSON.stringify(cards) }),
        sweepLine:        sweep ? APPLY_PROMPT.sweepRule : APPLY_PROMPT.noSweepRule
    });
}

// Build a pipelineSave patch from one decision. Strips null/empty fields so the
// save path never sees placeholder values.
function decisionPatch(d, factlet) {
    const patch = {};
    if (d.dossierLine) {
        const cat = d.category ? `[${d.category}] ` : '';
        patch.dossierAppend = `${cat}${d.dossierLine}`.slice(0, 500);
    }
    if (d.email) patch.email = String(d.email);
    if (d.phone) patch.phone = String(d.phone);
    const b = d.booking;
    if (b && b.title && b.startDateParts && b.startDateParts.year) {
        const bk = { title: String(b.title).slice(0, 200) };
        if (b.id)       bk.id = String(b.id);
        if (b.location) bk.location = String(b.location).slice(0, 300);
        if (b.zip)      bk.zip = String(b.zip);
        bk.startDateParts = b.startDateParts;
        if (!bk.id) bk.sourceUrl = factlet.source || undefined;
        patch.bookings = [bk];
    }
    return patch;
}

// run(task, deps) -> { status, output, error?, summary } (completion is the
// caller's job, mirroring Last30DaysWorker).
async function run(task, deps) {
    const factletId = task.targetId;
    const input = typeof task.input === 'string' ? (safeParse(task.input) || {}) : (task.input || {});
    // Batch input { clientIds: [...] }; tolerate the legacy single { clientId }.
    const clientIds = Array.isArray(input.clientIds)
        ? input.clientIds.filter(Boolean)
        : (input.clientId ? [input.clientId] : []);

    const factlet = await prisma.factlet.findUnique({ where: { id: factletId } });
    if (!factlet) {
        return { status: 'failed', error: 'factlet_missing',
                 output: { clientIds: [], bookingIds: [], factletIds: [factletId], summary: 'factlet missing', needsJudge: false },
                 summary: `apply ${factletId}: factlet missing` };
    }

    const clients = clientIds.length ? await prisma.client.findMany({
        where: { id: { in: clientIds } },
        include: { bookings: { orderBy: { startDate: 'desc' }, take: 3 } }
    }) : [];
    const cards = clients.map(clientCard);

    const cfg = RUNTIME_CONFIG;
    const raw = await llmComplete(buildPrompt(factlet, cards, vpSlice()), cfg, APPLY_LLM_MAX_TOKENS, 'apply');
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.decisions)) {
        // Sweep with a silent/unparseable model answer is a terminal no-op, not a
        // retry loop: fail only when we had real candidates to lose.
        if (raw !== null && cards.length === 0 && !parsed) {
            return { status: 'done',
                     output: { clientIds: [], bookingIds: [], factletIds: [factletId], summary: 'sweep -- no usable model output', needsJudge: false },
                     summary: `apply ${factletId}: sweep, no output` };
        }
        // Human-readable failure (2026-08-05): "apply cmrj...: LLM malformed" read as an
        // inscrutable system failure. Name the factlet by its content, say what actually
        // went wrong, and say what happens next (retried by a later planning pass).
        const gist = String((factlet && factlet.content) || factletId).replace(/\s+/g, ' ').slice(0, 60);
        const why = raw === null
            ? 'the LLM did not answer (provider down or timed out)'
            : 'the LLM returned an unparseable answer';
        return { status: 'failed', error: raw === null ? 'llm_unavailable' : 'llm_bad_json',
                 output: { clientIds: [], bookingIds: [], factletIds: [factletId], summary: 'LLM unavailable or malformed', needsJudge: false },
                 summary: `could not apply factlet "${gist}...": ${why} -- nothing written, will retry on a later pass` };
    }

    const validIds = new Set(cards.map(c => c.clientId));
    const affectedClients = [], affectedBookings = [];
    let applied = 0, skipped = 0;

    for (const d of parsed.decisions) {
        if (!d || !validIds.has(d.clientId)) continue;   // hallucinated id guard
        if (d.relevant !== true) { skipped++; continue; }
        const patch = decisionPatch(d, factlet);
        if (!Object.keys(patch).length) { skipped++; continue; }
        try {
            const resp = await deps.pipelineSave(`inproc-apply-${task.id.slice(-6)}`, d.clientId, patch, task.sessionId || null, false, factletId);
            const body = safeParse(resp && resp.result && resp.result.content ? resp.result.content[0].text
                                 : resp && resp.content ? resp.content[0].text : null) || {};
            affectedClients.push(body.clientId || d.clientId);
            for (const bid of (body.affectedBookingIds || [])) affectedBookings.push(bid);
            applied++;
        } catch (e) {
            console.error(`[inproc-apply] save failed for client ${d.clientId}: ${e.message}`);
        }
    }

    // SWEEP-create: only when no candidates were provided and the model returned a
    // real org + dated future booking. Never trust it against provided candidates.
    const nc = parsed.newClient;
    if (cards.length === 0 && nc && (nc.name || nc.company)
        && nc.booking && nc.booking.title && nc.booking.startDateParts && nc.booking.startDateParts.year) {
        const patch = decisionPatch({ ...nc, relevant: true }, factlet);
        patch.name    = String(nc.name || nc.company).slice(0, 200);
        patch.company = String(nc.company || nc.name).slice(0, 200);
        patch.source  = factlet.source || 'apply_factlet_sweep';
        try {
            const resp = await deps.pipelineSave(`inproc-apply-${task.id.slice(-6)}`, null, patch, task.sessionId || null, false, factletId);
            const body = safeParse(resp && resp.result && resp.result.content ? resp.result.content[0].text
                                 : resp && resp.content ? resp.content[0].text : null) || {};
            if (body.clientId) affectedClients.push(body.clientId);
            for (const bid of (body.affectedBookingIds || [])) affectedBookings.push(bid);
            applied++;
        } catch (e) {
            console.error(`[inproc-apply] sweep-create failed: ${e.message}`);
        }
    }

    const summary = `applied ${factletId} to ${applied}/${cards.length || 0} client(s)` +
                    (skipped ? `, ${skipped} not relevant` : '') +
                    (affectedBookings.length ? `, ${affectedBookings.length} booking(s)` : '');
    return {
        status: 'done',
        output: {
            clientIds:  [...new Set(affectedClients)],
            bookingIds: [...new Set(affectedBookings)],
            factletIds: [factletId],
            sourceIds:  [],
            summary,
            needsJudge: affectedClients.length > 0
        },
        summary
    };
}

module.exports = { run };
