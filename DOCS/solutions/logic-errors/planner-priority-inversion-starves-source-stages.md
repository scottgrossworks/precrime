---
title: Planner stage-priority inversion starved source scraping and discovery
date: 2026-06-28
category: docs/solutions/logic-errors
module: precrime-planner
problem_type: logic_error
component: background_job
symptoms:
  - "A full workflow ran 110 tasks but report_session showed 0 saves and 0 hot leedz"
  - "Conductor log: every spawned task was ENRICH_CLIENT / FIND_CLIENT_SOURCES / JUDGE_AFFECTED — not one SCRAPE_SOURCE or DISCOVER_SOURCES task was ever created the entire session"
  - "JUDGE_AFFECTED repeatedly returned changed=0; no new factlets, bookings, or promotions ever appeared"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [planner, task-pipeline, priority-inversion, funnel-stall, precrime, source-discovery]
---

# Planner stage-priority inversion starved source scraping and discovery

## Problem
The PreCrime planner (`plan_tasks` in `server/mcp/mcp_server.js`) is a stage-gated state machine: judge → apply-factlet → client-enrichment → scrape-source → discover-sources, where each scheduled stage suppresses the stages below it for that planning pass. A suppression rule let **client enrichment** (a downstream processing stage) switch off **SCRAPE_SOURCE and DISCOVER_SOURCES** (the foundational input stages). Because there was always a little enrichment work to do, the two input stages were suppressed every cycle and **never ran at all** — the funnel could never pull in fresh demand, so it produced zero new leedz no matter how long it ran.

## Symptoms
- A full interactive run executed **110 tasks, made 0 saves**, and produced 0 hot leedz.
- The conductor log showed only `ENRICH_CLIENT`, `FIND_CLIENT_SOURCES`, and `JUDGE_AFFECTED` spawns; **`SCRAPE_SOURCE` and `DISCOVER_SOURCES` were never created** (confirmed by querying the session's `Task` rows — empty for those two types).
- Every `JUDGE_AFFECTED` reported `changed=0` — the pipeline kept re-scoring the same records without anything moving.

## What Didn't Work
- **Reading `report_session` at face value.** It said `completed_no_new_evidence` and the LLM summary claimed "15 source discoveries" — but those were `FIND_CLIENT_SOURCES` (web pages *about* an existing client), not real source discovery. The blanket session reason hid the stall; the per-task type breakdown from the `Task` table is what exposed it.
- **Assuming the data was the bottleneck.** The instinct was "sources don't pair an event with a contact." True in general, but irrelevant here: the scraping stage that would even *test* that never executed. Verify the stage ran before blaming its inputs.

## Solution
Two surgical planner edits (`server/mcp/mcp_server.js`), verified by confirming the session created zero scrape/discover tasks before the change.

**Fix #1 — remove the enrichment → scrape/discover suppression.** The offending block:

```js
// BEFORE — client enrichment suppressed the input stages
if (clientWorkPlanned > 0 || enrichOpen > 0 || findOpen > 0) {
    suppressed.add('SCRAPE_SOURCE');
    suppressed.add('DISCOVER_SOURCES');
}
```

```js
// AFTER — deleted. Scraping fresh sources is the funnel's fuel and must run
// ALONGSIDE enrichment, not behind it. The judge/apply stages above still gate
// scrape correctly (don't scrape before judging existing evidence).
```

**Fix #2 — stop re-chasing un-promotable "live" clients.** Only 12 of 825 clients were "live" (future booking), and those 12 were stuck trade-show seeds with generic/org emails that can never pass the hot-gate — so enrichment burned the whole budget on dead-ends every run. In the live-client loop, skip a client once it has exhausted its find-pass budget without promoting:

```js
for (const c of liveClients) {
    if (clientWorkPlanned >= planCap) break;
    if (skipC.has(c.id)) continue;
    // skip clients we've already searched MAX_FIND_PASSES times and still can't promote
    if ((findPassCount.get(c.id) || 0) >= MAX_FIND_PASSES) continue;
    ...
}
```

## Why This Works
The stall was a **priority inversion**: a downstream stage (enrichment) was allowed to starve the upstream stages (scrape/discover) that feed the entire pipeline. Removing that one suppression lets the input stages run in every cycle, so fresh sources get scraped → factlets get minted → the backlog crosses the consume threshold → apply/judge produce new bookings and promotions. The downstream stages were never the bottleneck; they were drowning out the upstream ones. Fix #2 removes the perpetual-enrichment pressure that made the inversion bite — without un-promotable zombies generating endless work, even a stricter priority would drain and let scraping through. Tellingly, even at the run's tail, **4 stuck-claimed `ENRICH_CLIENT` tasks kept the suppression latched on**, so scraping never fired even after budgets drained — a second reason a downstream stage should never hold an upstream gate.

## Prevention
- **Foundational input stages must not be suppressible by downstream processing stages.** In any staged pipeline (ingest → transform → score), gate *downstream* work behind *upstream* readiness, never the reverse. If "get more input" can be switched off by "process what we have," and processing never fully drains, the system silently stops growing.
- **Diagnose stalls by task *type counts*, not summary text.** A run that does many tasks and saves nothing is a routing/priority bug until proven otherwise. Query which task types were *created* (not just completed) — a whole stage missing from the created set is the smoking gun. (This investigation is why `report_session` was changed to surface each task's own `output.summary`/`error` instead of one inferred blanket reason.)
- **Don't let un-promotable records generate perpetual work.** Cap retries per record on a durable signal (here, completed find-passes). A small set of records that can never reach the goal will otherwise consume the budget every run and mask the stall — see [[current-demand-hygiene]].
- **Beware stuck-`claimed` tasks latching a gate.** A suppression keyed on "work is open" stays latched if a worker dies mid-claim. Prefer gating on *createable* work, and reclaim/expire stale claims promptly.

## Related Issues
- Same session's broader refactor (markdown as the single source of truth for scrape sources, the `DISCOVER_SOURCES` orphan-worker wiring, current-demand factlet pruning): running record in agent memory `precrime_markdown_sources_refactor.md`.
- [[leed-ready-blocked-by-hardcoded-url-verification]] — another case where a gate, not the data, blocked the funnel.
