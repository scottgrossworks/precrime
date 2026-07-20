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

// Public API. Never rejects: returns { ok:false, error } so the pipeline action
// can hand the model a plain, retryable message ("bridge busy / not running").
function browseUrl(url) {
    const run = _queue.then(() => _browse(url)).catch(e => ({
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
