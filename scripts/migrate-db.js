#!/usr/bin/env node
/**
 * Pre-Crime — Lossless Database Migration Tool
 *
 * Migrates any SQLite database to the Pre-Crime schema without losing data.
 *
 *   SOURCE COLUMN EXISTS IN TARGET  → copied directly
 *   SOURCE COLUMN MISSING IN TARGET → column added to target, data preserved
 *   TARGET COLUMN MISSING IN SOURCE → stays NULL (enrichment fills it later)
 *   EXTRA SOURCE TABLE (no match)   → copied to target as _src_{tableName}
 *
 * Uses SQLite ATTACH — no npm packages required. Requires Node.js >= 22.5.
 *
 * Usage (from PRECRIME root or anywhere):
 *   node scripts/migrate-db.js --source <path> [--target <path>] [--dry-run]
 *
 *   --source   Path to the SQLite file to migrate FROM (read-only, never modified)
 *   --target   Path to write the migrated DB (default: {source-name}-migrated.sqlite)
 *              If the target already exists, new rows are added (INSERT OR IGNORE).
 *              If the target does NOT exist, it is created from template.sqlite.
 *   --dry-run  Inspect and show migration plan; write nothing
 */

'use strict';

// Suppress the "SQLite is experimental" warning — we know, it's fine on 22.17+
process.env.NODE_NO_WARNINGS = '1';

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args   = process.argv.slice(2);
const getArg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasArg = (f) => args.includes(f);

if (hasArg('--help') || hasArg('-h')) {
  console.log(`
Pre-Crime — Lossless Database Migration Tool

Usage:
  node scripts/migrate-db.js --source <path> [options]

Options:
  --source <path>   SQLite file to migrate FROM (required, never modified)
  --target <path>   Output path (default: {source-name}-migrated.sqlite alongside source)
  --dry-run         Show migration plan without writing anything
  --help            This message

Examples:
  node scripts/migrate-db.js --source data/leedz_3.24.2026.sqlite
  node scripts/migrate-db.js --source old.sqlite --target data/myproject.sqlite
  node scripts/migrate-db.js --source old.sqlite --dry-run
`);
  process.exit(0);
}

const sourceArg = getArg('--source');
if (!sourceArg) {
  console.error('ERROR: --source is required. Run with --help for usage.');
  process.exit(1);
}

const sourcePath = path.resolve(sourceArg);
if (!fs.existsSync(sourcePath)) {
  console.error(`ERROR: Source not found: ${sourcePath}`);
  process.exit(1);
}

const targetPath = getArg('--target')
  ? path.resolve(getArg('--target'))
  : path.join(path.dirname(sourcePath),
      path.basename(sourcePath, path.extname(sourcePath)) + '-migrated.sqlite');

const dryRun = hasArg('--dry-run');

// Locate template.sqlite relative to this script (PRECRIME/data/template.sqlite)
const PRECRIME_ROOT = path.resolve(__dirname, '..');
const templateDb    = path.join(PRECRIME_ROOT, 'data', 'template.sqlite');

// ---------------------------------------------------------------------------
// Pre-Crime authoritative schema
// Column definitions: [name, SQLiteType, defaultSql | null]
// ---------------------------------------------------------------------------

const PC_SCHEMA = {
  Client: [
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
    ['createdAt',      'DATETIME', "CURRENT_TIMESTAMP"],
    ['updatedAt',      'DATETIME', "CURRENT_TIMESTAMP"],
  ],
  Booking: [
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
    ['createdAt',        'DATETIME', "CURRENT_TIMESTAMP"],
    ['updatedAt',        'DATETIME', "CURRENT_TIMESTAMP"],
  ],
  Factlet: [
    ['id',        'TEXT',     null],
    ['content',   'TEXT',     null],
    ['source',    'TEXT',     null],
    ['createdAt', 'DATETIME', "CURRENT_TIMESTAMP"],
  ],
  Config: [
    ['id',                  'TEXT',    null],
    ['companyName',         'TEXT',    null],
    ['companyEmail',        'TEXT',    null],
    ['businessDescription', 'TEXT',    null],
    ['activeEntities',      'TEXT',    null],
    ['defaultTrade',        'TEXT',    null],
    ['marketplaceEnabled',  'INTEGER', '0'],
    ['leadCaptureEnabled',  'INTEGER', '0'],
    ['llmApiKey',           'TEXT',    null],
    ['llmProvider',         'TEXT',    null],
    ['llmBaseUrl',          'TEXT',    null],
    ['llmAnthropicVersion', 'TEXT',    null],
    ['llmMaxTokens',        'INTEGER', '1024'],
    ['leedzEmail',          'TEXT',    null],
    ['leedzSession',        'TEXT',    null],
    ['createdAt',           'DATETIME',"CURRENT_TIMESTAMP"],
    ['updatedAt',           'DATETIME',"CURRENT_TIMESTAMP"],
  ]
};

