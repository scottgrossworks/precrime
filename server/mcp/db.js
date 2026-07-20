// db.js -- Prisma singleton + conductor task helpers
//
// mcp_server.js sets DATABASE_URL before requiring this module, so
// new PrismaClient() here picks up the correct resolved DB path.
// This is the only file that instantiates PrismaClient.
// Both mcp_server.js and conductor.js import from here; they share one instance.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Task types the conductor can spawn a worker process for.
// JUDGE_AFFECTED, SHOW_HOT_LEEDZ, SHARE_BOOKING are handled in-process by
// the MCP server pipeline actions -- no external worker skill exists for them.
const WORKER_SKILL_MAP = {
    // APPLY_FACTLET moved to IN_PROCESS_TYPES (2026-07-19): one direct LLM call
    // applies a factlet to a BATCH of clients (workers/ApplyFactletWorker.js) --
    // no goose spawn per (factlet, client) pair, no ORPHAN failure mode.
    ENRICH_CLIENT:       'enrichment-agent.md',
    SCRAPE_SOURCE:       'url-loop.md',
    FIND_CLIENT_SOURCES: 'find-client-sources.md',
    DISCOVER_SOURCES:    'discover-sources.md',
    DRILL_DOWN:          'drill-down.md',
    DRILL_CONTAINER:     'drill-container.md',   // any multi-vendor event: organizer + expand fitting vendors + marketplace prep
    DRAFT_OUTREACH:      'outreach-drafter.md'
    // LAST_30_DAYS moved to IN_PROCESS_TYPES: it now runs as a procedural (zero-model)
    // in-process worker (server/mcp/workers/Last30DaysWorker.js), not a spawned goose skill.
};

const WORKER_TYPES = Object.keys(WORKER_SKILL_MAP);

// Browser-gated channels resolve to their own harvester skill instead of url-loop:
// fb/ig cannot render via Tavily in ANY mode -- they need the user's logged-in Chrome,
// driven through the mcp-chrome bridge (127.0.0.1:12306). The planner only emits fb/ig
// SCRAPE_SOURCE tasks when precrime_config.json chromeScrape=true, and the conductor
// (a) adds the `chrome` extension to these workers' recipes and (b) serializes them --
// the bridge accepts ONE client at a time.
const CHANNEL_SKILL_OVERRIDES = {
    fb: 'fb-factlet-harvester/SKILL.md',
    ig: 'ig-factlet-harvester/SKILL.md'
};

