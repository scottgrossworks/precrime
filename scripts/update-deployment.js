#!/usr/bin/env node
/**
 * Pre-Crime — Deployment Updater
 *
 * Replaces "guts" (skills, server code, configs) in an existing deployment
 * while preserving "memory" (database, VALUE_PROP, source URLs, user configs).
 *
 * Usage:
 *   node scripts/update-deployment.js <target-dir> [--dry-run]
 *
 * No npm packages required — only Node.js 22.5+ built-ins.
 */

'use strict';

const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const { execSync }    = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const target  = args.find(a => !a.startsWith('--'));

if (!target) {
  console.error('Usage: node scripts/update-deployment.js <target-dir> [--dry-run]');
  process.exit(1);
}

const targetDir  = path.resolve(target);
const PRECRIME   = path.resolve(__dirname, '..');
const TEMPLATES  = path.join(PRECRIME, 'templates');

if (dryRun) console.log('\n*** DRY RUN — no files will be modified ***\n');

// ---------------------------------------------------------------------------
// Guts files — ONLY these get replaced in the target
// ---------------------------------------------------------------------------

const GUTS_FILES = [
  // Skills
  'skills/enrichment-agent.md',
  'skills/enrichment-agent-parallel.md',
  'skills/evaluator.md',
  'skills/relevance-judge.md',
  'skills/factlet-harvester.md',
  'skills/source-discovery.md',
  'skills/source-discovery/discovered_directories.md',
  'skills/fb-factlet-harvester/SKILL.md',
  'skills/fb-factlet-harvester/fb_sources.md',
  'skills/reddit-factlet-harvester/SKILL.md',
  'skills/reddit-factlet-harvester/reddit_sources.md',
  'skills/ig-factlet-harvester/SKILL.md',
  'skills/ig-factlet-harvester/ig_sources.md',
  'skills/x-factlet-harvester/SKILL.md',
  'skills/x-factlet-harvester/x_sources.md',
  'skills/init-wizard.md',
  // Server
  'server/mcp/mcp_server.js',
  'server/mcp/mcp_server_config.json',
  'server/prisma/schema.prisma',
  // MCP config
  '.mcp.json',
  // Docs (NOT VALUE_PROP.md)
  'DOCS/CLAUDE.md',
  'DOCS/STATUS.md',
  // Root CLAUDE.md
  'CLAUDE.md',
];

// Memory patterns — NEVER overwrite these even if they somehow end up in GUTS_FILES
const MEMORY_PATTERNS = [
  /\.sqlite$/i,
  /\.sqlite-shm$/i,
  /\.sqlite-wal$/i,
  /server[\\/]\.env$/,
  /DOCS[\\/]VALUE_PROP\.md$/i,
  /fb_sources\.md$/i,
  /reddit_sources\.md$/i,
  /ig_sources\.md$/i,
  /x_sources\.md$/i,
  /rss_config\.json$/i,
  /[\\/]logs[\\/]/,
];

// Server files that trigger npm reinstall when changed
const SERVER_TRIGGER_FILES = [
  'server/mcp/mcp_server.js',
  'server/package.json',
  'server/prisma/schema.prisma',
];

