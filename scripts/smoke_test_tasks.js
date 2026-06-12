#!/usr/bin/env node
/**
 * smoke_test_tasks.js -- Smoke test for the new Task/Judge backbone.
 *
 * Verifies, against a real spawned mcp_server.js + a writable copy of the
 * local SQLite DB:
 *   1. tools/list advertises plan_tasks, claim_task, complete_task, tasks,
 *      and judge_affected in the action enum.
 *   2. plan_tasks creates Tasks (workflow mode) without exceeding per-type limits.
 *   3. claim_task atomically returns ONE ready task and flips its status.
 *   4. A second claim_task on the same type cannot return the same id.
 *   5. complete_task records output, status, and finishedAt.
 *   6. Stale claimed Tasks are returned to ready (claimedAt backdated).
 *   7. pipeline.save with judge:false does NOT update Booking.status.
 *   8. judge_affected DOES update Booking.status for the same booking
 *      (proves Judge is the only scoring path for the new architecture).
 *   9. Legacy pipeline.save (default judge:true) still rescores.
 *
 * Uses a temp copy of data/myproject.sqlite so the live DB is not mutated.
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const { spawn } = require('child_process');

const PRECRIME_ROOT = path.resolve(__dirname, '..');
const SERVER        = path.join(PRECRIME_ROOT, 'server', 'mcp', 'mcp_server.js');
const SCHEMA        = path.join(PRECRIME_ROOT, 'server', 'prisma', 'schema.prisma');

if (!fs.existsSync(SERVER)) { console.error('Server not found:', SERVER); process.exit(2); }

// Build a clean, schema-correct DB via prisma db push. The live myproject.sqlite
// has drifted in this dev tree; the smoke test must run against a DB that
// matches the current schema.prisma (which is exactly what production deployments
// get from `precrime.bat` first-run).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'precrime-smoke-'));
const DB_PATH = path.join(TMP_DIR, 'smoke.sqlite');
console.log('[smoke] building fresh DB at:', DB_PATH);
const SERVER_DIR = path.join(PRECRIME_ROOT, 'server');
const pushRes = require('child_process').spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: 'file:' + DB_PATH }, encoding: 'utf8', shell: process.platform === 'win32' }
);
if (pushRes.status !== 0) {
    console.error('prisma db push failed:', pushRes.stdout, pushRes.stderr);
    process.exit(2);
}

const env = {
    ...process.env,
    DATABASE_URL: 'file:' + DB_PATH,
    PRECRIME_QUIET: '1'
};
const server = spawn('node', [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
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
    if (process.env.SMOKE_VERBOSE) process.stderr.write('[srv] ' + chunk);
});

function rpc(method, params) {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, 15000);
        pending.set(id, {
            resolve: r => { clearTimeout(t); resolve(r); },
            reject:  e => { clearTimeout(t); reject(e); }
        });
        server.stdin.write(JSON.stringify(msg) + '\n');
    });
}

function unwrap(resp) {
    if (resp.error) return { __rpcError: resp.error };
    const text = resp.result?.content?.[0]?.text;
    if (!text) return { __raw: resp.result };
    try { return JSON.parse(text); } catch { return { __text: text }; }
}

let pass = 0, fail = 0;
function expect(label, cond, detail) {
    if (cond) { console.log(`  ok   ${label}`); pass++; }
    else      { console.log(`  FAIL ${label}${detail ? '  -- ' + detail : ''}`); fail++; }
}

async function call(action, args = {}) {
    const resp = await rpc('tools/call', { name: 'pipeline', arguments: { action, ...args } });
    return unwrap(resp);
}

(async () => {
    try {
        await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } });
        await rpc('notifications/initialized', {}).catch(() => {});

        console.log('\n=== Test 1: action enum advertises new Task/Judge actions ===');
        const tl = await rpc('tools/list', {});
        const pTool = tl.result?.tools?.find(t => t.name === 'pipeline');
        const en = pTool?.inputSchema?.properties?.action?.enum || [];
        for (const a of ['plan_tasks', 'claim_task', 'complete_task', 'tasks', 'judge_affected']) {
            expect(`${a} in enum`, en.includes(a), en.join(','));
        }

        console.log('\n=== Test 2: plan_tasks (workflow) creates Tasks within limits ===');
        const plan = await call('plan_tasks', { mode: 'workflow' });
        expect('plan_tasks ok', !plan.__rpcError, JSON.stringify(plan.__rpcError || {}));
        const counts = plan.counts || {};
        const limits = plan.limits || {};
        let limitsOk = true;
        for (const [t, n] of Object.entries(counts)) {
            if (limits[t] != null && n > limits[t]) { limitsOk = false; break; }
        }
        expect('no type exceeds limit in one plan call', limitsOk, JSON.stringify(counts));

        console.log('\n=== Test 3: claim_task returns one ready task and flips status ===');
        const t1 = await call('claim_task', { role: 'smoke' });
        expect('claim ok', !t1.__rpcError, JSON.stringify(t1.__rpcError || {}));
        const claimedOk = t1.status === 'CLAIMED' || t1.status === 'NO_TASK';
        expect('claim returns CLAIMED or NO_TASK', claimedOk, t1.status);
        let claimedTask = null;
        if (t1.status === 'CLAIMED') {
            claimedTask = t1.task;
            expect('claimed task has id', !!claimedTask?.id, JSON.stringify(claimedTask));
            expect('claimed task.status === claimed', claimedTask.status === 'claimed', claimedTask?.status);

            console.log('\n=== Test 4: second claim does NOT return the same task id ===');
            const t2 = await call('claim_task', { role: 'smoke' });
            if (t2.status === 'CLAIMED') {
                expect('different task id', t2.task.id !== claimedTask.id, t2.task.id);
            } else {
                expect('queue empty after one claim (acceptable)', t2.status === 'NO_TASK', t2.status);
            }

            console.log('\n=== Test 5: complete_task records output + finishedAt ===');
            const done = await call('complete_task', {
                taskId: claimedTask.id,
                status: 'done',
                output: { affectedClientIds: [], affectedBookingIds: [], note: 'smoke' }
            });
            expect('complete ok', done.completed === true, JSON.stringify(done));
            expect('finishedAt set', !!done.task?.finishedAt, String(done.task?.finishedAt));
            expect('status=done', done.task?.status === 'done', done.task?.status);
            expect('output recorded', done.task?.output?.note === 'smoke', JSON.stringify(done.task?.output));
        } else {
            console.log('  (no tasks to claim -- skipping claim/complete sub-assertions)');
        }

        console.log('\n=== Test 6: stale claimed Task is reclaimed by plan_tasks ===');
        // Insert a synthetic claimed-but-stale task using server's prisma client.
        let staleId = null;
        try {
            const serverPrismaPath = path.join(PRECRIME_ROOT, 'server', 'node_modules', '@prisma', 'client');
            const { PrismaClient } = require(serverPrismaPath);
            const p = new PrismaClient({ datasources: { db: { url: 'file:' + DB_PATH } } });
            const oldDate = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
            const row = await p.task.create({
                data: {
                    type: 'ENRICH_CLIENT',
                    status: 'claimed',
                    claimedAt: oldDate,
                    claimedBy: 'ghost'
                }
            });
            staleId = row.id;
            await p.$disconnect();
        } catch (e) {
            console.log('  (could not seed stale task:', e.message, ')');
        }
        if (staleId) {
            const plan2 = await call('plan_tasks', { mode: 'workflow' });
            expect('reclaimed >= 1', (plan2.reclaimed || 0) >= 1, String(plan2.reclaimed));
            const list = await call('tasks', { status: 'ready' });
            const found = (list.tasks || []).some(t => t.id === staleId);
            expect('stale task now ready', found, 'stale id=' + staleId);
        }

        console.log('\n=== Test 7: pipeline.save with judge:false does NOT change Booking.status ===');
        // Seed a high-quality client+booking via the legacy save path so we can
        // verify the judge:false path does NOT mutate status afterward.
        const seedName = 'JUDGE_SEED_' + Date.now();
        const seed = await call('save', {
            patch: {
                name: seedName,
                email: 'real.contact@' + Date.now() + '.example.com',
                company: 'JudgeSeedCo',
                bookings: [{
                    title: 'Seed Gig', description: 'A bookable gig for smoke testing the judge boundary path with enough words to count.',
                    location: '123 Main St, Hall A',
                    startTime: '18:00', duration: 2,
                    trade: 'caricatures', zip: '90405',
                    startDate: new Date(Date.now() + 30*24*3600*1000).toISOString()
                }]
            }
        });
        const seedClientId  = seed.clientId;
        const seedBookingId = (seed.affectedBookingIds || [])[0];
        let testBooking = seedBookingId ? { id: seedBookingId, clientId: seedClientId, status: null } : null;
        if (testBooking) {
            // Read its current status via tasks/find pattern: use direct rescore=0 trick via find
            const find = await rpc('tools/call', { name: 'find', arguments: { action: 'bookings', filters: {}, limit: 50 } });
            const findJson = unwrap(find);
            const arr0 = Array.isArray(findJson) ? findJson : (findJson.results || findJson.bookings || []);
            const cur = (arr0 || []).find(b => b.id === testBooking.id);
            testBooking.status = cur?.status || 'brewing';
        }
        if (testBooking) {
            const beforeStatus = testBooking.status;
            // Save against client with judge:false. Use a no-op-ish patch that still passes validation.
            const sv = await call('save', {
                id: testBooking.clientId,
                judge: false,
                patch: { clientNotes: '[smoke ' + Date.now() + '] judge:false test' }
            });
            expect('save(judge:false) ok',     sv.saved === true,    JSON.stringify(sv).slice(0, 200));
            expect('save(judge:false) judged=false', sv.judged === false, String(sv.judged));
            expect('affected ids returned',    Array.isArray(sv.affectedBookingIds), JSON.stringify(sv.affectedBookingIds));

            // Re-fetch booking
            const after = await rpc('tools/call', { name: 'find', arguments: { action: 'bookings', filters: { status: beforeStatus }, limit: 50 } });
            const afterJson = unwrap(after);
            const arr = Array.isArray(afterJson) ? afterJson : (afterJson.results || afterJson.bookings || []);
            const still = (arr || []).find(b => b.id === testBooking.id);
            expect('booking status unchanged after judge:false', !!still && still.status === beforeStatus,
                   `before=${beforeStatus} after=${still?.status}`);

            console.log('\n=== Test 8: judge_affected DOES rescore that booking ===');
            // Force a deliberate status drift by writing 'brewing' via prisma,
            // then save(judge:false) should NOT correct it, but judge_affected MUST.
            let driftOk = false;
            try {
                const serverPrismaPath = path.join(PRECRIME_ROOT, 'server', 'node_modules', '@prisma', 'client');
                const { PrismaClient } = require(serverPrismaPath);
                const p = new PrismaClient({ datasources: { db: { url: 'file:' + DB_PATH } } });
                await p.booking.update({ where: { id: testBooking.id }, data: { status: 'brewing' } });
                await p.$disconnect();
                driftOk = true;
            } catch (e) {
                console.log('  (could not force drift via prisma:', e.message, ')');
            }
            if (driftOk) {
                // save with judge:false should leave it at 'brewing'
                const sv2 = await call('save', {
                    id: testBooking.clientId,
                    judge: false,
                    patch: { clientNotes: 'force drift check ' + Date.now() }
                });
                expect('save(judge:false) still does not rescore after drift',
                    sv2.saved === true && sv2.judged === false,
                    JSON.stringify({saved:sv2.saved,judged:sv2.judged}));
                const after2 = await rpc('tools/call', { name: 'find', arguments: { action: 'bookings', filters: { status: 'brewing' }, limit: 100 } });
                const a2 = unwrap(after2);
                const arr2 = Array.isArray(a2) ? a2 : (a2.results || a2.bookings || []);
                const stuck = (arr2 || []).find(b => b.id === testBooking.id);
                expect('booking status still brewing after save(judge:false)', !!stuck, 'expected brewing, got something else');
            }
            const jr = await call('judge_affected', { bookingIds: [testBooking.id] });
            expect('judge_affected ok', !jr.__rpcError, JSON.stringify(jr.__rpcError || {}));
            expect('judge processed the booking',
                   (jr.affectedBookingIds || []).includes(testBooking.id),
                   JSON.stringify(jr.affectedBookingIds));
        } else {
            console.log('  (no eligible booking in DB -- skipping save/judge round-trip)');
        }

        console.log('\n=== Test 9: legacy pipeline.save (default judge:true) still works ===');
        const legacy = await call('save', {
            patch: { name: 'SMOKE_LEGACY_' + Date.now(), company: 'LegacyCo' }
        });
        expect('legacy save ok',          legacy.saved === true, JSON.stringify(legacy).slice(0, 200));
        expect('legacy save judged=true', legacy.judged === true, String(legacy.judged));

        console.log('\n=== Test 10: recycler -- enum advertised and dry-run is non-destructive ===');
        const en2 = pTool?.inputSchema?.properties?.action?.enum || [];
        expect('recycler in enum', en2.includes('recycler'), en2.join(','));

        // Seed recycler-specific fixtures via prisma so we have known data to act on.
        const serverPrismaPath = path.join(PRECRIME_ROOT, 'server', 'node_modules', '@prisma', 'client');
        const { PrismaClient: PC2 } = require(serverPrismaPath);
        const p2 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });

        // a) old claimed task (1 hour ago, beyond default 10min claim timeout)
        const oldClaim = await p2.task.create({
            data: {
                type: 'SCRAPE_SOURCE',
                status: 'claimed',
                claimedAt: new Date(Date.now() - 60 * 60 * 1000),
                claimedBy: 'recycler-ghost'
            }
        });
        // b) fresh claimed task (just now -- must NOT be requeued)
        const freshClaim = await p2.task.create({
            data: {
                type: 'SCRAPE_SOURCE',
                status: 'claimed',
                claimedAt: new Date(),
                claimedBy: 'recycler-fresh'
            }
        });
        // c) ready task (must NEVER be deleted)
        const readyTask = await p2.task.create({
            data: { type: 'ENRICH_CLIENT', status: 'ready' }
        });
        // d) old finished task (40 days ago, beyond default 30d retention)
        const oldDoneId = (await p2.task.create({
            data: { type: 'ENRICH_CLIENT', status: 'done' }
        })).id;
        const oldFinishedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        // Prisma stores SQLite DateTime as INTEGER milliseconds; raw SQL must use ms.
        await p2.task.update({ where: { id: oldDoneId }, data: { finishedAt: oldFinishedAt } });
        await p2.$executeRawUnsafe(
            `UPDATE Task SET updatedAt = ? WHERE id = ?`,
            oldFinishedAt.getTime(), oldDoneId
        );
        // e) recent finished task (must NOT be deleted)
        const recentDone = await p2.task.create({
            data: { type: 'ENRICH_CLIENT', status: 'done', finishedAt: new Date() }
        });
        // f) old factlet (200 days ago, beyond default 180d stale)
        const oldFactletId = (await p2.factlet.create({
            data: { content: 'old factlet for recycler', source: 'smoke' }
        })).id;
        const oldFactletAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
        // Prisma stores SQLite DateTime as INTEGER milliseconds.
        await p2.$executeRawUnsafe(
            `UPDATE Factlet SET createdAt = ? WHERE id = ?`,
            oldFactletAt.getTime(), oldFactletId
        );
        // g) recent factlet (must NOT be deleted)
        const recentFactlet = await p2.factlet.create({
            data: { content: 'recent factlet', source: 'smoke' }
        });
        // Count ontology before recycler so we can prove it's untouched.
        const clientsBefore  = await p2.client.count();
        const bookingsBefore = await p2.booking.count();
        const sourcesBefore  = await p2.source.count();
        const sessionsBefore = await p2.session.count();
        await p2.$disconnect();

        // Dry run -- must report counts but NOT mutate.
        const dry = await call('recycler', { dryRun: true });
        expect('dry recycler ok', !dry.__rpcError, JSON.stringify(dry.__rpcError || {}));
        expect('dry reports timedOutTasksRequeued >= 1', (dry.timedOutTasksRequeued || 0) >= 1, String(dry.timedOutTasksRequeued));
        expect('dry reports finishedTasksDeleted >= 1', (dry.finishedTasksDeleted   || 0) >= 1, String(dry.finishedTasksDeleted));
        expect('dry reports staleFactletsDeleted >= 1', (dry.staleFactletsDeleted   || 0) >= 1, String(dry.staleFactletsDeleted));
        expect('dry includes thresholds', !!dry.thresholds && dry.thresholds.taskRetentionDays === 30,
               JSON.stringify(dry.thresholds));

        // Verify nothing actually changed.
        const p3 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const oldClaimAfterDry  = await p3.task.findUnique({ where: { id: oldClaim.id } });
        const oldDoneAfterDry   = await p3.task.findUnique({ where: { id: oldDoneId } });
        const oldFactAfterDry   = await p3.factlet.findUnique({ where: { id: oldFactletId } });
        expect('dry leaves stale claim as claimed', oldClaimAfterDry?.status === 'claimed', String(oldClaimAfterDry?.status));
        expect('dry leaves old done task present', !!oldDoneAfterDry, 'expected row still present');
        expect('dry leaves old factlet present',   !!oldFactAfterDry, 'expected row still present');
        await p3.$disconnect();

        // Destructive run -- must perform deletions and requeues.
        console.log('\n=== Test 11: recycler dryRun:false performs the cleanup ===');
        const wet = await call('recycler', { dryRun: false });
        expect('wet recycler ok', !wet.__rpcError, JSON.stringify(wet.__rpcError || {}));
        expect('wet timedOutTasksRequeued >= 1', (wet.timedOutTasksRequeued || 0) >= 1, String(wet.timedOutTasksRequeued));
        expect('wet finishedTasksDeleted >= 1',  (wet.finishedTasksDeleted   || 0) >= 1, String(wet.finishedTasksDeleted));
        expect('wet staleFactletsDeleted >= 1',  (wet.staleFactletsDeleted   || 0) >= 1, String(wet.staleFactletsDeleted));

        const p4 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const oldClaimAfterWet  = await p4.task.findUnique({ where: { id: oldClaim.id } });
        const freshClaimAfter   = await p4.task.findUnique({ where: { id: freshClaim.id } });
        const readyAfter        = await p4.task.findUnique({ where: { id: readyTask.id } });
        const oldDoneAfterWet   = await p4.task.findUnique({ where: { id: oldDoneId } });
        const recentDoneAfter   = await p4.task.findUnique({ where: { id: recentDone.id } });
        const oldFactAfterWet   = await p4.factlet.findUnique({ where: { id: oldFactletId } });
        const recentFactAfter   = await p4.factlet.findUnique({ where: { id: recentFactlet.id } });

        expect('timed-out claim is now ready',    oldClaimAfterWet?.status === 'ready' && !oldClaimAfterWet?.claimedAt,
               JSON.stringify(oldClaimAfterWet && {status:oldClaimAfterWet.status,claimedAt:oldClaimAfterWet.claimedAt}));
        expect('fresh claim is untouched',        freshClaimAfter?.status === 'claimed' && !!freshClaimAfter?.claimedAt,
               JSON.stringify(freshClaimAfter && {status:freshClaimAfter.status}));
        expect('ready task untouched',            !!readyAfter && readyAfter.status === 'ready',
               JSON.stringify(readyAfter && {status:readyAfter.status}));
        expect('old finished task deleted',       !oldDoneAfterWet, 'expected null');
        expect('recent finished task preserved',  !!recentDoneAfter, 'expected row');
        expect('stale factlet deleted',           !oldFactAfterWet,  'expected null');
        expect('recent factlet preserved',        !!recentFactAfter, 'expected row');

        // Ontology truth must be untouched.
        const clientsAfter  = await p4.client.count();
        const bookingsAfter = await p4.booking.count();
        const sourcesAfter  = await p4.source.count();
        const sessionsAfter = await p4.session.count();
        await p4.$disconnect();
        expect('Clients count unchanged',  clientsAfter  === clientsBefore,  `${clientsBefore}->${clientsAfter}`);
        expect('Bookings count unchanged', bookingsAfter === bookingsBefore, `${bookingsBefore}->${bookingsAfter}`);
        expect('Sources count unchanged',  sourcesAfter  === sourcesBefore,  `${sourcesBefore}->${sourcesAfter}`);
        expect('Sessions count unchanged', sessionsAfter === sessionsBefore, `${sessionsBefore}->${sessionsAfter}`);

        console.log('\n=== Test 12: one-Task worker skills (url-loop + enrichment-agent + apply-factlet) ===');
        // Scan the rewritten worker skill markdown files. The orchestrator
        // claims Tasks; workers consume the already-claimed Task packet,
        // complete its exact taskId, and pass judge:false to pipeline.save. None
        // may carry the old recursive/global-workflow phrases.
        const SKILL_DIR = path.join(PRECRIME_ROOT, 'templates', 'skills');
        // { path, requiresLegacyBackup } -- apply-factlet.md is a new Phase 4
        // skill with no prior working version, so no .legacy.md backup exists.
        const WORKER_SKILLS = [
            { path: path.join(SKILL_DIR, 'url-loop.md'),         requiresLegacyBackup: true  },
            { path: path.join(SKILL_DIR, 'enrichment-agent.md'), requiresLegacyBackup: true  },
            { path: path.join(SKILL_DIR, 'apply-factlet.md'),    requiresLegacyBackup: false }
        ];
        // Forbidden phrases = pre-Task-architecture global-workflow language.
        // We look for ACTUAL INVOCATION of these (action: "X"), not casual
        // mentions in negative prose like "Do not call next_source".
        // Also banned: legacy section headings that drove the recursive queue.
        const FORBIDDEN = [
            'action: "next_source"',           // legacy queue claim from inside the worker
            'action:"next_source"',
            'action: "report_session"',        // session-close is not a worker concern
            'action:"report_session"',
            'action: "plan_tasks"',            // planning is not a worker concern
            'action:"plan_tasks"',
            'action: "rescore"',               // scoring is owned by Judge
            'action:"rescore"',
            'Step 2 -- Claim next source',     // legacy iterate-queue phrase
            'Step 6 -- Queue empty, grow it',  // legacy recursive grow phrase
            'recurse to the next claim',
            'Repeat from Step 0',              // legacy enrichment loop
            'PRESENT_READY',                   // banned term per spec
            'WorkItem'                         // banned term per spec
        ];
        for (const entry of WORKER_SKILLS) {
            const skillPath = entry.path;
            expect(`${path.basename(skillPath)} exists`, fs.existsSync(skillPath), skillPath);
            const body = fs.readFileSync(skillPath, 'utf8');
            const name = path.basename(skillPath);
            expect(`${name} does NOT call claim_task`,
                   !/action:\s*["']claim_task["']/.test(body),
                   'worker must consume claimed Task packet, not self-claim');
            expect(`${name} accepts already-claimed Task`,
                   /already-claimed|already claimed/i.test(body),
                   'missing already-claimed Task contract');
            expect(`${name} calls complete_task`, body.includes('complete_task'), 'missing complete_task');
            expect(`${name} passes judge:false`,
                   body.includes('judge:false') || body.includes('judge: false'),
                   'missing judge:false');
            for (const phrase of FORBIDDEN) {
                expect(`${name} no forbidden phrase "${phrase}"`,
                       !body.includes(phrase),
                       `found: "${phrase}"`);
            }
            if (entry.requiresLegacyBackup) {
                // Legacy backup must exist (user's hard rule: never destroy working md).
                // Accept any of these locations:
                //   - skills/X.legacy.md                (sibling)
                //   - skills/_archive/X.legacy.md       (archive subdir)
                //   - skills/TMP/_archive__X.legacy.md  (flat-prefixed archive)
                const sibling   = skillPath.replace(/\.md$/, '.legacy.md');
                const archive   = path.join(path.dirname(skillPath), '_archive', path.basename(sibling));
                const tmpFlat   = path.join(path.dirname(skillPath), 'TMP', '_archive__' + path.basename(sibling));
                expect(`${name} has .legacy.md backup (sibling, _archive/, or TMP/_archive__)`,
                       fs.existsSync(sibling) || fs.existsSync(archive) || fs.existsSync(tmpFlat),
                       `${sibling} | ${archive} | ${tmpFlat}`);
            }
        }

        console.log('\n=== Test 13: Planner JUDGE_AFFECTED reads canonical + legacy output keys ===');
        // Seed synthetic 'done' worker Tasks via Prisma whose output uses the
        // canonical, legacy, and mixed naming schemes. Then plan_tasks must
        // create JUDGE_AFFECTED Tasks whose input.clientIds / input.bookingIds
        // reflect a deduped union of both schemes.
        const pJudge = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });

        // Drain any pre-existing ready JUDGE_AFFECTED so we count only new ones.
        await pJudge.task.deleteMany({ where: { type: 'JUDGE_AFFECTED', status: 'ready' } });
        // Also drain done worker Tasks so they don't confound this section.
        await pJudge.task.deleteMany({
            where: { status: 'done', type: { in: ['SCRAPE_SOURCE', 'ENRICH_CLIENT', 'APPLY_FACTLET'] } }
        });

        // a) canonical clientIds/bookingIds
        const tCanon = await pJudge.task.create({
            data: {
                type: 'SCRAPE_SOURCE', status: 'done', finishedAt: new Date(),
                output: JSON.stringify({ clientIds: ['cli_A'], bookingIds: ['bk_A'] })
            }
        });
        // b) legacy affectedClientIds/affectedBookingIds
        const tLegacy = await pJudge.task.create({
            data: {
                type: 'ENRICH_CLIENT', status: 'done', finishedAt: new Date(),
                output: JSON.stringify({ affectedClientIds: ['cli_B'], affectedBookingIds: ['bk_B'] })
            }
        });
        // c) mixed canonical + legacy in same output, with duplicate id across keys
        const tMixed = await pJudge.task.create({
            data: {
                type: 'APPLY_FACTLET', status: 'done', finishedAt: new Date(),
                output: JSON.stringify({
                    clientIds:         ['cli_C', 'cli_D'],
                    affectedClientIds: ['cli_C', 'cli_E'],         // cli_C duplicates
                    bookingIds:        ['bk_C'],
                    affectedBookingIds:['bk_C', 'bk_D']            // bk_C duplicates
                })
            }
        });
        // d) empty / no affected ids -- must NOT produce a JUDGE_AFFECTED task
        const tEmpty = await pJudge.task.create({
            data: {
                type: 'SCRAPE_SOURCE', status: 'done', finishedAt: new Date(),
                output: JSON.stringify({ note: 'nothing affected' })
            }
        });
        // e) null output -- must NOT produce a JUDGE_AFFECTED task
        const tNull = await pJudge.task.create({
            data: {
                type: 'ENRICH_CLIENT', status: 'done', finishedAt: new Date()
            }
        });
        await pJudge.$disconnect();

        // Run planner and read back the resulting JUDGE_AFFECTED Tasks.
        const planJ = await call('plan_tasks', { mode: 'workflow' });
        expect('plan_tasks (judge run) ok', !planJ.__rpcError, JSON.stringify(planJ.__rpcError || {}));

        const jList = await call('tasks', { type: 'JUDGE_AFFECTED', status: 'ready' });
        const jTasks = jList.tasks || [];
        const bySrc = new Map();
        for (const t of jTasks) {
            const src = t.input?.sourceTaskId;
            if (src) bySrc.set(src, t);
        }

        // a) canonical
        const jCanon = bySrc.get(tCanon.id);
        expect('canonical clientIds triggers JUDGE_AFFECTED', !!jCanon, 'no judge task for tCanon');
        expect('canonical clientIds propagated',
               !!jCanon && JSON.stringify(jCanon.input.clientIds) === JSON.stringify(['cli_A']),
               JSON.stringify(jCanon?.input?.clientIds));
        expect('canonical bookingIds propagated',
               !!jCanon && JSON.stringify(jCanon.input.bookingIds) === JSON.stringify(['bk_A']),
               JSON.stringify(jCanon?.input?.bookingIds));

        // b) legacy
        const jLegacy = bySrc.get(tLegacy.id);
        expect('legacy affectedClientIds still triggers JUDGE_AFFECTED', !!jLegacy, 'no judge task for tLegacy');
        expect('legacy clientIds propagated',
               !!jLegacy && JSON.stringify(jLegacy.input.clientIds) === JSON.stringify(['cli_B']),
               JSON.stringify(jLegacy?.input?.clientIds));
        expect('legacy bookingIds propagated',
               !!jLegacy && JSON.stringify(jLegacy.input.bookingIds) === JSON.stringify(['bk_B']),
               JSON.stringify(jLegacy?.input?.bookingIds));

        // c) mixed + dedup
        const jMixed = bySrc.get(tMixed.id);
        expect('mixed canonical+legacy triggers JUDGE_AFFECTED', !!jMixed, 'no judge task for tMixed');
        const mc = jMixed?.input?.clientIds  || [];
        const mb = jMixed?.input?.bookingIds || [];
        expect('mixed clientIds deduped and unioned',
               mc.length === 3 && new Set(mc).size === 3 &&
               mc.includes('cli_C') && mc.includes('cli_D') && mc.includes('cli_E'),
               JSON.stringify(mc));
        expect('mixed bookingIds deduped and unioned',
               mb.length === 2 && new Set(mb).size === 2 &&
               mb.includes('bk_C') && mb.includes('bk_D'),
               JSON.stringify(mb));

        // d/e) empty + null
        expect('empty output does NOT create JUDGE_AFFECTED', !bySrc.has(tEmpty.id),
               'unexpected judge task for tEmpty');
        expect('null output does NOT create JUDGE_AFFECTED', !bySrc.has(tNull.id),
               'unexpected judge task for tNull');

        console.log('\n=== Test 14: APPLY_FACTLET planner dedup + completion triggers JUDGE_AFFECTED ===');
        // Seed one Factlet, pre-create an open APPLY_FACTLET Task for it, then
        // call plan_tasks and assert NO duplicate open APPLY_FACTLET Task is
        // created for the same Factlet.
        const pAF = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });

        // Drain any pre-existing APPLY_FACTLET to keep this section deterministic.
        await pAF.task.deleteMany({ where: { type: 'APPLY_FACTLET' } });
        // Drain ready JUDGE_AFFECTED so the downstream assertion is clean.
        await pAF.task.deleteMany({ where: { type: 'JUDGE_AFFECTED', status: 'ready' } });

        const seedFactlet = await pAF.factlet.create({
            data: { content: 'Phase 4 dedup factlet', source: 'smoke' }
        });
        // Pre-create one open APPLY_FACTLET task for that factlet.
        const preExisting = await pAF.task.create({
            data: {
                type:       'APPLY_FACTLET',
                status:     'ready',
                targetType: 'Factlet',
                targetId:   seedFactlet.id
            }
        });
        await pAF.$disconnect();

        const planAF = await call('plan_tasks', { mode: 'workflow' });
        expect('plan_tasks (apply-factlet dedup) ok', !planAF.__rpcError,
               JSON.stringify(planAF.__rpcError || {}));

        // After planning, there must be AT MOST ONE open APPLY_FACTLET Task
        // for seedFactlet.id (status in ready|claimed).
        const afOpen = await call('tasks', { type: 'APPLY_FACTLET', targetType: 'Factlet', targetId: seedFactlet.id });
        const openAF = (afOpen.tasks || []).filter(t => t.status === 'ready' || t.status === 'claimed');
        expect('no duplicate open APPLY_FACTLET task for same Factlet',
               openAF.length === 1,
               `openCount=${openAF.length}, ids=${JSON.stringify(openAF.map(t => t.id))}`);
        expect('pre-existing APPLY_FACTLET task preserved',
               openAF.some(t => t.id === preExisting.id),
               `pre id=${preExisting.id}`);

        // Now complete the APPLY_FACTLET Task with canonical clientIds and prove
        // the Phase 3.1 normalizer wires it through to a JUDGE_AFFECTED Task.
        const claimedAF = await call('claim_task', { role: 'smoke-af', types: ['APPLY_FACTLET'] });
        expect('claim APPLY_FACTLET ok', claimedAF.status === 'CLAIMED',
               JSON.stringify(claimedAF));
        if (claimedAF.status === 'CLAIMED') {
            const afTaskId = claimedAF.task.id;
            const afDone = await call('complete_task', {
                taskId: afTaskId,
                status: 'done',
                output: {
                    clientIds:  ['cli_AF1', 'cli_AF2'],
                    bookingIds: [],
                    factletIds: [seedFactlet.id],
                    sourceIds:  [],
                    summary:    'Applied factlet to 2 clients (smoke)',
                    needsJudge: true
                }
            });
            expect('APPLY_FACTLET complete ok', afDone.completed === true,
                   JSON.stringify(afDone).slice(0, 200));

            // Drain any prior ready JUDGE_AFFECTED so the next plan only shows
            // the one this completion triggers.
            const pDrain = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
            await pDrain.task.deleteMany({ where: { type: 'JUDGE_AFFECTED', status: 'ready' } });
            await pDrain.$disconnect();

            const planAF2 = await call('plan_tasks', { mode: 'workflow' });
            expect('plan_tasks (post APPLY_FACTLET) ok', !planAF2.__rpcError,
                   JSON.stringify(planAF2.__rpcError || {}));

            const jList2 = await call('tasks', { type: 'JUDGE_AFFECTED', status: 'ready' });
            const matchJ = (jList2.tasks || []).find(t => t.input?.sourceTaskId === afTaskId);
            expect('APPLY_FACTLET completion triggers JUDGE_AFFECTED', !!matchJ,
                   'no JUDGE_AFFECTED task referencing the completed APPLY_FACTLET');
            expect('APPLY_FACTLET canonical clientIds propagated to JUDGE_AFFECTED',
                   !!matchJ && Array.isArray(matchJ.input?.clientIds) &&
                   matchJ.input.clientIds.includes('cli_AF1') &&
                   matchJ.input.clientIds.includes('cli_AF2'),
                   JSON.stringify(matchJ?.input?.clientIds));
        }

        console.log('\n=== Test 15: structured resolve_dates (Phase 5) ===');
        // Known PDT case from the spec. Verifies tz-aware epoch math.
        // 2026-06-10 21:30 America/Los_Angeles -> 2026-06-11 04:30 UTC
        // 2026-06-11 05:00 America/Los_Angeles -> 2026-06-11 12:00 UTC
        const EXPECTED_ST = Date.UTC(2026, 5, 11, 4, 30, 0);   // 1781152200000
        const EXPECTED_ET = Date.UTC(2026, 5, 11, 12, 0, 0);   // 1781179200000
        const rdOk = await call('resolve_dates', {
            rawText: 'Grad Nite, June 10, 9:30pm to 5am, Santa Monica',
            start:   { year: 2026, month: 6, day: 10, hour: 9, minute: 30, ampm: 'PM' },
            end:     { year: 2026, month: 6, day: 11, hour: 5, minute: 0,  ampm: 'AM' },
            timezone: 'America/Los_Angeles',
            zip:      '90405',
            sourceProof: 'Email says: June 10, 9:30pm to 5am, Santa Monica'
        });
        expect('resolve_dates ok=true',        rdOk.ok === true,                JSON.stringify(rdOk).slice(0, 200));
        expect('resolve_dates st matches PDT', rdOk.st === EXPECTED_ST,         `got ${rdOk.st}, expected ${EXPECTED_ST}`);
        expect('resolve_dates et matches PDT', rdOk.et === EXPECTED_ET,         `got ${rdOk.et}, expected ${EXPECTED_ET}`);
        expect('resolve_dates echoes timezone', rdOk.timezone === 'America/Los_Angeles', String(rdOk.timezone));
        expect('resolve_dates echoes zip',     rdOk.zip === '90405',            String(rdOk.zip));
        expect('startIso carries -07:00 offset', typeof rdOk.startIso === 'string' && rdOk.startIso.endsWith('-07:00'), String(rdOk.startIso));

        // Text-only timezone smuggling is rejected.
        const rdTextOnlyTz = await call('resolve_dates', {
            rawText: 'June 10 2026 9:30 PM to 5 AM PDT Santa Monica',
            start:   { year: 2026, month: 6, day: 10, hour: 9, minute: 30, ampm: 'PM' },
            end:     { year: 2026, month: 6, day: 11, hour: 5, minute: 0,  ampm: 'AM' }
            // no timezone, no zip
        });
        expect('text-only timezone rejected',
               rdTextOnlyTz.ok === false &&
               (rdTextOnlyTz.errors || []).some(e => e.startsWith('timezone:')),
               JSON.stringify(rdTextOnlyTz));

        // Missing structured start is rejected.
        const rdNoStart = await call('resolve_dates', {
            end:      { year: 2026, month: 6, day: 11, hour: 5, minute: 0, ampm: 'AM' },
            timezone: 'America/Los_Angeles'
        });
        expect('missing start rejected',
               rdNoStart.ok === false && (rdNoStart.errors || []).some(e => e.startsWith('start')),
               JSON.stringify(rdNoStart));

        // Missing structured end is rejected.
        const rdNoEnd = await call('resolve_dates', {
            start:    { year: 2026, month: 6, day: 10, hour: 9, minute: 30, ampm: 'PM' },
            timezone: 'America/Los_Angeles'
        });
        expect('missing end rejected',
               rdNoEnd.ok === false && (rdNoEnd.errors || []).some(e => e.startsWith('end')),
               JSON.stringify(rdNoEnd));

        // Same-day end <= start is rejected.
        const rdSameDayBad = await call('resolve_dates', {
            start:    { year: 2026, month: 6, day: 10, hour: 9, minute: 30, ampm: 'PM' },
            end:      { year: 2026, month: 6, day: 10, hour: 9, minute: 0,  ampm: 'PM' },
            timezone: 'America/Los_Angeles'
        });
        expect('same-day end<=start rejected',
               rdSameDayBad.ok === false && (rdSameDayBad.errors || []).some(e => e.includes('same_day')),
               JSON.stringify(rdSameDayBad));

        // Overnight (different-day end < start in wall-clock) IS accepted.
        const rdOvernight = await call('resolve_dates', {
            start:    { year: 2026, month: 6, day: 10, hour: 9, minute: 30, ampm: 'PM' },
            end:      { year: 2026, month: 6, day: 11, hour: 5, minute: 0,  ampm: 'AM' },
            timezone: 'America/Los_Angeles'
        });
        expect('overnight (different day) accepted',
               rdOvernight.ok === true && rdOvernight.et > rdOvernight.st,
               JSON.stringify(rdOvernight).slice(0, 200));

        // Invalid AM/PM rejected.
        const rdBadAmpm = await call('resolve_dates', {
            start:    { year: 2026, month: 6, day: 10, hour: 9, minute: 30, ampm: 'XM' },
            end:      { year: 2026, month: 6, day: 11, hour: 5, minute: 0,  ampm: 'AM' },
            timezone: 'America/Los_Angeles'
        });
        expect('invalid ampm rejected',
               rdBadAmpm.ok === false && (rdBadAmpm.errors || []).some(e => e.includes('ampm')),
               JSON.stringify(rdBadAmpm));

        // Invalid calendar day rejected (Feb 30).
        const rdBadDay = await call('resolve_dates', {
            start:    { year: 2026, month: 2, day: 30, hour: 9, minute: 30, ampm: 'PM' },
            end:      { year: 2026, month: 3, day: 1,  hour: 5, minute: 0,  ampm: 'AM' },
            timezone: 'America/Los_Angeles'
        });
        expect('invalid calendar day rejected',
               rdBadDay.ok === false && (rdBadDay.errors || []).some(e => e.includes('day')),
               JSON.stringify(rdBadDay));

        console.log('\n=== Test 16: share_booking (Phase 5) ===');
        // share_booking rejects supplied st/et by name.
        const sbStForbid = await call('share_booking', { bookingId: 'whatever', mode: 'draft', st: 12345 });
        expect('share_booking rejects st',
               !!sbStForbid.__rpcError &&
               /forbidden input "st"/.test(sbStForbid.__rpcError.message || ''),
               JSON.stringify(sbStForbid));
        const sbEtForbid = await call('share_booking', { bookingId: 'whatever', mode: 'draft', et: 12345 });
        expect('share_booking rejects et',
               !!sbEtForbid.__rpcError &&
               /forbidden input "et"/.test(sbEtForbid.__rpcError.message || ''),
               JSON.stringify(sbEtForbid));

        // Seed a booking that legitimately passes the current leed_ready gate.
        const pSB = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const sbStart = new Date(Date.UTC(2026, 5, 10, 21, 30, 0)); // wall-clock-as-UTC convention
        const sbEnd   = new Date(Date.UTC(2026, 5, 11, 5, 0, 0));
        const sbClient = await pSB.client.create({
            data: {
                name: 'ShareSeed_' + Date.now(),
                email: 'real.contact@share-' + Date.now() + '.example.com',
                phone: '555-555-5555',
                company: 'ShareSeedCo'
            }
        });
        const sbBooking = await pSB.booking.create({
            data: {
                clientId: sbClient.id,
                title: 'Grad Nite',
                description: 'Overnight event at Santa Monica venue. Need a caricature artist for guest entertainment.',
                notes: 'Caricature artist for 4 hour block.',
                location: '123 Ocean Ave, Santa Monica',
                trade: 'caricatures',
                zip: '90405',
                sourceUrl: 'https://example.com/grad-nite-2026',
                startDate: sbStart,
                endDate:   sbEnd,
                startTime: '21:30',
                endTime:   '05:00',
                status:    'leed_ready'
            }
        });
        await pSB.$disconnect();

        // share_booking(mode:"draft") returns payload + humanReadable with computed st/et.
        // No `timezone` arg -- server derives it from Booking.zip ("90405" -> America/Los_Angeles).
        const sbDraft = await call('share_booking', {
            bookingId: sbBooking.id,
            mode:      'draft'
        });
        expect('share_booking(draft) ok',         !sbDraft.__rpcError && sbDraft.mode === 'draft', JSON.stringify(sbDraft).slice(0, 200));
        expect('share_booking(draft) payload built', !!sbDraft.payload && typeof sbDraft.payload === 'object', JSON.stringify(sbDraft.payload));
        expect('share_booking(draft) st computed',  sbDraft.payload?.st === EXPECTED_ST,
               `got ${sbDraft.payload?.st} expected ${EXPECTED_ST}`);
        expect('share_booking(draft) et computed',  sbDraft.payload?.et === EXPECTED_ET,
               `got ${sbDraft.payload?.et} expected ${EXPECTED_ET}`);
        expect('share_booking(draft) humanReadable present',
               !!sbDraft.humanReadable && !!sbDraft.humanReadable.startDisplay && !!sbDraft.humanReadable.endDisplay && sbDraft.humanReadable.timezone === 'America/Los_Angeles',
               JSON.stringify(sbDraft.humanReadable));

        // share_booking refuses non-leed_ready booking with current status in error.
        // Use a SEPARATE booking with NO leedId (so Judge can demote it normally).
        const pSB2 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const sbBrewClient = await pSB2.client.create({
            data: { name: 'BrewSeed_' + Date.now(), company: 'BrewCo' }
        });
        const sbBrewBooking = await pSB2.booking.create({
            data: {
                clientId:  sbBrewClient.id,
                title:     'Brewing Gig',
                trade:     'caricatures',
                zip:       '90405',
                startDate: sbStart,
                endDate:   sbEnd,
                status:    'brewing'
            }
        });
        await pSB2.$disconnect();
        const sbBrew = await call('share_booking', {
            bookingId: sbBrewBooking.id,
            mode:      'draft'
        });
        expect('share_booking refuses non-leed_ready',
               sbBrew.posted === false && sbBrew.error === 'booking_not_leed_ready',
               JSON.stringify(sbBrew));
        expect('share_booking reports current status',
               sbBrew.currentStatus && sbBrew.currentStatus !== 'leed_ready',
               String(sbBrew.currentStatus));
        // share_booking no longer accepts a `timezone` arg from the LLM. The
        // zone is derived server-side from Booking.zip. Calling without the
        // (now-ignored) timezone arg must SUCCEED when zip is valid, and FAIL
        // with missing_location_timezone / unresolved_location_timezone when
        // zip is missing / unmappable (those cases live in Tests 32-34 below).
        const sbNoTz = await call('share_booking', {
            bookingId: sbBooking.id,
            mode:      'draft'
            // no timezone arg -- server derives it from booking.zip ("90405" -> America/Los_Angeles)
        });
        expect('share_booking ignores missing timezone arg when zip resolves',
               !sbNoTz.__rpcError && sbNoTz.mode === 'draft' &&
               sbNoTz.humanReadable && sbNoTz.humanReadable.timezone === 'America/Los_Angeles',
               JSON.stringify(sbNoTz).slice(0, 240));

        const sbDtContact = await call('share_booking', {
            bookingId: sbBooking.id,
            mode: 'draft',
            dtDraft: 'Vendor coordination can also reference logistics@example.com for onsite setup details.'
        });
        expect('share_booking allows extra contact email in dtDraft',
               sbDtContact.mode === 'draft' && sbDtContact.payload?.dt?.includes('logistics@example.com'),
               JSON.stringify(sbDtContact).slice(0, 240));
        const sbTitleContact = await call('share_booking', {
            bookingId: sbBooking.id,
            mode: 'draft',
            titleDraft: 'Email logistics@example.com for Grad Nite'
        });
        expect('share_booking rejects contact email in titleDraft',
               sbTitleContact.posted === false &&
               sbTitleContact.error === 'unsafe_share_draft' &&
               Array.isArray(sbTitleContact.draftErrors) &&
               sbTitleContact.draftErrors.includes('titleDraft:contains_email'),
               JSON.stringify(sbTitleContact).slice(0, 240));

        // share_booking(mode:"post") without leedzSession reports leedz_not_configured
        // (this is the input-validation narrow path; we do NOT actually post to Leedz).
        const sbPostUnconfigured = await call('share_booking', {
            bookingId: sbBooking.id,
            mode:      'post'
        });
        expect('share_booking(post) returns structured response (not unhandled error)',
               !sbPostUnconfigured.__rpcError,
               JSON.stringify(sbPostUnconfigured).slice(0, 200));
        // Either it reports leedz_not_configured OR it attempted a post; in this
        // smoke env the Config has no leedzSession so we expect the former.
        expect('share_booking(post) flags missing leedzSession when unconfigured',
               sbPostUnconfigured.mode === 'post' && sbPostUnconfigured.posted === false,
               JSON.stringify(sbPostUnconfigured));

        // Terminal/acted-on bookings are intentionally scored below brewing.
        // A prior leedId must not keep a booking leed_ready forever.
        const pTerm = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const termClient = await pTerm.client.create({
            data: { name: 'TerminalSeed_' + Date.now(), email: 'terminal@example.com' }
        });
        const termBooking = await pTerm.booking.create({
            data: {
                clientId: termClient.id,
                title: 'Already Posted Event',
                description: 'Need a caricature artist for an already processed marketplace lead.',
                location: '123 Ocean Ave, Santa Monica',
                trade: 'caricatures',
                zip: '90405',
                sourceUrl: 'https://example.com/already-posted-2026',
                startDate: sbStart,
                endDate: sbEnd,
                startTime: '21:30',
                endTime: '05:00',
                status: 'hot',
                leedId: 'SMOKE_ALREADY_POSTED'
            }
        });
        await call('rescore', { scope: termClient.id });
        const termFresh = await pTerm.booking.findUnique({ where: { id: termBooking.id } });
        await pTerm.$disconnect();
        expect('rescore returns leedId-bearing booking to cold',
               termFresh.status === 'cold',
               JSON.stringify({ status: termFresh.status }));

        console.log('\n=== Test 17: skills/docs do not instruct direct leedz__createLeed for normal sharing ===');
        // Scan active share/headless docs for POSITIVE invocations of
        // leedz__createLeed. Negative/legacy mentions are allowed.
        function scanForPositiveCreateLeed(filePath) {
            if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
            const body = fs.readFileSync(filePath, 'utf8');
            const lines = body.split(/\r?\n/);
            const offenders = [];
            for (const line of lines) {
                if (!line.includes('leedz__createLeed')) continue;
                const low = line.toLowerCase();
                // Allow negative / legacy references.
                if (low.includes('legacy') ||
                    low.includes('never call') ||
                    low.includes('never call `leedz') ||
                    low.includes('no longer') ||
                    low.includes('do not call') ||
                    low.includes('do NOT call'.toLowerCase()) ||
                    low.includes('forbidden') ||
                    low.includes('bypass') ||
                    low.includes('direct `leedz__createleed` from worker prose is forbidden')) {
                    continue;
                }
                offenders.push(line.trim());
            }
            return { ok: offenders.length === 0, offenders };
        }
        const docScans = [
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'share-skill.md'),
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'headless_flow.md'),
            path.join(PRECRIME_ROOT, 'templates', 'GOOSE.md'),
            path.join(PRECRIME_ROOT, 'DOCS',      'FOUNDATION.md')
        ];
        for (const docPath of docScans) {
            const r = scanForPositiveCreateLeed(docPath);
            expect(`${path.basename(docPath)} no positive leedz__createLeed usage`,
                   r.ok,
                   r.offenders ? r.offenders.join(' | ') : r.reason);
            // Each must reference share_booking instead.
            const body = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
            expect(`${path.basename(docPath)} references share_booking`,
                   body.includes('share_booking'),
                   'no share_booking reference');
        }

        const toolSurfaceFiles = [
            path.join(PRECRIME_ROOT, '.mcp.json'),
            path.join(PRECRIME_ROOT, 'templates', 'mcp.json'),
            path.join(PRECRIME_ROOT, 'templates', 'goose_config.template.yaml')
        ];
        for (const surfacePath of toolSurfaceFiles) {
            const body = fs.existsSync(surfacePath) ? fs.readFileSync(surfacePath, 'utf8') : '';
            expect(`${path.basename(surfacePath)} does not expose leedz proxy`,
                   !/\bleedz_proxy_mcp\.py\b/.test(body) && !/^\s*leedz:\s*$/m.test(body) && !/"leedz"\s*:/.test(body),
                   'agent-facing Leedz proxy is still configured');
        }

        const retiredLeedDrafter = path.join(PRECRIME_ROOT, 'templates', 'skills', 'leed-drafter.md');
        expect('leed-drafter.md retired from active skills',
               !fs.existsSync(retiredLeedDrafter),
               retiredLeedDrafter);

        // Each edited skill/doc must have a .legacy.md backup (user's hard rule).
        const LEGACY_BACKUPS = [
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'share-skill.legacy.md'),
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'headless_flow.legacy.md'),
            path.join(PRECRIME_ROOT, 'templates', 'GOOSE.legacy.md'),
            path.join(PRECRIME_ROOT, 'DOCS',      'FOUNDATION.legacy.md')
        ];
        for (const b of LEGACY_BACKUPS) {
            // Accept any of these locations (user moves legacy md files around
            // to keep dirs clean):
            //   - sibling X.legacy.md
            //   - <dir>/_archive/X.legacy.md
            //   - <dir>/TMP/_archive__X.legacy.md  (flat-prefixed archive)
            const archive = path.join(path.dirname(b), '_archive', path.basename(b));
            const tmpFlat = path.join(path.dirname(b), 'TMP', '_archive__' + path.basename(b));
            expect(`${path.basename(b)} backup exists (sibling, _archive/, or TMP/_archive__)`,
                   fs.existsSync(b) || fs.existsSync(archive) || fs.existsSync(tmpFlat),
                   `${b} | ${archive} | ${tmpFlat}`);
        }

        console.log('\n=== Test 18: Phase 6 -- interactive bootstrap offers only SHOW_HOT_LEEDZ and RUN_WORKFLOW ===');
        const initWizardPath = path.join(PRECRIME_ROOT, 'templates', 'skills', 'init-wizard.md');
        const initBody = fs.existsSync(initWizardPath) ? fs.readFileSync(initWizardPath, 'utf8') : '';
        expect('init-wizard.md present',                fs.existsSync(initWizardPath), initWizardPath);
        expect('init-wizard.md offers SHOW_HOT_LEEDZ',  initBody.includes('SHOW_HOT_LEEDZ'), 'missing SHOW_HOT_LEEDZ');
        expect('init-wizard.md offers RUN_WORKFLOW',    initBody.includes('RUN_WORKFLOW'),   'missing RUN_WORKFLOW');
        // Old sprawling sub-mode menu must be gone (or only referenced negatively).
        // The legacy menu literally listed "Marketplace", "Outreach", "Hybrid" as
        // (1)/(2)/(3) options. The new menu has only (1) SHOW_HOT_LEEDZ + (2) RUN_WORKFLOW.
        const hasLegacyMenu = /\(1\)\s*Marketplace/i.test(initBody) ||
                              /\(2\)\s*Outreach/i.test(initBody)    ||
                              /\(3\)\s*Hybrid/i.test(initBody);
        expect('init-wizard.md no longer presents Marketplace/Outreach/Hybrid menu',
               !hasLegacyMenu,
               'legacy sub-mode menu still present');
        // init-wizard must route the SHOW_HOT_LEEDZ choice through plan_tasks(mode:"hot_only").
        expect('init-wizard.md routes SHOW_HOT_LEEDZ via plan_tasks hot_only',
               initBody.includes('"hot_only"') || initBody.includes("'hot_only'"),
               'no hot_only routing');
        expect('init-wizard.md routes RUN_WORKFLOW via plan_tasks workflow',
               initBody.includes('"workflow"') || initBody.includes("'workflow'"),
               'no workflow routing');
        // init-wizard must have a .legacy.md backup (user's hard rule).
        // Accept sibling, _archive/, or TMP/_archive__ location.
        const initLegacy        = path.join(PRECRIME_ROOT, 'templates', 'skills', 'init-wizard.legacy.md');
        const initLegacyArchive = path.join(PRECRIME_ROOT, 'templates', 'skills', '_archive', 'init-wizard.legacy.md');
        const initLegacyTmp     = path.join(PRECRIME_ROOT, 'templates', 'skills', 'TMP', '_archive__init-wizard.legacy.md');
        expect('init-wizard.legacy.md backup exists (sibling, _archive/, or TMP/_archive__)',
               fs.existsSync(initLegacy) || fs.existsSync(initLegacyArchive) || fs.existsSync(initLegacyTmp),
               `${initLegacy} | ${initLegacyArchive} | ${initLegacyTmp}`);

        console.log('\n=== Test 19: Phase 6 -- show-hot-leedz worker exists and is presenter-only ===');
        const showHotPath = path.join(PRECRIME_ROOT, 'templates', 'skills', 'show-hot-leedz.md');
        expect('show-hot-leedz.md present', fs.existsSync(showHotPath), showHotPath);
        const shBody = fs.existsSync(showHotPath) ? fs.readFileSync(showHotPath, 'utf8') : '';
        expect('show-hot-leedz does NOT call claim_task',
               !/action:\s*["']claim_task["']/.test(shBody),
               'presenter must consume claimed Task packet, not self-claim');
        expect('show-hot-leedz accepts already-claimed Task',
               /already-claimed|already claimed/i.test(shBody),
               'missing already-claimed Task contract');
        expect('show-hot-leedz uses complete_task', shBody.includes('complete_task'), 'missing complete_task');
        expect('show-hot-leedz uses share_booking', shBody.includes('share_booking'), 'missing share_booking');

        // Forbidden phrases as POSITIVE invocations only. Negative prose
        // ("Do not call X", "Do NOT call X") is allowed.
        function scanForbiddenPositive(body, phrase) {
            const lines = body.split(/\r?\n/);
            const offenders = [];
            for (const line of lines) {
                if (!line.includes(phrase)) continue;
                const low = line.toLowerCase();
                if (low.includes('do not call') ||
                    low.includes('do not')      ||
                    low.includes('never call')  ||
                    low.includes('never')       ||
                    low.includes('forbidden')   ||
                    low.includes('no longer')   ||
                    low.includes('legacy')      ||
                    low.includes('not call')    ||
                    low.includes('owned by judge')) {
                    continue;
                }
                offenders.push(line.trim());
            }
            return offenders;
        }
        const PRESENTER_FORBIDDEN = [
            'pipeline.save',
            'judge_affected',
            'resolve_dates',
            'tavily_extract',
            'leedz__createLeed',
            'scrape',
            'enrich',
            'rescore'
        ];
        for (const phrase of PRESENTER_FORBIDDEN) {
            const off = scanForbiddenPositive(shBody, phrase);
            expect(`show-hot-leedz does not positively invoke "${phrase}"`,
                   off.length === 0,
                   off.join(' | '));
        }

        console.log('\n=== Test 20: Phase 6 -- plan_tasks(hot_only) creates only SHOW_HOT_LEEDZ ===');
        // Drain any pre-existing planner state we created upstream so this
        // section is deterministic.
        const pH = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pH.task.deleteMany({ where: { status: 'ready' } });
        // Seed one hot booking so hot_only has something to schedule against.
        const hotClient = await pH.client.create({
            data: { name: 'HotSeed_' + Date.now(), company: 'HotCo' }
        });
        const hotBkLR = await pH.booking.create({
            data: {
                clientId: hotClient.id,
                title:    'Hot booking 1',
                trade:    'caricatures',
                zip:      '90405',
                startDate: new Date(Date.now() + 30*24*3600*1000),
                endDate:   new Date(Date.now() + 30*24*3600*1000 + 3600000),
                status:   'leed_ready'
            }
        });
        const hotBkLR2 = await pH.booking.create({
            data: {
                clientId: hotClient.id,
                title:    'Hot booking 2',
                trade:    'caricatures',
                zip:      '90405',
                startDate: new Date(Date.now() + 31*24*3600*1000),
                endDate:   new Date(Date.now() + 31*24*3600*1000 + 3600000),
                status:   'leed_ready'
            }
        });
        await pH.$disconnect();

        const planHot = await call('plan_tasks', { mode: 'hot_only' });
        expect('plan_tasks(hot_only) ok', !planHot.__rpcError, JSON.stringify(planHot.__rpcError || {}));
        const hotCreatedTypes = new Set((planHot.created || []).map(c => c.type));
        expect('hot_only creates SHOW_HOT_LEEDZ',
               hotCreatedTypes.has('SHOW_HOT_LEEDZ'),
               JSON.stringify(Array.from(hotCreatedTypes)));
        // hot_only must NOT create scrape/enrich/judge tasks.
        for (const banned of ['DISCOVER_SOURCES', 'SCRAPE_SOURCE', 'ENRICH_CLIENT', 'APPLY_FACTLET', 'JUDGE_AFFECTED', 'SHARE_BOOKING']) {
            expect(`hot_only does NOT create ${banned}`,
                   !hotCreatedTypes.has(banned),
                   JSON.stringify(Array.from(hotCreatedTypes)));
        }
        expect('hot_only reports hotBookingCount >= 2',
               (planHot.hotBookingCount || 0) >= 2,
               String(planHot.hotBookingCount));

        console.log('\n=== Test 21: Phase 6 -- plan_tasks(hot_only) with no hot bookings creates nothing ===');
        const pH2 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        // Hide every hot booking by flipping status, then ensure hot_only no-ops.
        await pH2.booking.updateMany({
            where:  { status: { in: ['leed_ready', 'outreach_ready'] } },
            data:   { status: 'brewing' }
        });
        await pH2.task.deleteMany({ where: { type: 'SHOW_HOT_LEEDZ', status: 'ready' } });
        await pH2.$disconnect();
        const planHot0 = await call('plan_tasks', { mode: 'hot_only' });
        expect('plan_tasks(hot_only) ok (no hot)', !planHot0.__rpcError, JSON.stringify(planHot0.__rpcError || {}));
        const hot0Types = new Set((planHot0.created || []).map(c => c.type));
        expect('hot_only with no hot bookings creates NO SHOW_HOT_LEEDZ',
               !hot0Types.has('SHOW_HOT_LEEDZ'),
               JSON.stringify(Array.from(hot0Types)));
        expect('hot_only reports hotBookingCount === 0',
               (planHot0.hotBookingCount || 0) === 0,
               String(planHot0.hotBookingCount));

        console.log('\n=== Test 22: plan_tasks(headless) hot interrupt -- SHARE_BOOKING fires, ENRICH/SCRAPE/DISCOVER are suppressed ===');
        // Spec (DOCS/WHAT_I_LEARNED.md, Stage 3): a hot future unshared
        // Booking interrupts the workflow. Headless+marketplace must create
        // SHARE_BOOKING for that Booking AND must NOT create ENRICH_CLIENT,
        // SCRAPE_SOURCE, or DISCOVER_SOURCES in the same pass. (Replaces the
        // pre-control-loop "cold headless" rule that ran discovery first.)
        const pH3 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        // Drain prior ready tasks AND close any active session so per-session
        // dedup from earlier hot_only test does not block the SHARE_BOOKING.
        await pH3.task.deleteMany({ where: { status: { in: ['ready', 'claimed'] } } });
        await pH3.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        // Two unshared leed_ready future Bookings -- hot interrupt material.
        await pH3.booking.update({ where: { id: hotBkLR.id  }, data: { status: 'leed_ready', shared: false } });
        await pH3.booking.update({ where: { id: hotBkLR2.id }, data: { status: 'leed_ready', shared: false } });
        await pH3.$disconnect();

        // Strict-gating prerequisite: clear any leftover JUDGE_AFFECTED ready/
        // claimed Tasks from earlier tests (Stage 2 fires before Stage 3 and
        // would block hot interrupt under the strict-funnel rule).
        const pH3b = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pH3b.task.updateMany({
            where: { type: 'JUDGE_AFFECTED', status: { in: ['ready', 'claimed'] } },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        await pH3b.task.updateMany({
            where: { status: 'done', type: { in: ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE'] } },
            data:  { output: JSON.stringify({ judgedAt: new Date().toISOString() }) }
        });
        await pH3b.$disconnect();

        const planHL = await call('plan_tasks', { mode: 'headless' });
        expect('plan_tasks(headless) ok', !planHL.__rpcError, JSON.stringify(planHL.__rpcError || {}));
        const createdSeqHL = (planHL.created || []).map(c => c.type);
        const createdTypesHL = new Set(createdSeqHL);
        expect('headless hot interrupt schedules at least one SHARE_BOOKING',
               createdTypesHL.has('SHARE_BOOKING'),
               JSON.stringify(createdSeqHL));
        // Strict stage-gating: hot interrupt must suppress EVERY lower stage,
        // not just enrich/scrape/discover. APPLY_FACTLET must also be banned.
        for (const banned of ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE', 'DISCOVER_SOURCES']) {
            expect(`hot interrupt strictly suppresses ${banned}`,
                   !createdTypesHL.has(banned),
                   JSON.stringify(createdSeqHL));
        }
        // First created Task should be the hot action (SHARE_BOOKING), not a
        // worker -- ordering matters for the budgets readout.
        const firstHotAction = createdSeqHL.findIndex(t =>
            t === 'SHARE_BOOKING' || t === 'DRAFT_OUTREACH' || t === 'SHOW_HOT_LEEDZ');
        const firstWorker = createdSeqHL.findIndex(t =>
            t === 'ENRICH_CLIENT' || t === 'SCRAPE_SOURCE' || t === 'DISCOVER_SOURCES' || t === 'APPLY_FACTLET');
        expect('hot action appears before any worker in created order',
               firstHotAction >= 0 && (firstWorker === -1 || firstHotAction < firstWorker),
               `firstHotAction=${firstHotAction} firstWorker=${firstWorker} seq=${JSON.stringify(createdSeqHL)}`);

        console.log('\n=== Test 23: Phase 7 -- loadPrecrimeConfig returns all required runtime keys ===');
        const loaderPath = path.join(PRECRIME_ROOT, 'server', 'config', 'precrime_config.js');
        const { loadPrecrimeConfig, FORBIDDEN_KEYS } = require(loaderPath);
        const live = loadPrecrimeConfig({ refresh: true });
        const required = [
            'deploymentName', 'databaseFile', 'defaultMode',
            'apiKeys', 'llm', 'tasks', 'recycler', 'paths'
        ];
        // timezone is no longer a user-config field. share_booking derives the
        // IANA zone from Booking.zip at leed creation time.
        expect('live config has NO `timezone` field (zip-derived now)',
               live.timezone === undefined, String(live.timezone));
        for (const k of required) {
            expect(`live config has key: ${k}`, live[k] !== undefined, String(live[k]));
        }
        expect('live config llm.provider set',
               !!(live.llm && live.llm.provider),
               JSON.stringify(live.llm));
        expect('live config has tasks.limits.SCRAPE_SOURCE',
               Number.isFinite(live.tasks && live.tasks.limits && live.tasks.limits.SCRAPE_SOURCE),
               String(live.tasks && live.tasks.limits && live.tasks.limits.SCRAPE_SOURCE));
        expect('live config has apiKeys block (object)',
               live.apiKeys && typeof live.apiKeys === 'object',
               typeof live.apiKeys);
        // Forbidden VALUE_PROP fields must not appear at any nesting.
        for (const fk of ['companyName','companyEmail','businessDescription','defaultTrade','leedzEmail']) {
            expect(`live config has NO forbidden VALUE_PROP key: ${fk}`,
                   live[fk] === undefined,
                   `unexpected value: ${JSON.stringify(live[fk])}`);
        }

        console.log('\n=== Test 24: Phase 7 -- missing precrime_config.json yields defaults + fallbacks ===');
        const ghostPath = path.join(TMP_DIR, 'no_such_precrime_config.json');
        const ghost = loadPrecrimeConfig({ refresh: true, path: ghostPath });
        expect('missing config returns object (no throw)', !!ghost, 'expected object');
        expect('fallbacks array populated when file missing',
               Array.isArray(ghost.fallbacks) && ghost.fallbacks.some(f => /not found/i.test(f)),
               JSON.stringify(ghost.fallbacks));
        expect('defaults applied: tasks.limits.SCRAPE_SOURCE === 5',
               ghost.tasks.limits.SCRAPE_SOURCE === 5,
               String(ghost.tasks.limits.SCRAPE_SOURCE));
        expect('defaults applied: recycler.taskRetentionDays === 30',
               ghost.recycler.taskRetentionDays === 30,
               String(ghost.recycler.taskRetentionDays));
        expect('defaults applied: recycler.claimTimeoutMinutes === 10',
               ghost.recycler.claimTimeoutMinutes === 10,
               String(ghost.recycler.claimTimeoutMinutes));

        console.log('\n=== Test 25: Phase 7 -- precrime_config.json overrides runtime knobs ===');
        const overridePath = path.join(TMP_DIR, 'precrime_config.override.json');
        fs.writeFileSync(overridePath, JSON.stringify({
            deploymentName: 'SMOKE_OVERRIDE',
            tasks: { limits: { SCRAPE_SOURCE: 42, ENRICH_CLIENT: 17 } },
            recycler: { taskRetentionDays: 99, claimTimeoutMinutes: 7 }
        }, null, 2));
        const overridden = loadPrecrimeConfig({ refresh: true, path: overridePath });
        expect('override tasks.limits.SCRAPE_SOURCE === 42',
               overridden.tasks.limits.SCRAPE_SOURCE === 42,
               String(overridden.tasks.limits.SCRAPE_SOURCE));
        expect('override tasks.limits.ENRICH_CLIENT === 17',
               overridden.tasks.limits.ENRICH_CLIENT === 17,
               String(overridden.tasks.limits.ENRICH_CLIENT));
        expect('untouched task-limit defaults preserved: SHARE_BOOKING === 3',
               overridden.tasks.limits.SHARE_BOOKING === 3,
               String(overridden.tasks.limits.SHARE_BOOKING));
        expect('override recycler.taskRetentionDays === 99',
               overridden.recycler.taskRetentionDays === 99,
               String(overridden.recycler.taskRetentionDays));
        expect('override recycler.claimTimeoutMinutes === 7',
               overridden.recycler.claimTimeoutMinutes === 7,
               String(overridden.recycler.claimTimeoutMinutes));
        expect('override deploymentName === SMOKE_OVERRIDE',
               overridden.deploymentName === 'SMOKE_OVERRIDE',
               String(overridden.deploymentName));

        console.log('\n=== Test 26: live precrime_config.json contains NO VALUE_PROP fields ===');
        const livePath = path.join(PRECRIME_ROOT, 'precrime_config.json');
        const liveRaw = JSON.parse(fs.readFileSync(livePath, 'utf8'));
        for (const fk of FORBIDDEN_KEYS) {
            expect(`live precrime_config.json key "${fk}" absent`,
                   !Object.prototype.hasOwnProperty.call(liveRaw, fk),
                   `forbidden key present: ${fk}`);
        }
        // Same for sample file.
        const samplePath = path.join(PRECRIME_ROOT, 'precrime_config.sample.json');
        const sampleRaw = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
        for (const fk of FORBIDDEN_KEYS) {
            expect(`sample precrime_config.sample.json key "${fk}" absent`,
                   !Object.prototype.hasOwnProperty.call(sampleRaw, fk),
                   `forbidden key present: ${fk}`);
        }

        // Helper: strip line comments (// ...) and block comments (/* ... */) before scanning.
        function stripComments(src) {
            return src
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '')
                .replace(/(^|[^:])\/\/[^\n]*$/gm, '$1');
        }
        // Helper: assert source has no operational .env access (require('dotenv'),
        // fs read of an .env path, or string literals like '.env' / '.env.sample').
        function assertNoDotenv(label, src) {
            const code = stripComments(src).replace(/\bprocess\.env\b/g, '');
            expect(`${label} does not require dotenv`,
                   !/require\s*\(\s*['"]dotenv['"]\s*\)/.test(code),
                   'dotenv require found');
            expect(`${label} does not reference .env file path`,
                   !/['"][^'"]*\.env(?:\.[a-z]+)?['"]/i.test(code),
                   '.env literal found');
            expect(`${label} does not read .env via fs`,
                   !/fs\.[a-zA-Z]+\([^)]*\.env/i.test(code),
                   'fs .env read found');
        }

        console.log('\n=== Test 27: Loader contains zero .env / dotenv references ===');
        assertNoDotenv('loader', fs.readFileSync(loaderPath, 'utf8'));

        console.log('\n=== Test 28: bootstrap_config.js contains zero .env / dotenv references ===');
        const bsPath = path.join(PRECRIME_ROOT, 'scripts', 'bootstrap_config.js');
        assertNoDotenv('bootstrap_config.js', fs.readFileSync(bsPath, 'utf8'));

        console.log('\n=== Test 28b: mcp_server.js application-config path has no .env operational read ===');
        const mcpSrc = fs.readFileSync(path.join(PRECRIME_ROOT, 'server', 'mcp', 'mcp_server.js'), 'utf8');
        const mcpCode = stripComments(mcpSrc).replace(/\bprocess\.env\b/g, '');
        expect('mcp_server.js does not require dotenv',
               !/require\s*\(\s*['"]dotenv['"]\s*\)/.test(mcpCode),
               'dotenv require found in mcp_server.js');
        expect('mcp_server.js does not read .env via fs',
               !/fs\.[a-zA-Z]+\([^)]*\.env/i.test(mcpCode),
               'fs .env read found in mcp_server.js');

        console.log('\n=== Test 29: VALUE_PROP-field injection into precrime_config.json is stripped + flagged ===');
        const taintPath = path.join(TMP_DIR, 'precrime_config.tainted.json');
        fs.writeFileSync(taintPath, JSON.stringify({
            deploymentName: 'TAINTED',
            companyName:    'should not be here',
            companyEmail:   'oops@example.com',
            defaultTrade:   'caricaturist'
        }, null, 2));
        const tainted = loadPrecrimeConfig({ refresh: true, path: taintPath });
        expect('tainted load strips companyName',  tainted.companyName  === undefined, String(tainted.companyName));
        expect('tainted load strips companyEmail', tainted.companyEmail === undefined, String(tainted.companyEmail));
        expect('tainted load strips defaultTrade', tainted.defaultTrade === undefined, String(tainted.defaultTrade));
        expect('tainted load surfaces fallback note about forbidden field',
               (tainted.fallbacks || []).some(f => /forbidden VALUE_PROP field/i.test(f)),
               JSON.stringify(tainted.fallbacks));

        console.log('\n=== Test 30: sync-config.js sources VALUE_PROP.md and does not read precrime_config.json ===');
        const syncPath = path.join(PRECRIME_ROOT, 'server', 'sync-config.js');
        const syncSrc = fs.readFileSync(syncPath, 'utf8');
        expect('sync-config.js reads VALUE_PROP.md',
               /VALUE_PROP\.md/.test(syncSrc),
               'no VALUE_PROP.md reference');
        expect('sync-config.js does NOT require precrime_config loader',
               !/loadPrecrimeConfig/.test(syncSrc),
               'sync-config.js still loads precrime_config.json');
        expect('sync-config.js parses explicit VALUE_PROP Trade line',
               /explicitTrade/.test(syncSrc) && /Trade:/.test(syncSrc),
               'sync-config.js does not parse **Trade:** directly');
        expect('sync-config.js does NOT infer trade from full VALUE_PROP body',
               !/textLower\s*=\s*text\.toLowerCase/.test(syncSrc),
               'sync-config.js can still choose unrelated trades from body text');
        expect('sync-config.js accepts legacy nested Signature heading',
               /#\{2,6\}\\s\+signature\\b/.test(syncSrc) && /\/im/.test(syncSrc),
               'sync-config.js does not accept ### Signature');

        console.log('\n=== Test 31: precrime_config.json + sample have no `timezone` key ===');
        expect('live precrime_config.json has no timezone',
               !Object.prototype.hasOwnProperty.call(liveRaw, 'timezone'),
               'unexpected timezone key in live config');
        expect('sample precrime_config.sample.json has no timezone',
               !Object.prototype.hasOwnProperty.call(sampleRaw, 'timezone'),
               'unexpected timezone key in sample config');
        const bsSrc = fs.readFileSync(bsPath, 'utf8');
        expect('bootstrap_config.js does NOT emit PRECRIME_TIMEZONE',
               !/PRECRIME_TIMEZONE/.test(stripComments(bsSrc)),
               'PRECRIME_TIMEZONE still emitted');

        // Tests 32 and 33 (zip-missing / unmappable-zip refusals from share_booking)
        // removed at user request 2026-05-27. Their leedId-based fixtures collided
        // with the new actedOn semantics in computeBookingTargetScore. share_booking
        // is being rewritten in another process; reinstate appropriate coverage there.

        console.log('\n=== Test 34: share_booking derives timezone from zip (90405 -> America/Los_Angeles) ===');
        // Reuse the seeded ShareSeed booking from Test 16 (zip=90405, leedId set).
        // Call share_booking WITHOUT passing timezone -- server must derive.
        const sbZipDerived = await call('share_booking', { bookingId: sbBooking.id, mode: 'draft' });
        expect('share_booking(no tz arg) succeeds when zip is valid',
               !sbZipDerived.__rpcError && sbZipDerived.mode === 'draft',
               JSON.stringify(sbZipDerived).slice(0, 200));
        expect('share_booking zip-derived timezone === America/Los_Angeles',
               sbZipDerived.humanReadable && sbZipDerived.humanReadable.timezone === 'America/Los_Angeles',
               JSON.stringify(sbZipDerived.humanReadable));

        console.log('\n=== Test 35: get_config (allowed / unknown / secret) ===');
        const gcSig = await call('get_config', { key: 'signature' });
        expect('get_config(signature) returns key=signature shape',
               gcSig.key === 'signature' && Object.prototype.hasOwnProperty.call(gcSig, 'value') && Object.prototype.hasOwnProperty.call(gcSig, 'present'),
               JSON.stringify(gcSig));
        const gcCompany = await call('get_config', { key: 'companyName' });
        expect('get_config(companyName) returns object',
               !gcCompany.__rpcError && gcCompany.key === 'companyName',
               JSON.stringify(gcCompany));
        const gcSecret = await call('get_config', { key: 'llmApiKey' });
        expect('get_config(llmApiKey) rejected (never returns secrets)',
               !!gcSecret.__rpcError && /forbidden|unknown/i.test(gcSecret.__rpcError.message || ''),
               JSON.stringify(gcSecret));
        const gcSession = await call('get_config', { key: 'leedzSession' });
        expect('get_config(leedzSession) rejected (never returns secrets)',
               !!gcSession.__rpcError && /forbidden|unknown/i.test(gcSession.__rpcError.message || ''),
               JSON.stringify(gcSession));
        const gcUnknown = await call('get_config', { key: 'nonexistent_field' });
        expect('get_config(unknown key) rejected with clear error',
               !!gcUnknown.__rpcError && /unknown|forbidden/i.test(gcUnknown.__rpcError.message || ''),
               JSON.stringify(gcUnknown));
        const gcEmpty = await call('get_config', {});
        expect('get_config({}) rejected',
               !!gcEmpty.__rpcError,
               JSON.stringify(gcEmpty));

        console.log('\n=== Test 36: plan_tasks creates Tasks with sessionId; complete_task writes task_completed event ===');
        const planSess = await call('plan_tasks', { mode: 'workflow' });
        expect('plan_tasks returns session_id',
               typeof planSess.session_id === 'string' && planSess.session_id.length > 0,
               JSON.stringify(planSess).slice(0, 200));
        const planSessId = planSess.session_id;
        const pSC = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const sessionTasks = await pSC.task.findMany({ where: { sessionId: planSessId } });
        expect('plan_tasks stamps sessionId on created Tasks',
               sessionTasks.length > 0 && sessionTasks.every(t => t.sessionId === planSessId),
               `count=${sessionTasks.length}`);
        await pSC.$disconnect();
        // Claim and complete one task; verify a task_completed SessionEvent appears.
        const claimSess = await call('claim_task', { role: 'smoke-session' });
        let sessTaskId = null;
        if (claimSess.status === 'CLAIMED') {
            sessTaskId = claimSess.task.id;
            const completeSess = await call('complete_task', {
                taskId: sessTaskId,
                status: 'done',
                output: { summary: 'smoke session test', needsJudge: false }
            });
            expect('complete_task returns session_id in payload',
                   typeof completeSess.session_id === 'string',
                   JSON.stringify(completeSess).slice(0, 200));
            const pEv = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
            const taskEvents = await pEv.sessionEvent.findMany({
                where: { sessionId: completeSess.session_id, action: 'task_completed' }
            });
            await pEv.$disconnect();
            expect('complete_task writes task_completed SessionEvent',
                   taskEvents.some(ev => {
                       try { return JSON.parse(ev.payload).taskId === sessTaskId; } catch { return false; }
                   }),
                   `${taskEvents.length} task_completed events found`);
        } else {
            console.log('  (no ready task to claim/complete -- skipping audit-event sub-assertion)');
        }

        console.log('\n=== Test 37: audit_session / report_session include Task history ===');
        const audit = await call('audit_session', { session_id: planSessId });
        expect('audit_session returns task_total field',
               Number.isInteger(audit.task_total),
               `task_total=${audit.task_total}`);
        expect('audit_session returns task_counts_by_type object',
               audit.task_counts_by_type && typeof audit.task_counts_by_type === 'object',
               JSON.stringify(audit.task_counts_by_type));
        expect('audit_session returns task_history array',
               Array.isArray(audit.task_history),
               typeof audit.task_history);
        expect('audit_session task_history references plan_tasks-created Tasks',
               audit.task_history.length > 0,
               `len=${audit.task_history.length}`);

        console.log('\n=== Test 38: ClientFactlet is fully removed from schema, client, and packaged DB ===');
        // Hard guards: the model, the prisma client accessor, the SQL table,
        // and the migration helper must all be gone. No compatibility shims.
        const schemaPath = path.join(PRECRIME_ROOT, 'server', 'prisma', 'schema.prisma');
        const schemaSrc  = fs.readFileSync(schemaPath, 'utf8');
        expect('schema.prisma defines no `model ClientFactlet`',
               !/\bmodel\s+ClientFactlet\b/.test(schemaSrc),
               'ClientFactlet model still in schema');
        expect('schema.prisma defines no `ClientFactlet[]` relation',
               !/ClientFactlet\[\]/.test(schemaSrc),
               'ClientFactlet[] relation still in schema');
        expect('schema.prisma has no Config.clientFactletMigratedAt column',
               !/clientFactletMigratedAt/.test(schemaSrc),
               'migration marker column still in schema');

        const mcpSrcAll = fs.readFileSync(path.join(PRECRIME_ROOT, 'server', 'mcp', 'mcp_server.js'), 'utf8');
        expect('mcp_server.js does not call prisma.clientFactlet.*',
               !/prisma\.clientFactlet\.|tx\.clientFactlet\./.test(mcpSrcAll),
               'mcp_server.js still calls prisma.clientFactlet.*');
        expect('mcp_server.js does not define migrateClientFactletsToDossier',
               !/migrateClientFactletsToDossier\s*\(/.test(mcpSrcAll),
               'migration helper still present');

        // Prisma client must NOT expose `clientFactlet` accessor at all.
        const pNoCF = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        expect('PrismaClient does not expose `clientFactlet` accessor',
               typeof pNoCF.clientFactlet === 'undefined',
               `unexpected accessor: ${typeof pNoCF.clientFactlet}`);

        // SQL: ClientFactlet table must not exist in the smoke DB.
        let smokeHasTable;
        try {
            const rows = await pNoCF.$queryRawUnsafe(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='ClientFactlet'"
            );
            smokeHasTable = Array.isArray(rows) && rows.length > 0;
        } catch (_) { smokeHasTable = true; }
        expect('smoke DB has no ClientFactlet table',
               smokeHasTable === false,
               'ClientFactlet table present in smoke DB');
        await pNoCF.$disconnect();

        // And the shipped blank.sqlite must not have the table either.
        const blankPath = path.join(PRECRIME_ROOT, 'data', 'blank.sqlite');
        if (fs.existsSync(blankPath)) {
            const pBlank = new PC2({ datasources: { db: { url: 'file:' + blankPath } } });
            let blankHasTable;
            try {
                const rows = await pBlank.$queryRawUnsafe(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='ClientFactlet'"
                );
                blankHasTable = Array.isArray(rows) && rows.length > 0;
            } catch (_) { blankHasTable = true; }
            expect('data/blank.sqlite has no ClientFactlet table',
                   blankHasTable === false,
                   'ClientFactlet table present in blank.sqlite');
            await pBlank.$disconnect();
        }

        // The save handler still creates Factlet rows when factlets[] is passed.
        const cfTag = 'FactletStandalone_' + Date.now();
        const seedCF = await call('save', {
            patch: {
                name:    'FACTLET_TEST_' + Date.now(),
                email:   'factlet.test.' + Date.now() + '@example.com',
                company: 'FactletTestCo',
                factlets: [
                    { content: cfTag + ' standalone factlet, no join table.', source: 'smoke-direct' }
                ]
            }
        });
        expect('save with factlets[] ok',
               seedCF.saved === true && !!seedCF.clientId,
               JSON.stringify(seedCF).slice(0, 200));
        const pCheck = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const factCount = await pCheck.factlet.count({ where: { content: { contains: cfTag } } });
        await pCheck.$disconnect();
        expect('save still creates a standalone Factlet row',
               factCount >= 1,
               `factlet count=${factCount}`);

        console.log('\n=== Test 39: drafting skills call get_config for signature (static scan) ===');
        const draftPath = path.join(PRECRIME_ROOT, 'templates', 'skills', 'outreach-drafter.md');
        const draftBody = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8') : '';
        expect('outreach-drafter.md present',          fs.existsSync(draftPath), draftPath);
        expect('outreach-drafter.md calls get_config',
               /pipeline.*get_config.*signature|action:\s*['"]get_config['"]/.test(draftBody),
               'no get_config(signature) reference');
        expect('outreach-drafter.md instructs verbatim signature use',
               /verbatim/i.test(draftBody),
               'no "verbatim" instruction');

        console.log('\n=== Test 39b: url-loop.md has channel:"rss" branch wired to precrime_rss__get_top_articles ===');
        const urlLoopPath = path.join(PRECRIME_ROOT, 'templates', 'skills', 'url-loop.md');
        const urlLoopBody = fs.existsSync(urlLoopPath) ? fs.readFileSync(urlLoopPath, 'utf8') : '';
        expect('url-loop.md exists', fs.existsSync(urlLoopPath), urlLoopPath);
        expect('url-loop.md has explicit channel === "rss" branch',
               /channel\s*===\s*["']rss["']|channel:\s*["']rss["']/.test(urlLoopBody),
               'no channel:"rss" branch found');
        expect('url-loop.md rss branch calls precrime_rss__get_top_articles with feedUrl',
               /precrime_rss__get_top_articles[\s\S]{0,200}feedUrl/.test(urlLoopBody),
               'no precrime_rss__get_top_articles({ feedUrl: ... }) call');

        // Split into 2.a (rss) and 2.b (default web) and assert the rss section
        // does NOT call tavily_extract.
        const rssSectionMatch = urlLoopBody.match(/### Step 2\.a[\s\S]*?(?=### Step 2\.b|\n---)/);
        const rssSection = rssSectionMatch ? rssSectionMatch[0] : '';
        expect('url-loop.md Step 2.a (rss branch) exists',     !!rssSection, 'no Step 2.a section');
        const rssSectionStripped = rssSection
            .replace(/Do NOT call[^\n]*tavily_extract[^\n]*/gi, '')
            .replace(/Do NOT also call[^\n]*tavily_extract[^\n]*/gi, '')
            .replace(/not[\s\S]{0,40}tavily_extract/gi, '');
        expect('url-loop.md rss branch does NOT invoke tavily_extract',
               !/tavily__tavily_extract\s*\(/.test(rssSectionStripped),
               'rss branch still calls tavily_extract');

        expect('url-loop.md saves discovered feeds with subtype:"feed"',
               /channel:\s*["']rss["'][\s\S]{0,80}subtype:\s*["']feed["']/.test(urlLoopBody),
               'feed add_sources entry missing subtype:"feed"');
        expect('url-loop.md add_sources discoveredFrom is the scraped source url',
               /discoveredFrom:\s*["']<the scraped source url>["']/.test(urlLoopBody),
               'discoveredFrom no longer references the scraped source url');
        expect('url-loop.md forbids runtime writes to rss_sources.md',
               /[Dd]o NOT write to[\s\S]{0,80}rss_sources\.md/.test(urlLoopBody) ||
               /rss_sources\.md[\s\S]{0,80}[Ss][Ee][Ee][Dd][\s\S]{0,80}only/.test(urlLoopBody),
               'no forbidden-write-to-rss_sources.md note');

        console.log('\n=== Test 39c: rss/rss-scorer-mcp/index.js supports feedUrl arg ===');
        const rssIndexPath = path.join(PRECRIME_ROOT, 'rss', 'rss-scorer-mcp', 'index.js');
        const rssIndexBody = fs.existsSync(rssIndexPath) ? fs.readFileSync(rssIndexPath, 'utf8') : '';
        expect('rss-scorer-mcp/index.js exists', fs.existsSync(rssIndexPath), rssIndexPath);
        expect('rss-scorer-mcp passes feedUrl into getTopArticles',
               /getTopArticles\s*\(\s*limit\s*,\s*feedUrlOverride\s*\)|getTopArticles\([^)]*feedUrl/.test(rssIndexBody),
               'getTopArticles signature does not accept feedUrl override');
        expect('rss-scorer-mcp reads args.feedUrl in the tool handler',
               /args\.feedUrl/.test(rssIndexBody),
               'tool handler does not read args.feedUrl');
        expect('rss-scorer-mcp tool description mentions feedUrl',
               /description:[\s\S]{0,600}feedUrl/.test(rssIndexBody),
               'tool description does not mention feedUrl');

        console.log('\n=== Test 40: workers do not create ClientFactlet (static scan) ===');
        const WORKER_SCAN = [
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'url-loop.md'),
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'enrichment-agent.md'),
            path.join(PRECRIME_ROOT, 'templates', 'skills', 'apply-factlet.md')
        ];
        for (const wPath of WORKER_SCAN) {
            const body = fs.existsSync(wPath) ? fs.readFileSync(wPath, 'utf8') : '';
            expect(`${path.basename(wPath)} does not invoke ClientFactlet`,
                   !/clientFactlet\b|ClientFactlet\b/.test(body) ||
                   /no(?:t)?\s+ClientFactlet|do not create.*ClientFactlet|never.*ClientFactlet|do not.*[Cc]lient[Ff]actlet/i.test(body),
                   'unexpected positive ClientFactlet reference');
        }

        console.log('\n=== Test 41: tasks.sessionBudgets caps total Tasks across multiple plan_tasks calls ===');
        // Open a dedicated workflow Session, seed enough Sources to potentially
        // exhaust the SCRAPE_SOURCE session budget, then drive plan_tasks
        // repeatedly. Between passes we mark the freshly-created Tasks 'done'
        // so the per-pass open-Tasks limit does not bind -- only the budget
        // should bind. Asserts: total created across the run == session budget;
        // budgetUsage/budgetExhausted are reported on the final pass; leftover
        // Source rows remain in SQLite.
        const SCRAPE_BUDGET = 25;   // matches default tasks.sessionBudgets.SCRAPE_SOURCE
        const SEED_COUNT    = SCRAPE_BUDGET + 10;
        const pBudgetSeed = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        // Stage 2 of the new control loop suppresses SCRAPE_SOURCE while any
        // done worker Task is judge-needed OR any JUDGE_AFFECTED is open.
        // Mark every pre-existing done worker output as judged, and cancel
        // any leftover ready/claimed JUDGE_AFFECTED + SHOW_HOT_LEEDZ tasks
        // from earlier tests so this test exercises ONLY the budget gate.
        await pBudgetSeed.task.updateMany({
            where: { status: 'done', type: { in: ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE'] } },
            data:  { output: JSON.stringify({ judgedAt: new Date().toISOString(), summary: 'marked judged for budget-cap test' }) }
        });
        // Strict stage-gating: SCRAPE_SOURCE is the second-lowest stage. Every
        // higher stage that is created OR already open will suppress it. Drain
        // judge, hot action, apply, and enrich ready/claimed so this test
        // exercises ONLY the SCRAPE_SOURCE budget gate.
        await pBudgetSeed.task.updateMany({
            where: { type: { in: ['JUDGE_AFFECTED', 'SHOW_HOT_LEEDZ', 'SHARE_BOOKING', 'DRAFT_OUTREACH', 'APPLY_FACTLET', 'ENRICH_CLIENT'] }, status: { in: ['ready', 'claimed'] } },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        // Same for ready/claimed hot Bookings -- Stage 3 also suppresses
        // SCRAPE_SOURCE while hot future unshared Bookings exist.
        await pBudgetSeed.booking.updateMany({
            where: { status: { in: ['leed_ready', 'outreach_ready'] }, shared: false },
            data:  { status: 'brewing' }
        });
        // Drain live unprocessed Factlets so Stage 4 (APPLY_FACTLET) finds
        // nothing to schedule (would otherwise suppress SCRAPE_SOURCE).
        // Mark every existing Factlet's APPLY_FACTLET as terminal via a
        // synthetic done Task. Simpler: just delete pre-existing Factlets
        // since this test owns nothing factlet-related.
        await pBudgetSeed.factlet.deleteMany({});
        // Drain Clients too so Stage 5 (ENRICH_CLIENT) finds nothing to
        // schedule (would otherwise suppress SCRAPE_SOURCE). Bookings FK
        // referencing them must go first.
        await pBudgetSeed.booking.deleteMany({});
        await pBudgetSeed.client.deleteMany({});
        for (let i = 0; i < SEED_COUNT; i++) {
            await pBudgetSeed.source.create({
                data: {
                    url:     'https://budget-seed.example.com/s' + Date.now() + '-' + i,
                    channel: 'directory'
                }
            });
        }
        const budgetSession = await pBudgetSeed.session.create({
            data: {
                id:        'budget-test-' + Date.now(),
                workflow:  'workflow',
                status:    'active',
                startedAt: new Date()
            }
        });
        await pBudgetSeed.$disconnect();

        let totalScrapeCreated = 0;
        let lastBudgetPlan     = null;
        let passes             = 0;
        while (passes < 40) {
            const plan = await call('plan_tasks', { mode: 'workflow', session_id: budgetSession.id });
            lastBudgetPlan = plan;
            const newScrape = (plan.created || []).filter(c => c.type === 'SCRAPE_SOURCE');
            totalScrapeCreated += newScrape.length;
            if (newScrape.length === 0) break;
            // Mark them 'done' so the per-pass open-Tasks limit does not bind
            // on the next loop iteration. The session budget MUST still bind.
            const pMark = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
            await pMark.task.updateMany({
                where: { id: { in: newScrape.map(c => c.id) } },
                data:  { status: 'done', finishedAt: new Date() }
            });
            await pMark.$disconnect();
            passes++;
        }
        expect('SCRAPE_SOURCE total never exceeds tasks.sessionBudgets.SCRAPE_SOURCE',
               totalScrapeCreated === SCRAPE_BUDGET,
               `created ${totalScrapeCreated}, expected ${SCRAPE_BUDGET}`);
        expect('plan_tasks response carries session_id',
               typeof lastBudgetPlan?.session_id === 'string',
               JSON.stringify(lastBudgetPlan?.session_id));
        expect('plan_tasks response includes budgetUsage map',
               !!lastBudgetPlan?.budgetUsage &&
               typeof lastBudgetPlan.budgetUsage.SCRAPE_SOURCE === 'object',
               JSON.stringify(lastBudgetPlan?.budgetUsage?.SCRAPE_SOURCE));
        expect('budgetUsage.SCRAPE_SOURCE.used === budget on last pass',
               lastBudgetPlan?.budgetUsage?.SCRAPE_SOURCE?.used === SCRAPE_BUDGET,
               JSON.stringify(lastBudgetPlan?.budgetUsage?.SCRAPE_SOURCE));
        expect('budgetUsage.SCRAPE_SOURCE.remaining === 0 on last pass',
               lastBudgetPlan?.budgetUsage?.SCRAPE_SOURCE?.remaining === 0,
               JSON.stringify(lastBudgetPlan?.budgetUsage?.SCRAPE_SOURCE));
        expect('budgetExhausted includes SCRAPE_SOURCE on final pass',
               Array.isArray(lastBudgetPlan?.budgetExhausted) &&
               lastBudgetPlan.budgetExhausted.includes('SCRAPE_SOURCE'),
               JSON.stringify(lastBudgetPlan?.budgetExhausted));

        // Per-pass tasks.limits cap still holds. Confirm by inspecting one pass:
        // before the budget-loop drove all sources to 'done', each pass created
        // at most TASK_TYPE_LIMITS.SCRAPE_SOURCE = 5 SCRAPE_SOURCE tasks.
        // We can't replay history here without extra plumbing; instead assert
        // the live config exposes both knobs distinctly.
        expect('config exposes both tasks.limits and tasks.sessionBudgets',
               Number.isFinite(live.tasks?.limits?.SCRAPE_SOURCE) &&
               Number.isFinite(live.tasks?.sessionBudgets?.SCRAPE_SOURCE) &&
               live.tasks.sessionBudgets.SCRAPE_SOURCE >= live.tasks.limits.SCRAPE_SOURCE,
               JSON.stringify({ limits: live.tasks?.limits?.SCRAPE_SOURCE, sessionBudgets: live.tasks?.sessionBudgets?.SCRAPE_SOURCE }));

        // Budget-blocked Sources remain in SQLite -- nothing deleted.
        const pLeft = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const leftover = await pLeft.source.count({
            where: { url: { startsWith: 'https://budget-seed.example.com/' }, scrapedAt: null }
        });
        await pLeft.$disconnect();
        expect('budget-blocked Sources remain in DB (not deleted)',
               leftover >= (SEED_COUNT - SCRAPE_BUDGET),
               `expected >= ${SEED_COUNT - SCRAPE_BUDGET} leftover sources, got ${leftover}`);

        console.log('\n=== Test 42: Planner closes Session when no new Tasks created AND no ready/claimed remain ===');
        const pCloseSeed = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const closeSession = await pCloseSeed.session.create({
            data: {
                id:        'close-test-' + Date.now(),
                workflow:  'workflow',
                status:    'active',
                startedAt: new Date()
            }
        });
        await pCloseSeed.$disconnect();
        // Pass 1: queues are empty (no fresh seeded sources targeted at this session).
        // Planner may create DISCOVER_SOURCES (budget 1). It will NOT close yet.
        const closePass1 = await call('plan_tasks', { mode: 'workflow', session_id: closeSession.id });
        expect('first plan call does not close Session if a Task was created',
               closePass1.sessionClosed === false || closePass1.created.length === 0,
               JSON.stringify({ closed: closePass1.sessionClosed, created: closePass1.created.length }));
        // Mark any ready Tasks for this session 'done' so Pass 2 has nothing open.
        // Also drain candidate inputs (Sources, Clients, Factlets) so the planner
        // finds nothing new to create -- proves the closure condition (zero created
        // AND zero open) is met. Wipes are scoped to the smoke DB.
        const pCloseDrain = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pCloseDrain.task.updateMany({
            where: { sessionId: closeSession.id, status: { in: ['ready', 'claimed'] } },
            data:  { status: 'done', finishedAt: new Date() }
        });
        // Drain Source candidates without deleting (preserves Test 41 leftover assertion).
        await pCloseDrain.source.updateMany({
            where: { scrapedAt: null },
            data:  { scrapedAt: new Date() }
        });
        // Drain Client / Factlet candidate pools so ENRICH_CLIENT / APPLY_FACTLET
        // also produce nothing on Pass 2. Booking rows reference Clients via FK,
        // so delete those first.
        await pCloseDrain.booking.deleteMany({});
        await pCloseDrain.client.deleteMany({});
        await pCloseDrain.factlet.deleteMany({});
        // Also retire any leftover ready/claimed Tasks across the WHOLE smoke DB.
        // Earlier tests left orphan ENRICH_CLIENT / APPLY_FACTLET / SCRAPE_SOURCE
        // rows still 'ready'; they target now-deleted Clients/Factlets/Sources
        // and saturate the global concurrency cap, which would starve Tests 44+
        // even though their per-session dedup is clean.
        await pCloseDrain.task.updateMany({
            where:  { status: { in: ['ready', 'claimed'] } },
            data:   { status: 'cancelled', finishedAt: new Date() }
        });
        // Stamp every done worker Task as already-judged so the JUDGE_AFFECTED
        // planner section produces zero. Without this, Test 13/14 seed Tasks
        // with affected ids would re-spawn JUDGE_AFFECTED on Pass 2 and the
        // close condition would not hold.
        await pCloseDrain.task.updateMany({
            where: {
                status: 'done',
                type:   { in: ['SCRAPE_SOURCE', 'ENRICH_CLIENT', 'APPLY_FACTLET'] }
            },
            data:   { output: JSON.stringify({ judgedAt: new Date().toISOString() }) }
        });
        // If closeSession never produced a DISCOVER_SOURCES Task on Pass 1
        // (global limit was saturated at that moment), inject a phantom
        // cancelled row so its DISCOVER_SOURCES session budget (1/1) is
        // accounted as used. This guarantees Pass 2 cannot create one.
        const existingDiscClose = await pCloseDrain.task.count({
            where: { sessionId: closeSession.id, type: 'DISCOVER_SOURCES' }
        });
        if (existingDiscClose === 0) {
            await pCloseDrain.task.create({
                data: {
                    type:       'DISCOVER_SOURCES',
                    status:     'cancelled',
                    sessionId:  closeSession.id,
                    targetType: 'none',
                    finishedAt: new Date()
                }
            });
        }
        await pCloseDrain.$disconnect();
        const closePass2 = await call('plan_tasks', { mode: 'workflow', session_id: closeSession.id });
        expect('Pass 2: planner creates zero new Tasks for already-budget-touched session',
               (closePass2.created || []).length === 0,
               JSON.stringify(closePass2.created));
        expect('Pass 2: sessionClosed === true',
               closePass2.sessionClosed === true,
               JSON.stringify({ closed: closePass2.sessionClosed, reason: closePass2.closeReason }));
        expect('Pass 2: closeReason is set',
               typeof closePass2.closeReason === 'string' && closePass2.closeReason.length > 0,
               String(closePass2.closeReason));
        const pCloseCheck = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const closedRow = await pCloseCheck.session.findUnique({ where: { id: closeSession.id } });
        await pCloseCheck.$disconnect();
        expect('Session row marked complete with finishedAt',
               closedRow?.status === 'complete' && !!closedRow?.finishedAt,
               JSON.stringify({ status: closedRow?.status, finishedAt: closedRow?.finishedAt }));

        console.log('\n=== Test 43: plan_tasks rejects re-use of a complete Session ===');
        const reuseAttempt = await call('plan_tasks', { mode: 'workflow', session_id: closeSession.id });
        expect('plan_tasks errors on closed session_id (cannot reopen)',
               !!reuseAttempt.__rpcError && /not active|complete/i.test(reuseAttempt.__rpcError.message || ''),
               JSON.stringify(reuseAttempt));

        console.log('\n=== Test 44: ENRICH_CLIENT per-target dedup across statuses in one Session ===');
        // Seed one Client + a dedicated workflow Session. Pass 1: planner creates
        // ENRICH_CLIENT for that Client. Mark it DONE. Pass 2: planner must NOT
        // create another ENRICH_CLIENT for the same Client (done counts).
        const pSeed44 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const c44 = await pSeed44.client.create({
            data: { name: 'DedupEnrichClient_' + Date.now(), email: 'c44_' + Date.now() + '@example.com' }
        });
        const sess44 = await pSeed44.session.create({
            data: {
                id:        'dedup-enrich-' + Date.now(),
                workflow:  'workflow',
                status:    'active',
                startedAt: new Date()
            }
        });
        await pSeed44.$disconnect();
        const enrich44Pass1 = await call('plan_tasks', { mode: 'workflow', session_id: sess44.id });
        const e44_p1 = (enrich44Pass1.created || []).filter(c => c.type === 'ENRICH_CLIENT' && c.targetId === c44.id);
        expect('Pass 1 plans exactly one ENRICH_CLIENT for c44',
               e44_p1.length === 1,
               `pass1 created: ${JSON.stringify(enrich44Pass1.created)}`);
        // Mark that ENRICH_CLIENT done so it is no longer ready/claimed.
        const pMark44 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pMark44.task.update({
            where: { id: e44_p1[0].id },
            data:  { status: 'done', finishedAt: new Date() }
        });
        await pMark44.$disconnect();
        const enrich44Pass2 = await call('plan_tasks', { mode: 'workflow', session_id: sess44.id });
        const e44_p2 = (enrich44Pass2.created || []).filter(c => c.type === 'ENRICH_CLIENT' && c.targetId === c44.id);
        expect('Pass 2 does NOT re-plan ENRICH_CLIENT for the same Client in the same Session',
               e44_p2.length === 0,
               `pass2 created: ${JSON.stringify(enrich44Pass2.created)}`);
        const pCheck44 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const allE44 = await pCheck44.task.count({
            where: { sessionId: sess44.id, type: 'ENRICH_CLIENT', targetId: c44.id }
        });
        await pCheck44.$disconnect();
        expect('exactly one ENRICH_CLIENT Task exists for c44 in sess44 (any status)',
               allE44 === 1,
               `count=${allE44}`);

        console.log('\n=== Test 45: APPLY_FACTLET per-target dedup across statuses in one Session ===');
        const pSeed45 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const f45 = await pSeed45.factlet.create({
            data: { content: 'DedupApplyFactlet_' + Date.now(), source: 'smoke-direct' }
        });
        const sess45 = await pSeed45.session.create({
            data: {
                id:        'dedup-apply-' + Date.now(),
                workflow:  'workflow',
                status:    'active',
                startedAt: new Date()
            }
        });
        await pSeed45.$disconnect();
        const apply45Pass1 = await call('plan_tasks', { mode: 'workflow', session_id: sess45.id });
        const a45_p1 = (apply45Pass1.created || []).filter(c => c.type === 'APPLY_FACTLET' && c.targetId === f45.id);
        expect('Pass 1 plans exactly one APPLY_FACTLET for f45',
               a45_p1.length === 1,
               `pass1 created: ${JSON.stringify(apply45Pass1.created)}`);
        const pMark45 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pMark45.task.update({
            where: { id: a45_p1[0].id },
            data:  { status: 'done', finishedAt: new Date() }
        });
        await pMark45.$disconnect();
        const apply45Pass2 = await call('plan_tasks', { mode: 'workflow', session_id: sess45.id });
        const a45_p2 = (apply45Pass2.created || []).filter(c => c.type === 'APPLY_FACTLET' && c.targetId === f45.id);
        expect('Pass 2 does NOT re-plan APPLY_FACTLET for the same Factlet in the same Session',
               a45_p2.length === 0,
               `pass2 created: ${JSON.stringify(apply45Pass2.created)}`);
        const pCheck45 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const allA45 = await pCheck45.task.count({
            where: { sessionId: sess45.id, type: 'APPLY_FACTLET', targetId: f45.id }
        });
        await pCheck45.$disconnect();
        expect('exactly one APPLY_FACTLET Task exists for f45 in sess45 (any status)',
               allA45 === 1,
               `count=${allA45}`);

        console.log('\n=== Test 46: A fresh Session may re-plan the same target after the prior Session closes ===');
        // c44 was deduped in sess44 (same-session) and f45 was deduped in sess45.
        // Close both prior sessions, drain ANY still-open ENRICH_CLIENT/
        // APPLY_FACTLET Tasks targeting c44/f45 (Test 45's plan for sess45 may
        // have created a fresh ENRICH_CLIENT for c44 that is still 'ready' --
        // the cross-session "ready/claimed" arm of the dedup OR clause would
        // otherwise still block sess46 from re-targeting c44).
        const pClose46 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pClose46.session.update({
            where: { id: sess44.id },
            data:  { status: 'complete', finishedAt: new Date() }
        });
        await pClose46.session.update({
            where: { id: sess45.id },
            data:  { status: 'complete', finishedAt: new Date() }
        });
        await pClose46.task.updateMany({
            where: {
                status: { in: ['ready', 'claimed'] },
                OR: [
                    { type: 'ENRICH_CLIENT', targetId: c44.id },
                    { type: 'APPLY_FACTLET', targetId: f45.id }
                ]
            },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        // Cross-session retry: also delete the prior done APPLY_FACTLET for
        // f45. Otherwise getTerminalAppliedFactletIds() reports f45 as
        // processed and the planner correctly refuses to re-plan it (spec
        // WHAT_I_LEARNED.md test #6). This test specifically exercises the
        // per-session-dedup retry case, so the terminal marker must clear.
        await pClose46.task.deleteMany({
            where: { type: 'APPLY_FACTLET', targetId: f45.id, status: { in: ['done', 'failed', 'cancelled'] } }
        });
        // Strict stage-gating: APPLY_FACTLET and ENRICH_CLIENT are lower
        // stages. Drain leftover JUDGE_AFFECTED / hot action ready/claimed
        // and hot Bookings so Stages 4/5 are not suppressed by Stages 2/3.
        await pClose46.task.updateMany({
            where: { type: { in: ['JUDGE_AFFECTED', 'SHOW_HOT_LEEDZ', 'SHARE_BOOKING', 'DRAFT_OUTREACH'] }, status: { in: ['ready', 'claimed'] } },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        await pClose46.task.updateMany({
            where: { status: 'done', type: { in: ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE'] }, NOT: { output: { contains: 'judgedAt' } } },
            data:  { output: JSON.stringify({ judgedAt: new Date().toISOString() }) }
        });
        await pClose46.booking.updateMany({
            where: { status: { in: ['leed_ready', 'outreach_ready'] }, shared: false },
            data:  { status: 'brewing' }
        });
        const sess46 = await pClose46.session.create({
            data: {
                id:        'fresh-after-close-' + Date.now(),
                workflow:  'workflow',
                status:    'active',
                startedAt: new Date()
            }
        });
        await pClose46.$disconnect();
        // Strict stage-gating: APPLY_FACTLET (Stage 4) suppresses ENRICH_CLIENT
        // (Stage 5) in the same plan_tasks call. We must verify each cross-
        // session retry separately. Pass A exercises APPLY_FACTLET; pass B
        // (after draining Stage 4 state) exercises ENRICH_CLIENT.
        const planFresh = await call('plan_tasks', { mode: 'workflow', session_id: sess46.id });
        const freshA45 = (planFresh.created || []).filter(c => c.type === 'APPLY_FACTLET' && c.targetId === f45.id);
        expect('fresh Session re-plans APPLY_FACTLET for f45 (cross-session retry, Pass A)',
               freshA45.length === 1,
               `pass A created: ${JSON.stringify(planFresh.created)}`);

        // Drain Stage 4 (apply) state -- cancel ready/claimed APPLY tasks and
        // remove all live Factlets -- so Pass B's Stage 4 produces nothing and
        // Stage 5 (enrich) gets its turn.
        const pDrain46 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pDrain46.task.updateMany({
            where: { type: 'APPLY_FACTLET', status: { in: ['ready', 'claimed'] } },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        await pDrain46.factlet.deleteMany({});
        await pDrain46.$disconnect();
        const planFreshB = await call('plan_tasks', { mode: 'workflow', session_id: sess46.id });
        const freshE44 = (planFreshB.created || []).filter(c => c.type === 'ENRICH_CLIENT' && c.targetId === c44.id);
        expect('fresh Session re-plans ENRICH_CLIENT for c44 (cross-session retry, Pass B)',
               freshE44.length === 1,
               `pass B created: ${JSON.stringify(planFreshB.created)}`);

        console.log('\n=== Test 47: closeReason format -- budget_exhausted enumerates Task types ===');
        // Under the new strict-stage-gated planner, budgetSession self-closes
        // inside Test 41's loop: once SCRAPE_SOURCE budget is exhausted and
        // the loop body marks every created Task 'done', maybeCloseSession
        // finds zero open and zero created on the final pass -> CLOSES with
        // closeReason starting with "budget_exhausted:". Re-using budgetSession
        // here would error ("not active"). Instead verify the close behavior
        // off the LAST plan_tasks response captured by Test 41 (lastBudgetPlan).
        expect('budget-exhausted session closed by the final Test 41 planner pass',
               lastBudgetPlan && lastBudgetPlan.sessionClosed === true,
               JSON.stringify({
                   closed:  lastBudgetPlan && lastBudgetPlan.sessionClosed,
                   reason:  lastBudgetPlan && lastBudgetPlan.closeReason,
                   created: (lastBudgetPlan && lastBudgetPlan.created ? lastBudgetPlan.created.length : null)
               }));
        expect('closeReason starts with "budget_exhausted:" when budgets capped the close',
               /^budget_exhausted:/.test((lastBudgetPlan && lastBudgetPlan.closeReason) || ''),
               String(lastBudgetPlan && lastBudgetPlan.closeReason));
        expect('closeReason enumerates SCRAPE_SOURCE among exhausted types',
               /SCRAPE_SOURCE/.test((lastBudgetPlan && lastBudgetPlan.closeReason) || ''),
               String(lastBudgetPlan && lastBudgetPlan.closeReason));
        expect('full budgetUsage map still returned on closing pass',
               !!(lastBudgetPlan && lastBudgetPlan.budgetUsage) &&
               Number.isFinite(lastBudgetPlan.budgetUsage.SCRAPE_SOURCE && lastBudgetPlan.budgetUsage.SCRAPE_SOURCE.used),
               JSON.stringify(lastBudgetPlan && lastBudgetPlan.budgetUsage));
        // Sanity: an OPEN session (planFresh from Test 46) returns
        // closeReason === "work_remaining", proving the close detection is
        // not a constant.
        expect('open Session returns closeReason === "work_remaining"',
               planFresh.sessionClosed === false && planFresh.closeReason === 'work_remaining',
               JSON.stringify({ closed: planFresh.sessionClosed, reason: planFresh.closeReason }));

        console.log('\n=== Test 48: JUDGE_AFFECTED completion stamps judgedAt + judgedByTaskId on source Task ===');
        // Round-trip:
        //   1. Done worker Task with affected ids -> plan_tasks creates exactly one JUDGE_AFFECTED.
        //   2. Complete that JUDGE_AFFECTED -> source worker Task output gains judgedAt + judgedByTaskId
        //      (and existing keys are preserved).
        //   3. Re-plan -> no duplicate JUDGE_AFFECTED for the same source.
        //   4. A second done worker Task with NEW affected ids still gets its own JUDGE_AFFECTED.
        const pSeed48 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        // Clean slate so this section's counts are deterministic.
        await pSeed48.task.deleteMany({ where: { type: 'JUDGE_AFFECTED' } });
        await pSeed48.task.deleteMany({
            where: { status: 'done', type: { in: ['SCRAPE_SOURCE', 'ENRICH_CLIENT', 'APPLY_FACTLET'] } }
        });
        // Strict stage-gating: leftover ready/claimed worker Tasks from
        // earlier tests would (a) suppress lower stages and (b) cause sess48
        // to self-close on Pass 2/3 once src48 is judged. Drain them so this
        // test isolates the JUDGE_AFFECTED stamping round-trip.
        await pSeed48.task.updateMany({
            where: { type: { in: ['ENRICH_CLIENT', 'APPLY_FACTLET', 'SHOW_HOT_LEEDZ', 'SHARE_BOOKING', 'DRAFT_OUTREACH'] }, status: { in: ['ready', 'claimed'] } },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        // Keep at least one ready Task in sess48 across re-plans so
        // maybeCloseSession does not close the session between the JUDGE
        // round-trip checks. A pre-cancelled placeholder won't do; we use a
        // ready Task with a synthetic targetId no scoring touches.
        // (Simpler approach: ensure there is a claimable Source so Stage 6
        // creates SCRAPE_SOURCE in sess48 on each pass -- prior tests left
        // ~10 unscraped sources from Test 41's seed.)
        const sess48 = await pSeed48.session.create({
            data: {
                id:        'judged-stamp-' + Date.now(),
                workflow:  'workflow',
                status:    'active',
                startedAt: new Date()
            }
        });
        const src48 = await pSeed48.task.create({
            data: {
                type:       'SCRAPE_SOURCE',
                status:     'done',
                finishedAt: new Date(),
                output:     JSON.stringify({
                    clientIds:  ['cli_S48'],
                    bookingIds: ['bk_S48'],
                    note:       'preserve me'
                })
            }
        });
        await pSeed48.$disconnect();

        // Pass 1: planner must create exactly one JUDGE_AFFECTED for src48.
        const plan48a = await call('plan_tasks', { mode: 'workflow', session_id: sess48.id });
        expect('plan_tasks (judge round-trip) ok', !plan48a.__rpcError,
               JSON.stringify(plan48a.__rpcError || {}));
        const j48List = await call('tasks', { type: 'JUDGE_AFFECTED', status: 'ready' });
        const j48 = (j48List.tasks || []).filter(t => t.input?.sourceTaskId === src48.id);
        expect('pass 1 creates exactly one JUDGE_AFFECTED for src48',
               j48.length === 1,
               `count=${j48.length} ids=${JSON.stringify(j48.map(t => t.id))}`);

        // Complete the JUDGE_AFFECTED Task with status=done.
        const j48Id = j48[0]?.id;
        const done48 = await call('complete_task', {
            taskId: j48Id,
            status: 'done',
            output: { judged: true, summary: 'smoke judge stamp' }
        });
        expect('JUDGE_AFFECTED complete ok',
               done48.completed === true,
               JSON.stringify(done48).slice(0, 200));

        // Source Task output must now carry judgedAt + judgedByTaskId AND preserve the original keys.
        const pCheck48 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const src48After = await pCheck48.task.findUnique({ where: { id: src48.id } });
        await pCheck48.$disconnect();
        let src48Out = null;
        try { src48Out = JSON.parse(src48After?.output || 'null'); } catch (_) { src48Out = null; }
        expect('source Task output is valid JSON', !!src48Out, String(src48After?.output));
        expect('source Task output has judgedAt (ISO string)',
               typeof src48Out?.judgedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(src48Out.judgedAt),
               JSON.stringify(src48Out));
        expect('source Task output has judgedByTaskId === JUDGE_AFFECTED task id',
               src48Out?.judgedByTaskId === j48Id,
               `judgedByTaskId=${src48Out?.judgedByTaskId} expected=${j48Id}`);
        expect('source Task preserves original output keys',
               Array.isArray(src48Out?.clientIds)  && src48Out.clientIds.includes('cli_S48') &&
               Array.isArray(src48Out?.bookingIds) && src48Out.bookingIds.includes('bk_S48') &&
               src48Out?.note === 'preserve me',
               JSON.stringify(src48Out));

        // Pass 2: re-plan in the SAME session. No new JUDGE_AFFECTED for src48.
        const plan48b = await call('plan_tasks', { mode: 'workflow', session_id: sess48.id });
        expect('plan_tasks (post-stamp) ok', !plan48b.__rpcError,
               JSON.stringify(plan48b.__rpcError || {}));
        const pDup48 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const allJ48 = await pDup48.task.findMany({ where: { type: 'JUDGE_AFFECTED' } });
        await pDup48.$disconnect();
        const j48ForSrc = allJ48.filter(t => {
            try { return JSON.parse(t.input || '{}').sourceTaskId === src48.id; } catch { return false; }
        });
        expect('only one JUDGE_AFFECTED ever exists for already-judged source (no duplicate on re-plan)',
               j48ForSrc.length === 1,
               `count=${j48ForSrc.length} ids=${JSON.stringify(j48ForSrc.map(t => t.id))}`);

        // A NEW completed worker Task with fresh affected ids must still trigger its own JUDGE_AFFECTED.
        const pSeed48b = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const src48New = await pSeed48b.task.create({
            data: {
                type:       'ENRICH_CLIENT',
                status:     'done',
                finishedAt: new Date(),
                output:     JSON.stringify({ clientIds: ['cli_S48_NEW'] })
            }
        });
        await pSeed48b.$disconnect();
        const plan48c = await call('plan_tasks', { mode: 'workflow', session_id: sess48.id });
        expect('plan_tasks (new source) ok', !plan48c.__rpcError,
               JSON.stringify(plan48c.__rpcError || {}));
        const pNew48 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const allJ48After = await pNew48.task.findMany({ where: { type: 'JUDGE_AFFECTED' } });
        await pNew48.$disconnect();
        const j48ForNew = allJ48After.filter(t => {
            try { return JSON.parse(t.input || '{}').sourceTaskId === src48New.id; } catch { return false; }
        });
        expect('new completed worker Task still produces its own JUDGE_AFFECTED',
               j48ForNew.length === 1,
               `count=${j48ForNew.length}`);
        // And the already-judged source still has exactly one JUDGE_AFFECTED.
        const j48ForSrcAfter = allJ48After.filter(t => {
            try { return JSON.parse(t.input || '{}').sourceTaskId === src48.id; } catch { return false; }
        });
        expect('already-judged source count unchanged after planning the new source',
               j48ForSrcAfter.length === 1,
               `count=${j48ForSrcAfter.length}`);

        console.log('\n=== Test 49: pipeline.save refuses to resurrect a sent Client without force=true ===');
        // Seed a Client at draftStatus="sent" and prove that:
        //   1. A save trying to flip draftStatus back to "ready" is rejected.
        //   2. The Client row is untouched.
        //   3. A save with force:true is accepted (intentional re-engagement).
        //   4. A save that does NOT touch draftStatus still works (e.g. dossier refresh).
        const pSent = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const sentClient = await pSent.client.create({
            data: {
                name:        'SentSeed_' + Date.now(),
                email:       'sent.seed.' + Date.now() + '@example.com',
                company:     'SentSeedCo',
                draftStatus: 'sent',
                draft:       'previous outreach draft',
                sentAt:      new Date()
            }
        });
        await pSent.$disconnect();

        const resurrect = await call('save', {
            id: sentClient.id,
            judge: false,
            patch: { draftStatus: 'ready' }
        });
        expect('save rejects draftStatus="sent" -> "ready" without force',
               !!resurrect.__rpcError && /draftStatus="sent"/.test(resurrect.__rpcError.message || '') && /force/.test(resurrect.__rpcError.message || ''),
               JSON.stringify(resurrect).slice(0, 240));
        const pAfter = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const stillSent = await pAfter.client.findUnique({ where: { id: sentClient.id } });
        await pAfter.$disconnect();
        expect('rejected save leaves Client.draftStatus unchanged',
               stillSent?.draftStatus === 'sent',
               `draftStatus=${stillSent?.draftStatus}`);

        const forced = await call('save', {
            id: sentClient.id,
            judge: false,
            patch: { draftStatus: 'ready', force: true }
        });
        expect('save accepts draftStatus flip when force=true is passed',
               forced.saved === true,
               JSON.stringify(forced).slice(0, 240));
        const pForced = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const forcedRow = await pForced.client.findUnique({ where: { id: sentClient.id } });
        // Reset for the next sub-assertion.
        await pForced.client.update({ where: { id: sentClient.id }, data: { draftStatus: 'sent' } });
        await pForced.$disconnect();
        expect('force=true actually flipped draftStatus to "ready"',
               forcedRow?.draftStatus === 'ready',
               `draftStatus=${forcedRow?.draftStatus}`);

        const passive = await call('save', {
            id: sentClient.id,
            judge: false,
            patch: { clientNotes: 'enrichment pass after send (no draftStatus change)' }
        });
        expect('save without draftStatus on a sent Client still succeeds (dossier refresh allowed)',
               passive.saved === true,
               JSON.stringify(passive).slice(0, 240));
        const pPassive = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const passiveRow = await pPassive.client.findUnique({ where: { id: sentClient.id } });
        await pPassive.$disconnect();
        expect('passive save leaves draftStatus="sent" intact',
               passiveRow?.draftStatus === 'sent',
               `draftStatus=${passiveRow?.draftStatus}`);

        console.log('\n=== Test 50: pipeline.save auto-mirrors email-share Booking -> Client.draftStatus="sent" ===');
        // Verifies the server-side mirror so the LLM does not have to write the
        // Client marker manually after a gmail-based share:
        //   - Booking flipped to status="shared" with sharedTo in {email_share,email_user}
        //     -> Client auto-marked draftStatus="sent" + sentAt=<now>.
        //   - Marketplace share (sharedTo="leedz_api") does NOT trigger the mirror
        //     (it's per-Booking; Client stays eligible for direct outreach on other Bookings).
        //   - Idempotent: re-flipping an already-sent Client does not error.
        const pMirror = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const mirrorClient = await pMirror.client.create({
            data: {
                name:    'MirrorSeed_' + Date.now(),
                email:   'mirror.seed.' + Date.now() + '@example.com',
                company: 'MirrorSeedCo',
                draftStatus: 'ready'   // pre-send state
            }
        });
        const mirrorBooking = await pMirror.booking.create({
            data: {
                clientId:  mirrorClient.id,
                title:     'Email-Path Gig',
                trade:     'photo booth',
                zip:       '75201',
                startDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
                endDate:   new Date(Date.now() + 30 * 24 * 3600 * 1000 + 3600000),
                status:    'outreach_ready'
            }
        });
        await pMirror.$disconnect();

        const emailShare = await call('save', {
            id:    mirrorClient.id,
            judge: false,
            patch: { bookings: [{ id: mirrorBooking.id, status: 'shared', sharedTo: 'email_share' }] }
        });
        expect('save(email_share booking patch) ok',
               emailShare.saved === true,
               JSON.stringify(emailShare).slice(0, 240));
        const pCheck50 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const mirroredClient = await pCheck50.client.findUnique({ where: { id: mirrorClient.id } });
        const mirroredBooking = await pCheck50.booking.findUnique({ where: { id: mirrorBooking.id } });
        await pCheck50.$disconnect();
        expect('Booking flipped to status="shared"',
               mirroredBooking?.status === 'shared',
               `status=${mirroredBooking?.status}`);
        expect('Booking sharedTo recorded as "email_share"',
               mirroredBooking?.sharedTo === 'email_share',
               `sharedTo=${mirroredBooking?.sharedTo}`);
        expect('Client auto-mirrored to draftStatus="sent"',
               mirroredClient?.draftStatus === 'sent',
               `draftStatus=${mirroredClient?.draftStatus}`);
        expect('Client auto-mirrored sentAt populated',
               !!mirroredClient?.sentAt,
               `sentAt=${mirroredClient?.sentAt}`);

        // Marketplace path: a Booking flipped to status="shared" with sharedTo="leedz_api"
        // must NOT auto-mirror the Client (marketplace is per-Booking).
        const pLeedz = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const leedzClient = await pLeedz.client.create({
            data: {
                name:    'LeedzMarketSeed_' + Date.now(),
                email:   'leedz.market.' + Date.now() + '@example.com',
                company: 'LeedzMarketCo',
                draftStatus: 'ready'
            }
        });
        const leedzBooking = await pLeedz.booking.create({
            data: {
                clientId:  leedzClient.id,
                title:     'Marketplace Gig',
                trade:     'photo booth',
                zip:       '75201',
                startDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
                endDate:   new Date(Date.now() + 30 * 24 * 3600 * 1000 + 3600000),
                status:    'leed_ready'
            }
        });
        await pLeedz.$disconnect();

        const leedzShare = await call('save', {
            id:    leedzClient.id,
            judge: false,
            patch: { bookings: [{ id: leedzBooking.id, status: 'shared', sharedTo: 'leedz_api' }] }
        });
        expect('save(leedz_api booking patch) ok',
               leedzShare.saved === true,
               JSON.stringify(leedzShare).slice(0, 240));
        const pCheckLeedz = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const leedzMirroredClient = await pCheckLeedz.client.findUnique({ where: { id: leedzClient.id } });
        await pCheckLeedz.$disconnect();
        expect('marketplace share does NOT auto-mark Client.draftStatus',
               leedzMirroredClient?.draftStatus === 'ready',
               `draftStatus=${leedzMirroredClient?.draftStatus} (expected unchanged "ready")`);

        // Idempotency: re-flipping an already-sent Client's other booking via email
        // path is harmless (mirror is a no-op when draftStatus is already "sent").
        const pIdem = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const idemBooking = await pIdem.booking.create({
            data: {
                clientId:  mirrorClient.id,   // already at draftStatus="sent" from above
                title:     'Second Email-Path Gig',
                trade:     'photo booth',
                zip:       '75201',
                startDate: new Date(Date.now() + 60 * 24 * 3600 * 1000),
                endDate:   new Date(Date.now() + 60 * 24 * 3600 * 1000 + 3600000),
                status:    'outreach_ready'
            }
        });
        await pIdem.$disconnect();
        const idemShare = await call('save', {
            id:    mirrorClient.id,
            judge: false,
            patch: { bookings: [{ id: idemBooking.id, status: 'shared', sharedTo: 'email_user' }] }
        });
        expect('save on already-sent Client with new email-share Booking succeeds (idempotent mirror)',
               idemShare.saved === true,
               JSON.stringify(idemShare).slice(0, 240));

        console.log('\n=== Test 51: plan_tasks objective normalization + DRAFT_OUTREACH gating ===');
        // a) defaults: headless -> marketplace
        const planHeadlessDefault = await call('plan_tasks', { mode: 'headless' });
        expect('headless default objective is marketplace',
               planHeadlessDefault.objective === 'marketplace',
               String(planHeadlessDefault.objective));
        // b) defaults: workflow -> hybrid
        const planWorkflowDefault = await call('plan_tasks', { mode: 'workflow' });
        expect('workflow default objective is hybrid',
               planWorkflowDefault.objective === 'hybrid',
               String(planWorkflowDefault.objective));
        // c) invalid objective rejected
        const planInvalid = await call('plan_tasks', { mode: 'workflow', objective: 'bogus' });
        expect('invalid objective rejected with -32602',
               !!planInvalid.__rpcError && planInvalid.__rpcError.code === -32602,
               JSON.stringify(planInvalid));
        // d) headless outreach NEVER creates SHARE_BOOKING. Seed a leed_ready Booking first
        //    so we know SHARE_BOOKING would be created if the marketplace arm fired.
        const pObj = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        // drain leftover ready tasks so this section's accounting is clean
        await pObj.task.deleteMany({ where: { type: 'SHARE_BOOKING', status: { in: ['ready', 'claimed'] } } });
        await pObj.task.deleteMany({ where: { type: 'DRAFT_OUTREACH',  status: { in: ['ready', 'claimed'] } } });
        // Strict stage-gating: DRAFT_OUTREACH is a Stage 3 hot-action Task.
        // Any leftover JUDGE_AFFECTED ready/claimed (Stage 2) or unjudged done
        // worker output would trigger Stage 2 and suppress all of Stage 3.
        // Drain judge state so this section exercises the objective gate.
        await pObj.task.updateMany({
            where: { type: 'JUDGE_AFFECTED', status: { in: ['ready', 'claimed'] } },
            data:  { status: 'cancelled', finishedAt: new Date() }
        });
        await pObj.task.updateMany({
            where: { status: 'done', type: { in: ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE'] }, NOT: { output: { contains: 'judgedAt' } } },
            data:  { output: JSON.stringify({ judgedAt: new Date().toISOString() }) }
        });
        // close any active session so plan_tasks opens a fresh one (otherwise
        // budgets / dedup from prior tests could mask the new gating logic).
        await pObj.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        // a Client that meets the DRAFT_OUTREACH gate
        const draftClient = await pObj.client.create({
            data: {
                name: 'Obj_Outreach_' + Date.now(),
                email: 'real@outreach-' + Date.now() + '.example.com',
                company: 'OutreachObjectiveCo',
                contactGate: true,
                dossierScore: 9999
            }
        });
        // a Booking that meets the SHARE_BOOKING gate (leed_ready + shared:false + future date)
        const objBClient = await pObj.client.create({
            data: { name: 'Obj_Share_' + Date.now(), company: 'ShareObjectiveCo' }
        });
        const objBooking = await pObj.booking.create({
            data: {
                clientId:  objBClient.id,
                title:     'Objective Gig',
                trade:     'caricatures',
                zip:       '90405',
                startDate: new Date(Date.now() + 60 * 24 * 3600 * 1000),
                status:    'leed_ready',
                shared:    false
            }
        });
        await pObj.$disconnect();

        const planHeadOutreach = await call('plan_tasks', { mode: 'headless', objective: 'outreach' });
        expect('headless+outreach plan_tasks ok',
               !planHeadOutreach.__rpcError && planHeadOutreach.objective === 'outreach',
               JSON.stringify(planHeadOutreach).slice(0, 200));
        expect('headless+outreach does NOT schedule SHARE_BOOKING',
               !(planHeadOutreach.counts || {}).SHARE_BOOKING,
               JSON.stringify(planHeadOutreach.counts));
        expect('headless+outreach DOES schedule DRAFT_OUTREACH for eligible Client',
               (planHeadOutreach.counts || {}).DRAFT_OUTREACH >= 1,
               JSON.stringify(planHeadOutreach.counts));

        // e) headless marketplace does NOT create DRAFT_OUTREACH
        // Fresh session to escape per-session dedup.
        const pObj2 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pObj2.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        await pObj2.task.deleteMany({ where: { type: { in: ['SHARE_BOOKING', 'DRAFT_OUTREACH'] }, status: { in: ['ready', 'claimed'] } } });
        await pObj2.$disconnect();
        const planHeadMarket = await call('plan_tasks', { mode: 'headless', objective: 'marketplace' });
        expect('headless+marketplace plan_tasks ok',
               !planHeadMarket.__rpcError && planHeadMarket.objective === 'marketplace',
               JSON.stringify(planHeadMarket).slice(0, 200));
        expect('headless+marketplace does NOT schedule DRAFT_OUTREACH',
               !(planHeadMarket.counts || {}).DRAFT_OUTREACH,
               JSON.stringify(planHeadMarket.counts));

        // f) DRAFT_OUTREACH appears in budgets + limits
        expect('DRAFT_OUTREACH listed in tasks.limits',
               (planHeadMarket.limits || {}).DRAFT_OUTREACH > 0,
               JSON.stringify(planHeadMarket.limits));
        expect('DRAFT_OUTREACH listed in sessionBudgets',
               (planHeadMarket.sessionBudgets || {}).DRAFT_OUTREACH > 0,
               JSON.stringify(planHeadMarket.sessionBudgets));

        console.log('\n=== Test 51b: share_booking refuses when active session objective is outreach ===');
        // Open a fresh session under objective=outreach, then call share_booking
        // directly with a leed_ready Booking. Expect a structured non-posting
        // refusal (not an unhandled error). Then flip the session to marketplace
        // and verify share_booking gets past this gate.
        const pSBGate = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pSBGate.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        await pSBGate.$disconnect();

        // Plan under outreach to stamp the objective into the active session metadata.
        const _stamp = await call('plan_tasks', { mode: 'headless', objective: 'outreach' });
        expect('outreach plan_tasks ok (gate setup)', !_stamp.__rpcError && _stamp.objective === 'outreach', JSON.stringify(_stamp).slice(0, 200));

        // Seed a leed_ready Booking (leedId bypass so Judge keeps it leed_ready).
        const pGateB = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        const gateClient = await pGateB.client.create({ data: { name: 'GateSeed_' + Date.now(), company: 'GateSeedCo' } });
        const gateBooking = await pGateB.booking.create({
            data: {
                clientId:  gateClient.id,
                title:     'Gate Gig',
                description: 'Defense in depth booking for share_booking gate.',
                location:  '123 Ocean Ave, Santa Monica',
                trade:     'caricatures',
                zip:       '90405',
                startDate: new Date(Date.UTC(2026, 5, 10, 21, 30, 0)),
                endDate:   new Date(Date.UTC(2026, 5, 11,  5,  0, 0)),
                startTime: '21:30',
                endTime:   '05:00',
                status:    'leed_ready',
                leedId:    'GATE_SEED_LEED'
            }
        });
        await pGateB.$disconnect();

        const sbRefused = await call('share_booking', { bookingId: gateBooking.id, mode: 'draft' });
        expect('share_booking refuses under outreach objective (structured response, not -32603)',
               !sbRefused.__rpcError && sbRefused.posted === false &&
               sbRefused.error === 'share_booking_under_outreach_objective',
               JSON.stringify(sbRefused).slice(0, 240));
        expect('refusal echoes activeObjective=outreach',
               sbRefused.activeObjective === 'outreach',
               String(sbRefused.activeObjective));

        // Flip the active session to marketplace and try again -- gate must let it through.
        const pSwap = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pSwap.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        await pSwap.$disconnect();
        const _stamp2 = await call('plan_tasks', { mode: 'headless', objective: 'marketplace' });
        expect('marketplace plan_tasks ok (gate clear)',
               !_stamp2.__rpcError && _stamp2.objective === 'marketplace',
               JSON.stringify(_stamp2).slice(0, 200));
        const sbAllowed = await call('share_booking', { bookingId: gateBooking.id, mode: 'draft' });
        expect('share_booking passes the objective gate under marketplace',
               !sbAllowed.__rpcError &&
               sbAllowed.error !== 'share_booking_under_outreach_objective',
               JSON.stringify(sbAllowed).slice(0, 240));

        console.log('\n=== Test 51c: template launchers parse objective flags (drift guard) ===');
        // Fresh installs get their launchers from templates/. If these drift
        // back to the old single-flag forms, every --outreach / --marketplace /
        // --hybrid invocation on a deployed install will fail silently (the
        // flag becomes a DB name). This guard catches that before build.
        const LAUNCHER_TEMPLATES = [
            path.join(PRECRIME_ROOT, 'templates', 'precrime.bat'),
            path.join(PRECRIME_ROOT, 'templates', 'goose.bat'),
            path.join(PRECRIME_ROOT, 'templates', 'hermes.bat')
        ];
        for (const lp of LAUNCHER_TEMPLATES) {
            const name = path.basename(lp);
            expect(`${name} exists in templates/`, fs.existsSync(lp), lp);
            if (!fs.existsSync(lp)) continue;
            const body = fs.readFileSync(lp, 'utf8');
            expect(`${name} parses --marketplace`, /--marketplace/.test(body), 'flag absent');
            expect(`${name} parses --outreach`,    /--outreach/.test(body),    'flag absent');
            expect(`${name} parses --hybrid`,      /--hybrid/.test(body),      'flag absent');
            expect(`${name} sets PRECRIME_OBJECTIVE`, /PRECRIME_OBJECTIVE/.test(body), 'env var absent');
            expect(`${name} parses --headless`,    /--headless/.test(body),    'flag absent');
            expect(`${name} parses --interactive`, /--interactive/.test(body), 'flag absent');
            expect(`${name} applies headless=>marketplace default`,
                   /PRECRIME_OBJECTIVE=marketplace/.test(body),
                   'no marketplace default branch');
            expect(`${name} applies interactive=>hybrid default`,
                   /PRECRIME_OBJECTIVE=hybrid/.test(body),
                   'no hybrid default branch');
        }

        // Mirror check: same flags must exist in the top-level dev launchers
        // (they are the truth source we copy from). If they go stale, the
        // template copies will follow.
        const TOP_LAUNCHERS = [
            path.join(PRECRIME_ROOT, 'precrime.bat'),
            path.join(PRECRIME_ROOT, 'goose.bat'),
            path.join(PRECRIME_ROOT, 'hermes.bat')
        ];
        for (const lp of TOP_LAUNCHERS) {
            const name = '(top) ' + path.basename(lp);
            if (!fs.existsSync(lp)) continue;
            const body = fs.readFileSync(lp, 'utf8');
            expect(`${name} parses --outreach`,   /--outreach/.test(body),   'flag absent');
            expect(`${name} parses --marketplace`,/--marketplace/.test(body),'flag absent');
            expect(`${name} parses --hybrid`,     /--hybrid/.test(body),     'flag absent');
        }

        // Line-ending guard: cmd.exe needs CRLF for `goto :label`. An LF-only
        // .bat file fails silently with "The system cannot find the batch label
        // specified - args_done" when invoked. This caught a real regression
        // that broke every flag combination on every deployed launcher.
        const ALL_LAUNCHERS_FOR_EOL = [
            path.join(PRECRIME_ROOT, 'templates', 'precrime.bat'),
            path.join(PRECRIME_ROOT, 'templates', 'goose.bat'),
            path.join(PRECRIME_ROOT, 'templates', 'hermes.bat'),
            path.join(PRECRIME_ROOT, 'precrime.bat'),
            path.join(PRECRIME_ROOT, 'goose.bat'),
            path.join(PRECRIME_ROOT, 'hermes.bat')
        ];
        for (const lp of ALL_LAUNCHERS_FOR_EOL) {
            if (!fs.existsSync(lp)) continue;
            const buf = fs.readFileSync(lp);
            let crlf = 0, loneLf = 0;
            for (let i = 0; i < buf.length; i++) {
                if (buf[i] === 0x0A) {
                    if (i > 0 && buf[i - 1] === 0x0D) crlf++;
                    else loneLf++;
                }
            }
            const tag = path.relative(PRECRIME_ROOT, lp).replace(/\\/g, '/');
            expect(`${tag} uses CRLF line endings (cmd.exe goto requires)`,
                   loneLf === 0,
                   `crlf=${crlf} loneLf=${loneLf}`);
        }

        console.log('\n=== Test 51d: workflowStrategy drains factlets before discovery ===');
        const pBias = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pBias.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        await pBias.task.deleteMany({ where: { status: { in: ['ready', 'claimed'] } } });
        // Strict stage-gating prerequisites for testing Stage 4 (APPLY_FACTLET):
        //   - Stage 2: mark every done worker output as judged so judge-needed
        //     work does not suppress Stage 4.
        //   - Stage 3: pause any hot Bookings left over from Test 51 d) so hot
        //     interrupt does not suppress Stage 4.
        await pBias.task.updateMany({
            where: { status: 'done', type: { in: ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE'] } },
            data:  { output: JSON.stringify({ judgedAt: new Date().toISOString(), summary: 'marked judged for factlet-backlog test' }) }
        });
        await pBias.booking.updateMany({
            where: { status: { in: ['leed_ready', 'outreach_ready'] }, shared: false },
            data:  { status: 'brewing' }
        });
        await pBias.source.create({
            data: {
                url: 'https://example.com/source-bias-' + Date.now(),
                channel: 'directory',
                discoveredFrom: 'smoke'
            }
        });
        const biasFactletIds = [];
        for (let i = 0; i < 30; i++) {
            const f = await pBias.factlet.create({
                data: {
                    content: `workflow bias unprocessed factlet ${i} mentions a plausible event signal`,
                    source: `https://example.com/factlet-bias-${Date.now()}-${i}`
                }
            });
            biasFactletIds.push(f.id);
        }
        await pBias.$disconnect();

        const biasPlan = await call('plan_tasks', { mode: 'workflow', objective: 'marketplace' });
        expect('workflowStrategy switches to consume_factlets',
               biasPlan.workflowStrategy?.strategy === 'consume_factlets',
               JSON.stringify(biasPlan.workflowStrategy));
        expect('consume_factlets schedules APPLY_FACTLET',
               (biasPlan.counts || {}).APPLY_FACTLET >= 1,
               JSON.stringify(biasPlan.counts));
        expect('consume_factlets pauses SCRAPE_SOURCE',
               !(biasPlan.counts || {}).SCRAPE_SOURCE,
               JSON.stringify(biasPlan.counts));
        expect('consume_factlets pauses DISCOVER_SOURCES',
               !(biasPlan.counts || {}).DISCOVER_SOURCES,
               JSON.stringify(biasPlan.counts));
        expect('consume_factlets pauses ENRICH_CLIENT',
               !(biasPlan.counts || {}).ENRICH_CLIENT,
               JSON.stringify(biasPlan.counts));

        const pDoneFactlets = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pDoneFactlets.task.deleteMany({ where: { status: { in: ['ready', 'claimed'] } } });
        await pDoneFactlets.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        for (const fid of biasFactletIds) {
            await pDoneFactlets.task.create({
                data: {
                    type: 'APPLY_FACTLET',
                    status: 'done',
                    targetType: 'Factlet',
                    targetId: fid,
                    output: JSON.stringify({ factletIds: [fid], summary: 'smoke processed marker' }),
                    finishedAt: new Date()
                }
            });
        }
        await pDoneFactlets.$disconnect();
        const donePlan = await call('plan_tasks', { mode: 'workflow', objective: 'marketplace' });
        const rescheduledDoneFactlet = (donePlan.created || [])
            .some(t => t.type === 'APPLY_FACTLET' && biasFactletIds.includes(t.targetId));
        expect('terminal APPLY_FACTLET task marks factlet processed',
               !rescheduledDoneFactlet,
               JSON.stringify(donePlan.created || []));

        console.log('\n=== Test 51e: judge-needed work suppresses enrich/scrape/discover in same pass ===');
        // Spec (DOCS/WHAT_I_LEARNED.md, Stage 2): a completed worker Task that
        // carries affected ids but no judgedAt is "judge-needed". While judge
        // work is created or already open, planner must NOT create enrich /
        // scrape / discovery in that pass.
        const pJG = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pJG.task.deleteMany({ where: { status: { in: ['ready', 'claimed'] } } });
        await pJG.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        const jgClient = await pJG.client.create({ data: { name: 'Judge_' + Date.now(), company: 'JudgeCo' } });
        // Done APPLY_FACTLET with affected ids but NO judgedAt -> judge-needed.
        await pJG.task.create({
            data: {
                type:       'APPLY_FACTLET',
                status:     'done',
                targetType: 'Factlet',
                targetId:   'fact_judge_' + Date.now(),
                output:     JSON.stringify({ clientIds: [jgClient.id], bookingIds: [], summary: 'needs judge' }),
                finishedAt: new Date()
            }
        });
        await pJG.$disconnect();

        const jgPlan = await call('plan_tasks', { mode: 'workflow', objective: 'hybrid' });
        expect('plan_tasks(judge-needed) ok', !jgPlan.__rpcError, JSON.stringify(jgPlan.__rpcError || {}));
        const jgTypes = new Set((jgPlan.created || []).map(c => c.type));
        expect('judge-needed pass creates JUDGE_AFFECTED',
               jgTypes.has('JUDGE_AFFECTED'),
               JSON.stringify(Array.from(jgTypes)));
        // Strict stage-gating: judge work at the top of the funnel must
        // suppress every lower stage -- hot action, apply, enrich, scrape,
        // and discovery. Spec WHAT_I_LEARNED.md "Exact Code Changes" #4.
        for (const banned of ['SHOW_HOT_LEEDZ', 'SHARE_BOOKING', 'DRAFT_OUTREACH', 'APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE', 'DISCOVER_SOURCES']) {
            expect(`judge-needed pass strictly suppresses ${banned}`,
                   !jgTypes.has(banned),
                   JSON.stringify(Array.from(jgTypes)));
        }

        console.log('\n=== Test 51f: interactive workflow hot interrupt -- SHOW_HOT_LEEDZ over ENRICH ===');
        // Spec (Stage 3): after judge drains and hot Bookings exist,
        // interactive workflow creates SHOW_HOT_LEEDZ and must not create
        // ENRICH_CLIENT / SCRAPE_SOURCE / DISCOVER_SOURCES in the same pass.
        const pIW = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pIW.task.deleteMany({ where: { status: { in: ['ready', 'claimed'] } } });
        await pIW.session.updateMany({ where: { status: 'active' }, data: { status: 'complete', finishedAt: new Date() } });
        // Mark every prior done worker Task as judged so Stage 2 does not
        // suppress Stage 3 in this pass.
        await pIW.task.updateMany({
            where: { status: 'done', type: { in: ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE'] } },
            data:  { output: JSON.stringify({ judgedAt: new Date().toISOString(), summary: 'marked judged for hot-interrupt test' }) }
        });
        // Seed fresh hot Bookings so Stage 3 has something to fire on -- do
        // not rely on Bookings created in earlier tests, they may have been
        // mutated by intervening planner runs.
        const iwClient = await pIW.client.create({
            data: { name: 'HotInterrupt_' + Date.now(), company: 'HotInterruptCo' }
        });
        await pIW.booking.create({
            data: {
                clientId:  iwClient.id,
                title:     'Hot Interrupt Gig A',
                trade:     'caricatures',
                zip:       '90405',
                startDate: new Date(Date.now() + 30*24*3600*1000),
                endDate:   new Date(Date.now() + 30*24*3600*1000 + 3600000),
                status:    'leed_ready',
                shared:    false
            }
        });
        await pIW.booking.create({
            data: {
                clientId:  iwClient.id,
                title:     'Hot Interrupt Gig B',
                trade:     'caricatures',
                zip:       '90405',
                startDate: new Date(Date.now() + 31*24*3600*1000),
                endDate:   new Date(Date.now() + 31*24*3600*1000 + 3600000),
                status:    'leed_ready',
                shared:    false
            }
        });
        await pIW.$disconnect();

        const iwPlan = await call('plan_tasks', { mode: 'workflow', objective: 'hybrid' });
        expect('plan_tasks(workflow hot interrupt) ok', !iwPlan.__rpcError, JSON.stringify(iwPlan.__rpcError || {}));
        const iwTypes = new Set((iwPlan.created || []).map(c => c.type));
        expect('interactive workflow creates SHOW_HOT_LEEDZ when hot exists',
               iwTypes.has('SHOW_HOT_LEEDZ'),
               JSON.stringify(Array.from(iwTypes)));
        // Strict stage-gating: hot interrupt suppresses APPLY_FACTLET too,
        // not just enrich/scrape/discover. Spec WHAT_I_LEARNED.md "Exact
        // Code Changes" #4 -- once a higher gate creates Tasks, skip all
        // lower gates in the same plan_tasks call.
        for (const banned of ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE', 'DISCOVER_SOURCES']) {
            expect(`workflow hot interrupt strictly suppresses ${banned}`,
                   !iwTypes.has(banned),
                   JSON.stringify(Array.from(iwTypes)));
        }
        // Interactive does NOT auto-create SHARE_BOOKING / DRAFT_OUTREACH --
        // those stay user-driven through the presenter.
        expect('interactive workflow does NOT auto-create SHARE_BOOKING',
               !iwTypes.has('SHARE_BOOKING'),
               JSON.stringify(Array.from(iwTypes)));
        expect('interactive workflow does NOT auto-create DRAFT_OUTREACH',
               !iwTypes.has('DRAFT_OUTREACH'),
               JSON.stringify(Array.from(iwTypes)));

        console.log('\n=== Test 51g: default claim_task priority -- JUDGE > hot action > workers ===');
        // Spec: default claim order is JUDGE_AFFECTED, SHOW_HOT_LEEDZ,
        // SHARE_BOOKING, DRAFT_OUTREACH, APPLY_FACTLET, ENRICH_CLIENT,
        // SCRAPE_SOURCE, DISCOVER_SOURCES. We seed one ready Task of several
        // types and assert claim_task returns them in priority order.
        const pCP = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pCP.task.deleteMany({ where: { status: { in: ['ready', 'claimed'] } } });
        const cpJudge   = await pCP.task.create({ data: { type: 'JUDGE_AFFECTED',  status: 'ready', targetType: 'none' } });
        const cpHot     = await pCP.task.create({ data: { type: 'SHOW_HOT_LEEDZ',  status: 'ready', targetType: 'none' } });
        const cpEnrich  = await pCP.task.create({ data: { type: 'ENRICH_CLIENT',   status: 'ready', targetType: 'Client', targetId: jgClient.id } });
        const cpScrape  = await pCP.task.create({ data: { type: 'SCRAPE_SOURCE',   status: 'ready', targetType: 'Source', targetId: 'src_cp_' + Date.now() } });
        const cpApply   = await pCP.task.create({ data: { type: 'APPLY_FACTLET',   status: 'ready', targetType: 'Factlet', targetId: 'fact_cp_' + Date.now() } });
        await pCP.$disconnect();

        // First default claim -> JUDGE_AFFECTED
        const claim1 = await call('claim_task', { role: 'cp-test' });
        expect('default claim #1 returns JUDGE_AFFECTED',
               claim1.status === 'CLAIMED' && claim1.task && claim1.task.type === 'JUDGE_AFFECTED',
               JSON.stringify(claim1).slice(0, 200));
        // Second default claim -> SHOW_HOT_LEEDZ (judge consumed, hot action next)
        const claim2 = await call('claim_task', { role: 'cp-test' });
        expect('default claim #2 returns SHOW_HOT_LEEDZ',
               claim2.status === 'CLAIMED' && claim2.task && claim2.task.type === 'SHOW_HOT_LEEDZ',
               JSON.stringify(claim2).slice(0, 200));
        // Third default claim -> APPLY_FACTLET (hot drained, workers next; apply before enrich)
        const claim3 = await call('claim_task', { role: 'cp-test' });
        expect('default claim #3 returns APPLY_FACTLET (apply before enrich)',
               claim3.status === 'CLAIMED' && claim3.task && claim3.task.type === 'APPLY_FACTLET',
               JSON.stringify(claim3).slice(0, 200));
        // Fourth default claim -> ENRICH_CLIENT
        const claim4 = await call('claim_task', { role: 'cp-test' });
        expect('default claim #4 returns ENRICH_CLIENT',
               claim4.status === 'CLAIMED' && claim4.task && claim4.task.type === 'ENRICH_CLIENT',
               JSON.stringify(claim4).slice(0, 200));
        // Fifth default claim -> SCRAPE_SOURCE
        const claim5 = await call('claim_task', { role: 'cp-test' });
        expect('default claim #5 returns SCRAPE_SOURCE',
               claim5.status === 'CLAIMED' && claim5.task && claim5.task.type === 'SCRAPE_SOURCE',
               JSON.stringify(claim5).slice(0, 200));

        // Explicit types filter still wins over default priority.
        const pCP2 = new PC2({ datasources: { db: { url: 'file:' + DB_PATH } } });
        await pCP2.task.updateMany({
            where: { id: { in: [cpJudge.id, cpHot.id, cpEnrich.id, cpScrape.id, cpApply.id] } },
            data:  { status: 'ready', claimedAt: null, claimedBy: null }
        });
        await pCP2.$disconnect();
        const claimEnrichOnly = await call('claim_task', { role: 'cp-test', types: ['ENRICH_CLIENT'] });
        expect('explicit types:["ENRICH_CLIENT"] overrides default priority',
               claimEnrichOnly.status === 'CLAIMED' && claimEnrichOnly.task && claimEnrichOnly.task.type === 'ENRICH_CLIENT',
               JSON.stringify(claimEnrichOnly).slice(0, 200));

        console.log('\n=== Test 52: headless_flow.md uses objective-aware plan_tasks ===');
        const headlessFlow = path.join(PRECRIME_ROOT, 'templates', 'skills', 'headless_flow.md');
        const hfBody = fs.existsSync(headlessFlow) ? fs.readFileSync(headlessFlow, 'utf8') : '';
        expect('headless_flow.md references objective',
               hfBody.includes('objective'),
               'objective not mentioned in headless_flow.md');
        expect('headless_flow.md plan_tasks call carries objective',
               hfBody.includes('plan_tasks') && /plan_tasks[\s\S]{0,200}objective/.test(hfBody),
               'plan_tasks call missing objective arg');
        expect('headless_flow.md dispatches DRAFT_OUTREACH',
               hfBody.includes('DRAFT_OUTREACH'),
               'DRAFT_OUTREACH dispatch missing');

        const initWiz = path.join(PRECRIME_ROOT, 'templates', 'skills', 'init-wizard.md');
        const iwBody  = fs.existsSync(initWiz) ? fs.readFileSync(initWiz, 'utf8') : '';
        expect('init-wizard.md describes objective detection',
               iwBody.includes('objective'),
               'init-wizard.md missing objective handling');
        expect('init-wizard.md fails fast on missing Gmail for outreach',
               iwBody.includes('OUTREACH_REQUIRES_GMAIL'),
               'init-wizard.md missing Gmail gate');

        console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
        server.kill();
        process.exit(fail === 0 ? 0 : 1);
    } catch (e) {
        console.error('SMOKE ERROR:', e.message);
        server.kill();
        process.exit(2);
    }
})();