// SCRAPE_SOURCE task input carries { url, channel }; other types have no channel.
function taskChannel(row) {
    if (!row || row.type !== 'SCRAPE_SOURCE' || row.input == null) return null;
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

// Attach a HUMAN label to each task row: the client's company/name/email, or the
// booking's "title — company". Conductor log lines print this instead of opaque
// record ids ("client xz58qd" told a human nothing; "client Ape Fitness" does).
// Two batched selects per poll — negligible against the worker spawn they precede.
async function attachTaskLabels(rows) {
    const cIds = [...new Set(rows.filter(r => r.targetType === 'Client' && r.targetId).map(r => r.targetId))];
    const bIds = [...new Set(rows.filter(r => r.targetType === 'Booking' && r.targetId).map(r => r.targetId))];
    const [cs, bs] = await Promise.all([
        cIds.length ? prisma.client.findMany({ where: { id: { in: cIds } }, select: { id: true, name: true, company: true, email: true } }) : [],
        bIds.length ? prisma.booking.findMany({ where: { id: { in: bIds } }, select: { id: true, title: true, client: { select: { company: true, name: true } } } }) : []
    ]);
    const cm = new Map(cs.map(c => [c.id, c.company || c.name || c.email || c.id.slice(-6)]));
    const bm = new Map(bs.map(b => {
        const org = b.client && (b.client.company || b.client.name);
        return [b.id, `${b.title || '(untitled)'}${org ? ' — ' + org : ''}`];
    }));
    for (const r of rows) {
        if (r.targetType === 'Client') r.label = cm.get(r.targetId);
        else if (r.targetType === 'Booking') r.label = bm.get(r.targetId);
    }
    return rows;
}

// Poll for ready Tasks that have a worker skill. Returns rows with an extra
// `skillFile` field + a human `label`. Ordered by createdAt ASC (oldest first).
async function conductorGetReadyTasks(limit) {
    const rows = await prisma.task.findMany({
        where:   { status: 'ready', type: { in: WORKER_TYPES } },
        orderBy: { createdAt: 'asc' },
        take:    limit || 10
    });
    await attachTaskLabels(rows);
    return rows.map(r => {
        const ch = taskChannel(r);
        return {
            ...r,
            skillFile: (ch && CHANNEL_SKILL_OVERRIDES[ch]) || WORKER_SKILL_MAP[r.type],
            // Set only for channels that need the single-client chrome bridge; the
            // conductor uses it to gate on chromeScrape and serialize to one worker.
            browserChannel: (ch && CHANNEL_SKILL_OVERRIDES[ch]) ? ch : null
        };
    });
}

// Poll for ready in-process Tasks (JUDGE_AFFECTED, SHOW_HOT_LEEDZ). Oldest first.
async function conductorGetReadyInProcessTasks(limit) {
    return prisma.task.findMany({
        where:   { status: 'ready', type: { in: IN_PROCESS_TYPES } },
        orderBy: { createdAt: 'asc' },
        take:    limit || 10
    });
}

// Atomic compare-and-swap claim. Returns true if this caller won the race.
async function conductorClaimTask(taskId, workerId) {
    try {
        const result = await prisma.task.updateMany({
            where: { id: taskId, status: 'ready' },
            data:  { status: 'claimed', claimedAt: new Date(), claimedBy: workerId }
        });
        return result.count > 0;
    } catch (_) {
        return false;
    }
}

// Mark a task failed. Used when a worker exits non-zero or is killed for being hung.
async function conductorFailTask(taskId, reason) {
    try {
        await prisma.task.updateMany({
            where: { id: taskId },
            data:  { status: 'failed', error: String(reason), finishedAt: new Date() }
        });
    } catch (_) {}
}

// Finalize a task ONLY if it is still 'claimed' -- i.e. the worker process exited but
// never called complete_task, leaving the task orphaned. The where-clause guards status,
// so a task the worker DID complete (now 'done'/'failed') is left untouched. Returns true
// if it actually finalized a stuck task. This stops workers that exit-without-completing
// from parking a task in 'claimed' until the 10-min stale-reclaim sweep -- the zombie loop.
async function conductorFailIfClaimed(taskId, reason) {
    try {
        const r = await prisma.task.updateMany({
            where: { id: taskId, status: 'claimed' },
            data:  { status: 'failed', error: String(reason), finishedAt: new Date() }
        });
        return r.count > 0;
    } catch (_) { return false; }
}

// Raw Task-row insert -- the persistence PRIMITIVE, callable from any module (the planner's
// createTask wrapper, procedural workers). Stateless: no budget gate, no session accounting
// (the planner's createTask owns those). `fields`: { sessionId?, targetType?, targetId?, input? };
// `input` is JSON-stringified when it is an object. Returns the created row.
async function createTaskRow(type, fields) {
    const f = fields || {};
    return prisma.task.create({
        data: {
            type,
            status:     'ready',
            sessionId:  f.sessionId || null,
            targetType: f.targetType || 'none',
            targetId:   f.targetId   || null,
            input:      f.input != null
                ? (typeof f.input === 'string' ? f.input : JSON.stringify(f.input))
                : null
        }
    });
}

module.exports = {
    prisma,
    WORKER_SKILL_MAP,
    CHANNEL_SKILL_OVERRIDES,
    IN_PROCESS_TYPES,
    createTaskRow,
    conductorGetReadyTasks,
    conductorGetReadyInProcessTasks,
    conductorClaimTask,
    conductorFailTask,
    conductorFailIfClaimed
};
