#!/usr/bin/env node
/**
 * audit_build_zip.js -- post-build verification of the PRECRIME deploy zip.
 *
 * Confirms the zip is shippable: required files present, forbidden files
 * absent, no user-facing .env instructions in packaged text, no VALUE_PROP
 * keys leaking into precrime_config.json, tools allowlisted only, no
 * *.legacy.* artifacts.
 *
 * Usage:
 *   node scripts/audit_build_zip.js [--zip <path-to-zip>]
 *
 *   --zip  Audit a specific zip. Default: newest precrime-deploy-*.zip in dist/.
 *
 * Uses only Node built-ins. Extracts via PowerShell Expand-Archive so the
 * audit does not pull in any npm deps.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync, execSync } = require('child_process');

const PRECRIME_ROOT = path.resolve(__dirname, '..');
const DIST_DIR      = path.join(PRECRIME_ROOT, 'dist');

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
}

let zipPath = getArg('--zip');
if (!zipPath) {
    if (!fs.existsSync(DIST_DIR)) {
        console.error(`[audit] dist/ not found at ${DIST_DIR}. Run build.bat first or pass --zip <path>.`);
        process.exit(2);
    }
    const candidates = fs.readdirSync(DIST_DIR)
        .filter(f => /^precrime-deploy-\d+\.zip$/.test(f))
        .map(f => ({ f, full: path.join(DIST_DIR, f), mtime: fs.statSync(path.join(DIST_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    if (!candidates.length) {
        console.error(`[audit] no precrime-deploy-*.zip in ${DIST_DIR}. Run build.bat first.`);
        process.exit(2);
    }
    zipPath = candidates[0].full;
    console.log(`[audit] auditing newest zip: ${zipPath}`);
} else {
    zipPath = path.resolve(zipPath);
    if (!fs.existsSync(zipPath)) {
        console.error(`[audit] zip not found: ${zipPath}`);
        process.exit(2);
    }
    console.log(`[audit] auditing zip: ${zipPath}`);
}

// --------------------------------------------------------------------------
// Extract to temp
// --------------------------------------------------------------------------

const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precrime-audit-'));
console.log(`[audit] extracting to: ${extractDir}`);

const expand = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
     `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`],
    { encoding: 'utf8' }
);
if (expand.status !== 0) {
    console.error(`[audit] Expand-Archive failed:\n${expand.stdout}\n${expand.stderr}`);
    process.exit(2);
}

// build.bat zips a directory named `precrime`, so the extracted layout is
// <extractDir>/precrime/<...>. Detect either layout.
let ROOT = path.join(extractDir, 'precrime');
if (!fs.existsSync(ROOT)) ROOT = extractDir;
if (!fs.existsSync(path.join(ROOT, 'precrime_config.json')) &&
    fs.existsSync(path.join(extractDir, 'precrime', 'precrime_config.json'))) {
    ROOT = path.join(extractDir, 'precrime');
}

// --------------------------------------------------------------------------
// Walk + collect all packaged file paths (relative)
// --------------------------------------------------------------------------

function walk(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...walk(full));
        } else if (ent.isFile()) {
            out.push(full);
        }
    }
    return out;
}

const allFiles = walk(ROOT).map(f => path.relative(ROOT, f).replace(/\\/g, '/'));
const fileSet = new Set(allFiles);

console.log(`[audit] packaged file count: ${allFiles.length}`);

// --------------------------------------------------------------------------
// Assertions
// --------------------------------------------------------------------------

let pass = 0, fail = 0;
const failures = [];

function expect(label, cond, detail) {
    if (cond) { console.log(`  ok    ${label}`); pass++; }
    else      { console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`); fail++; failures.push(label + (detail ? ' -- ' + detail : '')); }
}

// ---- (1) Required files ----
const REQUIRED = [
    'precrime_config.json',
    'precrime_config.sample.json',
    'precrime.bat',
    'goose.bat',
    'setup.bat',
    'GOOSE.md',
    'CLAUDE.md',
    'DOCS/VALUE_PROP.md',
    'DOCS/SCORING.json',
    'DOCS/FOUNDATION.md',
    'server/mcp/mcp_server.js',
    'server/mcp/mcp_gmail.js',
    'server/mcp/gmail_mcp_config.json',
    'server/mcp/mcp_server_config.json',
    'server/config/precrime_config.js',
    'server/sync-config.js',
    'server/package.json',
    'server/prisma/schema.prisma',
    'scripts/bootstrap_config.js',
    '.mcp.json',
    'goose_config.template.yaml',
    'rss/rss-scorer-mcp/index.js',
    'rss/rss-scorer-mcp/package.json'
];

console.log('\n=== Required files ===');
for (const req of REQUIRED) {
    expect(`required: ${req}`, fileSet.has(req));
}

// ---- (2) Active worker skills present ----
const REQUIRED_SKILLS = [
    'skills/init-wizard.md',
    'skills/url-loop.md',
    'skills/enrichment-agent.md',
    'skills/apply-factlet.md',
    'skills/show-hot-leedz.md',
    'skills/share-skill.md',
    'skills/headless_flow.md'
];
console.log('\n=== Active worker skills ===');
for (const sk of REQUIRED_SKILLS) {
    expect(`skill present: ${sk}`, fileSet.has(sk));
}

// ---- (3) Forbidden files / directories ----
console.log('\n=== Forbidden files / directories ===');
const FORBIDDEN_EXACT = [
    '.env',
    '.env.sample',
    'server/.env',
    'server/.env.sample'
];
for (const f of FORBIDDEN_EXACT) {
    expect(`forbidden absent: ${f}`, !fileSet.has(f));
}

// Forbidden by pattern -- any path containing these substrings is a fail.
const FORBIDDEN_PATTERNS = [
    { label: '*.legacy.* (any path)',           re: /\.legacy\./i },
    { label: '_archive/ directory',             re: /(^|\/)_archive(\/|$)/i },
    { label: 'node_modules/',                   re: /(^|\/)node_modules\//i },
    { label: 'TMP/',                            re: /(^|\/)TMP\//i },
    { label: 'dist/ (nested build artifacts)',  re: /(^|\/)dist\//i },
    { label: 'scripts/smoke_*',                 re: /(^|\/)scripts\/smoke[_-]/i },
    { label: 'scripts/migrate_*',               re: /(^|\/)scripts\/migrate[_-]/i },
    { label: 'docs/MCP_REWRITE.md (source-tree only)', re: /(^|\/)MCP_REWRITE\.md$/i }
];
for (const { label, re } of FORBIDDEN_PATTERNS) {
    const hits = allFiles.filter(f => re.test(f));
    expect(`forbidden pattern absent: ${label}`, hits.length === 0, hits.slice(0, 4).join(', '));
}

// ---- (4) No user-facing .env instructions in packaged text ----
console.log('\n=== Packaged text contains no user-facing .env instructions ===');
const TEXT_EXTS = new Set(['.md', '.bat', '.json', '.js', '.py', '.yaml', '.yml', '.txt', '.prisma']);
// Phrases that indicate a packaged file is telling the user to use .env.
const ENV_INSTRUCTION_PATTERNS = [
    /copy\s+\.env\.sample/i,
    /edit\s+\.env\b/i,
    /\.env\.sample\b/,
    /OPENROUTER_API_KEY\s+missing\s+from\s+\.env/i,
    /TAVILY_API_KEY\s+missing\s+from\s+\.env/i,
    /fill\s+in\s+your\s+API\s+keys.*\.env/i,
    />\s*"%~dp0server\\\.env"/i,                          // bat that writes server\.env
    /server\\\.env\b/i
];
const envOffenders = [];
for (const rel of allFiles) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    let body;
    try { body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    for (const re of ENV_INSTRUCTION_PATTERNS) {
        if (re.test(body)) {
            envOffenders.push(`${rel} :: ${re.source}`);
            break;
        }
    }
}
expect('no packaged text instructs user about .env',
       envOffenders.length === 0,
       envOffenders.slice(0, 6).join(' | '));

// ---- (5) Gmail MCP present ----
console.log('\n=== Gmail MCP present ===');
expect('server/mcp/mcp_gmail.js present',          fileSet.has('server/mcp/mcp_gmail.js'));
expect('server/mcp/gmail_mcp_config.json present', fileSet.has('server/mcp/gmail_mcp_config.json'));

// ---- (6) precrime_config.json has no forbidden VALUE_PROP keys ----
console.log('\n=== precrime_config.json contains no VALUE_PROP keys ===');
const FORBIDDEN_KEYS = [
    'companyName', 'companyEmail', 'businessDescription', 'defaultTrade',
    'leedzEmail', 'pitch', 'buyers', 'geography', 'pricing', 'outreachExamples',
    'marketplaceEnabled', 'leadCaptureEnabled', 'relevanceSignals',
    'signature',  // mirrored from VALUE_PROP.md into SQLite Config; never in precrime_config.json
    'timezone'    // derived from Booking.zip by share_booking; not user-configured
];
let cfgRaw;
try { cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'precrime_config.json'), 'utf8')); }
catch (e) { cfgRaw = null; expect('precrime_config.json parseable', false, e.message); }
if (cfgRaw) {
    for (const k of FORBIDDEN_KEYS) {
        expect(`precrime_config.json forbidden key absent: ${k}`,
               !Object.prototype.hasOwnProperty.call(cfgRaw, k));
    }
    // Required runtime fields:
    for (const k of ['apiKeys', 'llm', 'tasks', 'recycler', 'paths']) {
        expect(`precrime_config.json has required block: ${k}`,
               Object.prototype.hasOwnProperty.call(cfgRaw, k));
    }
    // Both tasks.limits AND tasks.sessionBudgets must ship.
    expect('precrime_config.json has tasks.limits.SCRAPE_SOURCE',
           Number.isFinite(cfgRaw.tasks?.limits?.SCRAPE_SOURCE),
           String(cfgRaw.tasks?.limits?.SCRAPE_SOURCE));
    expect('precrime_config.json has tasks.sessionBudgets.SCRAPE_SOURCE',
           Number.isFinite(cfgRaw.tasks?.sessionBudgets?.SCRAPE_SOURCE),
           String(cfgRaw.tasks?.sessionBudgets?.SCRAPE_SOURCE));
    expect('precrime_config.json sessionBudgets.SCRAPE_SOURCE >= limits.SCRAPE_SOURCE',
           cfgRaw.tasks?.sessionBudgets?.SCRAPE_SOURCE >= cfgRaw.tasks?.limits?.SCRAPE_SOURCE,
           `${cfgRaw.tasks?.sessionBudgets?.SCRAPE_SOURCE} vs ${cfgRaw.tasks?.limits?.SCRAPE_SOURCE}`);
    expect('precrime_config.json has tasks.workflowStrategy.factletBacklogDiscoveryPause',
           Number.isFinite(cfgRaw.tasks?.workflowStrategy?.factletBacklogDiscoveryPause),
           String(cfgRaw.tasks?.workflowStrategy?.factletBacklogDiscoveryPause));
}

// ---- (7) precrime_config.sample.json shape matches ----
let sampleRaw;
try { sampleRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'precrime_config.sample.json'), 'utf8')); }
catch (e) { sampleRaw = null; expect('precrime_config.sample.json parseable', false, e.message); }
if (sampleRaw) {
    for (const k of FORBIDDEN_KEYS) {
        expect(`precrime_config.sample.json forbidden key absent: ${k}`,
               !Object.prototype.hasOwnProperty.call(sampleRaw, k));
    }
    expect('precrime_config.sample.json has tasks.sessionBudgets',
           !!sampleRaw.tasks?.sessionBudgets &&
           Number.isFinite(sampleRaw.tasks.sessionBudgets.SCRAPE_SOURCE),
           JSON.stringify(sampleRaw.tasks?.sessionBudgets));
    expect('precrime_config.sample.json has tasks.workflowStrategy',
           Number.isFinite(sampleRaw.tasks?.workflowStrategy?.factletBacklogDiscoveryPause),
           JSON.stringify(sampleRaw.tasks?.workflowStrategy));
}

// ---- (8) Tools allowlist ----
console.log('\n=== tools/ is allowlisted ===');
const TOOLS_ALLOWED = new Set([
    'tools/tavily_lean_mcp.py',
    'tools/tavily_lean.py',
    'tools/leedz_proxy_mcp.py'
]);
const packagedTools = allFiles.filter(f => f.startsWith('tools/'));
for (const t of packagedTools) {
    expect(`tool allowed: ${t}`, TOOLS_ALLOWED.has(t));
}
// Active tools must be present
for (const t of TOOLS_ALLOWED) {
    expect(`active tool present: ${t}`, fileSet.has(t));
}

// The Leedz proxy may remain packaged for historical compatibility, but it
// must not be exposed to the agent. Marketplace posts go only through
// precrime.share_booking, which performs Judge/date gates server-side.
for (const cfgName of ['.mcp.json', 'mcp.json', 'goose_config.template.yaml']) {
    const cfgPath = allFiles.find(f => f === cfgName || f.endsWith('/' + cfgName));
    if (!cfgPath) continue;
    const body = fs.readFileSync(path.join(ROOT, cfgPath), 'utf8');
    expect(`${cfgPath} does not expose Leedz proxy`,
           !/\bleedz_proxy_mcp\.py\b/.test(body) && !/^\s*leedz:\s*$/m.test(body) && !/"leedz"\s*:/.test(body));
}

// ---- (9) No packaged file references dead skills as live invocations ----
console.log('\n=== Packaged text contains no live refs to removed skills ===');
// Dead skills = files removed from the package in the Task-architecture pivot.
// We flag a reference as "live" when it looks like a procedural invocation
// (skills/<dead>.md, follow skills/<dead>.md, Read .../skills/<dead>.md, etc.).
// Negative / historical mentions ("legacy", "no longer", "previously", "do not call")
// are allowed.
const DEAD_SKILLS = [
    'marketplace_flow.md',
    'hybrid_flow.md',
    'outreach_flow.md',
    'source-discovery.md',              // top-level skill (the discovered_directories.md seed stays)
    'client-seeder.md',
    'draft-checker.md',
    'leed-drafter.md',
    'relevance-judge.md',
    'value-prop-validator.md',
    'rss-factlet-harvester/SKILL.md',
    'fb-factlet-harvester/SKILL.md',
    'reddit-factlet-harvester/SKILL.md',
    'ig-factlet-harvester/SKILL.md',
    'x-factlet-harvester/SKILL.md'
];
function isAllowedLine(line) {
    const low = line.toLowerCase();
    return low.includes('legacy')
        || low.includes('no longer')
        || low.includes('previously')
        || low.includes('do not call')
        || low.includes('never call')
        || low.includes('removed')
        || low.includes('forbidden')
        || low.includes('not packaged')
        || low.includes('orphan')
        || low.includes('obsolete')
        || low.includes('do not invoke')
        || low.includes('historical');
}
const deadHits = [];
for (const rel of allFiles) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    let body;
    try { body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    const lines = body.split(/\r?\n/);
    for (const dead of DEAD_SKILLS) {
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].includes(dead)) continue;
            if (isAllowedLine(lines[i])) continue;
            deadHits.push(`${rel}:${i + 1} -> ${dead}: ${lines[i].trim().slice(0, 140)}`);
        }
    }
}
expect('no live invocation of removed skills',
       deadHits.length === 0,
       deadHits.slice(0, 8).join(' || '));

// ---- (10) Launchers do not reference .env files ----
console.log('\n=== Launchers do not require .env ===');
for (const launcher of ['precrime.bat', 'goose.bat', 'hermes.bat']) {
    if (!fileSet.has(launcher)) {
        expect(`launcher ${launcher} contents check`, false, 'missing');
        continue;
    }
    const body = fs.readFileSync(path.join(ROOT, launcher), 'utf8');
    expect(`${launcher} does not read .env file`,
           !/\bfor\s+\/f.*"%~dp0\.env"/i.test(body) && !/Copy\s+\.env\.sample/i.test(body));
    expect(`${launcher} does not write server\\.env`,
           !/>\s*"%~dp0server\\\.env"/i.test(body));
    expect(`${launcher} requires precrime_config.json`,
           /precrime_config\.json/.test(body));
    if (launcher !== 'hermes.bat') {
        expect(`${launcher} invokes bootstrap_config.js`,
               /bootstrap_config\.js/.test(body));
    }
    // Objective-routing contract: every shipped launcher must parse
    // --marketplace / --outreach / --hybrid and emit the resolved objective
    // so init-wizard.md can detect it. Without this, fresh installs lose
    // the ability to override the default at launch.
    expect(`${launcher} parses --marketplace flag`, /--marketplace/.test(body));
    expect(`${launcher} parses --outreach flag`,    /--outreach/.test(body));
    expect(`${launcher} parses --hybrid flag`,      /--hybrid/.test(body));
    expect(`${launcher} sets PRECRIME_OBJECTIVE`,   /PRECRIME_OBJECTIVE/.test(body));
    expect(`${launcher} applies headless=>marketplace / interactive=>hybrid defaults`,
           /PRECRIME_OBJECTIVE=marketplace/.test(body) && /PRECRIME_OBJECTIVE=hybrid/.test(body));
}

// ---- (10a) ClientFactlet must be fully removed (schema + code + shipped DB) ----
console.log('\n=== ClientFactlet absence (hard guard) ===');
if (fileSet.has('server/prisma/schema.prisma')) {
    const sch = fs.readFileSync(path.join(ROOT, 'server/prisma/schema.prisma'), 'utf8');
    expect('packaged schema.prisma defines no `model ClientFactlet`',
           !/\bmodel\s+ClientFactlet\b/.test(sch),
           'ClientFactlet model still in schema');
    expect('packaged schema.prisma defines no `ClientFactlet[]` relation',
           !/ClientFactlet\[\]/.test(sch),
           'ClientFactlet[] relation still in schema');
    expect('packaged schema.prisma has no Config.clientFactletMigratedAt column',
           !/clientFactletMigratedAt/.test(sch),
           'migration marker column still in schema');
    // P1012 guard: a field marked @id MUST be required (no `?`). This catches
    // schemas accidentally regenerated by `prisma db pull` against a loose
    // SQLite DB, which renders id columns as optional and breaks `prisma generate`.
    const optionalIdMatches = (sch.match(/^\s*\w+\s+\w+\?\s+.*@id\b/gm) || []);
    expect('packaged schema.prisma has no optional fields marked @id (P1012)',
           optionalIdMatches.length === 0,
           'offending lines: ' + optionalIdMatches.map(s => s.trim()).join(' | '));
    // The db-pull comment is a fingerprint of the same regression.
    expect('packaged schema.prisma was not produced by `prisma db pull`',
           !/The underlying table does not contain a valid unique identifier/.test(sch),
           'schema appears to be a prisma db pull output (re-export from canonical)');
    // Stale legacy model that should not survive into a packaged build.
    expect('packaged schema.prisma defines no `model precrime_migrations`',
           !/\bmodel\s+precrime_migrations\b/.test(sch),
           'precrime_migrations model still in schema');
}
if (fileSet.has('server/mcp/mcp_server.js')) {
    const ms = fs.readFileSync(path.join(ROOT, 'server/mcp/mcp_server.js'), 'utf8');
    expect('packaged mcp_server.js does not call prisma.clientFactlet.*',
           !/prisma\.clientFactlet\.|tx\.clientFactlet\./.test(ms),
           'mcp_server.js still calls prisma.clientFactlet.*');
    expect('packaged mcp_server.js does not define migrateClientFactletsToDossier',
           !/migrateClientFactletsToDossier\s*\(/.test(ms),
           'migration helper still present');
}
// Cheap binary scan of every shipped .sqlite file: SQLite stores table names
// as readable ASCII in the sqlite_master serialization, so a literal byte
// match is a reliable guard. deploy.js renames data/blank.sqlite to the
// manifest's dbFile, so we scan whatever .sqlite files actually shipped.
const shippedDbs = allFiles.filter(f => f.toLowerCase().endsWith('.sqlite'));
expect('at least one .sqlite ships (blank or named DB)',
       shippedDbs.length > 0,
       'no .sqlite found in zip');
for (const rel of shippedDbs) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    expect(`packaged ${rel} has no ClientFactlet table`,
           buf.indexOf('ClientFactlet') === -1,
           'ClientFactlet bytes found in ' + rel);
}

// ---- (11a) RSS branch invariants (zip-packaged copies) ----
console.log('\n=== RSS-channel invariants ===');
if (fileSet.has('skills/url-loop.md')) {
    const ul = fs.readFileSync(path.join(ROOT, 'skills/url-loop.md'), 'utf8');
    expect('packaged url-loop.md has channel:"rss" branch',
           /channel\s*===\s*["']rss["']|channel:\s*["']rss["']/.test(ul),
           'no channel:"rss" branch');
    expect('packaged url-loop.md rss branch calls precrime_rss__get_top_articles with feedUrl',
           /precrime_rss__get_top_articles[\s\S]{0,200}feedUrl/.test(ul),
           'no precrime_rss__get_top_articles({ feedUrl: ... }) call');
    expect('packaged url-loop.md saves discovered feeds with subtype:"feed"',
           /channel:\s*["']rss["'][\s\S]{0,80}subtype:\s*["']feed["']/.test(ul),
           'feed add_sources entry missing subtype:"feed"');
    expect('packaged url-loop.md discoveredFrom uses scraped source url',
           /discoveredFrom:\s*["']<the scraped source url>["']/.test(ul),
           'discoveredFrom not pinned to scraped source url');
    expect('packaged url-loop.md forbids runtime writes to rss_sources.md',
           /[Dd]o NOT write to[\s\S]{0,80}rss_sources\.md/.test(ul) ||
           /rss_sources\.md[\s\S]{0,80}[Ss][Ee][Ee][Dd][\s\S]{0,80}only/.test(ul),
           'no forbidden-write note');
}
if (fileSet.has('rss/rss-scorer-mcp/index.js')) {
    const r = fs.readFileSync(path.join(ROOT, 'rss/rss-scorer-mcp/index.js'), 'utf8');
    expect('packaged RSS MCP getTopArticles accepts feedUrl override',
           /getTopArticles\s*\(\s*limit\s*,\s*feedUrlOverride\s*\)|getTopArticles\([^)]*feedUrl/.test(r),
           'getTopArticles signature does not accept feedUrl');
    expect('packaged RSS MCP tool handler reads args.feedUrl',
           /args\.feedUrl/.test(r),
           'tool handler does not read args.feedUrl');
}
// Ship invariants: rss seed file + rss config + Gmail MCP + no harvester SKILL.md
expect('packaged rss_sources.md ships',
       fileSet.has('skills/rss-factlet-harvester/rss_sources.md'));
expect('packaged rss_config.json ships',
       fileSet.has('rss/rss-scorer-mcp/rss_config.json'));
expect('packaged Gmail MCP server ships',
       fileSet.has('server/mcp/mcp_gmail.js'));
expect('packaged Gmail MCP config ships',
       fileSet.has('server/mcp/gmail_mcp_config.json'));
const harvesterSkill = allFiles.filter(f => /-factlet-harvester\/SKILL\.md$/.test(f));
expect('no legacy harvester SKILL.md files packaged',
       harvesterSkill.length === 0,
       harvesterSkill.join(', '));

// ---- (11) New architecture invariants (timezone, signature, get_config) ----
console.log('\n=== New architecture invariants ===');
// precrime_config.json must not carry a `timezone` key (already covered above
// via FORBIDDEN_KEYS, but assert once more explicitly for the report).
expect('precrime_config.json contains no `timezone` key',
       !cfgRaw || !Object.prototype.hasOwnProperty.call(cfgRaw, 'timezone'));
expect('precrime_config.sample.json contains no `timezone` key',
       !sampleRaw || !Object.prototype.hasOwnProperty.call(sampleRaw, 'timezone'));

// bootstrap_config.js must not emit PRECRIME_TIMEZONE.
if (fileSet.has('scripts/bootstrap_config.js')) {
    const bsBody = fs.readFileSync(path.join(ROOT, 'scripts/bootstrap_config.js'), 'utf8');
    expect('bootstrap_config.js does NOT emit PRECRIME_TIMEZONE',
           !/PRECRIME_TIMEZONE/.test(bsBody.replace(/\/\/[^\n]*/g, '')),
           'still emits PRECRIME_TIMEZONE');
}