// ---------------------------------------------------------------------------
// Pre-Crime authoritative schema (duplicated from migrate-db.js)
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
    ['segment',        'TEXT',     null],
    ['dossier',        'TEXT',     null],
    ['targetUrls',     'TEXT',     null],
    ['draft',          'TEXT',     null],
    ['draftStatus',    'TEXT',     null],
    ['sentAt',         'DATETIME', null],
    ['warmthScore',    'REAL',     null],
    ['dossierScore',   'INTEGER',  null],
    ['contactGate',    'INTEGER',  '0'],
    ['intelScore',     'INTEGER',  null],
    ['lastEnriched',   'DATETIME', null],
    ['lastQueueCheck', 'DATETIME', null],
    ['source',         'TEXT',     null],
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
    ['leedId',           'TEXT',     null],
    ['bookingScore',     'INTEGER',  null],
    ['contactQuality',   'TEXT',     null],
    ['createdAt',        'DATETIME', "CURRENT_TIMESTAMP"],
    ['updatedAt',        'DATETIME', "CURRENT_TIMESTAMP"],
  ],
  Factlet: [
    ['id',        'TEXT',     null],
    ['content',   'TEXT',     null],
    ['source',    'TEXT',     null],
    ['createdAt', 'DATETIME', "CURRENT_TIMESTAMP"],
  ],
  ClientFactlet: [
    ['id',         'TEXT',     null],
    ['clientId',   'TEXT',     null],
    ['factletId',  'TEXT',     null],
    ['signalType', 'TEXT',     null],
    ['points',     'INTEGER',  null],
    ['appliedAt',  'DATETIME', "CURRENT_TIMESTAMP"],
  ],
  Config: [
    ['id',                   'TEXT',    null],
    ['companyName',          'TEXT',    null],
    ['companyEmail',         'TEXT',    null],
    ['businessDescription',  'TEXT',    null],
    ['activeEntities',       'TEXT',    null],
    ['defaultTrade',         'TEXT',    null],
    ['defaultBookingAction', 'TEXT',    null],
    ['marketplaceEnabled',   'INTEGER', '0'],
    ['leadCaptureEnabled',   'INTEGER', '0'],
    ['llmApiKey',            'TEXT',    null],
    ['llmProvider',          'TEXT',    null],
    ['llmBaseUrl',           'TEXT',    null],
    ['llmAnthropicVersion',  'TEXT',    null],
    ['llmMaxTokens',         'INTEGER', '1024'],
    ['leedzEmail',           'TEXT',    null],
    ['leedzSession',         'TEXT',    null],
    ['createdAt',            'DATETIME',"CURRENT_TIMESTAMP"],
    ['updatedAt',            'DATETIME',"CURRENT_TIMESTAMP"],
  ]
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isMemoryFile(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  return MEMORY_PATTERNS.some(pat => pat.test(normalized));
}

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

function timestamp() {
  const d = new Date();
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0')
    + '_'
    + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0');
}

function walCheckpoint(dbPath) {
  const shmFile = dbPath + '-shm';
  const walFile = dbPath + '-wal';
  if (fs.existsSync(shmFile) || fs.existsSync(walFile)) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    // Clean residual WAL files
    try { if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile); } catch (_) {}
    try { if (fs.existsSync(walFile)) fs.unlinkSync(walFile); } catch (_) {}
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Report tracking
// ---------------------------------------------------------------------------

const report = {
  backedUp: [],
  updated: [],
  added: [],
  unchanged: [],
  columnsAdded: [],
  warnings: [],
  errors: [],
  schemaChanged: false,
  depsReinstalled: false,
};

// =========================================================================
// Phase 0: Validate target
// =========================================================================

console.log('Pre-Crime Deployment Updater');
console.log(`Source:  ${PRECRIME}`);
console.log(`Target:  ${targetDir}`);
console.log('');

if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
  console.error(`ERROR: Target directory does not exist: ${targetDir}`);
  process.exit(1);
}

// =========================================================================
// Phase 1: Fingerprint check
// =========================================================================

console.log('Phase 1: Verifying target is a Pre-Crime deployment...');

const fingerprints = [
  path.join(targetDir, 'server', 'mcp', 'mcp_server.js'),
  path.join(targetDir, '.mcp.json'),
];
const dataDir = path.join(targetDir, 'data');

let fpOk = true;
for (const fp of fingerprints) {
  if (!fs.existsSync(fp)) {
    console.error(`  MISSING: ${path.relative(targetDir, fp)}`);
    fpOk = false;
  }
}
if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
  console.error('  MISSING: data/ directory');
  fpOk = false;
}

if (!fpOk) {
  console.error('\nERROR: Target does not look like a Pre-Crime deployment. Aborting.');
  process.exit(1);
}
console.log('  Target verified.\n');

// =========================================================================
// Phase 2: Backup SQLite files
// =========================================================================

console.log('Phase 2: Backing up databases...');

const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));

