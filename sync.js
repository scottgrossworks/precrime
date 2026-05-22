#!/usr/bin/env node
/**
 * Pre-Crime — Skill Sync
 *
 * Pushes updated skill files from PRECRIME/templates into an existing deployment.
 * Does NOT touch the database, node_modules, configs, or directory structure.
 *
 * Usage:
 *   node sync.js --manifest manifests/manifest.photobooth.json
 *   node sync.js --manifest manifests/manifest.photobooth.json --target C:\path\to\precrime
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const args    = process.argv.slice(2);
const get     = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const manifestArg = get('--manifest');
if (!manifestArg) {
  console.error('Usage: node sync.js --manifest <manifest.json> [--target <dir>]');
  process.exit(1);
}

const manifestPath = path.resolve(manifestArg);
if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest  = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const targetArg = get('--target');
const targetDir = path.resolve(targetArg || manifest.deployment.rootDir);
const PRECRIME  = __dirname;
const TMPL      = path.join(PRECRIME, 'templates');

if (!fs.existsSync(targetDir)) {
  console.error(`Target deployment not found: ${targetDir}`);
  console.error('Run deploy.js first to create a new deployment.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`  ✓ ${path.relative(targetDir, filePath)}`);
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`  ✓ ${path.relative(targetDir, dst)}`);
}

function substitute(content, tokens) {
  let out = content;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.split(k).join(v);
  }
  return out;
}

function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
}

function copyTemplate(tmplRel, outRel, tokens) {
  const src = path.join(TMPL, tmplRel);
  if (!fs.existsSync(src)) { console.warn(`  ⚠ template missing: ${tmplRel}`); return; }
  write(path.join(targetDir, outRel), stripHtmlComments(substitute(fs.readFileSync(src, 'utf8'), tokens)));
}

// ---------------------------------------------------------------------------
// Build minimal token map (only what skills need)
// ---------------------------------------------------------------------------

const d  = manifest.deployment || {};
const bc = manifest.bookingConfig || {};

const tokens = {
  '{{DEPLOYMENT_NAME}}': d.name || 'Unnamed',
  '{{RUN_MODE}}':        bc.runMode || 'hybrid',
  '{{TODAY}}':           new Date().toISOString().split('T')[0],
};

// ---------------------------------------------------------------------------
// Sync skill files
// ---------------------------------------------------------------------------

console.log(`\nPre-Crime Skill Sync`);
console.log(`Manifest : ${manifestPath}`);
console.log(`Target   : ${targetDir}\n`);

console.log('Skills:');
[
  ['skills/enrichment-agent.md',                          'skills/enrichment-agent.md'],
  ['skills/relevance-judge.md',                           'skills/relevance-judge.md'],
  ['skills/rss-factlet-harvester/SKILL.md',               'skills/rss-factlet-harvester/SKILL.md'],
  ['skills/fb-factlet-harvester/SKILL.md',                'skills/fb-factlet-harvester/SKILL.md'],
  ['skills/reddit-factlet-harvester/SKILL.md',            'skills/reddit-factlet-harvester/SKILL.md'],
  ['skills/ig-factlet-harvester/SKILL.md',                'skills/ig-factlet-harvester/SKILL.md'],
  ['skills/x-factlet-harvester/SKILL.md',                 'skills/x-factlet-harvester/SKILL.md'],
  ['skills/client-seeder.md',                             'skills/client-seeder.md'],
  ['skills/share-skill.md',                               'skills/share-skill.md'],
  ['skills/source-discovery.md',                          'skills/source-discovery.md'],
  ['skills/init-wizard.md',                               'skills/init-wizard.md'],
].forEach(([src, dst]) => copyTemplate(src, dst, tokens));

// ---------------------------------------------------------------------------
// Sync Docker SOUL.md (baked into image at build time)
// ---------------------------------------------------------------------------

console.log('\nDocker:');
const soulSrc = path.join(PRECRIME, 'docker', 'SOUL.md');
const soulDst = path.join(PRECRIME, 'docker', 'SOUL.md'); // stays in PRECRIME — rebuilt into image
if (fs.existsSync(soulSrc)) {
  console.log(`  ✓ docker/SOUL.md (already in place — rebuild image to activate)`);
} else {
  console.warn('  ⚠ docker/SOUL.md not found');
}

// ---------------------------------------------------------------------------
// Sync tools/
// ---------------------------------------------------------------------------

console.log('\nTools:');
const toolsSrc = path.join(PRECRIME, 'tools');
if (fs.existsSync(toolsSrc)) {
  for (const f of fs.readdirSync(toolsSrc)) {
    copyFile(path.join(toolsSrc, f), path.join(targetDir, 'tools', f));
  }
} else {
  console.warn('  ⚠ PRECRIME/tools/ not found');
}

console.log(`
${'='.repeat(55)}
Sync complete — ${targetDir}
${'='.repeat(55)}

If docker/SOUL.md changed, rebuild the Hermes image:
  cd ${PRECRIME}
  docker build -t hermes-precrime .

If docker/CLAUDE.docker.md or docker/entrypoint.claude.sh changed, rebuild the Claude image:
  cd ${PRECRIME}
  docker build -f Dockerfile.claude -t claude-precrime .

To use the Claude alternative, copy templates/claude.bat to your deployment folder
and replace YOUR_ANTHROPIC_API_KEY_HERE with your actual key.
`);