// outreach-drafter.md must reference get_config(signature) + verbatim use.
if (fileSet.has('skills/outreach-drafter.md')) {
    const draft = fs.readFileSync(path.join(ROOT, 'skills/outreach-drafter.md'), 'utf8');
    expect('outreach-drafter.md calls get_config for signature',
           /get_config[^\n]*signature|signature[^\n]*get_config/i.test(draft),
           'no get_config(signature) reference');
    expect('outreach-drafter.md instructs verbatim signature use',
           /verbatim/i.test(draft),
           'no "verbatim" instruction');
}

// VALUE_PROP.md template must have a SIGNATURE section.
if (fileSet.has('DOCS/VALUE_PROP.md')) {
    const vp = fs.readFileSync(path.join(ROOT, 'DOCS/VALUE_PROP.md'), 'utf8');
    expect('DOCS/VALUE_PROP.md has a SIGNATURE section',
           /^##\s+SIGNATURE\s*$/im.test(vp),
           'no `## SIGNATURE` heading');
}

// sync-config.js must parse signature into Config.
if (fileSet.has('server/sync-config.js')) {
    const sc = fs.readFileSync(path.join(ROOT, 'server/sync-config.js'), 'utf8');
    expect('server/sync-config.js parses signature',
           /signature/.test(sc) && /SIGNATURE/.test(sc),
           'no signature parse');
    expect('server/sync-config.js accepts legacy ### Signature headings',
           /#\{2,6\}\\s\+signature\\b/.test(sc) && /\/im/.test(sc),
           'no legacy Signature heading fallback');
    expect('server/sync-config.js parses explicit **Trade:** before inference',
           /explicitTrade/.test(sc) && /Trade:/.test(sc),
           'no explicit Trade parser');
    expect('server/sync-config.js does not infer trade from full VALUE_PROP body',
           !/textLower\s*=\s*text\.toLowerCase/.test(sc),
           'whole-body trade inference still present');
}

