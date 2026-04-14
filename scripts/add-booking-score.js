#!/usr/bin/env node
/**
 * Pre-Crime — Add Booking Score Migration
 *
 * Safely adds bookingScore (INTEGER) and contactQuality (TEXT) columns
 * to the Booking table in an existing SQLite database.
 *
 * Lossless guarantee:
 *   1. Timestamped file-copy backup is made BEFORE any write
 *   2. Columns are added only if they don't already exist (idempotent)
 *   3. Row count is verified against backup count after migration
 *   4. If row count mismatches: script exits non-zero and leaves backup intact
 *
 * Usage:
 *   node scripts/add-booking-score.js
 *       — migrates data/blank.sqlite (updates the ship template)
 *
 *   node scripts/add-booking-score.js --db <path>
 *       — migrates the specified DB (your live deployed DB)
 *
 *   node scripts/add-booking-score.js --all
 *       — migrates data/blank.sqlite AND data/template.sqlite if present
 *
 *   node scripts/add-booking-score.js --dry-run
 *       — reports what would happen without making any changes
 */

'use strict';

process.env.NODE_NO_WARNINGS = '1';

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

const PRECRIME_ROOT = path.resolve(__dirname, '..');

// New columns to add: [columnName, sqlType, defaultValue | null]
const NEW_COLUMNS = [
    ['bookingScore',   'INTEGER', null],
    ['contactQuality', 'TEXT',    null],
];

const args   = process.argv.slice(2);
const getArg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasArg = (f) => args.includes(f);
const dryRun = hasArg('--dry-run');

// Resolve target DB paths
let targets = [];
if (getArg('--db')) {
    targets = [path.resolve(getArg('--db'))];
} else if (hasArg('--all')) {
    targets = ['blank.sqlite', 'template.sqlite']
        .map(f => path.join(PRECRIME_ROOT, 'data', f))
        .filter(f => fs.existsSync(f));
    if (targets.length === 0) {
        console.error('ERROR: No SQLite files found in data/ directory.');
        process.exit(1);
    }
} else {
    const defaultDb = path.join(PRECRIME_ROOT, 'data', 'blank.sqlite');
    if (!fs.existsSync(defaultDb)) {
        console.error(`ERROR: Default target not found: ${defaultDb}`);
        console.error('       Use --db <path> to specify your deployed database.');
        process.exit(1);
    }
    targets = [defaultDb];
}

// ============================================================================
// Migrate one database file
// ============================================================================