// Infer a reasonable SQLite type for unknown source columns
function inferType(colName) {
  const n = colName.toLowerCase();
  if (n === 'warmthscore' || n.includes('score') || n.includes('float') || n.includes('rating')) return 'REAL';
  if (n.includes('count') || n.includes('num') || n.includes('int') || n.includes('tokens') || n.includes('max')) return 'INTEGER';
  if (n.includes('at') || n.includes('date') || n.includes('time') || n.includes('stamp')) return 'DATETIME';
  return 'TEXT';
}

// Try to match a source table name to a Pre-Crime table name.
// Exact match first, then case-insensitive, then common aliases.
const TABLE_ALIASES = {
  client:   'Client',
  clients:  'Client',
  contact:  'Client',
  contacts: 'Client',
  lead:     'Client',
  leads:    'Client',
  school:   'Client',
  schools:  'Client',
  org:      'Client',
  orgs:     'Client',
  factlet:  'Factlet',
  factlets: 'Factlet',
  facts:    'Factlet',
  booking:  'Booking',
  bookings: 'Booking',
  gig:      'Booking',
  gigs:     'Booking',
  event:    'Booking',
  events:   'Booking',
  config:   'Config',
  configs:  'Config',
  settings: 'Config',
};

function matchPcTable(sourceName) {
  if (PC_SCHEMA[sourceName]) return sourceName;  // exact
  const lower = sourceName.toLowerCase();
  if (TABLE_ALIASES[lower]) return TABLE_ALIASES[lower];
  // Case-insensitive direct match
  const direct = Object.keys(PC_SCHEMA).find(k => k.toLowerCase() === lower);
  if (direct) return direct;
  return null;
}

// Escape a SQLite identifier by wrapping in double quotes
function q(name) { return `"${name.replace(/"/g, '""')}"`; }

// Windows path → SQLite-safe path (forward slashes, no drive-letter issues in ATTACH)
function sqlitePath(p) { return p.replace(/\\/g, '/'); }

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(62)}`);
console.log(`  Pre-Crime — Lossless Database Migration`);
console.log(`${'═'.repeat(62)}`);
console.log(`  Source  : ${sourcePath}`);
console.log(`  Target  : ${targetPath}`);
console.log(`  Mode    : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
console.log(`${'═'.repeat(62)}\n`);

// ---------------------------------------------------------------------------
// Validate prerequisites
// ---------------------------------------------------------------------------

if (!fs.existsSync(templateDb)) {
  console.error(`ERROR: template.sqlite not found at ${templateDb}`);
  console.error(`       This script must be run from the PRECRIME root, or template.sqlite must exist at data/template.sqlite`);
  process.exit(1);
}

