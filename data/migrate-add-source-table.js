#!/usr/bin/env node
/**
 * Pre-Crime -- Source table migration (Pass 2)
 *
 * Adds the Source table to an existing deployment DB and seeds it from the
 * markdown _sources.md / discovered_directories.md files.
 *
 * Idempotent. Safe to run multiple times. Uses CREATE TABLE IF NOT EXISTS
 * and INSERT OR IGNORE so re-runs are no-ops.
 *
 * The same logic runs at MCP boot via ensureSourceTable() and at init-wizard
 * Step 1.5 via pipeline.import_sources. This script is a standalone fallback
 * for when the user wants to migrate without booting MCP, or to verify state.
 *
 * Usage:
 *   node data/migrate-add-source-table.js
 *       (defaults: --db data/myproject.sqlite, --seeds skills/)
 *
 *   node data/migrate-add-source-table.js --db <path-to-sqlite>
 *
 *   node data/migrate-add-source-table.js \
 *       --db "C:\path\to\deployment\data\myproject.sqlite" \
 *       --seeds "C:\path\to\deployment\skills"
 *
 *   node data/migrate-add-source-table.js --dry-run
 *       (shows the plan without writing)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PRECRIME_ROOT = path.resolve(__dirname, '..');

let Database;
try {
    Database = require(path.join(PRECRIME_ROOT, 'server', 'node_modules', 'better-sqlite3'));
} catch (e) {
    console.error('ERROR: better-sqlite3 not found in server/node_modules.');
    console.error('       Run "cd server && npm install" first, then re-run this script.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasArg = f => args.includes(f);
const dryRun = hasArg('--dry-run');

if (hasArg('--help') || hasArg('-h')) {
    console.log(`
Pre-Crime -- Source table migration

Usage:
  node data/migrate-add-source-table.js [options]

Options:
  --db <path>      Path to .sqlite file. Default: data/myproject.sqlite (relative to PRECRIME root)
  --seeds <dir>    Path to skills/ directory holding the seed files. Default: skills/ (relative to PRECRIME root)
  --dry-run        Show what would happen, write nothing
  --help           This message

Examples:
  Local PRECRIME source DB:
    node data/migrate-add-source-table.js

  External deployment (DALLAS):
    node data/migrate-add-source-table.js \\
        --db "C:\\Users\\Admin\\Desktop\\WKG\\PHOTOBOOTH\\DALLAS\\precrime\\data\\myproject.sqlite" \\
        --seeds "C:\\Users\\Admin\\Desktop\\WKG\\PHOTOBOOTH\\DALLAS\\precrime\\skills"
`);
    process.exit(0);
}

const dbPath  = path.resolve(getArg('--db')    || path.join(PRECRIME_ROOT, 'data', 'myproject.sqlite'));
const seedDir = path.resolve(getArg('--seeds') || path.join(PRECRIME_ROOT, 'skills'));

if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: DB not found: ${dbPath}`);
    process.exit(1);
}
if (!fs.existsSync(seedDir)) {
    console.error(`ERROR: Seeds dir not found: ${seedDir}`);
    process.exit(1);
}

console.log(`${'='.repeat(62)}`);
console.log(`  Pre-Crime -- Source table migration${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`${'='.repeat(62)}`);
console.log(`  DB:    ${dbPath}`);
console.log(`  Seeds: ${seedDir}`);
console.log('');

// ---------------------------------------------------------------------------
// Helpers (mirrors server/mcp/mcp_server.js normalizeSourceUrl + inferSubtype)
// ---------------------------------------------------------------------------

const VALID_CHANNELS = new Set(['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website']);

function normalizeSourceUrl(input, channel) {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

    if (channel === 'reddit') {
        const sub = raw.replace(/^r\//i, '').replace(/^\//, '');
        return `https://www.reddit.com/r/${sub}`;
    }
    if (channel === 'ig') {
        if (raw.startsWith('@')) return `https://www.instagram.com/${raw.slice(1)}/`;
        if (raw.startsWith('#')) return `https://www.instagram.com/explore/tags/${raw.slice(1)}/`;
        return `https://www.instagram.com/${raw}/`;
    }
    if (channel === 'x') {
        if (raw.startsWith('@')) return `https://x.com/${raw.slice(1)}`;
        if (raw.startsWith('#')) return `https://x.com/hashtag/${raw.slice(1)}`;
        return `https://x.com/search?q=${encodeURIComponent(raw)}`;
    }
    return `https://${raw}`;
}

function inferSubtype(input, channel) {
    const raw = (input || '').trim();
    if (channel === 'ig') return raw.startsWith('#') ? 'hashtag' : 'account';
    if (channel === 'reddit') return 'subreddit';
    if (channel === 'x') {
        if (raw.startsWith('@')) return 'account';
        if (raw.startsWith('#')) return 'hashtag';
        return 'keyword';
    }
    if (channel === 'rss') return 'feed';
    if (channel === 'directory') return 'directory';
    return null;
}

// Simple cuid-style ID. Doesn't need to be cryptographically unique --
// uniqueness comes from the URL UNIQUE constraint, not the id.
function makeId() {
    return 'c' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// WAL checkpoint
// ---------------------------------------------------------------------------

function walCheckpoint(p) {
    const shm = p + '-shm';
    const wal = p + '-wal';
    if (fs.existsSync(shm) || fs.existsSync(wal)) {
        const ck = new Database(p);
        ck.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        ck.close();
        try { if (fs.existsSync(shm)) fs.unlinkSync(shm); } catch (_) {}
        try { if (fs.existsSync(wal)) fs.unlinkSync(wal); } catch (_) {}
        return true;
    }
    return false;
}

if (walCheckpoint(dbPath)) {
    console.log('WAL checkpointed (cleaned residual -shm/-wal files).\n');
}

// ---------------------------------------------------------------------------
// Step 1: CREATE TABLE IF NOT EXISTS Source (+ indexes)
// ---------------------------------------------------------------------------

console.log('Step 1: Ensuring Source table exists...');

if (dryRun) {
    console.log('  [dry-run] Would: CREATE TABLE IF NOT EXISTS Source (... 13 columns ...)');
    console.log('  [dry-run] Would: 4x CREATE INDEX IF NOT EXISTS');
} else {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS Source (
            id             TEXT PRIMARY KEY,
            url            TEXT NOT NULL,
            channel        TEXT NOT NULL,
            subtype        TEXT,
            label          TEXT,
            category       TEXT,
            scrapedAt      DATETIME,
            claimedAt      DATETIME,
            claimedBy      TEXT,
            clientsFound   INTEGER NOT NULL DEFAULT 0,
            failedReason   TEXT,
            discoveredAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            discoveredFrom TEXT
        )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS Source_url_key ON Source(url)`);
    db.exec(`CREATE INDEX IF NOT EXISTS Source_channel_idx ON Source(channel)`);
    db.exec(`CREATE INDEX IF NOT EXISTS Source_scrapedAt_idx ON Source(scrapedAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS Source_claimedAt_idx ON Source(claimedAt)`);
    db.close();
    console.log('  Source table verified.');
}
console.log('');

// ---------------------------------------------------------------------------
// Step 2: Seed from markdown
// ---------------------------------------------------------------------------

console.log('Step 2: Seeding Source rows from markdown files...');

const seedFiles = [
    { rel: 'source-discovery/discovered_directories.md', channel: 'directory', format: 'directory' },
    { rel: 'rss-factlet-harvester/rss_sources.md',       channel: 'rss',       format: 'rss'       },
    { rel: 'fb-factlet-harvester/fb_sources.md',         channel: 'fb',        format: 'plain'     },
    { rel: 'ig-factlet-harvester/ig_sources.md',         channel: 'ig',        format: 'handle'    },
    { rel: 'reddit-factlet-harvester/reddit_sources.md', channel: 'reddit',    format: 'handle'    },
    { rel: 'x-factlet-harvester/x_sources.md',           channel: 'x',         format: 'handle'    }
];

const summary = { byChannel: {}, total_added: 0, total_duplicates: 0, total_invalid: 0 };

const db = dryRun ? null : new Database(dbPath);
const insertStmt = dryRun ? null : db.prepare(`
    INSERT OR IGNORE INTO Source (id, url, channel, subtype, label, category, discoveredAt)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

for (const sf of seedFiles) {
    const fullPath = path.join(seedDir, sf.rel);
    if (!fs.existsSync(fullPath)) {
        summary.byChannel[sf.channel] = { missing: true };
        console.log(`  [${sf.channel.padEnd(9)}] SEED FILE MISSING: ${sf.rel}`);
        continue;
    }

    const lines = fs.readFileSync(fullPath, 'utf8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    let added = 0, duplicates = 0, invalid = 0;
    for (const line of lines) {
        let url, subtype = null, label = null, category = null;

        if (sf.format === 'directory') {
            const parts = line.split('|').map(p => p.trim());
            url = parts[0];
            subtype = parts[1] || 'directory';
            category = parts[1] || null;
        } else if (sf.format === 'rss') {
            const parts = line.split('|').map(p => p.trim());
            url = parts[0];
            label = parts[1] || null;
            category = parts[2] || null;
            subtype = 'feed';
        } else if (sf.format === 'handle') {
            url = line;
            subtype = inferSubtype(line, sf.channel);
        } else {
            url = line;
        }

        const normalized = normalizeSourceUrl(url, sf.channel);
        if (!normalized) { invalid++; continue; }

        if (dryRun) {
            added++; // pretend
        } else {
            try {
                const r = insertStmt.run(makeId(), normalized, sf.channel, subtype, label, category);
                if (r.changes > 0) added++; else duplicates++;
            } catch (e) {
                invalid++;
            }
        }
    }

    summary.byChannel[sf.channel] = { added, duplicates, invalid, total_lines: lines.length };
    summary.total_added += added;
    summary.total_duplicates += duplicates;
    summary.total_invalid += invalid;

    console.log(`  [${sf.channel.padEnd(9)}] lines: ${String(lines.length).padStart(3)}  added: ${String(added).padStart(3)}  dup: ${String(duplicates).padStart(3)}  invalid: ${invalid}`);
}

if (db) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
}

// Final WAL cleanup
['-shm', '-wal'].forEach(suf => {
    const p = dbPath + suf;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Step 3: Verify counts
// ---------------------------------------------------------------------------

console.log('');
console.log('Step 3: Verifying...');

if (!dryRun) {
    const verify = new Database(dbPath, { readonly: true });
    const totalRows = verify.prepare('SELECT COUNT(*) as n FROM Source').get().n;
    const byChannel = verify.prepare('SELECT channel, COUNT(*) as n FROM Source GROUP BY channel ORDER BY channel').all();
    verify.close();

    console.log(`  Source rows in DB: ${totalRows}`);
    for (const r of byChannel) {
        console.log(`    ${r.channel.padEnd(9)}: ${r.n}`);
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log('='.repeat(62));
console.log(`  Migration complete${dryRun ? ' (DRY RUN -- nothing written)' : ''}`);
console.log('='.repeat(62));
console.log(`  Total added:      ${summary.total_added}`);
console.log(`  Total duplicates: ${summary.total_duplicates}`);
console.log(`  Total invalid:    ${summary.total_invalid}`);
console.log('');

if (summary.total_added === 0 && summary.total_duplicates === 0) {
    console.log('  Note: no rows added or seen. Check that seed files contain entries');
    console.log('  (each file may have only header comments).');
}
