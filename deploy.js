#!/usr/bin/env node
/**
 * Pre-Crime — Deployment Generator
 *
 * Reads a deployment manifest JSON and produces a fully scaffolded
 * LeedzEngine workspace: directories, MCP config, RSS config,
 * all 5 skill playbook files with tokens substituted, and doc stubs.
 *
 * Usage:
 *   node deploy.js --manifest <path/to/manifest.json> [--output <dir>]
 *
 * If --output is omitted, uses manifest.deployment.rootDir.
 *
 * No npm packages required — only Node.js built-ins.
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const manifestArg = get('--manifest');
if (!manifestArg) {
  console.error('Usage: node deploy.js --manifest <manifest.json> [--output <dir>]');
  process.exit(1);
}

const manifestPath = path.resolve(manifestArg);
if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest   = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const outputArg  = get('--output');
const outputDir  = path.resolve(outputArg || manifest.deployment.rootDir);
const PRECRIME   = __dirname;
const TMPL       = path.join(PRECRIME, 'templates');
const DATA       = path.join(PRECRIME, 'data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

function write(filePath, content) {
  mkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`  ✓ ${path.relative(outputDir, filePath)}`);
}

function copyFile(src, dst) {
  mkdir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log(`  ✓ ${path.relative(outputDir, dst)}`);
}

function substitute(content, tokens) {
  let out = content;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.split(k).join(v);
  }
  return out;
}

function copyTemplate(tmplRel, outRel, tokens) {
  const src = path.join(TMPL, tmplRel);
  if (!fs.existsSync(src)) { console.warn(`  ⚠ template missing: ${tmplRel}`); return; }
  write(path.join(outputDir, outRel), substitute(fs.readFileSync(src, 'utf8'), tokens));
}

// ---------------------------------------------------------------------------
// Build token map from manifest
// ---------------------------------------------------------------------------

function buildTokens(m) {
  const s  = m.seller   || {};
  const p  = m.product  || {};
  const a  = m.audience || {};
  const o  = m.outreachRules     || {};
  const rs = m.relevanceSignals  || {};
  const ws = m.warmthScoring     || {};
  const ec = m.evaluatorCriteria || [];
  const d  = m.deployment        || {};

  // Audience
  const segments = a.segments || [];
  const audienceDesc  = segments.map(sg => `${sg.label} (${(sg.targetRoles||[]).join(', ')})`).join('; ') || '(define audience.segments in manifest)';
  const targetRoles   = [...new Set(segments.flatMap(sg => sg.targetRoles || []))].join(', ') || '(define targetRoles in manifest)';
  const allEvents     = [...new Set(segments.flatMap(sg => sg.events     || []))].join(', ') || '(define events in manifest)';

  // Seasonal windows summary
  const seasonalSummary = segments.flatMap(sg => (sg.seasonalWindows || []).map(sw =>
    `- **${sw.name}** (${sg.label}): outreach months ${(sw.months||[]).join(',')} — event ${(sw.event_months||[]).join(',')}, book ${sw.lead_weeks||'?'}w out`
  )).join('\n') || '- (define seasonalWindows in manifest)';

  // Differentiators
  const diffs = (p.differentiators || []).map((d, i) => `${i+1}. ${d}`).join('\n') || '(define product.differentiators in manifest)';

  // Relevance signals
  const relHigh   = (rs.high    || []).map(x => `- "${x}"`).join('\n') || '- (define relevanceSignals.high in manifest)';
  const relMedium = (rs.medium  || []).map(x => `- "${x}"`).join('\n') || '- (define relevanceSignals.medium in manifest)';
  const relTiming = (rs.timing  || []).map(x => `- "${x}"`).join('\n') || '- (define relevanceSignals.timing in manifest)';
  const relNot    = (rs.not     || []).map(x => `- ${x}`).join('\n')   || '- (define relevanceSignals.not in manifest)';

  // Factlet topics
  const factletRelevant = (m.factletTopics    || []).map(x => `- ${x}`).join('\n') || '- (define factletTopics in manifest)';
  const factletNot      = (m.factletNotTopics || []).map(x => `- ${x}`).join('\n') || '- (define factletNotTopics in manifest)';

  // Warmth scoring table
  let scoringTable = '(define warmthScoring.categories in manifest)';
  if (ws.categories && ws.categories.length) {
    const header = '| Category | Max | 0 | 1 | 2 |\n|----------|-----|---|---|---|';
    const rows   = ws.categories.map(c => {
      const cr = c.criteria || {};
      return `| **${c.name}** | ${c.max} | ${cr['0']||''} | ${cr['1']||''} | ${c.max > 1 ? (cr['2']||'—') : '—'} |`;
    }).join('\n');
    scoringTable = header + '\n' + rows;
  }
  const hardGates = (ws.hardGates || []).map(g => `- ${g}`).join('\n') || '- No email → warmthScore = 0';

  // Evaluator criteria
  let evalCriteria = '(define evaluatorCriteria array in manifest)';
  if (ec.length) {
    evalCriteria = ec.map((c, i) =>
      `### ${i+1}. ${c.name}\n${c.description}\n\nPASS: ${c.passExample || '(define)'}\n\nFAIL: ${c.failExample || '(define)'}`
    ).join('\n\n');
  }

  // Outreach rules
  const forbidden = (o.forbidden || []).map(f => `- "${f}"`).join('\n') || '- "I hope this finds you well"\n- "I\'m reaching out because"\n- "I would love the opportunity"';

  // FB sources
  const fbSources = (m.fbSources || []).join('\n') || '# Add Facebook page URLs here — one per line\n# Active, public pages only';

  // DB path
  const dbFile    = d.dbFile || `data/${(d.name || 'project').toLowerCase()}.sqlite`;
  const dbAbsPath = path.join(outputDir, dbFile);

  return {
    '{{DEPLOYMENT_NAME}}':        d.name || 'Unnamed',
    '{{SELLER_NAME}}':            s.name || '',
    '{{SELLER_COMPANY}}':         s.company || '',
    '{{SELLER_EMAIL}}':           s.email || '',
    '{{SELLER_WEBSITE}}':         s.website || '',
    '{{SELLER_PHONE}}':           s.phone || '',
    '{{PRODUCT_NAME}}':           p.name || '',
    '{{PRODUCT_DESCRIPTION}}':    p.description || '',
    '{{PRODUCT_DIFFERENTIATORS}}': diffs,
    '{{GEOGRAPHY}}':              p.geography || 'Not specified',
    '{{PRICING}}':                p.pricing || 'See seller',
    '{{AUDIENCE_DESCRIPTION}}':   audienceDesc,
    '{{TARGET_ROLES}}':           targetRoles,
    '{{ALL_EVENTS}}':             allEvents,
    '{{SEASONAL_WINDOWS}}':       seasonalSummary,
    '{{RELEVANT_SIGNALS_HIGH}}':  relHigh,
    '{{RELEVANT_SIGNALS_MEDIUM}}': relMedium,
    '{{TIMING_SIGNALS}}':         relTiming,
    '{{NOT_RELEVANT_TOPICS}}':    relNot,
    '{{FACTLET_RELEVANT_TOPICS}}': factletRelevant,
    '{{FACTLET_NOT_TOPICS}}':     factletNot,
    '{{WARMTH_SCORING_TABLE}}':   scoringTable,
    '{{WARMTH_HARD_GATES}}':      hardGates,
    '{{EVALUATOR_CRITERIA}}':     evalCriteria,
    '{{OUTREACH_MAX_WORDS}}':     String(o.maxWords || 150),
    '{{OUTREACH_TONE}}':          o.tone || 'confident, direct, human',
    '{{OUTREACH_OPEN_RULE}}':     o.openWith  || "Lead with THEIR world — never with your name or product name",
    '{{OUTREACH_CLOSE_RULE}}':    o.closeWith || "Close with a command, not a hope",
    '{{OUTREACH_FORBIDDEN}}':     forbidden,
    '{{FB_SOURCES_LIST}}':        fbSources,
    '{{DB_RELATIVE_PATH}}':       dbFile.replace(/\\/g, '/'),
    '{{DB_ABS_PATH}}':            dbAbsPath.replace(/\\/g, '/'),
    '{{PROJECT_ROOT}}':           outputDir.replace(/\\/g, '/'),
    '{{TODAY}}':                  new Date().toISOString().split('T')[0],
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

console.log(`\nPre-Crime Deployment Generator`);
console.log(`Manifest : ${manifestPath}`);
console.log(`Output   : ${outputDir}\n`);

// 1. Create directory tree
const dirs = [
  outputDir,
  path.join(outputDir, 'data'),
  path.join(outputDir, 'DOCS'),
  path.join(outputDir, 'skills', 'fb-factlet-harvester'),
  path.join(outputDir, 'logs'),
  path.join(outputDir, 'server', 'mcp'),
  path.join(outputDir, 'server', 'prisma'),
  path.join(outputDir, 'rss', 'rss-scorer-mcp'),
  path.join(outputDir, 'reddit'),
  path.join(outputDir, 'ig'),
  path.join(outputDir, 'skills', 'ig-factlet-harvester'),
];
dirs.forEach(mkdir);
console.log('Directories created.');

// 2. Copy the built-in PRECRIME MCP server source into the generated workspace
const mcpSrc = path.join(PRECRIME, 'server', 'mcp', 'mcp_server.js');
const mcpDst = path.join(outputDir, 'server', 'mcp', 'mcp_server.js');
if (fs.existsSync(mcpSrc)) {
  copyFile(mcpSrc, mcpDst);
} else {
  console.warn(`  ⚠ MCP server source missing: ${mcpSrc}`);
  console.warn('    Copy server/mcp/mcp_server.js into the generated workspace manually.');
}

// 2b. Copy server/package.json
const pkgSrc = path.join(PRECRIME, 'server', 'package.json');
const pkgDst = path.join(outputDir, 'server', 'package.json');
if (fs.existsSync(pkgSrc)) {
  copyFile(pkgSrc, pkgDst);
} else {
  console.warn(`  ⚠ server/package.json missing: ${pkgSrc}`);
}

// 2c. Copy server/prisma/schema.prisma
const schemaSrc = path.join(PRECRIME, 'server', 'prisma', 'schema.prisma');
const schemaDst = path.join(outputDir, 'server', 'prisma', 'schema.prisma');
if (fs.existsSync(schemaSrc)) {
  copyFile(schemaSrc, schemaDst);
} else {
  console.warn(`  ⚠ server/prisma/schema.prisma missing: ${schemaSrc}`);
}

// 2d. npm install + prisma generate in generated workspace
console.log('\nInstalling server dependencies (npm install)...');
try {
  execSync('npm install', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
} catch (e) {
  console.warn('  ⚠ npm install failed — run manually: cd server && npm install');
}

console.log('\nGenerating Prisma client (npx prisma generate)...');
try {
  execSync('npx prisma generate', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
} catch (e) {
  console.warn('  ⚠ prisma generate failed — run manually: cd server && npx prisma generate');
}

// 2e. Copy RSS scorer (index.js + package.json) and install its deps
const rssSrc    = path.join(PRECRIME, 'rss', 'rss-scorer-mcp', 'index.js');
const rssDst    = path.join(outputDir, 'rss', 'rss-scorer-mcp', 'index.js');
const rssPkgSrc = path.join(PRECRIME, 'rss', 'rss-scorer-mcp', 'package.json');
const rssPkgDst = path.join(outputDir, 'rss', 'rss-scorer-mcp', 'package.json');

if (fs.existsSync(rssSrc)) {
  copyFile(rssSrc, rssDst);
} else {
  console.warn(`  ⚠ RSS scorer source missing: ${rssSrc}`);
}
if (fs.existsSync(rssPkgSrc)) {
  copyFile(rssPkgSrc, rssPkgDst);
}

console.log('\nInstalling RSS scorer dependencies (npm install)...');
try {
  execSync('npm install', { cwd: path.join(outputDir, 'rss', 'rss-scorer-mcp'), stdio: 'inherit' });
} catch (e) {
  console.warn('  ⚠ RSS npm install failed — run manually: cd rss/rss-scorer-mcp && npm install');
}

// 3. Copy template.sqlite → data/{name}.sqlite
const dbFile    = (manifest.deployment.dbFile || `data/${(manifest.deployment.name||'project').toLowerCase()}.sqlite`);
const dbDest    = path.join(outputDir, dbFile);
const tmplDb    = path.join(DATA, 'template.sqlite');
if (fs.existsSync(tmplDb)) {
  mkdir(path.dirname(dbDest));
  fs.copyFileSync(tmplDb, dbDest);
  console.log(`  ✓ ${dbFile}  (empty schema — ready for clients)`);
} else {
  console.warn(`  ⚠ template.sqlite not found at ${tmplDb}`);
  console.warn(`    Run: node scripts/create-template.js  to create it.`);
}

// 3. Build tokens
const tokens = buildTokens(manifest);

// 4a. Generate server/.env (Prisma reads this automatically)
write(path.join(outputDir, 'server', '.env'),
  `DATABASE_URL="file:${dbDest.replace(/\\/g, '/')}"\n`);

// 4b. Push schema to database — runs after .env and template.sqlite are in place
console.log('\nPushing schema to database (npx prisma db push)...');
try {
  execSync('npx prisma db push', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
} catch (e) {
  console.warn('  ⚠ prisma db push failed — run manually: cd server && npx prisma db push');
}

// 4. Generate mcp_server_config.json (DB path for MCP server)
const mcpServerCfg = {
  mcp:      { name: `${manifest.deployment.name}-mcp`, version: '2.0.0', protocolVersion: '2025-06-18' },
  database: { path: path.relative(path.join(outputDir, 'server'), dbDest).replace(/\\/g, '/') },
  logging:  { level: 'info', file: './mcp_server.log' }
};
write(path.join(outputDir, 'server', 'mcp', 'mcp_server_config.json'), JSON.stringify(mcpServerCfg, null, 2));

// 5. Generate .mcp.json
copyTemplate('mcp.json', '.mcp.json', tokens);

// 6. Generate rss_config.json (merge base template + manifest feeds)
const baseRssCfgPath = path.join(TMPL, 'rss_config.json');
let rssCfg = JSON.parse(fs.readFileSync(baseRssCfgPath, 'utf8'));
const mc = manifest.rssConfig || {};
if (mc.additionalKeywords && mc.additionalKeywords.length) {
  rssCfg.keywords.global.push(...mc.additionalKeywords);
  rssCfg.keywords.global = [...new Set(rssCfg.keywords.global)];
}
if (mc.feeds && mc.feeds.length) {
  rssCfg.feeds.push(...mc.feeds);
}
write(path.join(outputDir, 'rss', 'rss-scorer-mcp', 'rss_config.json'), JSON.stringify(rssCfg, null, 2));

// 6b. Generate reddit_config.json (merge base template + manifest subreddits)
const baseRedditCfgPath = path.join(TMPL, 'reddit_config.json');
if (fs.existsSync(baseRedditCfgPath)) {
  let redditCfg = JSON.parse(fs.readFileSync(baseRedditCfgPath, 'utf8'));
  const rc = manifest.redditConfig || {};
  if (rc.additionalKeywords && rc.additionalKeywords.length) {
    redditCfg.globalKeywords.push(...rc.additionalKeywords);
    redditCfg.globalKeywords = [...new Set(redditCfg.globalKeywords)];
  }
  if (rc.subreddits && rc.subreddits.length) {
    redditCfg.subreddits.push(...rc.subreddits);
  }
  write(path.join(outputDir, 'reddit', 'reddit_config.json'), JSON.stringify(redditCfg, null, 2));
}

// 6c. Generate ig_config.json (merge base template + manifest igConfig)
const baseIgCfgPath = path.join(TMPL, 'ig_config.json');
if (fs.existsSync(baseIgCfgPath)) {
  let igCfg = JSON.parse(fs.readFileSync(baseIgCfgPath, 'utf8'));
  const ic = manifest.igConfig || {};
  if (ic.accounts && ic.accounts.length) {
    igCfg.accounts.push(...ic.accounts);
  }
  if (ic.hashtags && ic.hashtags.length) {
    igCfg.hashtags.push(...ic.hashtags);
  }
  write(path.join(outputDir, 'ig', 'ig_config.json'), JSON.stringify(igCfg, null, 2));
}

// 7. Copy + substitute skill templates
console.log('\nSkill playbooks:');
[
  ['skills/enrichment-agent.md',              'skills/enrichment-agent.md'],
  ['skills/evaluator.md',                     'skills/evaluator.md'],
  ['skills/relevance-judge.md',               'skills/relevance-judge.md'],
  ['skills/factlet-harvester.md',             'skills/factlet-harvester.md'],
  ['skills/fb-factlet-harvester/SKILL.md',    'skills/fb-factlet-harvester/SKILL.md'],
  ['skills/fb-factlet-harvester/fb_sources.md','skills/fb-factlet-harvester/fb_sources.md'],
  ['skills/reddit-factlet-harvester.md',      'skills/reddit-factlet-harvester.md'],
  ['skills/ig-factlet-harvester/SKILL.md',    'skills/ig-factlet-harvester/SKILL.md'],
  ['skills/ig-factlet-harvester/ig_sources.md','skills/ig-factlet-harvester/ig_sources.md'],
  ['skills/init-wizard.md',                   'skills/init-wizard.md'],
  ['skills/share-skill.md',                   'skills/share-skill.md'],
].forEach(([src, dst]) => copyTemplate(src, dst, tokens));

// 8. Copy + substitute doc stubs
console.log('\nDocs:');
[
  ['docs/CLAUDE.md',    'DOCS/CLAUDE.md'],
  ['docs/STATUS.md',    'DOCS/STATUS.md'],
  ['docs/VALUE_PROP.md','DOCS/VALUE_PROP.md'],
].forEach(([src, dst]) => copyTemplate(src, dst, tokens));

// 9. Create empty run log
write(path.join(outputDir, 'logs', 'ROUNDUP.md'),
  `# ${manifest.deployment.name} — Enrichment Run Log\n\nNo runs yet.\n`);

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------
console.log(`
${'='.repeat(65)}
SCAFFOLD COMPLETE — Manual steps to finish:
${'='.repeat(65)}

1. Server infrastructure was auto-installed:
     server/mcp/mcp_server.js  — copied from Pre-Crime
     server/package.json       — copied from Pre-Crime
     server/prisma/            — schema copied + prisma generate ran
     server/node_modules/      — npm install ran automatically
     server/.env               — DATABASE_URL written for Prisma
     server/mcp/mcp_server_config.json — DB path configured

   If npm install or prisma generate failed, run manually:
     cd "${path.join(outputDir,'server').replace(/\\/g,'/')}" && npm install && npx prisma generate

2. SET UP CONFIG via Claude (once server is running):
     Run Claude from ${outputDir}
     Call: update_config({ companyName, companyEmail, businessDescription })

3. FILL IN DOCS/VALUE_PROP.md
   A stub was generated. Add the full pitch: differentiators, case studies,
   use cases, competitive positioning, pricing, objection handling.
   This is what the Composer reads to write outreach. The better it is,
   the better the drafts.

4. REVIEW AND CUSTOMIZE each skill file in skills/:
   - enrichment-agent.md  : adjust discovery steps for your audience
   - evaluator.md         : tune the 5 pass/fail criteria for your buyer
   - relevance-judge.md   : add/remove relevant topics for your domain
   - factlet-harvester.md : adjust topic filter for RSS article evaluation
   - fb-factlet-harvester/fb_sources.md : add Facebook page URLs to monitor
   - reddit-factlet-harvester.md : review subreddit + keyword config

5. POPULATE rss/rss-scorer-mcp/rss_config.json
   Feeds were generated from the manifest. Add/remove/tune feed URLs
   and per-feed keywords for your audience.

5a. FACEBOOK HARVESTER (requires Claude-in-Chrome MCP):
    Add Facebook page/group URLs to: skills/fb-factlet-harvester/fb_sources.md
    Run skill: skills/fb-factlet-harvester/SKILL.md
    Requires the Claude-in-Chrome browser extension connected.

5b. REDDIT HARVESTER (ready to use, no setup needed):
    pip install requests  (usually already installed)
    No API keys required — uses Reddit's public JSON endpoints.
    Config: reddit/reddit_config.json (generated from manifest)
    Test: python tools/reddit_harvest.py -r news -k "test" -n 5

5c. INSTAGRAM HARVESTER (requires one pip install):
    pip install instaloader
    No API keys required — fetches public profiles and hashtags without login.
    Config: ig/ig_config.json (generated from manifest)
    Add accounts and hashtags to ig/ig_config.json and ig_sources.md.
    Test: python tools/ig_harvest.py --account instagram --limit 3
    Note: If Instagram throttles (RATE_LIMITED errors), reduce account/hashtag
    count or increase delays between runs. Do not attempt to log in.

6. LOAD YOUR CLIENT DATABASE
   Copy your pre-built SQLite into: ${dbDest}
   (The template.sqlite schema has been applied — just replace the file
   with one that has the same schema + your client rows.)
   OR insert clients directly into the empty DB.

7. LAUNCH
     cd "${outputDir}"
     claude
     > initialize this deployment

   The init wizard will confirm config, generate your Leedz session JWT,
   discover harvest sources, then launch harvesters automatically.

${'='.repeat(65)}
`);
