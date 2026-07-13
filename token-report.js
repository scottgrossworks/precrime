// token-report.js -- per-worker-type token + COST attribution, read from goose's own
// session store (%APPDATA%\Block\goose\data\sessions\sessions.db). Each spawned worker is
// its own `goose run` = its own session row carrying accumulated_input/output/total_tokens
// and accumulated_cost (real $). We group those by task TYPE -- which OpenRouter cannot do
// (it sees one API key, blind to type). Run from the deployment root, ANY shell:
//     node token-report.js                 (all sessions since midnight today)
//     node token-report.js --since "2026-07-09 19:30"   (one run window)
//     node token-report.js --all            (every session ever, this deployment)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEPLOY_ROOT = __dirname;
const DB = path.join(process.env.APPDATA || '', 'Block', 'goose', 'data', 'sessions', 'sessions.db');

if (!fs.existsSync(DB)) {
    console.log(`goose session DB not found at ${DB} -- is goose installed for this user?`);
    process.exit(0);
}

// --since window (default: midnight local today). --all disables the window.
const args = process.argv.slice(2);
let since = new Date(); since.setHours(0, 0, 0, 0);
const sinceArg = args[args.indexOf('--since') + 1];
if (args.includes('--since') && sinceArg) since = new Date(sinceArg.replace(' ', 'T'));
const allTime = args.includes('--all');
const sinceStr = since.toISOString().slice(0, 19).replace('T', ' ');

// Task types (from db.js WORKER_SKILL_MAP + IN_PROCESS_TYPES). Normalized substring match
// against goose's session name recovers the type even from its auto-generated name
// ("APPLY_FACTLET worker instructions", "Drill Down Worker" -> DRILL_DOWN). An explicit
// --name precrime-<TYPE>-<id> (if the conductor sets one) is matched first, deterministically.
const TYPES = ['APPLY_FACTLET', 'ENRICH_CLIENT', 'SCRAPE_SOURCE', 'FIND_CLIENT_SOURCES',
    'DISCOVER_SOURCES', 'DRILL_CONTAINER', 'DRILL_DOWN', 'LAST_30_DAYS', 'DRAFT_OUTREACH',
    'JUDGE_AFFECTED', 'SHOW_HOT_LEEDZ', 'SHARE_BOOKING'];
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function typeOf(name) {
    const m = String(name || '').match(/^precrime-([A-Z0-9_]+)-/i);
    if (m) return m[1].toUpperCase();
    const n = norm(name);
    for (const t of TYPES) if (n.includes(norm(t))) return t;   // DRILL_CONTAINER before DRILL_DOWN
    // goose auto-names reorder words ("Client enrichment worker" != "enrich client"), which the
    // substring match above misses; map the common legacy forms so pre-naming sessions still
    // attribute. New sessions carry precrime-<TYPE>- and never reach this fallback.
    if (/client\s*enrich/i.test(name)) return 'ENRICH_CLIENT';
    if (/client\s*source|source\s*find/i.test(name)) return 'FIND_CLIENT_SOURCES';
    if (/outreach|draft/i.test(name)) return 'DRAFT_OUTREACH';
    return 'ORCHESTRATOR/other';
}

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(
    `SELECT name, working_dir, accumulated_input_tokens ai, accumulated_output_tokens ao,
            accumulated_total_tokens at, accumulated_cost ac, created_at
     FROM sessions WHERE working_dir = ?` + (allTime ? '' : ' AND created_at >= ?') +
    ` ORDER BY created_at ASC`
).all(...(allTime ? [DEPLOY_ROOT] : [DEPLOY_ROOT, sinceStr]));

const g = {};
let gIn = 0, gOut = 0, gTot = 0, gCost = 0, idle = 0;
for (const r of rows) {
    const t = typeOf(r.name);
    const b = (g[t] ||= { sessions: 0, idle: 0, input: 0, output: 0, total: 0, cost: 0 });
    b.sessions++;
    if (r.at == null) { b.idle++; idle++; }        // session created but no LLM turn (spawn overhead / orphan)
    b.input += r.ai || 0; b.output += r.ao || 0; b.total += r.at || 0; b.cost += r.ac || 0;
    gIn += r.ai || 0; gOut += r.ao || 0; gTot += r.at || 0; gCost += r.ac || 0;
}

const table = {};
for (const [t, b] of Object.entries(g)) table[t] = {
    sessions: b.sessions, idle: b.idle, input: b.input, output: b.output,
    total: b.total, cost: '$' + b.cost.toFixed(5)
};
console.log(allTime ? 'window: ALL sessions (this deployment)' : `window: since ${sinceStr}`);
console.table(table);
console.log(`TOTAL: ${rows.length} sessions (${idle} idle/no-LLM) | in ${gIn} | out ${gOut} | total ${gTot} tokens | cost $${gCost.toFixed(5)}`);
