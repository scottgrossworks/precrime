#!/usr/bin/env node
/**
 * Pre-Crime -- Zombie session cleanup
 *
 * Marks all 'active' sessions that have zero save_attempt events as 'abandoned'.
 * Useful after a goose / hermes / claude crash leaves a session orphaned in the DB,
 * which would otherwise trip the watchdog on the next agent's first read action.
 *
 * Usage:
 *   node data/cleanup-zombie-sessions.js
 *   node data/cleanup-zombie-sessions.js --db <path>
 *   node data/cleanup-zombie-sessions.js --db <path> --dry-run
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PRECRIME_ROOT = path.resolve(__dirname, '..');

let Database;
try {
    Database = require(path.join(PRECRIME_ROOT, 'server', 'node_modules', 'better-sqlite3'));
} catch (e) {
    console.error('ERROR: better-sqlite3 not found. Run "cd server && npm install".');
    process.exit(1);
}

const args = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const dryRun = args.includes('--dry-run');

const dbPath = path.resolve(getArg('--db') || path.join(PRECRIME_ROOT, 'data', 'myproject.sqlite'));
if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: DB not found: ${dbPath}`);
    process.exit(1);
}

console.log(`DB: ${dbPath}${dryRun ? '  (DRY RUN)' : ''}\n`);

const db = new Database(dbPath);

// WAL checkpoint
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

// Find active sessions with 0 save_attempt events
const zombies = db.prepare(`
    SELECT s.id, s.workflow, s.startedAt,
           (SELECT COUNT(*) FROM SessionEvent e
            WHERE e.sessionId = s.id AND e.action = 'save_attempt') AS attempts
    FROM Session s
    WHERE s.status = 'active'
    ORDER BY s.startedAt ASC
`).all();

if (zombies.length === 0) {
    console.log('No active sessions found. Nothing to clean up.');
    db.close();
    process.exit(0);
}

console.log(`Found ${zombies.length} active session(s):`);
for (const z of zombies) {
    const ageSec = Math.round((Date.now() - new Date(z.startedAt).getTime()) / 1000);
    const ageHrs = (ageSec / 3600).toFixed(1);
    console.log(`  ${z.id}  workflow="${z.workflow}"  age=${ageHrs}h  saves=${z.attempts}`);
}
console.log('');

const toAbandon = zombies.filter(z => z.attempts === 0);
console.log(`Of these, ${toAbandon.length} have 0 save attempts (true zombies).`);

if (toAbandon.length === 0) {
    console.log('Nothing to mark abandoned.');
    db.close();
    process.exit(0);
}

if (dryRun) {
    console.log('Dry run: would mark these as abandoned:');
    for (const z of toAbandon) console.log(`  ${z.id}`);
    db.close();
    process.exit(0);
}

const updateStmt = db.prepare(`
    UPDATE Session SET status='abandoned', finishedAt=CURRENT_TIMESTAMP WHERE id = ?
`);
const eventStmt = db.prepare(`
    INSERT INTO SessionEvent (id, sessionId, ts, action, payload)
    VALUES (?, ?, CURRENT_TIMESTAMP, 'auto_abandoned', ?)
`);

for (const z of toAbandon) {
    updateStmt.run(z.id);
    const eventId = 'evt_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    eventStmt.run(eventId, z.id, JSON.stringify({ reason: 'manual_cleanup_zombie_sessions_script' }));
    console.log(`  ABANDONED: ${z.id}`);
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

['-shm', '-wal'].forEach(suf => {
    const p = dbPath + suf;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
});

console.log(`\nCleanup complete. ${toAbandon.length} session(s) marked abandoned.`);