if (sqliteFiles.length === 0) {
  console.log('  No .sqlite files found in data/ — skipping backup.');
} else {
  const ts = timestamp();
  const backupDir = path.join(dataDir, '_backups', ts);

  if (!dryRun) mkdir(backupDir);

  for (const dbFile of sqliteFiles) {
    const dbPath = path.join(dataDir, dbFile);
    const size = fs.statSync(dbPath).size;
    const sizeKb = (size / 1024).toFixed(1);

    if (dryRun) {
      console.log(`  [dry-run] Would backup: ${dbFile} (${sizeKb} KB)`);
    } else {
      // WAL checkpoint before copying
      const hadWal = walCheckpoint(dbPath);
      if (hadWal) console.log(`  WAL checkpointed: ${dbFile}`);

      fs.copyFileSync(dbPath, path.join(backupDir, dbFile));
      console.log(`  Backed up: ${dbFile} (${sizeKb} KB)`);
    }
    report.backedUp.push({ file: dbFile, sizeKb });
  }

  if (!dryRun) console.log(`  Backups in: ${path.relative(targetDir, backupDir)}`);
}
console.log('');

// =========================================================================
// Phase 3: Generate fresh deployment to temp
// =========================================================================

console.log('Phase 3: Generating fresh reference deployment...');

const manifestPath = path.join(PRECRIME, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`ERROR: manifest.json not found at ${manifestPath}`);
  process.exit(1);
}

const tempDir = path.join(require('os').tmpdir(), `precrime-update-${timestamp()}`);

if (dryRun) {
  console.log(`  [dry-run] Would generate to: ${tempDir}`);
} else {
  try {
    execSync(
      `node "${path.join(PRECRIME, 'deploy.js')}" --manifest "${manifestPath}" --output "${tempDir}" --no-install`,
      { stdio: 'pipe' }
    );
    console.log(`  Generated to: ${tempDir}`);
  } catch (e) {
    console.error(`ERROR: deploy.js failed: ${e.message}`);
    process.exit(1);
  }
}
console.log('');

// =========================================================================
// Phase 4: Detect schema changes
// =========================================================================

console.log('Phase 4: Checking for schema changes...');

const srcSchema  = path.join(PRECRIME, 'server', 'prisma', 'schema.prisma');
const tgtSchema  = path.join(targetDir, 'server', 'prisma', 'schema.prisma');

if (fs.existsSync(srcSchema) && fs.existsSync(tgtSchema)) {
  const srcHash = sha256(srcSchema);
  const tgtHash = sha256(tgtSchema);
  if (srcHash !== tgtHash) {
    report.schemaChanged = true;
    console.log('  Schema has changed — will sync columns in Phase 6.');
  } else {
    console.log('  Schema unchanged.');
  }
} else {
  if (!fs.existsSync(tgtSchema)) {
    report.schemaChanged = true;
    console.log('  Target schema.prisma missing — will add and sync.');
  } else {
    console.log('  Source schema.prisma missing — skipping comparison.');
    report.warnings.push('Source schema.prisma not found');
  }
}
console.log('');

// =========================================================================
// Phase 5: Copy guts files (from temp -> target)
// =========================================================================

console.log('Phase 5: Updating guts files...');

let serverFilesChanged = false;

if (!dryRun && !fs.existsSync(tempDir)) {
  console.error('ERROR: Temp directory missing — cannot copy guts files.');
  process.exit(1);
}

