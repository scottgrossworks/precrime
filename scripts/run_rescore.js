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

(async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rescore', version: '1' } });
    const r = await rpc('tools/call', { name: 'pipeline', arguments: { action: 'rescore', scope: 'all' } });
    const text = r.result?.content?.[0]?.text;
    console.log(text || JSON.stringify(r, null, 2));
    server.kill();
    process.exit(0);
})();
