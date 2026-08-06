// db.js -- PRECRIME's DB entry point: thin composition over the SHARED core.
//
// Since the SCHEMA unification (2026-07-20, see C:\Users\Scott\Desktop\WKG\SCHEMA\PLAN.md):
//   - The PrismaClient singleton + generic CRUD live in the shared `leedz-db`
//     package (C:\Users\Scott\Desktop\WKG\SCHEMA\leedz-db), generated from the
//     canonical schema at C:\Users\Scott\Desktop\WKG\SCHEMA\schema.prisma.
//   - This file keeps PRECRIME POLICY only: the worker-skill map, in-process
//     type list, channel overrides, and the drills-first dispatch ordering.
//   - Exports are unchanged -- every other PRECRIME module still does
//     `require('./db')` and gets the same names with the same signatures.
//
// mcp_server.js sets DATABASE_URL before requiring this module, so the shared
// core picks up the correct resolved DB path at first use. LEEDZ_DB_PATH env
// var can override the shared-module location (deployment escape hatch).

const path = require('path');
const LEEDZ_DB_HOME = process.env.LEEDZ_DB_PATH
    || 'C:/Users/Scott/Desktop/WKG/SCHEMA/leedz-db';

const core = require(LEEDZ_DB_HOME);
const coreTasks = require(path.join(LEEDZ_DB_HOME, 'tasks'));

// One shared PrismaClient for the whole process (created on first access,
// after mcp_server.js has resolved DATABASE_URL). connect() also applies the
// WAL + busy_timeout pragmas -- REQUIRED because the INVOICER local server may
// have the same DB file open concurrently. Fire-and-forget: Prisma queues
// queries issued before the connection completes.
const prisma = core.prisma;
core.connect().catch(e => console.error('[db] connect/WAL init failed:', e.message));

// Worker capability now lives in ONE place: workerManifest.js (2026-08-06).
// WORKER_SKILL_MAP (spawnable types only -- skill:null entries are in-process)
// and CHANNEL_SKILL_OVERRIDES are DERIVED views over it; edit the manifest,
// never these.
const { WORKER_MANIFEST } = require('./workerManifest');
const WORKER_SKILL_MAP = Object.fromEntries(
    Object.entries(WORKER_MANIFEST).filter(([, m]) => m.skill).map(([t, m]) => [t, m.skill]));

const WORKER_TYPES = Object.keys(WORKER_SKILL_MAP);

// Browser-gated channels resolve to their own harvester skill instead of url-loop:
// fb/ig cannot render via Tavily in ANY mode -- they need the user's logged-in Chrome,
// driven through the mcp-chrome bridge (127.0.0.1:12306). The planner only emits fb/ig
// SCRAPE_SOURCE tasks when precrime_config.json chromeScrape=true, and the conductor
// (a) adds the browser extension set to these workers' recipes and (b) serializes
// them -- the bridge accepts ONE client at a time.
const CHANNEL_SKILL_OVERRIDES = WORKER_MANIFEST.SCRAPE_SOURCE.browser.skills;

// SCRAPE_SOURCE task input carries { url, channel }; DRILL_DOWN Signal tasks
// (demand-signal bird-dog, 2026-07-20) carry { url, note, channel }. Other types
// have no channel.
function taskChannel(row) {
    if (!row || row.input == null) return null;
    if (row.type !== 'SCRAPE_SOURCE' && row.type !== 'DRILL_DOWN') return null;
    try {
        const inp = typeof row.input === 'string' ? JSON.parse(row.input) : row.input;
        return (inp && inp.channel) || null;
    } catch (_) { return null; }
}

// Task types the conductor executes IN-PROCESS (via the runInProcess hook) rather
// than by spawning a worker. JUDGE_AFFECTED promotes bookings to hot (the
// hot-leedz maker); SHOW_HOT_LEEDZ marks hot leedz ready to present. Both gate
// the planner when left pending, so the conductor must drain them. SHARE_BOOKING
// is intentionally EXCLUDED — it posts to the external Leedz marketplace and must
// stay an explicit, user-driven action, never auto-run by the conductor.
// BOUNCE_SWEEP polls Gmail for hard-bounce notices and dead-flags the undeliverable
// clients (procedural, zero-model, like LAST_30_DAYS). Runs in-process; the conductor
// treats it as a background job (network I/O) so it never blocks worker dispatch.
// APPLY_FACTLET (2026-07-19): one bounded LLM call per factlet applied to a batch
// of clients (workers/ApplyFactletWorker.js); background so it never blocks dispatch.
const IN_PROCESS_TYPES = ['JUDGE_AFFECTED', 'SHOW_HOT_LEEDZ', 'LAST_30_DAYS', 'BOUNCE_SWEEP', 'APPLY_FACTLET'];

// Poll for ready Tasks that have a worker skill. Returns rows with an extra
// `skillFile` field + a human `label`. VERTICAL-FIRST (2026-07-20): ready
// DRILL_DOWN tasks are fetched FIRST (oldest first), then everything else fills
// the remainder oldest-first — a queued drill (near-hot booking or demand
// Signal) always jumps every queued scrape/enrich, matching the planner's
// drill-focus. Bird-dogging a hot leed outranks growing the tree.
async function conductorGetReadyTasks(limit) {
    const cap = limit || 10;
    const drills = await coreTasks.getReadyTasksByTypes(['DRILL_DOWN'], cap);
    const rest = cap - drills.length;
    const others = rest > 0
        ? await coreTasks.getReadyTasksByTypes(WORKER_TYPES.filter(t => t !== 'DRILL_DOWN'), rest)
        : [];
    const rows = [...drills, ...others];
    await coreTasks.attachTaskLabels(rows);
    return rows.map(r => {
        const ch = taskChannel(r);
        return {
            ...r,
            // fb/ig SCRAPE_SOURCE swaps in the harvester skill; a DRILL_DOWN Signal
            // keeps drill-down.md (it drills through the pipeline `browse` action).
            skillFile: (r.type === 'SCRAPE_SOURCE' && ch && CHANNEL_SKILL_OVERRIDES[ch])
                || WORKER_SKILL_MAP[r.type],
            // Set for any fb/ig-channel task: the conductor uses it to gate on
            // chromeScrape and serialize bridge users to one worker at a time.
            browserChannel: (ch && CHANNEL_SKILL_OVERRIDES[ch]) ? ch : null
        };
    });
}

// Poll for ready in-process Tasks (JUDGE_AFFECTED, SHOW_HOT_LEEDZ). Oldest first.
// Labels attached (2026-08-05): APPLY_FACTLET rides this path, and without labels
// its log lines printed raw id tails ('factlet "ou71di"') instead of the factlet gist.
async function conductorGetReadyInProcessTasks(limit) {
    const rows = await coreTasks.getReadyTasksByTypes(IN_PROCESS_TYPES, limit);
    await coreTasks.attachTaskLabels(rows);
    return rows;
}

module.exports = {
    prisma,
    core,               // the shared leedz-db module (generic CRUD, connect, stats)
    WORKER_SKILL_MAP,
    CHANNEL_SKILL_OVERRIDES,
    IN_PROCESS_TYPES,
    createTaskRow:                  coreTasks.createTaskRow,
    conductorGetReadyTasks,
    conductorGetReadyInProcessTasks,
    conductorClaimTask:             coreTasks.claimTask,
    conductorFailTask:              coreTasks.failTask,
    conductorFailIfClaimed:         coreTasks.failIfClaimed
};
