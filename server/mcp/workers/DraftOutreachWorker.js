// DraftOutreachWorker.js -- in-process DRAFT_OUTREACH (2026-08-06).
//
// Replaces the spawned goose worker (outreach-drafter.md). Drafting is a fixed
// procedure with ONE LLM decision: load booking + client, fetch the mandatory
// VALUE_PROP Sample Email + signature, gate outreach-readiness, rewrite the
// sample for this lead, save { draft, draftStatus:'ready' }. The goose version
// burned two whole turns just fetching the template via get_config; here the
// template is inlined into the single completion.
//
// Skill rules preserved procedurally:
// - Template mandate: the draft IS the sample email rewritten; composing from
//   scratch is impossible (the prompt contains the sample and demands a rewrite).
// - Signature appended VERBATIM by code, not by the model.
// - HARD RULE no em/en dashes or double hyphens: procedural replace before save.
// - Gate: generic/missing email and already-contacted clients skip (skip is a
//   normal done, not a failure). Product-market fit is judged inside the same
//   single call (the model answers SKIP: <reason> instead of a draft).
// - Never sends: output is draftStatus:'ready' in the DB, nothing more.
'use strict';

const { prisma } = require('../db');
const { RUNTIME_CONFIG, VALUE_PROP } = require('../runtime');
const { llmComplete, isGenericEmail } = require('../factlets');
const { fillPrompt } = require('../promptLoader');
const DRAFT_PROMPT = require('./DRAFT_PROMPT.json');   // prompt text: edit the JSON, not this file

// Create the Gmail DRAFT directly (2026-08-08): hot leedz = drafts in the
// user's Gmail Drafts folder, not rows in a DB. Same shared OAuth token the
// bounce sweep uses (mcp_gmail serves it on :7000/token). DRAFT ONLY -- this
// posts to /drafts, never /messages/send; the Gmail hard gate is untouched.
const TOKEN_URL = process.env.PRECRIME_GMAIL_TOKEN_URL || 'http://127.0.0.1:7000/token';
async function createGmailDraft(to, subject, bodyText) {
    let token = null;
    try {
        const r = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(3000) });
        if (r.ok) token = ((await r.json()) || {}).token || null;
    } catch (_) {}
    if (!token) return { ok: false, why: 'no gmail token on :7000 (is the Gmail MCP running / authorized?)' };
    const mime = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', bodyText].join('\r\n');
    const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try {
        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ message: { raw } }),
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) return { ok: false, why: `gmail api ${res.status}` };
        return { ok: true };
    } catch (e) {
        return { ok: false, why: e.message };
    }
}

function stripDashes(s) {
    // Em dash, en dash, and " -- " all become commas (mail path decodes UTF-8
    // dashes as mojibake; standing rule 2026-07-13).
    return String(s)
        .replace(/\s*(?:—|–)\s*/g, ', ')
        .replace(/\s+--\s+/g, ', ')
        .replace(/,\s*,/g, ',');
}

