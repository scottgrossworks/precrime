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

// RE-HUNT CADENCE (2026-08-10). A hunt harvests at most 8 clients (skills/
// mine-reason.md Step 3) out of a ~2,900-client book, and the worker drops
// anyone already contacted -- so ONE hunt can never exhaust a reason. The old
// rule ("any done task => hunted FOREVER") therefore did two bad things at once:
// it left most of every reason's yield unharvested, and after ~19 hunts it
// emptied the mining lane permanently. An empty lane means this planner stops
// suppressing OUTBOUND_LANES, so stranger-scraping silently became the default
// motion -- observed live 2026-08-10 (0 un-hunted reasons, 0 MINE_REASON, five
// vendor-directory scrapes instead).
//
// A hunted reason now goes to the BACK OF THE QUEUE: eligible again once its
// last hunt is REHUNT_HOURS old, and reasons are worked LEAST-RECENTLY-HUNTED
// first, so the queue rotates by itself with no new bookkeeping (the newest
// MINE_REASON Task's createdAt IS the last-hunt clock -- same no-counter-files
// rule as ReasonGenerator's cooldown).
//
// THIS CONSTANT IS THE MINE-vs-DISCOVER RATIO DIAL, and the only knob for it:
//   shorter -> lane refills sooner -> outbound lanes stay suppressed -> more
//              own-book work, less stranger discovery
//   longer  -> lane drains between passes -> discovery gets more airtime
// Hunts are DB-only (the mine-reason recipe ships no web tools at all), so the
// cost of a shorter cadence is LLM tokens, never search credits.
const REHUNT_HOURS = 24;

// ctx: { prisma, suppressed, countReady, createBudget, createTask, staleCutoff, logInfo }
// All helpers are the planner's own closures -- budgets, session accounting,
// and focus gating apply to MINE_REASON exactly as to every other type.
async function planMineReasons(ctx) {
    const { prisma, suppressed, countReady, createBudget, createTask, staleCutoff, logInfo } = ctx;

    await maybeGenerateReasons(staleCutoff, logInfo);

    let planned = 0;
    let rehunts = 0;      // of `planned`: reasons coming back around, not first-time
    let queueDepth = 0;   // reasons due this pass (planned + still waiting on budget)
    const open = await countReady('MINE_REASON');
    if ((await createBudget('MINE_REASON')).eff > 0) {
        const liveReasons = await prisma.factlet.findMany({
            where: { source: { startsWith: REASON_SOURCE_PREFIX }, createdAt: { gte: staleCutoff } },
            orderBy: { createdAt: 'desc' },
            select: { id: true }
        });
        // Queue state per reason. BLOCKED = has a hunt in flight right now, or was
        // abandoned after two failures (orphaned workers must not retry forever --
        // 2026-08-09 rule, unchanged). Everything else is queued by last-hunt time.
        const taskRows = await prisma.task.findMany({
            where: { type: 'MINE_REASON', targetType: 'Factlet' },
            select: { targetId: true, status: true, createdAt: true }
        });
        const blocked  = new Set();   // in flight, or abandoned after 2 failures
        const lastHunt = new Map();   // factletId -> newest completed hunt (ms since epoch)
        const failCount = new Map();
        for (const t of taskRows) {
            if (!t.targetId) continue;
            if (t.status === 'ready' || t.status === 'claimed') { blocked.add(t.targetId); continue; }
            if (t.status === 'done') {
                const ts = new Date(t.createdAt).getTime();
                lastHunt.set(t.targetId, Math.max(lastHunt.get(t.targetId) || 0, ts));
                continue;
            }
            const n = (failCount.get(t.targetId) || 0) + 1;
            failCount.set(t.targetId, n);
            if (n >= 2) blocked.add(t.targetId);
        }
        // Due = never hunted (lastHunt 0), or last hunt older than the cadence.
        // Sorted least-recently-hunted first, so never-hunted reasons lead and the
        // rest rotate in age order -- the "back of the queue" behaviour, for free.
        const rehuntBefore = Date.now() - REHUNT_HOURS * 3600000;
        const due = liveReasons
            .filter(f => !blocked.has(f.id) && (lastHunt.get(f.id) || 0) <= rehuntBefore)
            .sort((a, b) => (lastHunt.get(a.id) || 0) - (lastHunt.get(b.id) || 0));
        for (const f of due) {
            if ((await createBudget('MINE_REASON')).eff <= 0) break;
            const row = await createTask('MINE_REASON', { targetType: 'Factlet', targetId: f.id, input: {} });
            if (row) { planned++; if (lastHunt.has(f.id)) rehunts++; }
        }
        queueDepth = due.length;
    }

    if (planned > 0 || open > 0) {
        for (const t of OUTBOUND_LANES) suppressed.add(t);
        const working = planned + open;
        // Say WHERE the work came from (fresh reason vs one rotating back around)
        // and how deep the queue still is -- otherwise "3 workers queued" gives no
        // way to tell a healthy rotating lane from one about to run dry again.
        const mix = planned
            ? ` (${planned} new: ${planned - rehunts} never-hunted, ${rehunts} re-hunt after ${REHUNT_HOURS}h; ${Math.max(0, queueDepth - planned)} more reason(s) waiting their turn)`
            : '';
        logInfo(`CLIENT MINING: ${working} worker(s) ${planned ? 'queued' : 'still running'}${mix} to search your existing client base for re-contact matches. Drills, web scraping, and discovery are ALL PAUSED until mining finishes -- your own clients get worked first, at zero search-credit cost.`);
    }
    return { planned, open };
}

module.exports = { planMineReasons };
