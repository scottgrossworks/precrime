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

const args      = process.argv.slice(2);
const get       = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const noInstall = args.includes('--no-install');

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

function stripHtmlComments(content) {
  // Remove deployer CUSTOMIZATION NOTES blocks — not needed at runtime, pure token waste
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
}

function copyTemplate(tmplRel, outRel, tokens) {
  const src = path.join(TMPL, tmplRel);
  if (!fs.existsSync(src)) { console.warn(`  ⚠ template missing: ${tmplRel}`); return; }
  write(path.join(outputDir, outRel), stripHtmlComments(substitute(fs.readFileSync(src, 'utf8'), tokens)));
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
    '{{RUN_MODE}}':               (m.bookingConfig && m.bookingConfig.runMode) || 'hybrid',
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
  path.join(outputDir, 'skills', 'reddit-factlet-harvester'),
  path.join(outputDir, 'skills', 'ig-factlet-harvester'),
  path.join(outputDir, 'skills', 'x-factlet-harvester'),
  path.join(outputDir, 'skills', 'source-discovery'),
  path.join(outputDir, 'tools'),
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

// 2a. Copy scoring_config.json — policy file loaded at MCP server startup.
// Tuning the booking/client scorer means editing this JSON, not the JS.
const scoringSrc = path.join(PRECRIME, 'server', 'mcp', 'scoring_config.json');
const scoringDst = path.join(outputDir, 'server', 'mcp', 'scoring_config.json');
if (fs.existsSync(scoringSrc)) {
  copyFile(scoringSrc, scoringDst);
} else {
  console.warn(`  ⚠ scoring_config.json missing: ${scoringSrc}`);
  console.warn('    The MCP server will fail fast on startup without it.');
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
if (!noInstall) {
  console.log('\nInstalling server dependencies (npm install)...');
  try {
    execSync('npm install', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
  } catch (e) {
    console.error('\nFATAL: npm install failed. Fix npm/Node and retry.');
    process.exit(1);
  }

  console.log('\nGenerating Prisma client (npx prisma generate)...');
  try {
    execSync('npx prisma generate', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
  } catch (e) {
    console.error('\nFATAL: prisma generate failed. Check schema.prisma and retry.');
    process.exit(1);
  }
} else {
  console.log('\n[--no-install] Skipping npm install + prisma generate (run setup.bat on target)');
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

if (!noInstall) {
  console.log('\nInstalling RSS scorer dependencies (npm install)...');
  try {
    execSync('npm install', { cwd: path.join(outputDir, 'rss', 'rss-scorer-mcp'), stdio: 'inherit' });
  } catch (e) {
    console.warn('  ⚠ RSS npm install failed — run manually: cd rss/rss-scorer-mcp && npm install');
  }
} else {
  console.log('[--no-install] Skipping RSS npm install');
}

// 2f. Copy tools/ — all files, dynamically (no manual update needed when new tools are added)
const toolsSrc = path.join(PRECRIME, 'tools');
if (fs.existsSync(toolsSrc)) {
  for (const toolFile of fs.readdirSync(toolsSrc)) {
    copyFile(path.join(toolsSrc, toolFile), path.join(outputDir, 'tools', toolFile));
  }
} else {
  console.warn('  ⚠ PRECRIME/tools/ directory missing');
}

// 3. Copy blank template DB — schema is already applied, no prisma db push needed at runtime
const dbFile = (manifest.deployment.dbFile || `data/${(manifest.deployment.name||'project').toLowerCase()}.sqlite`);
const dbDest = path.join(outputDir, dbFile);
mkdir(path.dirname(dbDest));
const blankDb = path.join(PRECRIME, 'data', 'blank.sqlite');
if (fs.existsSync(blankDb)) {
  fs.copyFileSync(blankDb, dbDest);
  console.log(`  ✓ ${dbFile} — blank DB with schema copied`);
} else {
  console.warn(`  ⚠ data/blank.sqlite not found — DB will need prisma db push at runtime`);
  console.log(`  ✓ data/ directory ready — ${dbFile} will need prisma db push`);
}

// 3. Build tokens
const tokens = buildTokens(manifest);

// 4a. Generate server/.env (Prisma reads this automatically)
// Use path relative to server/ so it works in both build context and deployed workspace
const dbRelToServer = path.relative(path.join(outputDir, 'server'), dbDest).replace(/\\/g, '/');
write(path.join(outputDir, 'server', '.env'),
  `DATABASE_URL="file:${dbRelToServer}"\n`);

// 4b. DB already shipped as blank.sqlite — no prisma db push needed
if (!noInstall) {

  // 4b-seed. Seed Config table from manifest.configSeed (optional — enables headless install)
  if (manifest.configSeed && Object.keys(manifest.configSeed).length) {
    // Strip doc keys (_*) and empty-string values so init-wizard still prompts for them
    const seedData = {};
    for (const [k, v] of Object.entries(manifest.configSeed)) {
      if (k.startsWith('_')) continue;
      if (v === '' || v === null || v === undefined) continue;
      seedData[k] = v;
    }

    if (!Object.keys(seedData).length) {
      console.log('\nconfigSeed present but no real values — skipping seed (init-wizard will prompt).');
    } else {
    console.log('\nSeeding Config table from manifest.configSeed...');

    // Auto-generate leedzSession JWT if leedzEmail given but session not
    if (seedData.leedzEmail && !seedData.leedzSession) {
      const crypto = require('crypto');
      const secret = '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c';
      const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const header  = b64url({ alg: 'HS256', typ: 'JWT' });
      const payload = b64url({
        email: seedData.leedzEmail,
        type: 'session',
        exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600
      });
      const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
      seedData.leedzSession = `${header}.${payload}.${sig}`;
      console.log('  ✓ Generated 1-year leedzSession JWT');
    }

    const seedScript = `
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const data = ${JSON.stringify(seedData)};
(async () => {
  try {
    const existing = await prisma.config.findFirst();
    if (existing) {
      await prisma.config.update({ where: { id: existing.id }, data });
    } else {
      await prisma.config.create({ data });
    }
    console.log('  ✓ Config row seeded');
  } catch (e) {
    console.error('  ✗ Config seed failed:', e.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
`;
    const seedPath = path.join(outputDir, 'server', '_seed_config.js');
    fs.writeFileSync(seedPath, seedScript);
    try {
      execSync('node _seed_config.js', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
    } catch (e) {
      console.warn('  ⚠ Config seed failed — Config table left empty, init-wizard will fill it');
    } finally {
      try { fs.unlinkSync(seedPath); } catch {}
    }
    }  // end if (seedData has real values)
  }

  // 4c. Prune devDependencies (removes prisma CLI + its engine binaries — not needed at runtime)
  console.log('\nPruning devDependencies (npm prune --production)...');
  try {
    execSync('npm prune --production', { cwd: path.join(outputDir, 'server'), stdio: 'inherit' });
  } catch (e) {
    console.warn('  ⚠ npm prune failed — zip will be larger than necessary');
  }
} else {
  console.log('[--no-install] Skipping prisma db push + npm prune + configSeed (run setup.bat on target)');
}

// 4. Generate mcp_server_config.json (logging + MCP metadata only — DB path is set via DATABASE_URL env var by precrime.bat)
const mcpServerCfg = {
  mcp:     { name: `${manifest.deployment.name}-mcp`, version: '2.0.0', protocolVersion: '2025-06-18' },
  logging: { level: 'info', file: './mcp_server.log' }
};
write(path.join(outputDir, 'server', 'mcp', 'mcp_server_config.json'), JSON.stringify(mcpServerCfg, null, 2));

// 5. Generate .mcp.json
copyTemplate('mcp.json', '.mcp.json', tokens);

// 6. Generate rss_config.json (merge base template + manifest keywords)
// NOTE: feeds are loaded by the RSS server from skills/rss-factlet-harvester/rss_sources.md,
// NOT from this JSON. Any `feeds` field here is ignored at runtime.
const baseRssCfgPath = path.join(TMPL, 'rss_config.json');
let rssCfg = JSON.parse(fs.readFileSync(baseRssCfgPath, 'utf8'));
const mc = manifest.rssConfig || {};
if (mc.additionalKeywords && mc.additionalKeywords.length) {
  rssCfg.keywords.global.push(...mc.additionalKeywords);
  rssCfg.keywords.global = [...new Set(rssCfg.keywords.global)];
}
if (mc.feeds && mc.feeds.length) {
  console.warn('  ⚠ manifest.rssConfig.feeds is ignored — edit skills/rss-factlet-harvester/rss_sources.md instead');
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
  ['skills/enrichment-agent-parallel.md',     'skills/enrichment-agent-parallel.md'],
  ['skills/evaluator.md',                     'skills/evaluator.md'],
  ['skills/relevance-judge.md',               'skills/relevance-judge.md'],
  ['skills/rss-factlet-harvester/SKILL.md',   'skills/rss-factlet-harvester/SKILL.md'],
  ['skills/rss-factlet-harvester/rss_sources.md', 'skills/rss-factlet-harvester/rss_sources.md'],
  ['skills/fb-factlet-harvester/SKILL.md',    'skills/fb-factlet-harvester/SKILL.md'],
  ['skills/fb-factlet-harvester/fb_sources.md','skills/fb-factlet-harvester/fb_sources.md'],
  ['skills/reddit-factlet-harvester/SKILL.md',      'skills/reddit-factlet-harvester/SKILL.md'],
  ['skills/reddit-factlet-harvester/reddit_sources.md','skills/reddit-factlet-harvester/reddit_sources.md'],
  ['skills/ig-factlet-harvester/SKILL.md',    'skills/ig-factlet-harvester/SKILL.md'],
  ['skills/ig-factlet-harvester/ig_sources.md','skills/ig-factlet-harvester/ig_sources.md'],
  ['skills/x-factlet-harvester/SKILL.md',    'skills/x-factlet-harvester/SKILL.md'],
  ['skills/x-factlet-harvester/x_sources.md','skills/x-factlet-harvester/x_sources.md'],
  ['skills/client-seeder.md',                 'skills/client-seeder.md'],
  ['skills/share-skill.md',                   'skills/share-skill.md'],
  ['skills/source-discovery.md',              'skills/source-discovery.md'],
  ['skills/source-discovery/discovered_directories.md', 'skills/source-discovery/discovered_directories.md'],
  ['skills/init-wizard.md',                   'skills/init-wizard.md'],
  ['skills/email-finder.md',                  'skills/email-finder.md'],
].forEach(([src, dst]) => copyTemplate(src, dst, tokens));

// 8. Copy + substitute doc stubs
console.log('\nDocs:');
[
  ['docs/CLAUDE.md',    'DOCS/CLAUDE.md'],
  ['docs/STATUS.md',    'DOCS/STATUS.md'],
  ['docs/VALUE_PROP.md','DOCS/VALUE_PROP.md'],
].forEach(([src, dst]) => copyTemplate(src, dst, tokens));

// 8b. Write CLAUDE.md to workspace root (Claude Code auto-loads from cwd)
copyTemplate('docs/CLAUDE.md', 'CLAUDE.md', tokens);

// 9. Create empty run log
write(path.join(outputDir, 'logs', 'ROUNDUP.md'),
  `# ${manifest.deployment.name} — Enrichment Run Log\n\nNo runs yet.\n`);

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------
console.log(`
${'='.repeat(65)}
DEPLOYMENT READY — ${outputDir}
${'='.repeat(65)}

Next steps:
  1. Fill in DOCS/VALUE_PROP.md (drives draft quality)
  2. Review and tune skill files in skills/
  3. Add RSS feeds: rss/rss-scorer-mcp/rss_config.json
  4. Add Facebook pages: skills/fb-factlet-harvester/fb_sources.md
  5. Add Reddit subreddits: skills/reddit-factlet-harvester/reddit_sources.md
  6. Add Instagram accounts/hashtags: ig/ig_config.json
  7. Add X/Twitter sources: skills/x-factlet-harvester/x_sources.md
  8. Unzip on target machine → cd precrime → precrime

${'='.repeat(65)}
`);
