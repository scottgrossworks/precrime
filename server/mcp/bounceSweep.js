// ============================================================================
// bounceSweep.js -- read Gmail for hard-bounce (mailer-daemon) notices and
// return the undeliverable recipient addresses. Procedural, zero-LLM. Borrows
// the OAuth token the Gmail MCP already shares on http://127.0.0.1:3001/token,
// so PRECRIME reads Gmail with the SAME credentials that send it -- no second
// auth, no public endpoint, no Pub/Sub. Requires the extension's OAuth scopes
// to include gmail.readonly (added to INVOICER manifest 2026-07-13); until the
// user re-consents, the Gmail API returns 403 and this cleanly returns [].
// ============================================================================

// The Gmail MCP's token-sharing endpoint (mcp_gmail.js: GET /token, default :3001).
const TOKEN_URL = process.env.PRECRIME_GMAIL_TOKEN_URL || 'http://127.0.0.1:3001/token';
// Search only recent daemon mail; a permanent bounce lands within minutes.
const BOUNCE_QUERY = 'from:mailer-daemon@googlemail.com OR from:postmaster newer_than:2d';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function b64urlDecode(data) {
    if (!data) return '';
    try { return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
    catch (_) { return ''; }
}

// Walk a Gmail message payload tree and concatenate every part's decoded text.
function collectText(payload) {
    if (!payload) return '';
    let out = '';
    if (payload.body && payload.body.data) out += b64urlDecode(payload.body.data) + '\n';
    if (Array.isArray(payload.parts)) for (const p of payload.parts) out += collectText(p);
    return out;
}

// Extract PERMANENT-failure recipient addresses from one bounce message's text.
// A DSN carries `Final-Recipient: rfc822; <addr>` + `Status: 5.x.x` (5 = permanent;
// 4.x.x is a transient retry -> ignored). Falls back to `Action: failed` + address.
function extractHardBounces(text) {
    if (!text) return [];
    const emails = new Set();
    // Only treat as a hard bounce when a permanent 5.x.x status is present anywhere.
    const permanent = /\bStatus:\s*5\.\d+\.\d+/i.test(text) || /Action:\s*failed/i.test(text);
    if (!permanent) return [];
    const re = /Final-Recipient:\s*rfc822;\s*<?([^\s<>]+@[^\s<>]+?)>?\s/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const addr = m[1].trim().toLowerCase().replace(/[.,;]+$/, '');
        if (addr.includes('@')) emails.add(addr);
    }
    return Array.from(emails);
}

async function _getToken() {
    try {
        const res = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const j = await res.json();
        return (j && j.token) || null;
    } catch (_) { return null; }
}

async function _gmail(path, token) {
    const res = await fetch(GMAIL_API + path, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
        const err = new Error(`gmail ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// Return { addresses: string[], scanned: number, reason?: string }. Never throws;
// a missing token / 403 (scope not yet granted) / network error yields an empty
// result with a reason, so the caller (an in-process task) always completes cleanly.
async function sweepBounces() {
    const token = await _getToken();
    if (!token) return { addresses: [], scanned: 0, reason: 'no_gmail_token' };
    let list;
    try {
        list = await _gmail(`/messages?q=${encodeURIComponent(BOUNCE_QUERY)}&maxResults=25`, token);
    } catch (e) {
        return { addresses: [], scanned: 0, reason: e.status === 403 ? 'gmail_readonly_scope_missing' : `gmail_error:${e.message}` };
    }
    const ids = (list.messages || []).map(m => m.id);
    const found = new Set();
    let scanned = 0;
    for (const id of ids) {
        try {
            const msg = await _gmail(`/messages/${id}?format=full`, token);
            scanned++;
            for (const addr of extractHardBounces(collectText(msg.payload))) found.add(addr);
        } catch (_) { /* skip a single unreadable message */ }
    }
    return { addresses: Array.from(found), scanned };
}

module.exports = { sweepBounces, extractHardBounces, collectText };
