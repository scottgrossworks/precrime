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
    APPLY_FACTLET:       'apply-factlet.md',
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

// Task types the conductor executes IN-PROCESS (via the runInProcess hook) rather
// than by spawning a worker. JUDGE_AFFECTED promotes bookings to hot (the
// hot-leedz maker); SHOW_HOT_LEEDZ marks hot leedz ready to present. Both gate
// the planner when left pending, so the conductor must drain them. SHARE_BOOKING
// is intentionally EXCLUDED — it posts to the external Leedz marketplace and must
// stay an explicit, user-driven action, never auto-run by the conductor.
const IN_PROCESS_TYPES = ['JUDGE_AFFECTED', 'SHOW_HOT_LEEDZ', 'LAST_30_DAYS'];

// Poll for ready Tasks that have a worker skill. Returns rows with an extra
// `skillFile` field. Ordered by createdAt ASC (oldest first).
async function conductorGetReadyTasks(limit) {
    const rows = await prisma.task.findMany({
        where:   { status: 'ready', type: { in: WORKER_TYPES } },
        orderBy: { createdAt: 'asc' },
        take:    limit || 10
    });
    return rows.map(r => ({ ...r, skillFile: WORKER_SKILL_MAP[r.type] }));
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
    IN_PROCESS_TYPES,
    createTaskRow,
    conductorGetReadyTasks,
    conductorGetReadyInProcessTasks,
    conductorClaimTask,
    conductorFailTask,
    conductorFailIfClaimed
};
