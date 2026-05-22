#!/usr/bin/env node
/**
 * preview_summary_markdown.js — Show what report_session.summary_markdown
 * actually looks like end-to-end. Spawns the TDS server, opens a session
 * with target=3, saves 2 clients, fails 1 (forced via missing name), reports.
 * Prints the markdown the agent would paste verbatim to the user.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const TDS = 'C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime';
const env = { ...process.env, DATABASE_URL: 'file:' + path.join(TDS, 'data', 'myproject.sqlite'), PRECRIME_QUIET: '1' };
const server = spawn('node', [path.join(TDS, 'server', 'mcp', 'mcp_server.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '', nextId = 1;
const pending = new Map();
server.stdout.on('data', c => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
    }
});
function rpc(method, params) {
    const id = nextId++;
    return new Promise(res => { pending.set(id, res); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
function unwrap(r) { try { return JSON.parse(r.result?.content?.[0]?.text); } catch { return r.result; } }

(async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preview', version: '1' } });
    const start = unwrap(await rpc('tools/call', { name: 'pipeline', arguments: { action: 'start_session', workflow: 'preview-demo', target_count: 3 } }));
    const SID = start.session_id;
    // 2 successful saves
    await rpc('tools/call', { name: 'pipeline', arguments: { action: 'save', session_id: SID, patch: { name: 'PREVIEW_A_' + Date.now(), company: 'Acme' } } });
    await rpc('tools/call', { name: 'pipeline', arguments: { action: 'save', session_id: SID, patch: { name: 'PREVIEW_B_' + Date.now(), company: 'BetaCo' } } });
    // 1 forced failure (no name)
    await rpc('tools/call', { name: 'pipeline', arguments: { action: 'save', session_id: SID, patch: { company: 'NoNameCo' } } });
    const report = unwrap(await rpc('tools/call', { name: 'pipeline', arguments: { action: 'report_session', session_id: SID } }));

    console.log('=========== summary_markdown (what the agent pastes) ===========\n');
    console.log(report.summary_markdown);
    console.log('\n========================= end =========================');
    server.kill();
    process.exit(0);
})();
