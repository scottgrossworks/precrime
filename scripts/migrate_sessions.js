#!/usr/bin/env node
/**
 * migrate_sessions.js — Add Session + SessionEvent tables to a Pre-Crime SQLite DB.
 *
 * SAFETY: Idempotent. Uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 *         Does NOT touch any existing rows in any existing table. Safe to re-run.
 *
 * USAGE:
 *   node scripts/migrate_sessions.js                    # migrates all 3 known deployments
 *   node scripts/migrate_sessions.js <path-to.sqlite>   # migrates one specific DB
 *   node scripts/migrate_sessions.js --dry-run          # report what would happen, no writes
 *
 * The three known deployments (auto-detected, skipped if missing):
 *   WKG/PRECRIME/data/myproject.sqlite           (canonical / dev)
 *   WKG/TDS/precrime/data/myproject.sqlite       (TDS deployment, ~461 clients)
 *   WKG/PHOTOBOOTH/precrime/data/myproject.sqlite (legacy)
 *
 * Why raw SQL and not `prisma migrate`?
 *   `prisma migrate` tracks state in `_prisma_migrations` and can refuse to apply
 *   if the migration history is inconsistent across deployments. CREATE TABLE
 *   IF NOT EXISTS is declarative, idempotent, and zero-risk. Run it everywhere.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// --- Locate @prisma/client ----------------------------------------------------
// Prefer the canonical PRECRIME copy; fall back to whatever's resolvable.
const PRECRIME_ROOT = path.resolve(__dirname, '..');
const candidatePaths = [
    path.join(PRECRIME_ROOT, 'server', 'node_modules', '@prisma', 'client'),
    path.join(PRECRIME_ROOT, 'node_modules', '@prisma', 'client'),
];
let PrismaClient = null;
for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
        try {
            ({ PrismaClient } = require(p));
            break;
        } catch (e) { /* try next */ }
    }
}
if (!PrismaClient) {
    try {
        ({ PrismaClient } = require('@prisma/client'));
    } catch (e) {
        console.error('[migrate_sessions] FATAL: cannot load @prisma/client. Run `npm install` in WKG/PRECRIME/server first.');
        process.exit(2);
    }
}

// --- Migration SQL ------------------------------------------------------------
// CREATE TABLE IF NOT EXISTS is idempotent. Re-running this script on a DB
// that already has these tables is a no-op.
//
// Column types match what Prisma generates for SQLite from schema.prisma:
//   String       -> TEXT
//   String?      -> TEXT (nullable)
//   Int          -> INTEGER
//   Int?         -> INTEGER (nullable)
//   DateTime     -> DATETIME (Prisma stores as ISO-8601 TEXT in SQLite, but DATETIME affinity is fine)
//   DateTime?    -> DATETIME (nullable)
//   @default(now()) on DateTime -> DEFAULT CURRENT_TIMESTAMP
const MIGRATIONS = [
    {
        name: 'Session',
        sql: `
            CREATE TABLE IF NOT EXISTS "Session" (
                "id"          TEXT NOT NULL PRIMARY KEY,
                "workflow"    TEXT NOT NULL,
                "status"      TEXT NOT NULL DEFAULT 'active',
                "targetCount" INTEGER,
                "startedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "finishedAt"  DATETIME,
                "metadata"    TEXT
            );
        `
    },
    {
        name: 'SessionEvent',
        sql: `
            CREATE TABLE IF NOT EXISTS "SessionEvent" (
                "id"        TEXT NOT NULL PRIMARY KEY,
                "sessionId" TEXT NOT NULL,
                "ts"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "action"    TEXT NOT NULL,
                "payload"   TEXT,
                CONSTRAINT "SessionEvent_sessionId_fkey"
                    FOREIGN KEY ("sessionId") REFERENCES "Session" ("id")
                    ON DELETE CASCADE ON UPDATE CASCADE
            );
        `
    },
    {
        name: 'idx_SessionEvent_sessionId',
        sql: `CREATE INDEX IF NOT EXISTS "SessionEvent_sessionId_idx" ON "SessionEvent" ("sessionId");`
    },
    {
        name: 'idx_SessionEvent_action',
        sql: `CREATE INDEX IF NOT EXISTS "SessionEvent_action_idx" ON "SessionEvent" ("action");`
    }
];

// --- DB targeting -------------------------------------------------------------
const KNOWN_TARGETS = [
    { label: 'PRECRIME (canonical)', path: 'C:\\Users\\Admin\\Desktop\\WKG\\PRECRIME\\data\\myproject.sqlite' },
    { label: 'TDS (deployment)',     path: 'C:\\Users\\Admin\\Desktop\\WKG\\TDS\\precrime\\data\\myproject.sqlite' },
    { label: 'PHOTOBOOTH (legacy)',  path: 'C:\\Users\\Admin\\Desktop\\WKG\\PHOTOBOOTH\\precrime\\data\\myproject.sqlite' }
];

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const explicitArg = argv.find(a => !a.startsWith('--'));

