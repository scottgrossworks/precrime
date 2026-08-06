// chromeBridge.js -- transient MCP client for the mcp-chrome bridge (2026-07-19)
//
// Gives the INTERACTIVE orchestrator its Chrome back without re-registering the
// bridge as a goose extension: the pipeline `browse` action calls browseUrl(),
// which opens a SHORT-LIVED MCP session on http://127.0.0.1:12306/mcp
// (initialize -> chrome_navigate -> chrome_get_web_content -> DELETE), so the
// user's logged-in Chrome (Facebook, Instagram, any signed-in site) is reachable
// on demand from ANY caller of the pipeline -- while background fb/ig workers
// keep their own serialized sessions. All access flows through THIS server;
// nobody holds the bridge open. Calls are serialized in-module (one browse at a
// time) so concurrent orchestrator requests never race each other.

const BRIDGE_URL = 'http://127.0.0.1:12306/mcp';
const BRIDGE_TIMEOUT_MS = 25000;
const MAX_TEXT_CHARS = 9000;   // lean: cap page text like tavily_lean does

// PER-DOMAIN PACING + BLOCK COOLDOWN (2026-07-20): reddit's perimeter security
// blocked us after back-to-back machine-speed fetches. Because EVERY browse call
// already serializes through this module's queue, pacing here is global across
// all callers (workers, orchestrator, signal drills) with zero coordination:
//  - min gap per registrable domain (config browsePacingMs, default 10s) with
//    ±30% jitter -- a FIXED interval is itself a bot signature;
//  - a bot-block page (detected in the returned text) puts that domain on a
//    45-min do-not-touch cooldown, machine-enforced: knocking again after being
//    caught is how a temporary gate becomes an IP/account-level ban.
// In-memory state -- resets with the process, like the bridge queue itself.
const PACING_MS = (() => {
    try {
        const v = Number(require('./runtime').PRECRIME_CONFIG.browsePacingMs);
        return Number.isFinite(v) && v >= 0 ? v : 30000;
    } catch (_) { return 30000; }
})();
const BLOCK_COOLDOWN_MS = 45 * 60 * 1000;
const BLOCK_RE = /blocked by network security|verify (that )?you are (a )?human|are you a robot|unusual traffic from your|attention required.{0,40}cloudflare|access to this page has been denied/i;
const _domainState = new Map();   // registrable domain -> { lastHitAt, coolUntil }

function _domainOf(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        const parts = host.split('.');
        return parts.length > 2 ? parts.slice(-2).join('.') : host;  // old.reddit.com -> reddit.com
    } catch (_) { return String(url); }
}

// Parse a bridge response: SSE ("event: message\ndata: {...}") or plain JSON.
async function parseBridgeResponse(res) {
    const body = await res.text();
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    let last = null;
    for (const line of trimmed.split('\n')) {
        if (line.startsWith('data:')) last = line.slice(5).trim();
    }
    return last ? JSON.parse(last) : null;
}

async function bridgePost(sessionId, payload) {
    const headers = {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream'
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetch(BRIDGE_URL, {
        method: 'POST', headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`bridge http ${res.status}`);
    return { json: await parseBridgeResponse(res), sessionId: res.headers.get('mcp-session-id') || sessionId };
}

function toolText(rpc) {
    const c = rpc && rpc.result && rpc.result.content;
    return (c && c[0] && c[0].text) || '';
}

// One browse at a time: chain every call onto this promise.
let _queue = Promise.resolve();

async function _browse(url) {
    let sid = null;
    try {
        const init = await bridgePost(null, {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'precrime-browse', version: '1.0' } }
        });
        sid = init.sessionId;
        if (!sid) throw new Error('bridge gave no session id');
        await bridgePost(sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
        const nav = await bridgePost(sid, {
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'chrome_navigate', arguments: { url } }
        });
        if (nav.json && nav.json.error) throw new Error(`navigate: ${nav.json.error.message}`);
        // Give the page a moment to render before extracting text.
        await new Promise(r => setTimeout(r, 2000));
        const content = await bridgePost(sid, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'chrome_get_web_content', arguments: { textContent: true } }
        });
        if (content.json && content.json.error) throw new Error(`get_content: ${content.json.error.message}`);
        const text = toolText(content.json).slice(0, MAX_TEXT_CHARS);
        return { ok: true, url, text };
    } finally {
        // Always release the bridge session so background workers can connect.
        if (sid) {
            try {
                await fetch(BRIDGE_URL, { method: 'DELETE', headers: { 'mcp-session-id': sid }, signal: AbortSignal.timeout(4000) });
            } catch (_) { /* session will expire on its own */ }
        }
    }
}

// Pacing wrapper: cooldown check -> jittered same-domain gap -> fetch -> block scan.
async function _pacedBrowse(url) {
    const domain = _domainOf(url);
    const st = _domainState.get(domain) || { lastHitAt: 0, coolUntil: 0 };
    _domainState.set(domain, st);
    if (Date.now() < st.coolUntil) {
        const min = Math.ceil((st.coolUntil - Date.now()) / 60000);
        return { ok: false, url, error: `"${domain}" triggered a bot-block earlier -- cooling down ${min} more min. Do NOT retry it now; move on to other work.` };
    }
    const gap = PACING_MS * (0.7 + Math.random() * 0.6);   // ±30% jitter
    const wait = st.lastHitAt + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    st.lastHitAt = Date.now();
    const r = await _browse(url);
    if (r.ok && BLOCK_RE.test(r.text)) {
        st.coolUntil = Date.now() + BLOCK_COOLDOWN_MS;
        console.error(`[browse] BOT-BLOCK detected on ${domain} -- cooling ${Math.round(BLOCK_COOLDOWN_MS / 60000)}min`);
        return { ok: false, url, error: `"${domain}" served a bot-block page -- domain cooling for ${Math.round(BLOCK_COOLDOWN_MS / 60000)}min. Do NOT retry it now; move on to other work.` };
    }
    return r;
}

// Public API. Never rejects: returns { ok:false, error } so the pipeline action
// can hand the model a plain, retryable message ("bridge busy / not running").
function browseUrl(url) {
    const run = _queue.then(() => _pacedBrowse(url)).catch(e => ({
        ok: false, url,
        error: /ECONNREFUSED|fetch failed/i.test(e.message)
            ? 'mcp-chrome bridge not running (start Chrome with the mcp-chrome extension + mcp-chrome-bridge)'
            : /Already connected/i.test(e.message)
                ? 'bridge busy with a background chrome scrape -- retry in a moment'
                : e.message
    }));
    _queue = run.then(() => undefined, () => undefined);
    return run;
}

module.exports = { browseUrl };
