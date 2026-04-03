#!/usr/bin/env node
/**
 * Pre-Crime — In-Place Database Migration
 *
 * Safely migrates template.sqlite to the current Pre-Crime schema.
 * NEVER destroys data. Strategy:
 *   - New tables       → CREATE TABLE IF NOT EXISTS (safe, idempotent)
 *   - Missing columns  → ALTER TABLE ADD COLUMN (safe, idempotent)
 *   - Existing data    → untouched
 *
 * Steps:
 *   1. Count rows before migration (baseline)
 *   2. Create timestamped backup in this directory
 *   3. Apply schema changes in-place
 *   4. Verify row counts match baseline
 *
 * Usage (from any directory):
 *   node PRECRIME\data\migrate.js [--dry-run]
 *
 * Requires Node.js >= 22.5
 */

'use strict';
process.env.NODE_NO_WARNINGS = '1';

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname);
const DB_FILE  = path.join(DATA_DIR, 'template.sqlite');
const DRY_RUN  = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Authoritative schema — matches PRECRIME\server\mcp\mcp_server.js PC_SCHEMA
// [columnName, SQLiteType, defaultSql | null]
// ---------------------------------------------------------------------------

const SCHEMA = {
  Client: {
    columns: [
      ['id',             'TEXT',     null],
      ['name',           'TEXT',     null],
      ['email',          'TEXT',     null],
      ['phone',          'TEXT',     null],
      ['company',        'TEXT',     null],
      ['website',        'TEXT',     null],
      ['clientNotes',    'TEXT',     null],
      ['dossier',        'TEXT',     null],
      ['targetUrls',     'TEXT',     null],
      ['draft',          'TEXT',     null],
      ['draftStatus',    'TEXT',     null],
      ['warmthScore',    'REAL',     null],
      ['source',         'TEXT',     null],
      ['lastEnriched',   'DATETIME', null],
      ['lastQueueCheck', 'DATETIME', null],
      ['createdAt',      'DATETIME', 'CURRENT_TIMESTAMP'],
      ['updatedAt',      'DATETIME', 'CURRENT_TIMESTAMP'],
    ],
    pk: 'id',
    constraints: [],
  },
  Booking: {
    columns: [
      ['id',               'TEXT',     null],
      ['clientId',         'TEXT',     null],
      ['title',            'TEXT',     null],
      ['description',      'TEXT',     null],
      ['notes',            'TEXT',     null],
      ['location',         'TEXT',     null],
      ['startDate',        'DATETIME', null],
      ['endDate',          'DATETIME', null],
      ['startTime',        'TEXT',     null],
      ['endTime',          'TEXT',     null],
      ['duration',         'REAL',     null],
      ['hourlyRate',       'REAL',     null],
      ['flatRate',         'REAL',     null],
      ['totalAmount',      'REAL',     null],
      ['status',           'TEXT',     "'new'"],
      ['source',           'TEXT',     null],
      ['sourceUrl',        'TEXT',     null],
      ['trade',            'TEXT',     null],
      ['zip',              'TEXT',     null],
      ['shared',           'INTEGER',  '0'],
      ['sharedTo',         'TEXT',     null],
      ['sharedAt',         'INTEGER',  null],
      ['leedPrice',        'INTEGER',  null],
      ['squarePaymentUrl', 'TEXT',     null],
      ['leedId',           'TEXT',     null],
      ['createdAt',        'DATETIME', 'CURRENT_TIMESTAMP'],
      ['updatedAt',        'DATETIME', 'CURRENT_TIMESTAMP'],
    ],
    pk: 'id',
    constraints: ['FOREIGN KEY (clientId) REFERENCES Client(id)'],
  },
  Factlet: {
    columns: [
      ['id',        'TEXT',     null],
      ['content',   'TEXT',     null],
      ['source',    'TEXT',     null],
      ['createdAt', 'DATETIME', 'CURRENT_TIMESTAMP'],
    ],
    pk: 'id',
    constraints: [],
  },
  Config: {
    columns: [
      ['id',                  'TEXT',     null],
      ['companyName',         'TEXT',     null],
      ['companyEmail',        'TEXT',     null],
      ['businessDescription', 'TEXT',     null],
      ['activeEntities',      'TEXT',     null],
      ['defaultTrade',        'TEXT',     null],
      ['marketplaceEnabled',  'INTEGER',  '0'],
      ['leadCaptureEnabled',  'INTEGER',  '0'],
      ['llmApiKey',           'TEXT',     null],
      ['llmProvider',         'TEXT',     null],
      ['llmBaseUrl',          'TEXT',     null],
      ['llmAnthropicVersion', 'TEXT',     null],
      ['llmMaxTokens',        'INTEGER',  '1024'],
      ['leedzEmail',          'TEXT',     null],
      ['leedzSession',        'TEXT',     null],
      ['createdAt',           'DATETIME', 'CURRENT_TIMESTAMP'],
      ['updatedAt',           'DATETIME', 'CURRENT_TIMESTAMP'],
    ],
    pk: 'id',
    constraints: [],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(name) { return `"${name.replace(/"/g, '""')}"`; }

function pad(s, n) { return String(s).padEnd(n); }

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const line = '═'.repeat(62);
console.log(`\n${line}`);
console.log(`  Pre-Crime — Database Migration`);
console.log(`  ${DRY_RUN ? 'DRY RUN — no changes will be written' : 'LIVE — in-place migration'}`);
console.log(line);
console.log(`  DB: ${DB_FILE}`);
console.log(`${line}\n`);

// ---------------------------------------------------------------------------
// Check DB exists
// ---------------------------------------------------------------------------

if (!fs.existsSync(DB_FILE)) {
  console.error(`ERROR: DB not found: ${DB_FILE}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1 — Baseline row counts (read-only)
// ---------------------------------------------------------------------------

console.log('Step 1: Reading baseline row counts...');

const baseline = {};
const ro = new DatabaseSync(DB_FILE, { readOnly: true });

const existingTables = ro
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%'`)
  .all()
  .map(r => r.name);

for (const tname of existingTables) {
  try {
    baseline[tname] = ro.prepare(`SELECT COUNT(*) AS n FROM ${q(tname)}`).get().n;
    console.log(`  ${pad(tname, 20)} ${baseline[tname]} rows`);
  } catch (e) {
    console.warn(`  ⚠ Could not count ${tname}: ${e.message}`);
  }
}

ro.close();

// ---------------------------------------------------------------------------
// Step 2 — Backup
// ---------------------------------------------------------------------------

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const backupPath = path.join(DATA_DIR, `template-backup-${ts}.sqlite`);

if (DRY_RUN) {
  console.log(`\nStep 2 (dry-run): Would create backup → ${backupPath}`);
} else {
  console.log(`\nStep 2: Creating backup...`);
  fs.copyFileSync(DB_FILE, backupPath);
  console.log(`  ✓ Backup created: ${backupPath}`);
}

// ---------------------------------------------------------------------------
// Step 3 — Apply schema migrations
// ---------------------------------------------------------------------------

console.log(`\nStep 3: ${DRY_RUN ? 'Planning' : 'Applying'} schema migrations...`);

const actions = { tablesCreated: [], columnsAdded: [], warnings: [] };

if (!DRY_RUN) {
  const db = new DatabaseSync(DB_FILE);

  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=OFF');

  for (const [tableName, tableDef] of Object.entries(SCHEMA)) {
    const { columns, pk, constraints } = tableDef;

    // 3a. CREATE TABLE IF NOT EXISTS
    const colDefs = columns.map(([name, type, def]) => {
      let s = `  ${q(name)} ${type}`;
      if (name === pk) s += ' PRIMARY KEY';
      if (def !== null) s += ` DEFAULT ${def}`;
      return s;
    });
    if (constraints.length > 0) colDefs.push(...constraints.map(c => `  ${c}`));
    const createSql = `CREATE TABLE IF NOT EXISTS ${q(tableName)} (\n${colDefs.join(',\n')}\n)`;

    try {
      db.exec(createSql);
      if (!existingTables.includes(tableName)) {
        console.log(`  ✓ Created table: ${tableName}`);
        actions.tablesCreated.push(tableName);
      }
    } catch (e) {
      actions.warnings.push(`CREATE TABLE ${tableName}: ${e.message}`);
      console.warn(`  ⚠ CREATE TABLE ${tableName}: ${e.message}`);
    }

    // 3b. ALTER TABLE ADD COLUMN for each column in schema
    for (const [colName, colType, colDef] of columns) {
      const defaultClause = colDef !== null ? ` DEFAULT ${colDef}` : '';
      const alterSql = `ALTER TABLE ${q(tableName)} ADD COLUMN ${q(colName)} ${colType}${defaultClause}`;
      try {
        db.exec(alterSql);
        console.log(`  + ${tableName}.${colName} (${colType}) added`);
        actions.columnsAdded.push({ table: tableName, column: colName });
      } catch (e) {
        if (e.message.toLowerCase().includes('duplicate column')) {
          // Already exists — normal for up-to-date DB
        } else if (e.message.toLowerCase().includes('cannot add a primary key')) {
          // PK column skip
        } else {
          actions.warnings.push(`ALTER TABLE ${tableName} ADD COLUMN ${colName}: ${e.message}`);
          console.warn(`  ⚠ ${tableName}.${colName}: ${e.message}`);
        }
      }
    }
  }

  db.exec('PRAGMA foreign_keys=ON');
  db.close();

  if (actions.tablesCreated.length === 0 && actions.columnsAdded.length === 0) {
    console.log('  ✓ DB is already up to date — no changes needed.');
  }
} else {
  const ro2 = new DatabaseSync(DB_FILE, { readOnly: true });
  for (const [tableName, tableDef] of Object.entries(SCHEMA)) {
    const tableExists = existingTables.includes(tableName);
    if (!tableExists) {
      console.log(`  [NEW TABLE] ${tableName}`);
      continue;
    }
    const existingCols = new Set(
      ro2.prepare(`PRAGMA table_info(${q(tableName)})`).all().map(r => r.name)
    );
    const missing = tableDef.columns.filter(([n]) => !existingCols.has(n)).map(([n]) => n);
    if (missing.length > 0) {
      console.log(`  [ADD COLUMNS] ${tableName}: ${missing.join(', ')}`);
    } else {
      console.log(`  [OK]          ${tableName} — no changes needed`);
    }
  }
  ro2.close();
}

// ---------------------------------------------------------------------------
// Step 4 — Verify
// ---------------------------------------------------------------------------

console.log(`\nStep 4: Verifying row counts...`);

if (!DRY_RUN) {
  const verify = new DatabaseSync(DB_FILE, { readOnly: true });
  let allGood = true;

  for (const [tname, before] of Object.entries(baseline)) {
    try {
      const after = verify.prepare(`SELECT COUNT(*) AS n FROM ${q(tname)}`).get().n;
      const ok = after >= before;
      if (!ok) allGood = false;
      const status = ok ? '✓' : '✗ MISMATCH';
      console.log(`  ${status}  ${pad(tname, 20)} before=${before}  after=${after}`);
    } catch (e) {
      console.warn(`  ⚠ Could not verify ${tname}: ${e.message}`);
    }
  }

  for (const tname of actions.tablesCreated) {
    try {
      const count = verify.prepare(`SELECT COUNT(*) AS n FROM ${q(tname)}`).get().n;
      console.log(`  ✓  ${pad(tname, 20)} (new) ${count} rows`);
    } catch (e) {
      console.warn(`  ⚠ New table ${tname}: ${e.message}`);
    }
  }

  verify.close();

  console.log(`\n${line}`);
  console.log(`  Migration Complete`);
  console.log(line);
  console.log(`  Backup : ${backupPath}`);
  if (actions.tablesCreated.length > 0)
    console.log(`  Tables created : ${actions.tablesCreated.join(', ')}`);
  if (actions.columnsAdded.length > 0)
    console.log(`  Columns added  : ${actions.columnsAdded.map(c => `${c.table}.${c.column}`).join(', ')}`);
  if (actions.warnings.length > 0) {
    console.log(`\n  Warnings:`);
    actions.warnings.forEach(w => console.log(`    ⚠ ${w}`));
  }
  if (allGood) {
    console.log(`\n  ✓ All row counts verified — no data lost.`);
  } else {
    console.log(`\n  ✗ Row count mismatch detected. Review warnings. Backup is at:\n    ${backupPath}`);
  }
  console.log(`${line}\n`);
} else {
  console.log(`\n${line}`);
  console.log(`  DRY RUN complete — no changes written.`);
  console.log(`  Run without --dry-run to execute.`);
  console.log(`${line}\n`);
}
