// FindClientSourcesWorker.js -- in-process FIND_CLIENT_SOURCES (2026-08-06).
//
// Replaces the spawned goose worker (find-client-sources.md). That skill was
// fully mechanical -- "search, store the search snippets, done... Do NOT
// interpret or score" -- yet each run paid a whole goose session (system prompt
// + tool schemas + skill body re-billed every turn). This worker is the same
// procedure with ZERO LLM calls: 2 bounded Tavily basic searches, top snippets
// stored verbatim on Client.targetUrls as { url, summary, consumed:false } for
// the ENRICH_CLIENT worker. Snippet-first, never extract (the skill's HARD RULE,
// now structurally impossible to violate).
'use strict';

const { prisma } = require('../db');
const { PRECRIME_CONFIG, VALUE_PROP } = require('../runtime');

const TAVILY_URL = 'https://api.tavily.com/search';
const MAX_HITS = 4;
// Login-walled / social hosts produce junk snippets; the skill said skip them.
const SKIP_HOSTS = /facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|(^|\.)x\.com|twitter\.com/i;

async function tavilySearch(query, apiKey) {
    const res = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 5 }),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`tavily http ${res.status}`);
    const j = await res.json();
    return Array.isArray(j.results) ? j.results : [];
}

async function run(task, deps) {
    const clientId = task.targetId;
    const out = (summary, ids) => ({ clientIds: [clientId], bookingIds: [], factletIds: [], sourceIds: [], summary, needsJudge: false });

    const apiKey = PRECRIME_CONFIG && PRECRIME_CONFIG.apiKeys && PRECRIME_CONFIG.apiKeys.tavily;
    if (!apiKey) {
        return { status: 'cancelled', error: 'tavily_unavailable',
                 output: out('no tavily key'), summary: `find-sources ${clientId}: no tavily key` };
    }
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
        return { status: 'failed', error: 'client_missing',
                 output: out('client missing'), summary: `find-sources: client ${clientId} missing` };
    }

    const ident = client.company || client.name;
    const label = ident || clientId;
    if (!ident) {
        return { status: 'done', output: out('no identity to search'), summary: `find-sources "${label}": no company/name to search` };
    }
    // The skill's query recipes: who they are / buying occasions. (The decision-maker
    // email hunt stays DRILL_DOWN's mission -- same division of labor as before.)
    const flavor = client.segment || (VALUE_PROP && VALUE_PROP.trade) || 'events';
    const queries = [
        `"${ident}" ${flavor}`,
        `"${ident}" event OR booking OR festival OR fundraiser`
    ];

    let hits = [];
    for (const q of queries) {
        try { hits.push(...await tavilySearch(q, apiKey)); }
        catch (e) {
            if (hits.length) break;   // partial results are fine
            return { status: 'cancelled', error: 'tavily_unavailable',
                     output: out(`tavily failed: ${e.message}`), summary: `find-sources "${label}": tavily failed (${e.message})` };
        }
    }

    // Existing entries: dedup on url, preserve everything already stored.
    let existing = [];
    try { existing = client.targetUrls ? JSON.parse(client.targetUrls) : []; } catch (_) { existing = []; }
    if (!Array.isArray(existing)) existing = [];
    const known = new Set(existing.map(e => e && e.url));

    const fresh = [];
    for (const h of hits.sort((a, b) => (b.score || 0) - (a.score || 0))) {
        if (fresh.length >= MAX_HITS) break;
        const url = h && h.url;
        const snippet = (h && h.content || '').trim();
        if (!url || !snippet || known.has(url) || SKIP_HOSTS.test(url)) continue;
        known.add(url);
        fresh.push({ url, summary: snippet.slice(0, 600), consumed: false });
    }

    if (!fresh.length) {
        return { status: 'done', output: out('no new sources found'), summary: `find-sources "${label}": no new sources` };
    }

    // Write through pipelineSave so every save-time gate (banned terms, service
    // area, email rules) holds exactly as it did for the goose worker.
    const resp = await deps.pipelineSave('inproc-findsrc', clientId,
        { targetUrls: JSON.stringify([...existing, ...fresh]) }, task.sessionId || null, false);
    let body = {};
    try { body = JSON.parse(resp.result.content[0].text); } catch (_) {}
    if (body.blocked) {
        return { status: 'done', output: out('save blocked by gate'), summary: `find-sources "${label}": save blocked (${body.blockedReason || 'gate'})` };
    }
    return { status: 'done', output: out(`Found ${fresh.length} source snippet(s).`),
             summary: `find-sources "${label}": stored ${fresh.length} snippet(s) for enrichment` };
}

module.exports = { run };
