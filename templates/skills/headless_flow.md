---
name: headless-flow
description: Planner-driven headless orchestrator. Calls plan_tasks(mode:"headless"), drains the resulting Task queue via claim_task / dispatch-by-type / complete_task, replans, exits when the queue is exhausted. No global LLM workflow.
triggers:
  - run headless
  - headless mode
  - autonomous run
---

# Headless Flow

Headless orchestrator. Pure Planner/Task dispatch. No global LLM workflow. No per-step narrative. No ad-hoc recursion.

The user is not at the keyboard. There are no approval gates and no menus. Every "what should I do next" decision belongs to the server-side Planner. This skill only:

1. Asks the Planner to populate the Task queue.
2. Pops one Task at a time, dispatches it by `type` to the matching worker / server action, completes it.
3. Replans when claim returns `NO_TASK`.
4. Exits when a fresh replan creates zero new Tasks AND every claim returns `NO_TASK`.

Do NOT read `DOCS/VALUE_PROP.md` and improvise. Do NOT loop over harvesters, sources, clients, or bookings yourself. Do NOT call `pipeline.rescore`. Do NOT call `pipeline.next_source` / `pipeline.mark_source` directly -- only the worker skills touch those, and only when they own an active SCRAPE_SOURCE claim. Do NOT call `leedz__createLeed`. Do NOT compose drafts.

The legacy multi-step recursive flow is preserved at `__PROJECT_ROOT__/skills/headless_flow.legacy.md` for reference only.

---

## Step 1 -- Plan

```
precrime__pipeline({ action: "plan_tasks", mode: "headless" })
```

Headless mode queues hot `SHARE_BOOKING` Tasks first (existing unshared `leed_ready` Bookings), then workflow Tasks: `DISCOVER_SOURCES`, `SCRAPE_SOURCE`, `APPLY_FACTLET`, `ENRICH_CLIENT`, `JUDGE_AFFECTED`. Per-type limits come from `precrime_config.json` (`tasks.limits`). The server, not this skill, decides them.

Append the returned `counts` block to `logs/ROUNDUP.md`. Hold `lastCounts = response.counts`. Initialize a per-run tally `runTotals = { SHARE_BOOKING:0, SCRAPE_SOURCE:0, ENRICH_CLIENT:0, APPLY_FACTLET:0, JUDGE_AFFECTED:0, DISCOVER_SOURCES:0, failed:0 }` and `replans = 1`.

---

## Step 2 -- Drain

Drain until claim returns `NO_TASK`. Strict caps prevent runaway:

- **Per Task wall time:** 5 minutes. If a Task takes longer, complete it with `status:"failed"` and continue.
- **Per drain pass:** 50 Tasks. On cap, jump to Step 3 to record progress, then come back to Step 2.

### 2.a Claim

```
precrime__pipeline({ action: "claim_task", role: "headless-orchestrator" })
```

- `status == "NO_TASK"` -> jump to Step 3 (replan).
- `status == "CLAIMED"` -> hold `task = response.task`; dispatch on `task.type`.
- Any other status (`CONTENTION`, error) -> jump to Step 3.

### 2.b Dispatch

