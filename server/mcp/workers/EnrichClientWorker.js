// EnrichClientWorker.js -- in-process ENRICH_CLIENT (2026-08-06).
//
// Replaces the spawned goose worker (enrichment-agent.md). The skill was a
// straight line with ONE LLM decision in the middle: take one pre-fetched
// source summary (input.url + input.summary from find-client-sources), fold
// the facts into the client's dossier, mark the source consumed, save. Each
// run previously paid a full goose session; this is one bounded completion.
//
// Faithfulness notes vs the skill:
// - The LLM returns ONLY new dossier lines (strict JSON); we write them via
//   dossierAppend instead of letting the model rewrite the whole dossier --
//   history can no longer be mangled or silently dropped.
// - email/phone are accepted ONLY if they appear VERBATIM in the source
//   summary (verify-at-enrichment doctrine, enforced procedurally here).
// - The container-vendor SYNERGY scan is in the prompt, as before.
'use strict';

const { prisma } = require('../db');
const { RUNTIME_CONFIG, VALUE_PROP } = require('../runtime');
const { llmComplete } = require('../factlets');

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function extractJson(raw) {
    if (!raw) return null;
    const direct = safeParse(raw);
    if (direct) return direct;
    const m = String(raw).match(/\{[\s\S]*\}/);
    return m ? safeParse(m[0]) : null;
}

async function run(task, deps) {
    const clientId = task.targetId;
    let input = {};
    try { input = typeof task.input === 'string' ? JSON.parse(task.input) : (task.input || {}); } catch (_) {}
    const url = input.url || null;
    const summary = String(input.summary || '').trim();
    const out = (s, needsJudge) => ({ clientIds: [clientId], bookingIds: [], factletIds: [], sourceIds: [], summary: s, needsJudge: !!needsJudge });

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
        return { status: 'failed', error: 'client_missing', output: out('client missing'),
                 summary: `enrich: client ${clientId} missing` };
    }
    const label = client.company || client.name || clientId;

    // Mark-consumed is unconditional (skill Step 0/2): even an empty summary is
    // consumed so the planner never re-serves it.
    let targetUrls = [];
    try { targetUrls = client.targetUrls ? JSON.parse(client.targetUrls) : []; } catch (_) { targetUrls = []; }
    if (!Array.isArray(targetUrls)) targetUrls = [];
    let marked = false;
    for (const e of targetUrls) {
        if (e && e.url === url && !e.consumed) { e.consumed = true; marked = true; }
    }

    let patch = marked ? { targetUrls: JSON.stringify(targetUrls) } : {};
    let resultLine = 'no enrichable signal';
    let needsJudge = false;

    if (summary) {
        const today = new Date().toISOString().slice(0, 10);
        const isContainerVendor = typeof client.source === 'string' && client.source.startsWith('container:');
        const prompt = [
            `Fold ONE source summary into the sales dossier of a prospect for a "${(VALUE_PROP && VALUE_PROP.trade) || 'events'}" vendor.`,
            `CLIENT: ${JSON.stringify({ name: client.name, company: client.company, website: client.website, segment: client.segment })}`,
            `DOSSIER TAIL (do not repeat facts already here): """${String(client.dossier || '').slice(-1500)}"""`,
            `SOURCE (url: ${url || 'unknown'}): """${summary.slice(0, 2000)}"""`,
            '',
            'Return STRICT JSON only, exactly: {"lines":["..."],"email":null,"phone":null}',
            `Rules: lines are NEW dossier facts about THIS client only, taken from the SOURCE -- invent nothing, skip anything already in the dossier tail. Format each line as "[PERMANENT] <stable fact>" or "[${today}] time-sensitive signal from ${url || 'source'}: <buying occasion / event date / budget / trend>".`,
            'email/phone: ONLY if a direct, personal (non-generic, not info@/sales@) one appears VERBATIM in the SOURCE text; otherwise null.',
            isContainerVendor
                ? 'This client is a container-event vendor: if the SOURCE shows fit evidence for the vendor above (prior photo booth / caricature / live-entertainment use, crowd type that buys it), add a line "[PERMANENT] synergy: <specific evidence>". No evidence, no synergy line.'
                : '',
            'No new facts -> {"lines":[],"email":null,"phone":null}. JSON only, no prose.'
        ].filter(Boolean).join('\n');

        const raw = await llmComplete(prompt, RUNTIME_CONFIG, 700, 'apply');
        const parsed = extractJson(raw);
        if (!parsed || !Array.isArray(parsed.lines)) {
            // LLM down/garbled: consume nothing beyond the marker; fail so a later
            // pass can retry with the summary intact... but the marker write must
            // still land or the entry is re-served forever. Save marker, fail task.
            if (marked) await deps.pipelineSave('inproc-enrich', clientId, patch, task.sessionId || null, false).catch(() => {});
            return { status: 'failed', error: raw === null ? 'llm_unavailable' : 'llm_bad_json',
                     output: out('LLM unavailable or malformed'),
                     summary: `enrich "${label}": the LLM ${raw === null ? 'did not answer' : 'returned an unparseable answer'} -- will retry later` };
        }
        const lines = parsed.lines.map(l => String(l).trim()).filter(Boolean).slice(0, 6);
        if (lines.length) {
            patch.dossierAppend = lines.join('\n').slice(0, 1800);
            resultLine = `${lines.length} new dossier line(s)`;
            needsJudge = true;
        }
        // Verbatim verification: the summary must literally contain the value.
        if (parsed.email && summary.toLowerCase().includes(String(parsed.email).toLowerCase())) patch.email = String(parsed.email);
        if (parsed.phone && summary.replace(/[^0-9]/g, '').includes(String(parsed.phone).replace(/[^0-9]/g, ''))) patch.phone = String(parsed.phone);
    }

    if (Object.keys(patch).length) {
        const resp = await deps.pipelineSave('inproc-enrich', clientId, patch, task.sessionId || null, false);
        let body = {};
        try { body = JSON.parse(resp.result.content[0].text); } catch (_) {}
        if (body.blocked) {
            return { status: 'done', output: out(`save blocked (${body.blockedReason || 'gate'})`),
                     summary: `enrich "${label}": save blocked by gate` };
        }
    }
    return { status: 'done', output: out(`Enriched from ${url || 'source'}: ${resultLine}`, needsJudge),
             summary: `enrich "${label}": ${resultLine}` };
}

module.exports = { run };