for (const relPath of GUTS_FILES) {
  // Safety guard
  if (isMemoryFile(relPath)) {
    report.warnings.push(`BLOCKED: ${relPath} matched a memory pattern — skipped`);
    console.log(`  BLOCKED: ${relPath} (memory pattern match)`);
    continue;
  }

  const srcFile = dryRun ? null : path.join(tempDir, relPath);
  const tgtFile = path.join(targetDir, relPath);

  if (dryRun) {
    // In dry-run, compare source template output expectations vs target
    if (fs.existsSync(tgtFile)) {
      console.log(`  [dry-run] Would check/update: ${relPath}`);
    } else {
      console.log(`  [dry-run] Would add: ${relPath}`);
    }
    continue;
  }

  if (!fs.existsSync(srcFile)) {
    report.warnings.push(`Source missing in temp build: ${relPath}`);
    console.log(`  WARN: ${relPath} — not in temp build, skipping`);
    continue;
  }

  const srcContent = fs.readFileSync(srcFile);

  if (fs.existsSync(tgtFile)) {
    const tgtContent = fs.readFileSync(tgtFile);
    if (Buffer.compare(srcContent, tgtContent) === 0) {
      report.unchanged.push(relPath);
      continue; // No output for unchanged files — keep it clean
    }
    // File differs — replace it
    mkdir(path.dirname(tgtFile));
    fs.writeFileSync(tgtFile, srcContent);
    report.updated.push(relPath);
    console.log(`  UPDATED: ${relPath}`);
  } else {
    // New file
    mkdir(path.dirname(tgtFile));
    fs.writeFileSync(tgtFile, srcContent);
    report.added.push(relPath);
    console.log(`  ADDED: ${relPath}`);
  }

  // Track if server files changed
  if (SERVER_TRIGGER_FILES.includes(relPath.replace(/\\/g, '/'))) {
    serverFilesChanged = true;
  }
}

// Phase 5b: Copy bat files from templates (not from temp)
console.log('\n  Bat files (from templates/):');
const batFiles = [
  { src: path.join(TEMPLATES, 'setup.bat'),    dst: path.join(targetDir, 'setup.bat'),    name: 'setup.bat' },
  { src: path.join(TEMPLATES, 'precrime.bat'),  dst: path.join(targetDir, 'precrime.bat'),  name: 'precrime.bat' },
];

for (const bf of batFiles) {
  if (!fs.existsSync(bf.src)) {
    report.warnings.push(`Template missing: ${bf.name}`);
    console.log(`  WARN: ${bf.name} — template not found`);
    continue;
  }

  if (dryRun) {
    console.log(`  [dry-run] Would update: ${bf.name}`);
    continue;
  }

  const srcContent = fs.readFileSync(bf.src);
  if (fs.existsSync(bf.dst)) {
    const tgtContent = fs.readFileSync(bf.dst);
    if (Buffer.compare(srcContent, tgtContent) === 0) {
      report.unchanged.push(bf.name);
      continue;
    }
  }

  fs.writeFileSync(bf.dst, srcContent);
  report.updated.push(bf.name);
  console.log(`  UPDATED: ${bf.name}`);
}

console.log('');

// =========================================================================
// Phase 6: Schema sync (conditional)
// =========================================================================

