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
    const prompt = [
        `You draft outreach for a "${(VALUE_PROP && VALUE_PROP.trade) || 'events'}" seller. Your draft IS the SAMPLE EMAIL below rewritten for THIS lead. You are not an author; you are doing a careful find-and-replace on a proven letter.`,
        'Rules, in order:',
        '1. Keep the skeleton: same paragraphs, order, approximate length, tone. First line stays a salutation + a question about THEIR event whose answer is obviously yes. Last line stays an imperative close retargeted to THEIR event/brand.',
        '2. Swap ONLY the lead facts: recipient first name, their company/brand, event name, date in plain words, venue/city, all taken from LEAD DATA. A fact you do not have: drop that clause, never guess.',
        '3. Keep every seller fact exactly as written: rates line, no-deposit line, video link, credentials. The sample tailors ONE product detail to its own event; retarget that one detail to THIS event or drop it.',
        '4. Salutation: first name only.',
        '5. NO em dash, en dash, or double hyphen anywhere; use commas.',
        '6. Do NOT include the signature block; it is appended separately. End at the imperative close.',
        'FIRST decide the gate: is this a plausible buyer for the product at this event (product-market fit, contact looks like a decision-maker)? If NOT, reply with exactly: SKIP: <short reason>',
        'Otherwise reply with ONLY the rewritten email body text, nothing else.',
        `SAMPLE EMAIL: """${tpl}"""`,
        `LEAD DATA: ${JSON.stringify({
            contactName: client.name, company: client.company, email: client.email,
            event: booking.title, date: isoDate, location: booking.location,
            dossierTail: String(client.dossier || '').slice(-1200)
        })}`
    ].join('\n');

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
    return { status: 'done', output: out(`drafted outreach (${draft.length} chars), draftStatus:ready`, clientId),
             summary: `draft "${label}": outreach draft ready (template rewrite, ${draft.length} chars)` };
}

module.exports = { run };
