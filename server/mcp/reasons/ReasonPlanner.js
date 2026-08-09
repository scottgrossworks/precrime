// ============================================================================
// ReasonPlanner.js -- Stage 1 of plan_tasks: MINE THE BOOK FIRST.
//
// Mine-first inversion (2026-08-08, per FOUNDATION): review existing clients
// for a reason to re-contact them BEFORE spending anything on outbound
// discovery. A human with a full client book works exactly this way -- resale
// first, marketing only when the book is dry.
//
// This stage:
//   1. asks ReasonGenerator for fresh recontact reasons (cooldown-gated),
//   2. creates one MINE_REASON task per live un-hunted reason Factlet
//      (a spawned goose curiosity worker: reason in, affected clients out --
//      queries the DB only, zero Tavily by construction: its recipe ships no
//      tavily extension at all),
//   3. while the mining lane is active, suppresses the OUTBOUND lanes
//      (scrape / discover / containers / last30) so discovery is the fallback,
//      not the default motion. DRILL_DOWN stays live -- closing a near-hot
//      lead outranks everything, mined or scraped.
//
// Lives outside mcp_server.js on purpose: planner stages are extracted into
// their own classes as they are touched (monolith LOC goes DOWN, not up).
// ============================================================================
'use strict';

const { maybeGenerateReasons, REASON_SOURCE_PREFIX } = require('./ReasonGenerator');

// DRILL_DOWN included since 2026-08-08 test run: the near-hot queue can be
// full of pre-mining container leftovers (cannabis-expo exhibitors at LACC),
// so "drills stay live during mining" in practice meant "keep working the
// trade-show backlog." Mining is STRICTLY first; drills resume the moment the
// mining lane drains -- a real hot lead waits minutes, not days.
const OUTBOUND_LANES = ['DRILL_DOWN', 'SCRAPE_SOURCE', 'DISCOVER_SOURCES', 'DRILL_CONTAINER', 'LAST_30_DAYS'];

// ctx: { prisma, suppressed, countReady, createBudget, createTask, staleCutoff, logInfo }
// All helpers are the planner's own closures -- budgets, session accounting,
// and focus gating apply to MINE_REASON exactly as to every other type.
async function planMineReasons(ctx) {
    const { prisma, suppressed, countReady, createBudget, createTask, staleCutoff, logInfo } = ctx;

    await maybeGenerateReasons(staleCutoff, logInfo);

    let planned = 0;
    const open = await countReady('MINE_REASON');
    if ((await createBudget('MINE_REASON')).eff > 0) {
        const liveReasons = await prisma.factlet.findMany({
            where: { source: { startsWith: REASON_SOURCE_PREFIX }, createdAt: { gte: staleCutoff } },
            orderBy: { createdAt: 'desc' },
            select: { id: true }
        });
        // One SUCCESSFUL hunt per reason: an open or done MINE_REASON task means
        // it was (or is being) worked. A FAILED hunt (orphaned worker) retries --
        // 2026-08-09: the old any-task-ever rule let two orphans permanently burn
        // their reasons, so the evening session had nothing to mine. Two failures
        // and the reason is abandoned (no infinite retry loop).
        const taskRows = await prisma.task.findMany({
            where: { type: 'MINE_REASON', targetType: 'Factlet' },
            select: { targetId: true, status: true }
        });
        const hunted = new Set();
        const failCount = new Map();
        for (const t of taskRows) {
            if (!t.targetId) continue;
            if (['ready', 'claimed', 'done'].includes(t.status)) hunted.add(t.targetId);
            else {
                const n = (failCount.get(t.targetId) || 0) + 1;
                failCount.set(t.targetId, n);
                if (n >= 2) hunted.add(t.targetId);
            }
        }
        for (const f of liveReasons) {
            if (hunted.has(f.id)) continue;
            if ((await createBudget('MINE_REASON')).eff <= 0) break;
            const row = await createTask('MINE_REASON', { targetType: 'Factlet', targetId: f.id, input: {} });
            if (row) planned++;
        }
    }

    if (planned > 0 || open > 0) {
        for (const t of OUTBOUND_LANES) suppressed.add(t);
        const working = planned + open;
        logInfo(`CLIENT MINING: ${working} worker(s) ${planned ? `queued (${planned} new)` : 'still running'} to search your existing client base for re-contact matches. Drills, web scraping, and discovery are ALL PAUSED until mining finishes -- your own clients get worked first, at zero search-credit cost.`);
    }
    return { planned, open };
}

module.exports = { planMineReasons };
