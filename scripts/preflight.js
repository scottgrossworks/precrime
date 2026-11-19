// preflight.js -- launch-time gate (2026-11-18). Run by goose.bat BEFORE the server starts.
//
// PRECRIME's search, page fetch, and Gmail all ride the user's own logged-in Chrome and
// the shared Gmail token. Tavily is gone. If any of those is down, every search-dependent
// stage silently produces nothing, and the user finds out two hours later. So: check
// them NOW and stop with a plain message.
//
//   FATAL (exit 1): Chrome bridge down or extension not connected; Gmail token missing;
//                   LLM key rejected or out of credit.
//   WARN  (exit 0): credit running low; Leedz server (:4000) not up (PRECRIME reads the
//                   shared DB directly, so it is not required).
// Prints no secrets.
'use strict';
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'precrime_config.json'), 'utf8'));
const BRIDGE = 'http://127.0.0.1:12306/mcp';
const GMAIL_TOKEN = 'http://127.0.0.1:7000/token';
const LEEDZ = 'http://127.0.0.1:4000/';
const LOW_CREDIT_WARN = 25, LOW_CREDIT_FATAL = 2;

const fatal = [], warn = [];
const ok = (m) => console.log(`  ok    ${m}`);

async function bridge() {
    let sid = null;
    try {
        const post = async (s, body) => {
            const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
            if (s) h['mcp-session-id'] = s;
            const r = await fetch(BRIDGE, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
            const t = await r.text();
            const m = t.match(/data:\s*(\{[\s\S]*\})/) || t.match(/(\{[\s\S]*\})/);
            return { sid: r.headers.get('mcp-session-id'), json: m ? JSON.parse(m[1]) : null };
        };
        const i = await post(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'precrime-preflight', version: '1' } } });
        sid = i.sid;
        // No session = the bridge refused; its own message says why (usually "Already connected").
        if (!sid) throw new Error((i.json && i.json.message) || 'bridge gave no session');
        await post(sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
        // Read-only: proves the Chrome EXTENSION is attached, not just the native host.
        const w = await post(sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_windows_and_tabs', arguments: {} } });
        const res = w.json && w.json.result;
        if (!res || res.isError) throw new Error('extension not answering (is Chrome open with the mcp-chrome extension connected?)');
        ok('Chrome bridge :12306 + extension connected (search and page fetch run here)');
    } catch (e) {
        const msg = /Already connected/i.test(e.message)
            ? 'bridge is stuck holding a dead session from a previous run. Click the Chrome MCP Server extension -> Disconnect -> Connect, then relaunch'
            : /ECONNREFUSED|fetch failed|aborted|timeout/i.test(e.message)
                ? 'bridge not running on :12306 (start Chrome, open the Chrome MCP Server extension, click Connect)'
                : e.message;
        fatal.push(`CHROME: ${msg}`);
    } finally {
        if (sid) { try { await fetch(BRIDGE, { method: 'DELETE', headers: { 'mcp-session-id': sid }, signal: AbortSignal.timeout(4000) }); } catch (_) {} }
    }
}

async function gmail() {
    try {
        const r = await fetch(GMAIL_TOKEN, { signal: AbortSignal.timeout(6000) });
        const j = r.ok ? await r.json() : null;
        if (j && j.token) ok('Gmail token present (:7000)');
        else fatal.push('GMAIL: no token on :7000 -- open the Leedz extension and click Authorize Gmail');
    } catch (_) {
        fatal.push('GMAIL: Gmail MCP not reachable on :7000 -- start the Leedz server / mcp_gmail.js');
    }
}

async function llm() {
    const p = String((cfg.llm && cfg.llm.provider) || '').toLowerCase();
    const key = cfg.apiKeys && cfg.apiKeys[p];
    if (!key) { fatal.push(`LLM: apiKeys.${p} is empty`); return; }
    if (p !== 'openrouter') { ok(`LLM key present (${p}); credit not checked`); return; }
    try {
        const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
        if (r.status === 401) { fatal.push('LLM: OpenRouter rejected the key (401)'); return; }
        const d = (await r.json()).data || {};
        const rem = d.limit_remaining;
        if (rem == null) { ok('OpenRouter key valid (no spend limit set)'); return; }
        if (rem < LOW_CREDIT_FATAL) fatal.push(`LLM: OpenRouter credit nearly gone ($${rem.toFixed(2)} left of $${d.limit}) -- every LLM call will fail mid-run`);
        else if (rem < LOW_CREDIT_WARN) warn.push(`LLM: OpenRouter has only $${rem.toFixed(2)} left of the $${d.limit} key limit ($${(d.usage || 0).toFixed(2)} used)`);
        else ok(`OpenRouter credit $${rem.toFixed(2)} left`);
    } catch (e) {
        warn.push(`LLM: could not check OpenRouter credit (${e.message})`);
    }
}

async function leedz() {
    try { await fetch(LEEDZ, { signal: AbortSignal.timeout(3000) }); ok('Leedz server :4000 up'); }
    catch (_) { warn.push('LEEDZ: server not on :4000 (PRECRIME reads the shared DB directly, so this is not blocking)'); }
}

(async () => {
    console.log('\n PRECRIME preflight');
    await Promise.all([bridge(), gmail(), llm(), leedz()]);
    for (const w of warn) console.log(`  WARN  ${w}`);
    for (const f of fatal) console.log(`  FATAL ${f}`);
    // exitCode, not process.exit(): a hard exit while fetch handles are still closing
    // trips a libuv assertion on Windows.
    if (fatal.length) { console.log('\n  Not starting: fix the FATAL line(s) above and relaunch.\n'); process.exitCode = 1; return; }
    console.log('  preflight passed\n');
})();