// init-wizard.md must include a mandatory Config gate that references signature.
if (fileSet.has('skills/init-wizard.md')) {
    const iw = fs.readFileSync(path.join(ROOT, 'skills/init-wizard.md'), 'utf8');
    expect('init-wizard.md has Mandatory Config gate referencing signature',
           /signature/i.test(iw) && /mandatory/i.test(iw),
           'no signature/mandatory wording');
    expect('init-wizard.md headless mode stops with CONFIG_INCOMPLETE',
           /CONFIG_INCOMPLETE/.test(iw),
           'no CONFIG_INCOMPLETE stop signal');
}

// mcp_server.js must declare get_config in the action enum and ship the ZIP->IANA resolver.
if (fileSet.has('server/mcp/mcp_server.js')) {
    const ms = fs.readFileSync(path.join(ROOT, 'server/mcp/mcp_server.js'), 'utf8');
    expect('mcp_server.js exposes pipeline action get_config',
           /'get_config'/.test(ms),
           'no get_config action enum');
    expect('mcp_server.js ships zipToTimezone resolver',
           /function\s+zipToTimezone\s*\(/.test(ms),
           'no zipToTimezone function');
    expect('mcp_server.js share_booking returns missing_location_timezone',
           /missing_location_timezone/.test(ms),
           'no missing_location_timezone code path');
    expect('mcp_server.js share_booking returns unresolved_location_timezone',
           /unresolved_location_timezone/.test(ms),
           'no unresolved_location_timezone code path');
    expect('mcp_server.js does NOT define or call migrateClientFactletsToDossier',
           !/migrateClientFactletsToDossier\s*\(/.test(ms),
           'migration helper still present (ClientFactlet was removed end-to-end)');
    expect('mcp_server.js complete_task writes task_completed SessionEvent',
           /task_completed/.test(ms),
           'no task_completed event');
    expect('mcp_server.js defines TASK_SESSION_BUDGETS',
           /TASK_SESSION_BUDGETS/.test(ms),
           'no TASK_SESSION_BUDGETS constant');
    expect('mcp_server.js plan_tasks returns budgetUsage / budgetExhausted',
           /budgetUsage/.test(ms) && /budgetExhausted/.test(ms),
           'no budget reporting fields');
    expect('mcp_server.js plan_tasks supports deterministic session close',
           /sessionClosed/.test(ms) && /closeReason/.test(ms),
           'no session-close reporting');
}

// --------------------------------------------------------------------------
// Cleanup + report
// --------------------------------------------------------------------------

try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}

console.log(`\n=== Audit result: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
}
process.exit(0);
