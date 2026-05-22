#!/usr/bin/env node
/**
 * smoke_test_sessions.js — End-to-end test of the session accountability layer.
 *
 * Spawns mcp_server.js as a child stdio process, sends real JSON-RPC, asserts:
 *   1. tools/list advertises the new actions in the inputSchema enum
 *   2. start_session returns a session_id
 *   3. save with that session_id logs save_success
 *   4. save with a forged session_id is rejected
 *   5. report_session returns server-computed counts that match reality
 *
 * Defaults to TDS DB (where the live data lives). Run with no args.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const TDS_ROOT = 'C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime';
const SERVER   = path.join(TDS_ROOT, 'server', 'mcp', 'mcp_server.js');
const DB_PATH  = path.join(TDS_ROOT, 'data', 'myproject.sqlite');

if (!fs.existsSync(SERVER)) { console.error('Server not found:', SERVER); process.exit(2); }
if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(2); }

// --- spawn server -----------------------------------------------------------
const env = {
    ...process.env,
    DATABASE_URL: 'file:' + DB_PATH,
    PRECRIME_QUIET: '1'
};
const server = spawn('node', [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map(); // id -> {resolve, reject}
let nextId = 1;

server.stdout.on('data', chunk => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
            const { resolve } = pending.get(msg.id);
            pending.delete(msg.id);
            resolve(msg);
        }
    }
});

server.stderr.on('data', chunk => {
    // Server logs go to stderr; only print on failure.
    process.env.SMOKE_VERBOSE && process.stderr.write('[srv] ' + chunk);
});

function rpc(method, params) {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`timeout on ${method} (id=${id})`));
        }, 10000);
        pending.set(id, {
            resolve: r => { clearTimeout(timer); resolve(r); },
            reject:  e => { clearTimeout(timer); reject(e); }
        });
        server.stdin.write(JSON.stringify(msg) + '\n');
    });
}

// --- helpers ----------------------------------------------------------------
function unwrap(resp) {
    if (resp.error) return { error: resp.error };
    const text = resp.result?.content?.[0]?.text;
    if (!text) return { raw: resp.result };
    try { return JSON.parse(text); } catch { return { text }; }
}

let pass = 0, fail = 0;
function expect(label, cond, detail) {
    if (cond) { console.log(`  ok   ${label}`); pass++; }
    else      { console.log(`  FAIL ${label}${detail ? '  -- ' + detail : ''}`); fail++; }
}

// --- run --------------------------------------------------------------------
(async () => {
    try {
        // Initialize the protocol — every MCP server expects this first.
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } });
        await rpc('notifications/initialized', {}).catch(()=>{});

        console.log('\n=== Test 1: tools/list advertises new actions ===');
        const tl = await rpc('tools/list', {});
        const pipelineTool = tl.result?.tools?.find(t => t.name === 'pipeline');
        const enumValues = pipelineTool?.inputSchema?.properties?.action?.enum || [];
        expect('start_session in action enum',  enumValues.includes('start_session'),  enumValues.join(','));
        expect('report_session in action enum', enumValues.includes('report_session'), enumValues.join(','));
        expect('audit_session in action enum',  enumValues.includes('audit_session'),  enumValues.join(','));

        console.log('\n=== Test 2: start_session returns server-issued session_id ===');
        const startResp = await rpc('tools/call', {
            name: 'pipeline',
            arguments: { action: 'start_session', workflow: 'smoke-test', target_count: 2, metadata: { test: true } }
        });
        const startJson = unwrap(startResp);
        expect('start_session OK',          !startJson.error,                  JSON.stringify(startJson.error || {}));
        expect('session_id starts with ses_', (startJson.session_id || '').startsWith('ses_'), startJson.session_id);
        expect('workflow echoed',           startJson.workflow === 'smoke-test', startJson.workflow);
        expect('target_count echoed',       startJson.target_count === 2,        String(startJson.target_count));
        const SID = startJson.session_id;

        console.log('\n=== Test 3: save with valid session_id logs save_success ===');
        // Use a unique name so we don't collide with existing clients.
        const uniqueName = 'SMOKE_TEST_' + Date.now();
        const saveResp = await rpc('tools/call', {
            name: 'pipeline',
            arguments: {
                action: 'save',
                session_id: SID,
                patch: { name: uniqueName, company: 'SmokeCo', segment: 'test', source: 'smoke_test_sessions.js' }
            }
        });
        const saveJson = unwrap(saveResp);
        expect('save returned saved=true', saveJson.saved === true, JSON.stringify(saveJson));
        expect('save returned clientId',   typeof saveJson.clientId === 'string', String(saveJson.clientId));
        expect('save echoed session_id',   saveJson.session_id === SID, saveJson.session_id);
        const SAVED_CLIENT_ID = saveJson.clientId;

        console.log('\n=== Test 4: save with forged session_id is rejected ===');
        const forgedResp = await rpc('tools/call', {
            name: 'pipeline',
            arguments: {
                action: 'save',
                session_id: 'ses_FORGEDxxxxxxxxxxxx',
                patch: { name: 'forged_' + Date.now() }
            }
        });
        const forgedJson = unwrap(forgedResp);
        expect('forged session rejected',
               forgedJson.error || (forgedResp.error && /not found/i.test(JSON.stringify(forgedResp.error))),
               JSON.stringify(forgedJson));

        console.log('\n=== Test 5: audit_session shows 1 saved, 0 failed (mid-flight) ===');
        const auditResp = await rpc('tools/call', {
            name: 'pipeline',
            arguments: { action: 'audit_session', session_id: SID }
        });
        const auditJson = unwrap(auditResp);
        expect('audit reports 1 actually_saved', auditJson.actually_saved === 1, String(auditJson.actually_saved));
        expect('audit reports 0 failed',         auditJson.failed === 0,         String(auditJson.failed));
        expect('audit status still active',      auditJson.status === 'active',  auditJson.status);
        expect('saved_clients[0] is the smoke client',
               auditJson.saved_clients?.[0]?.clientId === SAVED_CLIENT_ID,
               JSON.stringify(auditJson.saved_clients?.[0]));

        console.log('\n=== Test 6: report_session closes session and returns truth ===');
        const reportResp = await rpc('tools/call', {
            name: 'pipeline',
            arguments: { action: 'report_session', session_id: SID }
        });
        const reportJson = unwrap(reportResp);
        expect('report status=complete',   reportJson.status === 'complete',  reportJson.status);
        expect('report requested=2',       reportJson.requested === 2,        String(reportJson.requested));
        expect('report actually_saved=1',  reportJson.actually_saved === 1,   String(reportJson.actually_saved));
        expect('report failed=0',          reportJson.failed === 0,           String(reportJson.failed));

        console.log('\n=== Test 6b: report includes server-built summary_markdown ===');
        const md = reportJson.summary_markdown;
        expect('summary_markdown is a string',   typeof md === 'string',                            typeof md);
        expect('markdown opens with H2',         typeof md === 'string' && md.startsWith('## '),    md && md.slice(0, 30));
        expect('markdown mentions under-target', typeof md === 'string' && /under target/i.test(md), md && md.slice(0, 80));
        expect('markdown lists actually_saved',  typeof md === 'string' && /Actually saved:\s*1/.test(md), md && (md.match(/Actually saved.*$/m) || [''])[0]);
        expect('markdown lists requested',       typeof md === 'string' && /Requested:\s*2/.test(md),       md && (md.match(/Requested.*$/m) || [''])[0]);
        expect('markdown shows saved client',    typeof md === 'string' && md.includes(SAVED_CLIENT_ID),    SAVED_CLIENT_ID);
        expect('markdown contains session id',   typeof md === 'string' && md.includes(SID),                SID);

        console.log('\n=== Test 7: save against closed session is rejected ===');
        const afterCloseResp = await rpc('tools/call', {
            name: 'pipeline',
            arguments: {
                action: 'save',
                session_id: SID,
                patch: { name: 'too_late_' + Date.now() }
            }
        });
        const afterCloseJson = unwrap(afterCloseResp);
        expect('closed session rejects new save',
               afterCloseJson.error || (afterCloseResp.error && /complete|not active/i.test(JSON.stringify(afterCloseResp.error))),
               JSON.stringify(afterCloseJson));

        console.log(`\n${'='.repeat(40)}\n${pass} passed, ${fail} failed`);
        // Cleanup: delete the smoke test client + session events would orphan via cascade
        // (kept for now — easy to inspect in DB).
        process.exit(fail > 0 ? 1 : 0);
    } catch (e) {
        console.error('Smoke test crashed:', e);
        process.exit(2);
    } finally {
        server.kill();
    }
})();
