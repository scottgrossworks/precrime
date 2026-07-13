// ============================================================================
// judge.js -- the in-process Judge orchestration (the hot-leedz maker).
//
// judgeAffected re-scores affected clients/bookings via the factlets.js scoring
// primitives and writes Booking.status; the dismiss/judge_affected handlers wrap
// it. Requires db/responses/factlets/sessionLog -- imported by same names so save,
// the in-process executor, and the share.js factory wiring resolve unchanged.
// ============================================================================

const { prisma } = require('./db');
const { createSuccessResponse, createErrorResponse } = require('./responses');
const { computeBookingTargetScore, computeClientScore } = require('./factlets');
const { logSessionEvent } = require('./sessionLog');

// Single source of truth for the "acted-on" downgrade write shape. dismiss_booking, the
// draft-save downgrade, mark_sent, and the container fit-gate all flip a booking OUT of the
// live/hot set the same way: shared + cold, stamped now, tagged by WHO acted. The WHERE clause
// differs per caller (by booking id vs by clientId), so callers own that; this owns the DATA
// invariant so it can never drift across the four sites.
function actedOnData(sharedTo) {
    return { shared: true, sharedTo, sharedAt: BigInt(Date.now()), status: 'cold' };
}

// Acted-on veto sets: emails, normalized company-name keys, and website domains of every
// client already emailed (draftStatus sent/ready or sentAt) or with a shared/dismissed
// booking. Built once per judge/rescore pass; used to VETO re-promoting the SAME ORG back
// to hot even when re-ingestion minted a new client row under a variant name spelling or a
// different contact email -> "dismissed/contacted stays cold". Purely procedural, no LLM.
function normOrgKey(s) {
    const k = String(s || '').toLowerCase()
        .replace(/\b(llc|inc|incorporated|co|corp|corporation|company|ltd|limited|group)\b\.?/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    return k.length >= 4 ? k : '';   // too-short keys ("ace") over-match -> unusable
}
// Hosts shared by unrelated orgs -- never org-identifying.
const GENERIC_HOSTS = new Set(['facebook.com', 'instagram.com', 'linkedin.com', 'x.com',
    'twitter.com', 'eventbrite.com', 'meetup.com', 'youtube.com', 'tiktok.com', 'sites.google.com']);
function normDomain(url) {
    if (!url) return '';
    try {
        const h = new URL(String(url).startsWith('http') ? url : 'https://' + url)
            .hostname.replace(/^www\./, '').toLowerCase();
        return GENERIC_HOSTS.has(h) ? '' : h;
    } catch (_) { return ''; }
}
async function buildActedVetoSets() {
    const emails = new Set(), orgs = new Set(), domains = new Set();
    const addClient = (c) => {
        if (!c) return;
        if (c.email) emails.add(String(c.email).trim().toLowerCase());
        const key = normOrgKey(c.company || c.name);
        if (key) orgs.add(key);
        const dom = normDomain(c.website);
        if (dom) domains.add(dom);
    };
    const sel = { email: true, name: true, company: true, website: true };
    const acted = await prisma.client.findMany({
        where: { OR: [{ draftStatus: 'sent' }, { draftStatus: 'ready' }, { sentAt: { not: null } }] },
        select: sel
    });
    for (const c of acted) addClient(c);
    const sharedRows = await prisma.booking.findMany({
        where: { shared: true },
        select: { client: { select: sel } }
    });
    for (const r of sharedRows) addClient(r.client);
    return { emails, orgs, domains };
}
// True when this client matches an acted-on org by email, company key, or website domain.
function actedVetoHit(sets, client) {
    if (!sets || !client) return false;
    const em = client.email ? String(client.email).trim().toLowerCase() : '';
    if (em && sets.emails.has(em)) return true;
    const key = normOrgKey(client.company || client.name);
    if (key && sets.orgs.has(key)) return true;
    const dom = normDomain(client.website);
    return !!(dom && sets.domains.has(dom));
}

async function judgeAffected({ clientIds, bookingIds, reason, writeStatus, intelOverride }) {
    if (writeStatus === undefined) writeStatus = true;

    // PAST-DUE SHORTCUT (standing rule 2026-07-13): a booking whose date has passed is dead —
    // never spend classification or the judge LLM on it. Expiry (expirePastBookings) owns its
    // status. So the client→bookings expansion takes only future/undated bookings, and the
    // judge loop below hard-skips any past date that arrives via explicit bookingIds. For a
    // client with several bookings this judges only the live one(s) — typically the most recent.
    const bookingIdSet = new Set(Array.isArray(bookingIds) ? bookingIds.filter(Boolean) : []);
    if (Array.isArray(clientIds) && clientIds.length > 0) {
        const rows = await prisma.booking.findMany({
            where: {
                clientId: { in: clientIds.filter(Boolean) },
                OR: [{ startDate: null }, { startDate: { gte: new Date() } }]
            },
            select: { id: true }
        });
        for (const r of rows) bookingIdSet.add(r.id);
    }

    const bookings = await prisma.booking.findMany({
        where: { id: { in: Array.from(bookingIdSet) } },
        select: { id: true, status: true, clientId: true, startDate: true,
                  client: { select: { email: true, name: true, company: true, website: true } } }
    });

    // Org-level acted-on veto: a booking may score hot on its own fields, but if its ORG was
    // ALREADY emailed/dismissed/shared -- matched by email, normalized company name, or website
    // domain, across ANY duplicate/variant client row -- it must NOT resurface as hot. This is
    // the fix for "I already contacted/dismissed them but they're hot again".
    const actedSets = await buildActedVetoSets();

    const changed = [];
    const errors  = [];
    for (const b of bookings) {
        try {
            // Past-due hard skip: zero classification, zero LLM. Expiry demotes it.
            if (b.startDate && new Date(b.startDate) < new Date()) continue;
            const score = await computeBookingTargetScore(b.id);
            if (!score || !score.status) continue;
            let target = score.status;
            if (target === 'hot' && actedVetoHit(actedSets, b.client)) {
                target = 'cold';   // org already contacted/dismissed (email, name key, or domain)
            }
            if (target !== b.status) {
                if (writeStatus) {
                    await prisma.booking.update({ where: { id: b.id }, data: { status: target } });
                }
                changed.push({ bookingId: b.id, from: b.status, to: target });
            }
        } catch (e) {
            errors.push({ bookingId: b.id, error: e.message });
        }
    }

    // Re-score clients last so dossier/client score reflects post-judge state.
    const clientScores = [];
    let lastScore = null;
    const uniqueClientIds = Array.from(new Set((clientIds || []).filter(Boolean)));
    for (const cid of uniqueClientIds) {
        try {
            const s = await computeClientScore(cid, intelOverride == null ? null : intelOverride);
            clientScores.push({ clientId: cid, score: s });
            lastScore = s;
        } catch (e) {
            errors.push({ clientId: cid, error: e.message });
        }
    }

    return {
        reason: reason || null,
        affectedBookingIds: Array.from(bookingIdSet),
        affectedClientIds:  uniqueClientIds,
        changed,
        clientScores,
        clientScore: lastScore,
        errors,
        wroteStatus: !!writeStatus
    };
}

// dismiss_booking -- the user's permanent SKIP. A hot leed the user rejects must
// never resurface. Mark it acted-on (shared=true, sharedTo="dismissed") and cold:
// the classification cold-gate (booking.shared) keeps it cold through every future
// rescore, and the hot query (shared:false) excludes it. Distinct from a real
// marketplace share by sharedTo="dismissed".
async function pipelineDismissBooking(id, args) {
    // Accept a single bookingId OR a batch bookingIds[]. "Dismiss all X rows" is a natural
    // bulk action; batching it in ONE call is essential -- without it the model, told to
    // dismiss many, fires N sequential saves that mis-write Booking.status and hang the
    // session (the freeze we saw). updateMany dismisses every match at once; ids that don't
    // exist simply don't match (count < requested), no error -- correct for "dismiss all".
    let ids = [];
    if (Array.isArray(args.bookingIds)) ids = args.bookingIds.filter(Boolean);
    else if (args.bookingId) ids = [args.bookingId];
    if (ids.length === 0) {
        return createErrorResponse(id, -32602, 'dismiss_booking requires bookingId (string) or bookingIds (array of Booking.id).');
    }
    // Resolve the affected clients BEFORE the write (clientId is untouched by it).
    const affected = await prisma.booking.findMany({
        where: { id: { in: ids } },
        select: { clientId: true }
    });
    const r = await prisma.booking.updateMany({
        where: { id: { in: ids } },
        data: actedOnData('dismissed')
    });
    // Dismissal RESETS the client's dossier signal (standing rule 2026-07-13): the #1
    // dismissal reason is dead evidence (event over, factlet past-due), so a dismissed
    // leed's client must not keep sitting in the high-dossier bucket drawing attention.
    // Zero both scores; genuinely NEW live factlets can rebuild them later, and the
    // acted-on veto keeps the org out of hot regardless.
    const clientIds = Array.from(new Set(affected.map(b => b.clientId).filter(Boolean)));
    if (clientIds.length) {
        await prisma.client.updateMany({
            where: { id: { in: clientIds } },
            data: { dossierScore: 0, intelScore: 0 }
        });
    }
    return createSuccessResponse(id, JSON.stringify({
        dismissed: r.count, requested: ids.length, clientsReset: clientIds.length,
        note: `Permanently skipped ${r.count} booking(s); reset dossier score on ${clientIds.length} client(s). They will not be presented as hot again.`
    }, null, 2));
}

async function pipelineJudgeAffected(id, args) {
    const clientIds  = Array.isArray(args.clientIds)  ? args.clientIds  : [];
    const bookingIds = Array.isArray(args.bookingIds) ? args.bookingIds : [];
    if (clientIds.length === 0 && bookingIds.length === 0) {
        return createErrorResponse(id, -32602, 'judge_affected requires clientIds[] or bookingIds[].');
    }
    const result = await judgeAffected({
        clientIds,
        bookingIds,
        reason:      args.reason || 'judge_affected',
        writeStatus: args.writeStatus !== false
    });
    await logSessionEvent(args.session_id || null, 'judge_affected', {
        changed: result.changed.length,
        clientIds: result.affectedClientIds,
        bookingIds: result.affectedBookingIds
    });
    return createSuccessResponse(id, JSON.stringify(result, null, 2));
}

module.exports = { judgeAffected, pipelineDismissBooking, pipelineJudgeAffected, actedOnData, buildActedVetoSets, actedVetoHit };