async function run(task, deps) {
    const bookingId = task.targetId;
    const out = (s, cid) => ({ clientIds: cid ? [cid] : [], bookingIds: [bookingId], factletIds: [], sourceIds: [], summary: s, needsJudge: false });

    const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { client: true } });
    if (!booking || !booking.client) {
        return { status: 'failed', error: 'booking_missing', output: out('booking or client missing'),
                 summary: `draft: booking ${bookingId} missing` };
    }
    const client = booking.client;
    const clientId = client.id;
    const label = client.company || client.name || clientId;

    // Identity: the MANDATORY template + signature, pulled from the parsed
    // VALUE_PROP (same source get_config serves). Missing either = hard fail.
    const tpl = (VALUE_PROP && VALUE_PROP.sampleEmail) || '';
    const sig = (VALUE_PROP && VALUE_PROP.signature) || (RUNTIME_CONFIG && RUNTIME_CONFIG.signature) || '';
    if (!tpl) return { status: 'failed', error: 'MISSING_SAMPLE_EMAIL', output: out('no sample email in VALUE_PROP', clientId), summary: `draft "${label}": VALUE_PROP has no ### Sample Email` };
    if (!sig) return { status: 'failed', error: 'MISSING_SIGNATURE', output: out('no signature in VALUE_PROP', clientId), summary: `draft "${label}": VALUE_PROP has no signature` };

    // Procedural outreach-ready gate (skips are normal, not failures).
    if (!client.email) return { status: 'done', output: out('skip: no direct email', clientId), summary: `draft "${label}": skip, no direct email` };
    if (isGenericEmail(client.email)) return { status: 'done', output: out('skip: generic email', clientId), summary: `draft "${label}": skip, generic inbox ${client.email}` };
    if (client.draftStatus === 'sent' || client.sentAt) return { status: 'done', output: out('skip: already contacted', clientId), summary: `draft "${label}": skip, already contacted` };

    const isoDate = booking.startDate ? new Date(booking.startDate).toISOString().slice(0, 10) : '';
    // Anniversary re-book (Stage 1, 2026-08-09): a PAST booking means this is a
    // re-hire pitch -- reference the history, target this year's occasion.
    // TEMPLATE FAMILY IS CHOSEN FROM WHAT WE ACTUALLY KNOW (2026-10-22).
    //
    // A re-hire letter says "after drawing at your X" -- so there must BE an X. When
    // there isn't, the model does not decline, it invents: Karen Altman, whose entire
    // history is one $7.00 tip in 2023, got a letter about her baby shower and her
    // daughter "Esperanza" turning one. No baby shower. No Esperanza. Fabricated
    // memories aimed at a real customer's real inbox.
    //
    // A tip is still a GOOD lead -- they stood there and watched the work, and we have
    // their email. They just have no event of their own to reference yet. So they get
    // the SEASONAL pitch instead: what's coming up this time of year, no invented past.
    // Money decides which, because a tip is a transaction and a gig is a job. $26 is
    // one dollar over the tip ceiling in VALUE_PROP ## PRICING ("$1-25 -> tip",
    // mirrored by SquareSyncWorker BANDS).
    // The prior job is a DIFFERENT ROW than the one being drafted. A re-engagement
    // booking is forward-dated by design (SquareSyncWorker forwardDate()), so the old
    // test "this booking's date is in the past" was false for every re-engagement row
    // and sent even a $1,250 repeat customer down the seasonal path. Look up the real
    // past job and pitch THAT.
    const priorJobs = await prisma.booking.findMany({
        where: { clientId, totalAmount: { gt: 0 }, startDate: { lt: new Date() } },
        orderBy: { startDate: 'desc' },
        select: { title: true, startDate: true, totalAmount: true }
    });
    const lifetime = priorJobs.reduce((n, b) => n + Number(b.totalAmount || 0), 0);
    const lastJob = priorJobs.find(b => Number(b.totalAmount || 0) >= 26) || priorJobs[0] || null;
    const hasRealPriorJob = lifetime >= 26 && !!lastJob;
    const isRehire = hasRealPriorJob;
    // Seasonal windows keyed off the booking's target month -- the occasions a buyer
    // in that part of the year is actually planning for. Generic to any event trade.
    const SEASONS = [
        { months: [1, 2],   name: 'late winter',   occasions: "Valentine's Day, Presidents Day weekend, Mardi Gras, Purim" },
        { months: [3, 4],   name: 'spring',        occasions: 'Easter and Passover, spring break parties, proms, Cinco de Mayo' },
        { months: [5, 6],   name: 'late spring',   occasions: "Mother's Day, graduations, Father's Day, end-of-school and summer kickoff parties" },
        { months: [7, 8],   name: 'summer',        occasions: '4th of July, summer backyard parties, reunions, back-to-school events' },
        { months: [9, 10],  name: 'fall',          occasions: 'Halloween, fall festivals and carnivals, Rosh Hashanah and Yom Kippur, Oktoberfest' },
        { months: [11, 12], name: 'the holidays',  occasions: "Friendsgiving and Thanksgiving, Hanukkah, Christmas and holiday parties, New Year's Eve" }
    ];
    const targetMonth = (booking.startDate ? new Date(booking.startDate) : new Date()).getUTCMonth() + 1;
    const season = SEASONS.find(s => s.months.includes(targetMonth)) || SEASONS[0];
    const isSeasonal = !isRehire && !booking.sourceUrl;   // no real prior job AND no scraped event of their own
    // Booker template family (2026-08-14, build item #6): clientClass='booker'
    // switches the rewrite mandate to the roster pitch. Same skeleton, same
    // seller facts, different ask -- see DRAFT_PROMPT.bookerRule.
    const isBooker = client.clientClass === 'booker';
    const prompt = fillPrompt(DRAFT_PROMPT.lines, {
        trade:       (VALUE_PROP && VALUE_PROP.trade) || 'events',
        rehireLine:  isRehire ? fillPrompt(DRAFT_PROMPT.rehireRule, {
                         pastTitle: (lastJob && lastJob.title) || 'their event',
                         pastDate:  (lastJob && lastJob.startDate) ? new Date(lastJob.startDate).toISOString().slice(0, 10) : '' })
                   : isSeasonal ? fillPrompt(DRAFT_PROMPT.seasonalRule, { season: season.name, seasonOccasions: season.occasions })
                   : '',
        bookerLine:  isBooker ? DRAFT_PROMPT.bookerRule : '',
        sampleEmail: tpl,
        leadData:    JSON.stringify({
            contactName: client.name, company: client.company, email: client.email,
            clientClass: client.clientClass || 'host',
            event: booking.title, date: isoDate, location: booking.location,
            dossierTail: String(client.dossier || '').slice(-1200)
        })
    });

    const raw = await llmComplete(prompt, RUNTIME_CONFIG, 900, 'draft');
    if (raw === null) {
        return { status: 'failed', error: 'llm_unavailable', output: out('LLM did not answer', clientId),
                 summary: `draft "${label}": the LLM did not answer -- will retry later` };
    }
    const text = raw.trim();
    if (/^skip\s*:/i.test(text)) {
        return { status: 'done', output: out(text.slice(0, 160), clientId), summary: `draft "${label}": ${text.slice(0, 120)}` };
    }
    if (text.length < 100) {
        return { status: 'failed', error: 'llm_thin_output', output: out('draft too short', clientId),
                 summary: `draft "${label}": LLM returned ${text.length} chars -- will retry later` };
    }

    // Assemble: dash-filtered body + VERBATIM signature (code appends it, so the
    // model can neither reword it nor forget it).
    const draft = `${stripDashes(text)}\n\n${sig}`;
    const resp = await deps.pipelineSave('inproc-draft', clientId,
        { draft, draftStatus: 'ready' }, task.sessionId || null, false);
    let body = {};
    try { body = JSON.parse(resp.result.content[0].text); } catch (_) {}
    if (body.blocked) {
        return { status: 'done', output: out(`save blocked (${body.blockedReason || 'gate'})`, clientId),
                 summary: `draft "${label}": save blocked by gate` };
    }

    // Put the draft in the user's Gmail Drafts folder and mark the client
    // contacted RIGHT NOW (drafting IS contacting -- same rule as mcp_gmail's
    // synchronous mark_sent). On Gmail failure the DB draft survives and the
    // summary says loudly what to do.
    const subject = stripDashes(`Live ${(VALUE_PROP && VALUE_PROP.trade) || 'entertainment'} for ${booking.title || 'your event'}`);
    const g = await createGmailDraft(client.email, subject, draft);
    if (g.ok && deps.pipelineMarkSent) {
        await deps.pipelineMarkSent('inproc-draft', { clientId });
    }
    const note = g.ok
        ? 'draft is in the Gmail Drafts folder; client marked CONTACTED'
        : `WARNING: Gmail draft FAILED (${g.why}) -- the draft text is saved on the client record; fix Gmail and re-run, client NOT marked contacted`;
    return { status: 'done', output: out(`drafted outreach (${draft.length} chars); ${note}`, clientId),
             summary: `draft "${label}": ${note}` };
}

module.exports = { run };