let targets;
if (explicitArg) {
    if (!fs.existsSync(explicitArg)) {
        console.error(`[migrate_sessions] FATAL: db not found: ${explicitArg}`);
        process.exit(2);
    }
    targets = [{ label: 'CUSTOM', path: path.resolve(explicitArg) }];
} else {
    targets = KNOWN_TARGETS.filter(t => fs.existsSync(t.path));
    if (targets.length === 0) {
        console.error('[migrate_sessions] FATAL: none of the known DB paths exist.');
        process.exit(2);
    }
}

// --- Helpers ------------------------------------------------------------------
async function tableExists(prisma, tableName) {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
        tableName
    );
    return rows.length > 0;
}

async function rowCount(prisma, tableName) {
    try {
        const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${tableName}"`);
        return Number(rows[0]?.n ?? 0);
    } catch {
        return null;
    }
}

async function migrateOne(target) {
    const dbPath = target.path;
    process.env.DATABASE_URL = `file:${dbPath}`;
    console.log(`\n========== ${target.label} ==========`);
    console.log(`DB: ${dbPath}`);

    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    try {
        // Pre-state: existence + row counts of legacy tables (should be untouched after run).
        const legacyTables = ['Client', 'Booking', 'Factlet', 'ClientFactlet', 'Config'];
        const before = {};
        for (const t of legacyTables) {
            before[t] = await rowCount(prisma, t);
        }
        const sessionExistedBefore      = await tableExists(prisma, 'Session');
        const sessionEventExistedBefore = await tableExists(prisma, 'SessionEvent');

        console.log('Pre-migration state:');
        for (const t of legacyTables) {
            console.log(`  ${t.padEnd(15)} ${before[t] === null ? '(missing)' : `${before[t]} rows`}`);
        }
        console.log(`  Session         ${sessionExistedBefore ? '(exists)' : '(missing)'}`);
        console.log(`  SessionEvent    ${sessionEventExistedBefore ? '(exists)' : '(missing)'}`);

        if (DRY_RUN) {
            console.log('--dry-run: would apply', MIGRATIONS.map(m => m.name).join(', '));
            return { ok: true, skipped: true };
        }

        // Apply each migration step. CREATE TABLE/INDEX IF NOT EXISTS is idempotent.
        for (const m of MIGRATIONS) {
            await prisma.$executeRawUnsafe(m.sql);
            console.log(`  applied: ${m.name}`);
        }

        // Post-state: confirm legacy tables untouched, new tables present.
        const after = {};
        for (const t of legacyTables) {
            after[t] = await rowCount(prisma, t);
        }
        const sessionExistsAfter      = await tableExists(prisma, 'Session');
        const sessionEventExistsAfter = await tableExists(prisma, 'SessionEvent');

        let dataLoss = false;
        for (const t of legacyTables) {
            if (before[t] !== null && before[t] !== after[t]) {
                console.error(`  !! DATA LOSS: ${t} ${before[t]} -> ${after[t]}`);
                dataLoss = true;
            }
        }
        if (!sessionExistsAfter || !sessionEventExistsAfter) {
            console.error('  !! New tables not present after migration.');
            return { ok: false };
        }

        console.log('Post-migration state:');
        for (const t of legacyTables) {
            console.log(`  ${t.padEnd(15)} ${after[t] === null ? '(missing)' : `${after[t]} rows`}`);
        }
        console.log(`  Session         present`);
        console.log(`  SessionEvent    present`);

        return { ok: !dataLoss };
    } catch (e) {
        console.error(`[migrate_sessions] ${target.label} FAILED: ${e.message}`);
        return { ok: false, error: e.message };
    } finally {
        await prisma.$disconnect();
    }
}

// --- Main ---------------------------------------------------------------------
(async () => {
    console.log(`[migrate_sessions] ${DRY_RUN ? 'DRY RUN — ' : ''}targets: ${targets.length}`);
    const results = [];
    for (const t of targets) {
        const r = await migrateOne(t);
        results.push({ label: t.label, ...r });
    }

    console.log('\n========== SUMMARY ==========');
    let allOk = true;
    for (const r of results) {
        const status = r.ok ? (r.skipped ? 'DRY-RUN' : 'OK') : 'FAIL';
        console.log(`  ${status.padEnd(8)} ${r.label}${r.error ? '  ' + r.error : ''}`);
        if (!r.ok) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
})();