if (report.schemaChanged && sqliteFiles.length > 0) {
  console.log('Phase 6: Syncing database schema...');

  for (const dbFile of sqliteFiles) {
    const dbPath = path.join(dataDir, dbFile);

    if (dryRun) {
      console.log(`  [dry-run] Would sync schema for: ${dbFile}`);
      continue;
    }

    try {
      // WAL checkpoint before modifying
      walCheckpoint(dbPath);

      const db = new DatabaseSync(dbPath);

      // Get existing tables
      const existingTables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%'")
        .all()
        .map(r => r.name);

      let colsAdded = 0;

      for (const [tableName, columns] of Object.entries(PC_SCHEMA)) {
        if (!existingTables.includes(tableName)) {
          report.warnings.push(`Table ${tableName} missing in ${dbFile} — cannot add columns to non-existent table`);
          continue;
        }

        for (const [colName, colType, defaultSql] of columns) {
          const defaultClause = defaultSql !== null ? ` DEFAULT ${defaultSql}` : '';
          try {
            db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}${defaultClause}`);
            colsAdded++;
            report.columnsAdded.push({ db: dbFile, table: tableName, column: colName, type: colType });
            console.log(`  + ${dbFile}: ${tableName}.${colName} (${colType})`);
          } catch (e) {
            // "duplicate column name" = already exists = fine
            if (!e.message.includes('duplicate column')) {
              report.warnings.push(`${dbFile}: ALTER TABLE ${tableName} ADD ${colName} failed: ${e.message}`);
            }
          }
        }
      }

      // WAL checkpoint after modifications
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();

      // Clean residual WAL files
      const shmFile = dbPath + '-shm';
      const walFile = dbPath + '-wal';
      try { if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile); } catch (_) {}
      try { if (fs.existsSync(walFile)) fs.unlinkSync(walFile); } catch (_) {}

      if (colsAdded === 0) {
        console.log(`  ${dbFile}: schema already current`);
      }
    } catch (e) {
      report.errors.push(`Schema sync failed for ${dbFile}: ${e.message}`);
      console.error(`  ERROR: ${dbFile}: ${e.message}`);
    }
  }
  console.log('');
} else if (report.schemaChanged) {
  console.log('Phase 6: Schema changed but no .sqlite files to sync.\n');
} else {
  console.log('Phase 6: Skipped — schema unchanged.\n');
}

// =========================================================================
// Phase 7: Reinstall dependencies (conditional)
// =========================================================================

if (serverFilesChanged) {
  console.log('Phase 7: Reinstalling server dependencies...');

  // Also copy package.json from source (it may have changed)
  const srcPkg = path.join(PRECRIME, 'server', 'package.json');
  const tgtPkg = path.join(targetDir, 'server', 'package.json');
  if (fs.existsSync(srcPkg)) {
    if (dryRun) {
      console.log('  [dry-run] Would copy server/package.json and run npm install + prisma generate');
    } else {
      fs.copyFileSync(srcPkg, tgtPkg);
      console.log('  Copied server/package.json');

      const serverDir = path.join(targetDir, 'server');
      try {
        console.log('  Running npm install...');
        execSync('npm install', { cwd: serverDir, stdio: 'pipe' });
        console.log('  npm install complete.');
      } catch (e) {
        report.errors.push(`npm install failed: ${e.message}`);
        console.error('  ERROR: npm install failed');
      }

      try {
        console.log('  Running npx prisma generate...');
        execSync('npx prisma generate', { cwd: serverDir, stdio: 'pipe' });
        console.log('  prisma generate complete.');
      } catch (e) {
        report.errors.push(`prisma generate failed: ${e.message}`);
        console.error('  ERROR: prisma generate failed');
      }

      report.depsReinstalled = true;
    }
  }
  console.log('');
} else {
  console.log('Phase 7: Skipped — no server file changes.\n');
}

// =========================================================================
// Phase 8: Cleanup temp
// =========================================================================

if (!dryRun && fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// =========================================================================
// Phase 9: Report
// =========================================================================

console.log('='.repeat(55));
console.log(`  Pre-Crime Update ${dryRun ? '(DRY RUN) ' : ''}Complete`);
console.log('='.repeat(55));
console.log(`  Target:     ${targetDir}`);
if (report.backedUp.length > 0) {
  console.log(`  Backup:     data/_backups/ (${report.backedUp.length} file${report.backedUp.length > 1 ? 's' : ''})`);
}
console.log(`  Updated:    ${report.updated.length} file${report.updated.length !== 1 ? 's' : ''} replaced`);
console.log(`  Added:      ${report.added.length} new file${report.added.length !== 1 ? 's' : ''}`);
console.log(`  Unchanged:  ${report.unchanged.length} file${report.unchanged.length !== 1 ? 's' : ''} (already current)`);

if (report.columnsAdded.length > 0) {
  console.log(`  Schema:     ${report.columnsAdded.length} column${report.columnsAdded.length !== 1 ? 's' : ''} added`);
} else if (report.schemaChanged) {
  console.log('  Schema:     checked — already current');
} else {
  console.log('  Schema:     no changes');
}

console.log(`  Deps:       ${report.depsReinstalled ? 'reinstalled' : 'skipped (no server changes)'}`);

if (report.warnings.length > 0) {
  console.log('\n  Warnings:');
  report.warnings.forEach(w => console.log(`    ! ${w}`));
}

if (report.errors.length > 0) {
  console.log('\n  Errors:');
  report.errors.forEach(e => console.log(`    X ${e}`));
}

console.log('='.repeat(55));
console.log('');