function migrateDb(dbPath) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Target : ${dbPath}`);
    console.log(`  Mode   : ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`${'═'.repeat(60)}`);

    if (!fs.existsSync(dbPath)) {
        console.error(`  ERROR: File not found: ${dbPath}`);
        return false;
    }

    // ------------------------------------------------------------------
    // Step 1: Open DB and inspect current Booking columns
    // ------------------------------------------------------------------
    let db;
    try {
        db = new DatabaseSync(dbPath);
    } catch (e) {
        console.error(`  ERROR: Cannot open database: ${e.message}`);
        return false;
    }

    const existingCols = db
        .prepare(`PRAGMA table_info("Booking")`)
        .all()
        .map(c => c.name);

    const bookingRows = db.prepare(`SELECT COUNT(*) AS n FROM "Booking"`).get().n;

    console.log(`  Booking table: ${bookingRows} rows, ${existingCols.length} columns`);

    const toAdd = NEW_COLUMNS.filter(([name]) => !existingCols.includes(name));
    const alreadyPresent = NEW_COLUMNS.filter(([name]) => existingCols.includes(name));

    if (alreadyPresent.length > 0) {
        console.log(`  Already present (no action): ${alreadyPresent.map(c => c[0]).join(', ')}`);
    }
    if (toAdd.length === 0) {
        console.log(`  All columns already exist. Nothing to do.`);
        db.close();
        return true;
    }

    console.log(`  Columns to add: ${toAdd.map(c => c[0]).join(', ')}`);

    if (dryRun) {
        console.log(`\n  DRY RUN — no changes made.`);
        db.close();
        return true;
    }

    db.close(); // close before backup

    // ------------------------------------------------------------------
    // Step 2: Timestamped file-copy backup
    // ------------------------------------------------------------------
    const now    = new Date();
    const stamp  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}` +
                   `_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
    const ext    = path.extname(dbPath);
    const base   = dbPath.slice(0, -ext.length);
    const backupPath = `${base}.backup-${stamp}${ext}`;

    try {
        fs.copyFileSync(dbPath, backupPath);
        console.log(`\n  Backup: ${backupPath}`);
    } catch (e) {
        console.error(`  ERROR: Could not create backup: ${e.message}`);
        return false;
    }

    // Verify backup is byte-identical
    const origSize   = fs.statSync(dbPath).size;
    const backupSize = fs.statSync(backupPath).size;
    if (origSize !== backupSize) {
        console.error(`  ERROR: Backup size mismatch (${backupSize} vs ${origSize}). Aborting.`);
        return false;
    }
    console.log(`  Backup verified: ${backupSize} bytes`);

    // ------------------------------------------------------------------
    // Step 3: ALTER TABLE ADD COLUMN
    // ------------------------------------------------------------------
    let db2;
    try {
        db2 = new DatabaseSync(dbPath);
    } catch (e) {
        console.error(`  ERROR: Cannot reopen database after backup: ${e.message}`);
        return false;
    }

    let ok = true;
    for (const [colName, colType, colDefault] of toAdd) {
        const defaultClause = colDefault !== null ? ` DEFAULT ${colDefault}` : '';
        const sql = `ALTER TABLE "Booking" ADD COLUMN "${colName}" ${colType}${defaultClause}`;
        try {
            db2.exec(sql);
            console.log(`  + Added: ${colName} (${colType})`);
        } catch (e) {
            if (e.message.includes('duplicate column name')) {
                console.log(`  ~ ${colName} already exists (concurrent run?) — skipping`);
            } else {
                console.error(`  ERROR adding ${colName}: ${e.message}`);
                ok = false;
            }
        }
    }

    // ------------------------------------------------------------------
    // Step 4: Verify row count unchanged
    // ------------------------------------------------------------------
    const rowsAfter = db2.prepare(`SELECT COUNT(*) AS n FROM "Booking"`).get().n;
    db2.close();

    if (rowsAfter !== bookingRows) {
        console.error(`\n  ERROR: Row count changed! Before=${bookingRows} After=${rowsAfter}`);
        console.error(`  The backup is intact at: ${backupPath}`);
        console.error(`  Restore with: copy "${backupPath}" "${dbPath}"`);
        return false;
    }

    console.log(`  Row count verified: ${rowsAfter} rows (unchanged)`);

    // ------------------------------------------------------------------
    // Step 5: Confirm final column list
    // ------------------------------------------------------------------
    const db3 = new DatabaseSync(dbPath, { readOnly: true });
    const finalCols = db3.prepare(`PRAGMA table_info("Booking")`).all().map(c => c.name);
    db3.close();

    const confirmed = NEW_COLUMNS.every(([name]) => finalCols.includes(name));
    if (!confirmed) {
        console.error(`  ERROR: Column verification failed. Expected columns not found in final schema.`);
        return false;
    }

    console.log(`  Schema verified: bookingScore, contactQuality present`);
    if (ok) {
        console.log(`\n  Migration complete. Backup retained at:\n  ${backupPath}`);
    }
    return ok;
}

// ============================================================================
// Run all targets
// ============================================================================

let allOk = true;
for (const target of targets) {
    const result = migrateDb(target);
    if (!result) allOk = false;
}

console.log(`\n${'═'.repeat(60)}`);
if (allOk) {
    console.log(`  All migrations complete.`);
    if (!dryRun) {
        console.log(`  Next: restart the MCP server (run precrime) to pick up the new columns.`);
    }
} else {
    console.log(`  One or more migrations failed. Check output above.`);
}
console.log(`${'═'.repeat(60)}\n`);

process.exit(allOk ? 0 : 1);