| `task.type`        | Action |
|--------------------|--------|
| `SHARE_BOOKING`    | `precrime__pipeline({ action:"share_booking", bookingId: task.targetId, mode:"post", timezone: "<config.timezone>" })`. Quote the literal response. Then `complete_task({ taskId: task.id, status:"done", output:{ bookingIds:[task.targetId], summary:"shared <bookingId>: leedId=<response.leedId>", needsJudge:false } })`. If response `posted:false`, instead `complete_task({ status:"failed", error: response.error, output:{ bookingIds:[task.targetId], summary:"share refused: <error>", needsJudge:false } })`. NEVER call `leedz__createLeed`. |
| `SCRAPE_SOURCE`    | Execute `__PROJECT_ROOT__/skills/url-loop.md` starting from its **Step 2** (the Task is already claimed; do not re-claim). The worker skill calls `complete_task` itself. |
| `ENRICH_CLIENT`    | Execute `__PROJECT_ROOT__/skills/enrichment-agent.md` starting from its **Step 2**. Same handoff. |
| `APPLY_FACTLET`    | Execute `__PROJECT_ROOT__/skills/apply-factlet.md` starting from its **Step 2**. Same handoff. |
| `JUDGE_AFFECTED`   | `precrime__pipeline({ action:"judge_affected", clientIds: task.input.clientIds \|\| [], bookingIds: task.input.bookingIds \|\| [], session_id: task.sessionId })`. Then `complete_task({ taskId: task.id, status:"done", output:{ clientIds: task.input.clientIds \|\| [], bookingIds: task.input.bookingIds \|\| [], summary:"judged", needsJudge:false } })`. Do not call `pipeline.rescore`. |
| `DISCOVER_SOURCES` | One bounded `tavily__tavily_search({ query: "<config.defaultTrade> directories <geography from VALUE_PROP>", max_results: 5 })`. Filter results to plausible source URLs. Feed them in one call: `precrime__pipeline({ action:"add_sources", entries:[{ url, channel:"directory", discoveredFrom:"discover" }, ...] })`. Then `complete_task({ taskId: task.id, status:"done", output:{ sourceIds: response.addedIds \|\| [], summary:"discovered <N> sources", needsJudge:false } })`. |
| `SHOW_HOT_LEEDZ`   | Headless does not present. `complete_task({ taskId: task.id, status:"cancelled", error:"presenter_skipped_headless", output:{ summary:"skipped in headless", needsJudge:false } })`. |
| any other type     | `complete_task({ taskId: task.id, status:"failed", error:"unknown_task_type:" + task.type, output:{ summary:"unknown type", needsJudge:false } })`. |

### 2.c Honesty

Quote the literal MCP response for every `share_booking(mode:"post")` call. The user audits CloudWatch and DynamoDB; faking success is the worst possible failure in headless because no human is watching.

### 2.d Tally and loop

After `complete_task` returns: increment `runTotals[task.type]` (or `runTotals.failed` if status was failed/cancelled), then go back to 2.a.

---

## Step 3 -- Replan / exit

When Step 2 drained because of `NO_TASK`:

```
precrime__pipeline({ action: "plan_tasks", mode: "headless" })
```

Increment `replans`. Compare new `counts` vs `lastCounts`. **Exit condition:** the new pass created `0` ready Tasks in EVERY type AND the previous drain claimed `0` Tasks of any type. If exit condition holds -> jump to Step 4.

Otherwise update `lastCounts = response.counts` and go to Step 2.

When Step 2 stopped because of the 50-Task per-pass cap (not `NO_TASK`), still replan once to surface fresh judge/share work, then continue draining. Do NOT exit on cap stops.

---

## Step 4 -- Final report

Append ONE report block to `logs/ROUNDUP.md`:

```
== Headless run completed <ISO timestamp> ==
SHARE_BOOKING=<n>  SCRAPE_SOURCE=<n>  ENRICH_CLIENT=<n>  APPLY_FACTLET=<n>  JUDGE_AFFECTED=<n>  DISCOVER_SOURCES=<n>
Failed/Cancelled: <n>
Replans: <n>
Exit reason: queue_exhausted
```

Exit. Do not call `plan_tasks` again. Do not invoke any worker skill again.

On an unrecoverable error (mcp_server connection lost, repeated tool-layer failures), instead exit with:

```
== Headless run aborted <ISO timestamp> ==
Reason: <one-line cause>
Last completed type: <type>
Replans: <n>
```

---

## Forbidden actions in this orchestrator

- Never call `leedz__createLeed`. It is forbidden in this architecture; only `share_booking(mode:"post")` posts to Leedz.
- Never call `pipeline.rescore`. Judge owns scoring; the orchestrator never re-rescores.
- No recursive harvester traversal: harvesters are not a separate skill chain in this architecture. SCRAPE_SOURCE handles every channel via `url-loop.md`.
- No direct DB writes / sqlite: every persistence step goes through `pipeline.*`.
- No questions to the user: headless is silent; on a missing config field, exit with the field name in the report and stop.