if (sourcePath === targetPath) {
  console.error(`ERROR: --source and --target cannot be the same file.`);
  console.error(`       The source is NEVER modified. Use a different --target path.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1: Open source (read-only) and inspect
// ---------------------------------------------------------------------------

console.log(`Inspecting source database...`);

let src;
try {
  src = new DatabaseSync(sourcePath, { readOnly: true });
} catch (e) {
  console.error(`ERROR: Cannot open source database: ${e.message}`);
  process.exit(1);
}

// Get all user tables from source
const sourceTables = src
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name`)
  .all()
  .map(r => r.name);

if (sourceTables.length === 0) {
  console.error(`ERROR: Source database has no user tables.`);
  src.close();
  process.exit(1);
}

// Get schema and row counts for each source table
const sourceInfo = {};
for (const tname of sourceTables) {
  const cols  = src.prepare(`PRAGMA table_info(${q(tname)})`).all();
  const count = src.prepare(`SELECT COUNT(*) AS n FROM ${q(tname)}`).get().n;
  sourceInfo[tname] = {
    columns:  cols,   // [{cid, name, type, notnull, dflt_value, pk}]
    rowCount: count,
  };
  const colNames = cols.map(c => c.name).join(', ');
  console.log(`  ${tname}: ${count} rows | ${cols.length} cols: ${colNames}`);
}

src.close();

// ---------------------------------------------------------------------------
// Step 2: Map source tables → Pre-Crime tables; identify extras
// ---------------------------------------------------------------------------

console.log(`\nMatching tables to Pre-Crime schema...`);

const tableMap   = {};  // pcTableName → sourceTableName
const extraTables = []; // source tables that don't match any Pre-Crime table

for (const sTable of sourceTables) {
  const pcTable = matchPcTable(sTable);
  if (pcTable) {
    if (tableMap[pcTable]) {
      // Collision: two source tables map to same PC table — prefer exact match
      if (sTable === pcTable) tableMap[pcTable] = sTable;
      console.warn(`  ⚠ Multiple source tables map to ${pcTable}: using "${tableMap[pcTable]}"`);
    } else {
      tableMap[pcTable] = sTable;
      const arrow = sTable !== pcTable ? ` (mapped from "${sTable}")` : '';
      console.log(`  ✓ ${pcTable}${arrow} — ${sourceInfo[sTable].rowCount} rows`);
    }
  } else {
    extraTables.push(sTable);
    console.log(`  ~ "${sTable}" — no Pre-Crime match → will copy as _src_${sTable}`);
  }
}

const unmappedPcTables = Object.keys(PC_SCHEMA).filter(t => !tableMap[t]);
if (unmappedPcTables.length > 0) {
  console.log(`\n  Pre-Crime tables not found in source (will remain empty):`);
  unmappedPcTables.forEach(t => console.log(`    ${t}`));
}

// ---------------------------------------------------------------------------
// Step 3: For each mapped table, build the migration plan
// ---------------------------------------------------------------------------

console.log(`\nBuilding migration plan...`);

// plan[pcTable] = {
//   sourceTable: string,
//   addColumns: [{name, type, default}],     // source cols to ADD to target
//   insertCols: [string],                    // all cols for INSERT
//   selectExprs: [string],                   // SELECT expressions (col or NULL)
//   missingFromSource: [string],             // target cols not in source (will be NULL)
// }
const plan = {};

for (const [pcTable, sourceTable] of Object.entries(tableMap)) {
  const srcCols    = sourceInfo[sourceTable].columns.map(c => c.name);
  const srcColSet  = new Set(srcCols);
  const pcColDefs  = PC_SCHEMA[pcTable];
  const pcColNames = pcColDefs.map(c => c[0]);
  const pcColSet   = new Set(pcColNames);

  // Source columns NOT in target → need ALTER TABLE ADD COLUMN
  const addColumns = srcCols
    .filter(cn => !pcColSet.has(cn))
    .map(cn => ({ name: cn, type: inferType(cn), default: null }));

  // Target columns NOT in source → will be NULL in INSERT (filled by enrichment)
  const missingFromSource = pcColNames.filter(cn => !srcColSet.has(cn));

  // Full column list for INSERT: all pcCols + extra source cols
  const insertCols  = [...pcColNames, ...addColumns.map(c => c.name)];

  // SELECT expression for each insertCol:
  //   - if col exists in source → col name (reads from src table)
  //   - if col is target-only   → NULL
  const selectExprs = insertCols.map(cn => srcColSet.has(cn) ? q(cn) : 'NULL');

  plan[pcTable] = { sourceTable, addColumns, insertCols, selectExprs, missingFromSource };

  console.log(`\n  ${pcTable} ← ${sourceTable}`);
  if (addColumns.length > 0) {
    console.log(`    + Add ${addColumns.length} source-only col(s): ${addColumns.map(c => c.name).join(', ')}`);
  }
  if (missingFromSource.length > 0) {
    console.log(`    ≈ ${missingFromSource.length} target col(s) will be NULL: ${missingFromSource.join(', ')}`);
  }
  console.log(`    → INSERT ${insertCols.length} cols, ${sourceInfo[sourceTable].rowCount} rows`);
}

// ---------------------------------------------------------------------------
// Dry-run stops here
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  DRY RUN complete — no files written.`);
  console.log(`  Run without --dry-run to execute the migration.`);
  console.log(`${'═'.repeat(62)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 4: Prepare target file
// ---------------------------------------------------------------------------

console.log(`\nPreparing target...`);

if (!fs.existsSync(targetPath)) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(templateDb, targetPath);
  console.log(`  Created ${targetPath} from template.sqlite`);
} else {
  console.log(`  Target exists — will INSERT OR IGNORE (no existing rows overwritten)`);
}

// ---------------------------------------------------------------------------
// Step 5: Open target and ATTACH source
// ---------------------------------------------------------------------------

let db;
try {
  db = new DatabaseSync(targetPath);
} catch (e) {
  console.error(`ERROR: Cannot open target database: ${e.message}`);
  process.exit(1);
}

// ATTACH source (read-only, as 'src')
const attachSql = `ATTACH DATABASE '${sqlitePath(sourcePath)}' AS src`;
try {
  db.exec(attachSql);
} catch (e) {
  console.error(`ERROR: Could not attach source database: ${e.message}`);
  db.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 6: Execute migration plan
// ---------------------------------------------------------------------------

const report = {
  tablesProcessed: [],
  columnsAdded:    [],
  rowsMigrated:    {},
  extraTablesProcessed: [],
  warnings:        [],
};

console.log(`\nExecuting migration...`);

try {

  for (const [pcTable, p] of Object.entries(plan)) {
    console.log(`\n  ${pcTable}`);

    // 6a. ADD COLUMN for source-only columns
    for (const col of p.addColumns) {
      const defaultClause = col.default ? ` DEFAULT ${col.default}` : '';
      const alterSql = `ALTER TABLE ${q(pcTable)} ADD COLUMN ${q(col.name)} ${col.type}${defaultClause}`;
      try {
        db.exec(alterSql);
        console.log(`    + Added column: ${col.name} (${col.type})`);
        report.columnsAdded.push({ table: pcTable, column: col.name, type: col.type });
      } catch (e) {
        if (e.message.includes('duplicate column name')) {
          console.log(`    ~ Column ${col.name} already exists in target — skipping ALTER`);
        } else {
          report.warnings.push(`ALTER TABLE ${pcTable} ADD COLUMN ${col.name}: ${e.message}`);
          console.warn(`    ⚠ Could not add column ${col.name}: ${e.message}`);
        }
      }
    }

    // 6b. INSERT OR IGNORE ... SELECT from attached source
    const colList    = p.insertCols.map(q).join(', ');
    const selectList = p.selectExprs.join(', ');
    const insertSql  = `INSERT OR IGNORE INTO main.${q(pcTable)} (${colList}) SELECT ${selectList} FROM src.${q(p.sourceTable)}`;

    let migrated = 0;
    try {
      const result = db.prepare(insertSql).run();
      migrated = result.changes;
    } catch (e) {
      // INSERT OR IGNORE should not throw for constraint violations, but just in case
      report.warnings.push(`INSERT into ${pcTable}: ${e.message}`);
      console.error(`    ✗ INSERT failed: ${e.message}`);
      console.error(`      SQL: ${insertSql.substring(0, 120)}...`);
    }

    const sourceCount = sourceInfo[p.sourceTable].rowCount;
    const skipped     = sourceCount - migrated;
    report.rowsMigrated[pcTable] = { source: sourceCount, migrated, skipped };

    if (skipped > 0 && skipped < sourceCount) {
      console.log(`    ✓ ${migrated} rows inserted, ${skipped} skipped (already in target)`);
    } else if (skipped === sourceCount && sourceCount > 0) {
      console.log(`    ~ All ${sourceCount} rows already in target (no duplicates added)`);
    } else {
      console.log(`    ✓ ${migrated} rows inserted`);
    }

    report.tablesProcessed.push(pcTable);
  }

  // 6c. Copy extra source tables with _src_ prefix
  if (extraTables.length > 0) {
    console.log(`\n  Extra source tables:`);
    for (const sTable of extraTables) {
      const destTable = `_src_${sTable}`;
      const srcCols   = sourceInfo[sTable].columns;

      // Build CREATE TABLE based on source schema
      const colDefs = srcCols.map(c => {
        let def = `${q(c.name)} ${c.type || 'TEXT'}`;
        if (c.pk === 1) def += ' PRIMARY KEY';
        if (c.notnull && !c.pk) def += ' NOT NULL';
        if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
        return def;
      }).join(', ');

      try {
        db.exec(`DROP TABLE IF EXISTS ${q(destTable)}`);
        db.exec(`CREATE TABLE ${q(destTable)} (${colDefs})`);

        const srcColList  = srcCols.map(c => q(c.name)).join(', ');
        const insertExtra = `INSERT OR IGNORE INTO main.${q(destTable)} (${srcColList}) SELECT ${srcColList} FROM src.${q(sTable)}`;
        const res = db.prepare(insertExtra).run();
        console.log(`    ✓ "${sTable}" → "_src_${sTable}" — ${res.changes} rows`);
        report.extraTablesProcessed.push({ source: sTable, dest: destTable, rows: res.changes });
        report.rowsMigrated[destTable] = { source: sourceInfo[sTable].rowCount, migrated: res.changes, skipped: 0 };
      } catch (e) {
        report.warnings.push(`Extra table ${sTable}: ${e.message}`);
        console.warn(`    ⚠ Could not copy ${sTable}: ${e.message}`);
      }
    }
  }

} finally {
  // Always detach and close, even on error
  try { db.exec(`DETACH DATABASE src`); } catch (_) {}
  db.close();
}

// ---------------------------------------------------------------------------
// Step 7: Verify row counts (re-open target to confirm)
// ---------------------------------------------------------------------------

console.log(`\nVerifying...`);

const verify = new DatabaseSync(targetPath, { readOnly: true });
let allMatch = true;

for (const [pcTable, counts] of Object.entries(report.rowsMigrated)) {
  try {
    const actual = verify.prepare(`SELECT COUNT(*) AS n FROM ${q(pcTable)}`).get().n;
    const expected = counts.migrated;
    const ok = actual >= expected;
    if (!ok) {
      allMatch = false;
      report.warnings.push(`VERIFY MISMATCH ${pcTable}: expected ≥${expected}, got ${actual}`);
    }
    const label = pcTable.startsWith('_src_') ? `(extra) ${pcTable}` : pcTable;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${actual} rows in target`);
  } catch (e) {
    console.warn(`  ⚠ Could not verify ${pcTable}: ${e.message}`);
  }
}

verify.close();

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(62)}`);
console.log(`  Migration Complete`);
console.log(`${'═'.repeat(62)}`);
console.log(`  Output: ${targetPath}`);

if (report.columnsAdded.length > 0) {
  console.log(`\n  Columns added to target (source data preserved):`);
  for (const ca of report.columnsAdded) {
    console.log(`    + ${ca.table}.${ca.column} (${ca.type})`);
  }
}

console.log(`\n  Rows migrated:`);
for (const [table, counts] of Object.entries(report.rowsMigrated)) {
  const note = counts.skipped > 0
    ? ` (${counts.skipped} already existed — skipped)`
    : '';
  console.log(`    ${table}: ${counts.migrated}/${counts.source}${note}`);
}

if (report.warnings.length > 0) {
  console.log(`\n  Warnings:`);
  report.warnings.forEach(w => console.log(`    ⚠ ${w}`));
}

if (!allMatch) {
  console.log(`\n  ✗ Some row counts did not match. Check warnings above.`);
} else {
  console.log(`\n  ✓ All row counts verified.`);
}

console.log(`\n  Next steps:`);
console.log(`    1. Copy to your deployment:  {rootDir}\\data\\{name}.sqlite`);
console.log(`    2. Launch Claude from {rootDir} and call: get_stats()`);
console.log(`    3. Verify client count, then run the enrichment workflow`);
console.log(`${'═'.repeat(62)}\n`);
