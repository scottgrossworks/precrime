// ============================================================================
// recycler.js -- startup/manual cleanup of stale runtime/exhaust data.
//
// Touches ONLY Task and Factlet rows. Never deletes Clients, Bookings, Sources,
// Sessions, or dossier text. pruneStaleFactlets is the single shared definition
// of "stale" used by startup, the planner cycle, and the recycler action.
// Requires only db/runtime/responses/factlets -- imported by same names.
// ============================================================================

const { prisma } = require('./db');
const { PRECRIME_CONFIG } = require('./runtime');
const { createSuccessResponse } = require('./responses');
const { getFactletStaleDays } = require('./factlets');

// Delete Factlets older than the stale window. PreCrime is about CURRENT demand:
// stale evidence is REMOVED, never re-animated. Shared by startup, the planner
// cycle, and the recycler action so all three agree on one definition of "stale".
// dryRun reports the count without deleting (used by the recycler action).
async function pruneStaleFactlets({ dryRun = false, staleDays } = {}) {
    const days = Number.isFinite(staleDays) ? staleDays : getFactletStaleDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const stale = await prisma.factlet.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true }
    });
    const ids = stale.map(f => f.id);
    if (!dryRun && ids.length > 0) {
        await prisma.factlet.deleteMany({ where: { id: { in: ids } } });
    }
    return { deleted: ids.length, ids, cutoffIso: cutoff.toISOString() };
}

async function pipelineRecycler(id, args) {
    const dryRun              = args.dryRun !== false;  // default true
    // Precedence: explicit args > precrime_config.json > hardcoded defaults.
    const _rec = (PRECRIME_CONFIG && PRECRIME_CONFIG.recycler) || {};
    const _cfgFactletStale  = Number.isFinite(_rec.factletStaleDays)    ? _rec.factletStaleDays    : 180;
    const _cfgTaskRetention = Number.isFinite(_rec.taskRetentionDays)   ? _rec.taskRetentionDays   : 30;
    const _cfgClaimTimeout  = Number.isFinite(_rec.claimTimeoutMinutes) ? _rec.claimTimeoutMinutes : 10;
    const factletStaleDays    = Number.isFinite(args.factletStaleDays)    ? args.factletStaleDays    : _cfgFactletStale;
    const taskRetentionDays   = Number.isFinite(args.taskRetentionDays)   ? args.taskRetentionDays   : _cfgTaskRetention;
    const claimTimeoutMinutes = Number.isFinite(args.claimTimeoutMinutes) ? args.claimTimeoutMinutes : _cfgClaimTimeout;

    const now            = new Date();
    const claimCutoff    = new Date(now.getTime() - claimTimeoutMinutes * 60 * 1000);
    const taskCutoff     = new Date(now.getTime() - taskRetentionDays   * 24 * 60 * 60 * 1000);
    const factletTaskCutoff = new Date(now.getTime() - Math.max(taskRetentionDays, factletStaleDays) * 24 * 60 * 60 * 1000);
    const factletCutoff  = new Date(now.getTime() - factletStaleDays    * 24 * 60 * 60 * 1000);
    const SAMPLE         = 10;
    const warnings       = [];

    // 1. Timed-out claimed Tasks -> ready
    const staleClaims = await prisma.task.findMany({
        where: { status: 'claimed', claimedAt: { lt: claimCutoff } },
        select: { id: true }
    });
    const staleClaimIds = staleClaims.map(t => t.id);
    if (!dryRun && staleClaimIds.length > 0) {
        await prisma.task.updateMany({
            where: { id: { in: staleClaimIds } },
            data:  { status: 'ready', claimedAt: null, claimedBy: null }
        });
    }

    // 2. Old finished Tasks -> delete. Use finishedAt when set, else updatedAt.
    // Never touch ready or claimed Tasks here. (Timed-out claimed were requeued above.)
    const finishedCandidates = await prisma.task.findMany({
        where: {
            status: { in: ['done', 'failed', 'cancelled'] },
            OR: [
                {
                    AND: [
                        { type: { not: 'APPLY_FACTLET' } },
                        {
                            OR: [
                                { finishedAt: { lt: taskCutoff } },
                                { AND: [{ finishedAt: null }, { updatedAt: { lt: taskCutoff } }] }
                            ]
                        }
                    ]
                },
                {
                    AND: [
                        { type: 'APPLY_FACTLET' },
                        {
                            OR: [
                                { finishedAt: { lt: factletTaskCutoff } },
                                { AND: [{ finishedAt: null }, { updatedAt: { lt: factletTaskCutoff } }] }
                            ]
                        }
                    ]
                }
            ]
        },
        select: { id: true }
    });
    const finishedIds = finishedCandidates.map(t => t.id);
    if (!dryRun && finishedIds.length > 0) {
        await prisma.task.deleteMany({ where: { id: { in: finishedIds } } });
    }

    // 3. Stale Factlets -> delete (via shared pruneStaleFactlets so startup,
    // planner, and this action agree on one definition). Dossier text is untouched.
    let staleFactletIds = [];
    try {
        const pruned = await pruneStaleFactlets({ dryRun, staleDays: factletStaleDays });
        staleFactletIds = pruned.ids;
    } catch (e) {
        warnings.push(`factlet delete failed: ${e.message}`);
    }

    return createSuccessResponse(id, JSON.stringify({
        dryRun,
        now: now.toISOString(),
        thresholds: { factletStaleDays, taskRetentionDays, applyFactletTaskRetentionDays: Math.max(taskRetentionDays, factletStaleDays), claimTimeoutMinutes },
        timedOutTasksRequeued: staleClaimIds.length,
        finishedTasksDeleted:  finishedIds.length,
        staleFactletsDeleted:  staleFactletIds.length,
        sample: {
            timedOutTaskIds:  staleClaimIds.slice(0, SAMPLE),
            finishedTaskIds:  finishedIds.slice(0, SAMPLE),
            staleFactletIds:  staleFactletIds.slice(0, SAMPLE)
        },
        warnings
    }, null, 2));
}

module.exports = { pruneStaleFactlets, pipelineRecycler };
