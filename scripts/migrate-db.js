#!/usr/bin/env node
/**
 * migrate-db.js -- single PRECRIME SQLite migration tool.
 *
 * Input:  one SQLite file.
 * Output: a migrated SQLite file that matches the current Prisma schema.
 *
 * Normal mode never mutates the source:
 *   node scripts/migrate-db.js --source C:\path\old.sqlite
 *   node scripts/migrate-db.js C:\path\old.sqlite --target C:\path\new.sqlite
 *
 * In-place wrapper mode:
 *   node scripts/migrate-db.js --source C:\path\myproject.sqlite --in-place
 *
 * In-place mode writes a temp migrated DB first, verifies it, creates a backup
 * beside the original, and overwrites the original only after every verification
 * passes. If verification fails, the source is left untouched.
 *
 * Lossless rule:
 * - Current PRECRIME tables are rebuilt into the canonical schema.
 * - Every source table is also copied byte-for-byte by value into _legacy_<table>.
 *   This preserves old/extra columns and removed tables such as ClientFactlet.
 * - Old ClientFactlet links, when present, are folded into Client.dossier before
 *   ClientFactlet is removed from the active schema.
 *
 * 2026-06-11 (classification model): the canonical Booking drops bookingScore /
 * factletScore / contactQuality (still preserved in _legacy_Booking), and every
 * legacy Booking.status is remapped onto cold|brewing|hot (mapBookingStatus).
 * No row is deleted; run pipeline.rescore after migrating to re-classify
 * brewing -> hot. See DOCS/CLASSIFICATION.md.
 *
 * 2026-06-15 (unified schema): the Config TABLE is eliminated (runtime config is
 * in-memory from VALUE_PROP.md + precrime_config.json); a legacy Config is kept
 * only as _legacy_Config. Booking gains squarePaymentUrl and a SquareConnection
 * table is added so PRECRIME and the Leedz desktop (INVOICER) share one schema.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PRECRIME_ROOT = path.resolve(__dirname, '..');
const BETTER_SQLITE3 = path.join(PRECRIME_ROOT, 'server', 'node_modules', 'better-sqlite3');

let Database;
try {
  Database = require(BETTER_SQLITE3);
} catch (err) {
  console.error('FATAL: cannot load better-sqlite3 from: ' + BETTER_SQLITE3);
  console.error('Run: cd ' + path.join(PRECRIME_ROOT, 'server') + ' && npm install');
  console.error('Underlying error: ' + err.message);
  process.exit(2);
}

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const hasArg = (name) => args.includes(name);

if (hasArg('--help') || hasArg('-h')) usage(0);

const positionalSource = args.find(a => !a.startsWith('--') && !['--source', '--target'].includes(a));
const sourceArg = getArg('--source') || positionalSource;
if (!sourceArg) usage(1, 'ERROR: source SQLite file is required.');

const sourcePath = path.resolve(sourceArg);
const dryRun = hasArg('--dry-run');
const inPlace = hasArg('--in-place');
const requestedTarget = getArg('--target');
// Deployment root whose skills/*_sources.md files receive the exported Source
// rows (markdown is now the single source of truth). Default is derived from the
// DB location -- a PRECRIME DB lives at <root>/data/<file>.sqlite -- so migrating
// a deployed DB exports into THAT tree (the one whose skills/ the server reads),
// not this repo. Pass --root to override. Falls back to this repo only when the
// DB is not under a data/ dir.
function defaultDeployRoot(dbPath) {
  const parent = path.dirname(dbPath);
  if (path.basename(parent).toLowerCase() === 'data') return path.dirname(parent);
  return PRECRIME_ROOT;
}
const deployRoot = path.resolve(getArg('--root') || defaultDeployRoot(sourcePath));

// The Source table is being removed: its rows are exported to markdown, and it
// is NOT rebuilt as canonical NOR preserved as _legacy_. Matches any name in the
// Source lineage (Source, _legacy_Source, _legacy__legacy_Source, ...).
function isSourceLineage(tableName) {
  return String(tableName || '').replace(/^(_legacy_)+/i, '').toLowerCase() === 'source';
}

if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  fail('Source SQLite file not found: ' + sourcePath);
}

if (inPlace && requestedTarget) {
  fail('Use either --in-place or --target, not both.');
}

const targetPath = inPlace
  ? sourcePath
  : path.resolve(requestedTarget || defaultTargetPath(sourcePath));

if (!inPlace && path.resolve(targetPath) === path.resolve(sourcePath)) {
  fail('--target cannot equal --source. Use --in-place for backup-and-replace mode.');
}

const tempPath = inPlace
  ? path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.migrating-${timestamp()}.sqlite`)
  : targetPath;

const CURRENT_SCHEMA = {
  Client: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['name', 'TEXT', 'NOT NULL'],
      ['email', 'TEXT', null],
      ['phone', 'TEXT', null],
      ['company', 'TEXT', null],
      ['website', 'TEXT', null],
      ['clientNotes', 'TEXT', null],
      ['segment', 'TEXT', null],
      ['dossier', 'TEXT', null],
      ['targetUrls', 'TEXT', null],
      ['draft', 'TEXT', null],
      ['draftStatus', 'TEXT', null],
      ['sentAt', 'DATETIME', null],
      ['warmthScore', 'REAL', null],
      ['dossierScore', 'INTEGER', null],
      ['contactGate', 'BOOLEAN', 'NOT NULL DEFAULT false'],
      ['intelScore', 'INTEGER', null],
      ['lastEnriched', 'DATETIME', null],
      ['lastQueueCheck', 'DATETIME', null],
      ['source', 'TEXT', null],
      ['createdAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['updatedAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ],
    indexes: [
      'CREATE UNIQUE INDEX IF NOT EXISTS "Client_email_key" ON "Client"("email")'
    ]
  },
  Booking: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['clientId', 'TEXT', 'NOT NULL'],
      ['title', 'TEXT', null],
      ['description', 'TEXT', null],
      ['notes', 'TEXT', null],
      ['location', 'TEXT', null],
      ['startDate', 'DATETIME', null],
      ['endDate', 'DATETIME', null],
      ['startTime', 'TEXT', null],
      ['endTime', 'TEXT', null],
      ['duration', 'REAL', null],
      ['hourlyRate', 'REAL', null],
      ['flatRate', 'REAL', null],
      ['totalAmount', 'REAL', null],
      ['status', 'TEXT', "NOT NULL DEFAULT 'brewing'"],
      ['source', 'TEXT', null],
      ['sourceUrl', 'TEXT', null],
      ['trade', 'TEXT', null],
      ['zip', 'TEXT', null],
      ['shared', 'BOOLEAN', 'NOT NULL DEFAULT false'],
      ['sharedTo', 'TEXT', null],
      ['sharedAt', 'BIGINT', null],
      ['leedPrice', 'INTEGER', null],
      ['leedId', 'TEXT', null],
      ['squarePaymentUrl', 'TEXT', null],
      ['createdAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['updatedAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ],
    indexes: []
  },
  Factlet: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['content', 'TEXT', 'NOT NULL'],
      ['source', 'TEXT', 'NOT NULL'],
      ['createdAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ],
    indexes: []
  },
  Session: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['workflow', 'TEXT', 'NOT NULL'],
      ['status', 'TEXT', "NOT NULL DEFAULT 'active'"],
      ['targetCount', 'INTEGER', null],
      ['startedAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['finishedAt', 'DATETIME', null],
      ['metadata', 'TEXT', null],
    ],
    indexes: []
  },
  SessionEvent: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['sessionId', 'TEXT', 'NOT NULL'],
      ['ts', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['action', 'TEXT', 'NOT NULL'],
      ['payload', 'TEXT', null],
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS "SessionEvent_sessionId_idx" ON "SessionEvent"("sessionId")',
      'CREATE INDEX IF NOT EXISTS "SessionEvent_action_idx" ON "SessionEvent"("action")'
    ]
  },
  // Source TABLE removed: scrape sources now live in per-channel markdown files
  // (single source of truth). Existing Source rows are exported to markdown by
  // exportSourcesToMarkdown() and the table is neither rebuilt nor preserved.
  Task: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['type', 'TEXT', 'NOT NULL'],
      ['status', 'TEXT', "NOT NULL DEFAULT 'ready'"],
      ['sessionId', 'TEXT', null],
      ['targetType', 'TEXT', null],
      ['targetId', 'TEXT', null],
      ['input', 'TEXT', null],
      ['output', 'TEXT', null],
      ['error', 'TEXT', null],
      ['claimedAt', 'DATETIME', null],
      ['claimedBy', 'TEXT', null],
      ['createdAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['updatedAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['finishedAt', 'DATETIME', null],
    ],
    indexes: [
      'CREATE INDEX IF NOT EXISTS "Task_status_idx" ON "Task"("status")',
      'CREATE INDEX IF NOT EXISTS "Task_type_idx" ON "Task"("type")',
      'CREATE INDEX IF NOT EXISTS "Task_sessionId_idx" ON "Task"("sessionId")',
      'CREATE INDEX IF NOT EXISTS "Task_targetType_targetId_idx" ON "Task"("targetType", "targetId")'
    ]
  },
  // Config table eliminated: runtime config is an in-memory struct built at MCP
  // startup from VALUE_PROP.md + precrime_config.json. A legacy source `Config`
  // table is preserved automatically as _legacy_Config (copyAllLegacyTables); it
  // is NOT rebuilt as an active table.
  // SquareConnection: owned by the Leedz desktop (INVOICER); durable Square OAuth
  // state. PRECRIME never reads/writes it, but it is part of the unified schema so
  // a shared DB carries it and the desktop's Prisma client finds it.
  SquareConnection: {
    columns: [
      ['id', 'TEXT', 'PRIMARY KEY'],
      ['accessToken', 'TEXT', null],
      ['refreshToken', 'TEXT', null],
      ['expiresAt', 'BIGINT', null],
      ['merchantId', 'TEXT', null],
      ['locationId', 'TEXT', null],
      ['state', 'TEXT', null],
      ['createdAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
      ['updatedAt', 'DATETIME', 'NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ],
    indexes: []
  }
};

const TABLE_ALIASES = {
  client: 'Client', clients: 'Client', contact: 'Client', contacts: 'Client',
  lead: 'Client', leads: 'Client', school: 'Client', schools: 'Client',
  booking: 'Booking', bookings: 'Booking', event: 'Booking', events: 'Booking',
  gig: 'Booking', gigs: 'Booking',
  factlet: 'Factlet', factlets: 'Factlet', facts: 'Factlet',
  // source/sources intentionally removed -- the Source table is dropped and its
  // rows are exported to markdown (see exportSourcesToMarkdown).
  session: 'Session', sessions: 'Session',
  sessionevent: 'SessionEvent', sessionevents: 'SessionEvent',
  task: 'Task', tasks: 'Task',
  squareconnection: 'SquareConnection', squareconnections: 'SquareConnection'
  // NOTE: legacy `config` / `settings` source tables intentionally have no alias --
  // they are preserved as _legacy_<table> only, never rebuilt as an active table.
};

main();

function main() {
  console.log('\nPRECRIME single DB migrator');
  console.log('Source : ' + sourcePath);
  console.log('Target : ' + (inPlace ? `${sourcePath} (in-place after verified temp)` : targetPath));
  console.log('Mode   : ' + (dryRun ? 'dry-run' : inPlace ? 'in-place' : 'output'));

  checkpointSource(sourcePath, dryRun);

  const sourceInfo = inspectSource(sourcePath);
  printPlan(sourceInfo);

  // Export Source rows to markdown BEFORE dropping the table, so no productive
  // source is lost (markdown is now the single source of truth).
  const exported = exportSourcesToMarkdown(sourcePath, deployRoot, dryRun);
  if (exported.total > 0) {
    console.log(`\nSource -> markdown export (${dryRun ? 'dry-run, not written' : 'written'}) under ${deployRoot}:`);
    console.log(`  ${exported.total} Source row(s): ${exported.added} new, ${exported.duplicates} already present, ${exported.invalid} invalid.`);
    for (const [ch, n] of Object.entries(exported.byChannel)) console.log(`    ${ch}: ${n}`);
    // SAFETY: never drop the Source table unless every row landed in markdown.
    // Without this, a wrong --root silently exports nothing and the drop loses
    // the sources (only a .bak would save them). Abort BEFORE migrateToTarget so
    // the source DB is untouched.
    if (!dryRun) {
      const accounted = exported.added + exported.duplicates;
      if (accounted < exported.total || exported.invalid > 0) {
        fail(`Source export incomplete: only ${accounted}/${exported.total} row(s) landed in markdown ` +
             `(invalid=${exported.invalid}) under ${deployRoot}. REFUSING to drop the Source table. ` +
             `Pass --root <deployment-dir> (the tree whose skills/ the server reads). Your DB is unchanged.`);
      }
    }
  } else {
    console.log('\nNo Source rows to export (table empty or absent).');
  }

  if (dryRun) {
    console.log('\nDry run complete. No files changed.');
    return;
  }

  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  fs.mkdirSync(path.dirname(tempPath), { recursive: true });

  const report = migrateToTarget(sourcePath, tempPath, sourceInfo);
  verifyMigration(sourcePath, tempPath, sourceInfo, report);
  finalizeSqliteFile(tempPath);

  if (inPlace) {
    const backupPath = sourcePath + '.bak.' + timestamp();
    fs.copyFileSync(sourcePath, backupPath);
    fs.copyFileSync(tempPath, sourcePath);
    fs.rmSync(tempPath, { force: true });
    console.log('\nBackup written: ' + backupPath);
    console.log('Original replaced only after verified migration passed.');
  }

  console.log('\nMigration complete.');
  console.log('Output: ' + (inPlace ? sourcePath : tempPath));
  console.log('\nNEXT: start the server, then run pipeline.rescore (scope="all") to');
  console.log('re-classify every Booking to cold / brewing / hot under the new model.');
  console.log('\nCanonical rows:');
  for (const [table, counts] of Object.entries(report.canonicalRows)) {
    console.log(`  ${table}: ${counts.inserted}/${counts.source}`);
  }
  console.log('\nLegacy copies:');
  for (const [table, counts] of Object.entries(report.legacyRows)) {
    console.log(`  _legacy_${table}: ${counts.copied}/${counts.source}`);
  }
  if (report.dossierFolded > 0) {
    console.log(`\nFolded old ClientFactlet evidence into dossiers: ${report.dossierFolded}`);
  }
  if (report.warnings.length) {
    console.log('\nWarnings:');
    for (const w of report.warnings) console.log('  - ' + w);
  }
}

// Read the Source table and append its rows to the per-channel markdown files
// under deployRoot, reusing the runtime SourceStore so the line format + dedup
// match exactly. Idempotent. Writes nothing when dryRun. Returns counts.
function exportSourcesToMarkdown(srcPath, root, dry) {
  const result = { total: 0, added: 0, duplicates: 0, invalid: 0, byChannel: {} };
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  let rows = [];
  try {
    if (new Set(listTables(src)).has('Source')) {
      rows = src.prepare('SELECT url, channel, subtype, label, category FROM "Source"').all();
    }
  } finally {
    src.close();
  }
  result.total = rows.length;
  if (!rows.length) return result;
  for (const r of rows) result.byChannel[r.channel] = (result.byChannel[r.channel] || 0) + 1;
  if (dry) return result;

  // createSourceStore only needs fs/path; root is the deployment dir (holds skills/).
  const { createSourceStore } = require(path.join(PRECRIME_ROOT, 'server', 'mcp', 'sourceStore'));
  const store = createSourceStore({ root });
  store.load();
  const r = store.addSources(rows.map(s => ({
    url: s.url, channel: s.channel, subtype: s.subtype, label: s.label, category: s.category
  })));
  result.added = r.added;
  result.duplicates = r.duplicates;
  result.invalid = r.invalid;
  return result;
}

function migrateToTarget(srcPath, outPath, sourceInfo) {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const dst = new Database(outPath);
  const report = { canonicalRows: {}, legacyRows: {}, warnings: [], dossierFolded: 0 };

  try {
    dst.pragma('journal_mode = WAL');
    dst.pragma('foreign_keys = OFF');

    createCurrentSchema(dst);
    copyAllLegacyTables(src, dst, sourceInfo, report);

    const tx = dst.transaction(() => {
      for (const table of Object.keys(CURRENT_SCHEMA)) {
        const sourceTable = sourceInfo.tableMap[table];
        if (!sourceTable) {
          report.canonicalRows[table] = { source: 0, inserted: 0 };
          continue;
        }
        const sourceRows = src.prepare(`SELECT * FROM ${q(sourceTable)}`).all();
        const inserted = insertCanonicalRows(src, dst, table, sourceTable, sourceRows, sourceInfo, report);
        report.canonicalRows[table] = { source: sourceRows.length, inserted };
      }
      report.dossierFolded = foldClientFactletsIntoDossiers(src, dst, sourceInfo, report);
      repairBookingClientIds(dst, report);
    });

    tx();
    dst.pragma('foreign_keys = ON');
  } finally {
    src.close();
    dst.close();
  }

  return report;
}

function createCurrentSchema(db) {
  for (const [table, def] of Object.entries(CURRENT_SCHEMA)) {
    const colSql = def.columns.map(([name, type, extra]) =>
      [q(name), type, extra].filter(Boolean).join(' ')
    ).join(',\n      ');
    db.exec(`CREATE TABLE ${q(table)} (\n      ${colSql}\n    )`);
  }
  for (const def of Object.values(CURRENT_SCHEMA)) {
    for (const sql of def.indexes) db.exec(sql);
  }
}

function insertCanonicalRows(src, dst, table, sourceTable, sourceRows, sourceInfo, report) {
  const targetCols = CURRENT_SCHEMA[table].columns.map(c => c[0]);
  const srcCols = new Set(sourceInfo.tables[sourceTable].columns.map(c => c.name));
  const stmt = dst.prepare(buildInsertSql(table, targetCols));
  let inserted = 0;

  for (const sourceRow of sourceRows) {
    const row = {};
    for (const col of targetCols) {
      row[col] = srcCols.has(col) ? normalizeValue(sourceRow[col]) : null;
    }
    applyDefaults(table, row, sourceRow);
    try {
      stmt.run(row);
      inserted++;
    } catch (err) {
      report.warnings.push(`${table}: skipped source row id=${sourceRow.id || '[none]'}: ${err.message}`);
    }
  }

  return inserted;
}

function applyDefaults(table, row, sourceRow) {
  const now = new Date().toISOString();
  if (!row.id) row.id = `mig_${table.toLowerCase()}_${hash(JSON.stringify(sourceRow)).slice(0, 16)}`;
  if ('createdAt' in row && !row.createdAt) row.createdAt = now;
  if ('updatedAt' in row && !row.updatedAt) row.updatedAt = now;

  if (table === 'Client') {
    if (!row.name) row.name = row.company || row.email || `Legacy Client ${String(row.id).slice(-8)}`;
    row.contactGate = boolish(row.contactGate);
  }
  if (table === 'Booking') {
    if (!row.clientId) row.clientId = 'legacy_orphan_client';
    row.shared = boolish(row.shared);
    // Map any legacy status (leed_ready / outreach_ready / taken / expired / new /
    // needs_enrichment / ...) onto the cold|brewing|hot model. We never invent
    // 'hot' here -- that requires the LLM judge. Run pipeline.rescore after the
    // migration to re-classify brewing -> hot. See DOCS/CLASSIFICATION.md.
    row.status = mapBookingStatus(row.status, row.shared);
  }
  if (table === 'Factlet') {
    if (!row.content) row.content = sourceRow.content || sourceRow.title || JSON.stringify(sourceRow);
    if (!row.source) row.source = sourceRow.source || sourceRow.sourceUrl || 'legacy';
  }
  if (table === 'Task') {
    if (!row.type) row.type = 'LEGACY_IMPORTED';
    if (!row.status) row.status = 'done';
  }
  if (table === 'Session') {
    if (!row.workflow) row.workflow = 'legacy_import';
    if (!row.status) row.status = 'complete';
    if (!row.startedAt) row.startedAt = now;
  }
  if (table === 'SessionEvent') {
    if (!row.sessionId) row.sessionId = 'legacy_orphan_session';
    if (!row.action) row.action = 'legacy_import';
    if (!row.ts) row.ts = now;
  }
}

function repairBookingClientIds(db, report) {
  const missing = db.prepare(`
    SELECT DISTINCT b.clientId AS id
    FROM "Booking" b
    LEFT JOIN "Client" c ON c.id = b.clientId
    WHERE c.id IS NULL
  `).all().map(r => r.id).filter(Boolean);

  if (!missing.length) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO "Client" ("id", "name", "source", "createdAt", "updatedAt")
    VALUES (?, ?, 'migration:orphan-booking-client', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  for (const id of missing) {
    insert.run(id, `Legacy Client ${String(id).slice(-8)}`);
  }
  report.warnings.push(`Created ${missing.length} stub Client row(s) for legacy Booking.clientId values without matching Client rows.`);
}

function foldClientFactletsIntoDossiers(src, dst, sourceInfo, report) {
  const cfTable = sourceInfo.sourceTables.find(t => t.toLowerCase() === 'clientfactlet' || t.toLowerCase() === 'clientfactlets');
  const fTable = sourceInfo.tableMap.Factlet;
  if (!cfTable || !fTable) return 0;

  const cfCols = new Set(sourceInfo.tables[cfTable].columns.map(c => c.name));
  if (!cfCols.has('clientId') || !cfCols.has('factletId')) return 0;

  const rows = src.prepare(`
    SELECT cf.clientId, cf.factletId, cf.appliedAt, cf.signalType, cf.points,
           f.content, f.source, f.createdAt
    FROM ${q(cfTable)} cf
    LEFT JOIN ${q(fTable)} f ON f.id = cf.factletId
  `).all();

  if (!rows.length) return 0;

  const byClient = new Map();
  for (const r of rows) {
    if (!r.clientId || !r.content) continue;
    const date = String(r.createdAt || r.appliedAt || new Date().toISOString()).slice(0, 10);
    const srcText = r.source ? ` from ${r.source}` : '';
    const line = `[${date}] Legacy factlet${srcText}: ${String(r.content).trim()}`;
    if (!byClient.has(r.clientId)) byClient.set(r.clientId, []);
    byClient.get(r.clientId).push(line);
  }

  const getClient = dst.prepare('SELECT dossier FROM "Client" WHERE id = ?');
  const update = dst.prepare('UPDATE "Client" SET dossier = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?');
  let folded = 0;
  for (const [clientId, lines] of byClient.entries()) {
    const cur = getClient.get(clientId);
    if (!cur) continue;
    const existing = cur.dossier || '';
    const additions = dedupeLines(lines, existing);
    if (!additions.length) continue;
    const next = existing
      ? existing + '\n' + additions.join('\n')
      : additions.join('\n');
    update.run(next, clientId);
    folded += additions.length;
  }
  return folded;
}

function copyAllLegacyTables(src, dst, sourceInfo, report) {
  for (const table of sourceInfo.sourceTables) {
    // Source lineage is exported to markdown and dropped -- no _legacy_ copy.
    if (isSourceLineage(table)) continue;
    const legacyName = `_legacy_${sanitizeIdentifier(table)}`;
    const rows = src.prepare(`SELECT * FROM ${q(table)}`).all();
    const cols = sourceInfo.tables[table].columns;
    const ddlCols = cols.length
      ? cols.map(c => `${q(c.name)} ${c.type || 'TEXT'}`).join(', ')
      : '"_empty" TEXT';
    dst.exec(`CREATE TABLE ${q(legacyName)} (${ddlCols})`);
    if (cols.length && rows.length) {
      const names = cols.map(c => c.name);
      const stmt = dst.prepare(buildInsertSql(legacyName, names));
      const tx = dst.transaction(() => {
        for (const row of rows) {
          const data = {};
          for (const n of names) data[n] = normalizeValue(row[n]);
          stmt.run(data);
        }
      });
      tx();
    }
    report.legacyRows[table] = { source: rows.length, copied: rows.length };
  }
}

function verifyMigration(srcPath, outPath, sourceInfo, report) {
  const db = new Database(outPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(listTables(db));
    for (const table of Object.keys(CURRENT_SCHEMA)) {
      if (!tables.has(table)) throw new Error(`required table missing: ${table}`);
      const cols = new Set(listColumns(db, table).map(c => c.name));
      for (const [col] of CURRENT_SCHEMA[table].columns) {
        if (!cols.has(col)) throw new Error(`required column missing: ${table}.${col}`);
      }
    }
    if (tables.has('ClientFactlet')) {
      throw new Error('ClientFactlet must not exist in migrated active schema');
    }

    for (const sourceTable of sourceInfo.sourceTables) {
      if (isSourceLineage(sourceTable)) continue; // exported to markdown, dropped
      const legacyName = `_legacy_${sanitizeIdentifier(sourceTable)}`;
      if (!tables.has(legacyName)) throw new Error(`legacy preservation table missing: ${legacyName}`);
      const n = countRows(db, legacyName);
      const expected = sourceInfo.tables[sourceTable].rowCount;
      if (n !== expected) throw new Error(`${legacyName} row count mismatch: ${n} !== ${expected}`);
    }
    // Belt-and-suspenders: the Source table must be gone from the migrated DB.
    if (tables.has('Source')) {
      throw new Error('Source table must not exist in migrated DB (it is now markdown-only)');
    }

    for (const [table, counts] of Object.entries(report.canonicalRows)) {
      if (counts.source > 0 && counts.inserted <= 0) {
        throw new Error(`${table} source had ${counts.source} row(s), but canonical insert wrote 0`);
      }
    }
  } finally {
    db.close();
  }
}

function inspectSource(srcPath) {
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    const sourceTables = listTables(db);
    if (!sourceTables.length) fail('Source database has no user tables.');
    const tables = {};
    for (const table of sourceTables) {
      tables[table] = {
        columns: listColumns(db, table),
        rowCount: countRows(db, table)
      };
    }
    const tableMap = {};
    for (const table of sourceTables) {
      const canonical = matchCanonicalTable(table);
      if (!canonical) continue;
      if (!tableMap[canonical] || table === canonical) tableMap[canonical] = table;
    }
    return { sourceTables, tables, tableMap };
  } finally {
    db.close();
  }
}

function printPlan(info) {
  console.log('\nSource tables:');
  for (const table of info.sourceTables) {
    const canonical = matchCanonicalTable(table);
    const mapped = isSourceLineage(table)
      ? ' -> DROPPED (exported to markdown)'
      : canonical ? ` -> ${canonical}` : ' -> legacy copy only';
    console.log(`  ${table}: ${info.tables[table].rowCount} row(s), ${info.tables[table].columns.length} col(s)${mapped}`);
  }
  console.log('\nActive target schema: ' + Object.keys(CURRENT_SCHEMA).join(', '));
  console.log('Removed active table: ClientFactlet (preserved only as _legacy_ClientFactlet if present).');
}

function checkpointSource(srcPath, readOnlyPlan) {
  const hasWal = fs.existsSync(srcPath + '-wal') || fs.existsSync(srcPath + '-shm');
  if (!hasWal) return;
  console.log('Source WAL files detected.');
  if (readOnlyPlan) {
    console.log('Dry run: would checkpoint source WAL before migration.');
    return;
  }
  const db = new Database(srcPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  console.log('Source WAL checkpointed.');
}

function finalizeSqliteFile(dbPath) {
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
}

function matchCanonicalTable(name) {
  if (CURRENT_SCHEMA[name]) return name;
  return TABLE_ALIASES[String(name).toLowerCase()] || null;
}

function listTables(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_prisma_%'
    ORDER BY name
  `).all().map(r => r.name);
}

function listColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all();
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n;
}

function buildInsertSql(table, cols) {
  const colSql = cols.map(q).join(', ');
  const valSql = cols.map(c => `@${c}`).join(', ');
  return `INSERT OR REPLACE INTO ${q(table)} (${colSql}) VALUES (${valSql})`;
}

function normalizeValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

function boolish(value) {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return 1;
  return 0;
}

// Legacy Booking.status -> cold | brewing | hot. Idempotent (already-new values
// pass through). Acted-on / terminal -> cold; everything else -> brewing so the
// new Judge re-classifies it. Never produces 'hot' (that needs the LLM judge).
function mapBookingStatus(oldStatus, shared) {
  const s = String(oldStatus || '').toLowerCase();
  if (s === 'cold' || s === 'brewing' || s === 'hot') return s;
  if (shared || s === 'shared' || s === 'taken' || s === 'expired') return 'cold';
  return 'brewing';
}

function dedupeLines(lines, existing) {
  const seen = new Set(String(existing || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const out = [];
  for (const line of lines) {
    const clean = line.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function q(identifier) {
  return '"' + String(identifier).replace(/"/g, '""') + '"';
}

function sanitizeIdentifier(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '_');
}

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function defaultTargetPath(srcPath) {
  const ext = path.extname(srcPath) || '.sqlite';
  const base = path.basename(srcPath, ext);
  return path.join(path.dirname(srcPath), `${base}-migrated.sqlite`);
}

function usage(code, msg) {
  if (msg) console.error(msg + '\n');
  console.log(`Usage:
  node scripts/migrate-db.js --source <file.sqlite> [--target <out.sqlite>]
  node scripts/migrate-db.js <file.sqlite> [--target <out.sqlite>]
  node scripts/migrate-db.js --source <file.sqlite> --in-place
  node scripts/migrate-db.js --source <file.sqlite> --dry-run

Options:
  --source <path>  Input SQLite file.
  --target <path>  Output SQLite file. Default: <source>-migrated.sqlite.
  --in-place       Create backup, migrate temp DB, verify, then overwrite source.
  --dry-run        Inspect and print plan only.
`);
  process.exit(code);
}

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}
