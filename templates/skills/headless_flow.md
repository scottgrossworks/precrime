---
name: headless-flow
description: Planner-driven headless orchestrator. plan_tasks(headless), claim/dispatch/complete, replan, exit when exhausted. Objective-aware.
triggers:
  - run headless
  - headless mode
  - autonomous run
---

# Headless Flow

No menus, no global LLM workflow, no direct scraping loops. The server Planner chooses Tasks; this skill only dispatches them.

Forbidden: external Leedz tools, `pipeline.rescore`, direct sqlite writes, direct `next_source` / `mark_source`, ad-hoc harvester traversal, user questions.

## Step 0 -- Resolve objective

Read `objective` from the `init-wizard.md` handoff (or from the startup prompt: scan for `objective=marketplace|outreach|hybrid`). Valid values: `marketplace`, `outreach`, `hybrid`. If none was supplied, default to `marketplace` (the headless default).

If `objective` is `outreach` or `hybrid`, the Gmail MCP MUST already be registered (init-wizard verifies this; arriving here without `gmail__gmail_send` registered means STOP with `OUTREACH_REQUIRES_GMAIL`).

## Step 1 -- Plan

```
precrime__pipeline({ action: "plan_tasks", mode: "headless", objective: "<objective>" })
```

Record `counts`, `session_id`, `objective` (echoed in the response), `budgetUsage`, and initialize:

```
runTotals = { SHARE_BOOKING:0, DRAFT_OUTREACH:0, SCRAPE_SOURCE:0, ENRICH_CLIENT:0, APPLY_FACTLET:0, JUDGE_AFFECTED:0, DISCOVER_SOURCES:0, failed:0 }
replans = 1
```

The Planner owns workflow bias. If `workflowStrategy.strategy` is `consume_factlets`, drain APPLY_FACTLET / JUDGE_AFFECTED work before expecting new discovery; do not improvise around it.

## Step 2 -- Drain

Repeat until `claim_task` returns `NO_TASK`. Hard caps: 5 minutes per Task, 50 Tasks per drain pass.

```
precrime__pipeline({ action: "claim_task", role: "headless-orchestrator" })
```

- `NO_TASK` -> Step 3.
- `CLAIMED` -> dispatch by `task.type`.
- Error/contention -> Step 3.

## Step 2.b -- Dispatch

`SHARE_BOOKING`

Legal only when `objective` is `marketplace` or `hybrid`. If `objective` is `outreach`, the Planner should never have created this; complete `failed` with `error: "share_booking_under_outreach_objective"` and return to Step 2.

Otherwise:

```
precrime__pipeline({ action:"share_booking", bookingId: task.targetId, mode:"post" })
```

Server derives timezone from Booking zip/location; do not pass `timezone`. Quote response. Then complete:

```
complete_task({ taskId: task.id, status:"done", output:{ bookingIds:[task.targetId], summary:"shared <bookingId>: leedId=<response.leedId>", needsJudge:false } })
```

If refused, complete `failed` with `error: response.error`.

`DRAFT_OUTREACH`

Legal only when `objective` is `outreach` or `hybrid`. If `objective` is `marketplace`, the Planner should never have created this; complete `failed` with `error: "draft_outreach_under_marketplace_objective"` and return to Step 2.

Otherwise hand off to `__PROJECT_ROOT__/skills/outreach-drafter.md` for the already-claimed Task. Pass the full Task packet; the worker must use `task.id`, `task.targetType` (`Booking`), and `task.targetId`, and must not call `claim_task`.

Headless contract for the drafter:
- Compose the email from the loaded hot Booking + dossier + signature (verbatim from `pipeline.get_config({ key:"signature" })`).
- Save the draft via `pipeline.save({ judge:false, patch:{ draft, draftStatus:"ready" } })`.
- Create a Gmail DRAFT (NOT a send) when the Gmail MCP exposes a draft tool; otherwise just persist the draft text and log it to `logs/ROUNDUP.md`. Auto-send is never allowed in headless.
- Complete the Task:

```
complete_task({ taskId: task.id, status:"done", output:{ bookingIds:[task.targetId], summary:"drafted outreach for <bookingId>", needsJudge:false } })
```

On composition failure (`MISSING_SIGNATURE`, `MISSING_RATE`, thin dossier), complete `failed` with the structured reason returned by the drafter.

`SCRAPE_SOURCE`

Route by `task.input.channel` (headless has no browser MCP):

- `fb` / `ig` -> browser-only, cannot render headless. Complete `cancelled` with `error:"browser_channel_skipped_headless"` and return to Step 2; these channels are processed in interactive mode.
- `x` -> run `skills/x-factlet-harvester/SKILL.md` (its Tavily `site:x.com` fallback works headless).
- all others (`rss` / `directory` / `blog` / `website` / `reddit`) -> run `skills/url-loop.md`.

Pass the full claimed Task packet from Step 2. The worker must not call `claim_task`.

`ENRICH_CLIENT`

Run `skills/enrichment-agent.md` with the full claimed Task packet from Step 2. Task is already claimed; the worker must not call `claim_task`.

`APPLY_FACTLET`

Run `skills/apply-factlet.md` with the full claimed Task packet from Step 2. Task is already claimed; the worker must not call `claim_task`.

`JUDGE_AFFECTED`

```
precrime__pipeline({ action:"judge_affected", clientIds: task.input.clientIds || [], bookingIds: task.input.bookingIds || [], session_id: task.sessionId })
complete_task({ taskId: task.id, status:"done", output:{ clientIds: task.input.clientIds || [], bookingIds: task.input.bookingIds || [], summary:"judged", needsJudge:false } })
```

`DISCOVER_SOURCES`

Seed from the peer table first (C#1). Read `DOCS/PEER_SOURCES.json`. For each `peers[]` entry whose `match[]` contains a substring of your trade or segments (from `DOCS/VALUE_PROP.md`), enqueue its `sources[]` via `add_sources` with `discoveredFrom:"peer-table"`. Only if NO entry matches (or the file is missing/malformed) fall back to one bounded web search. Then:

```
precrime__pipeline({ action:"add_sources", entries:[/* matched peer sources, else searched urls */ { url, channel, subtype, label, discoveredFrom:"peer-table" }] })
complete_task({ taskId: task.id, status:"done", output:{ sourceIds: response.addedIds || [], summary:"discovered <N> sources (<peer|search>)", needsJudge:false } })
```

`SHOW_HOT_LEEDZ`

Headless does not present:

```
complete_task({ taskId: task.id, status:"cancelled", error:"presenter_skipped_headless", output:{ summary:"skipped in headless", needsJudge:false } })
```

Unknown type: complete `failed`.

After each completion, update `runTotals` and return to Step 2.

## Step 3 -- Replan Or Exit

```
precrime__pipeline({ action: "plan_tasks", mode: "headless", objective: "<objective>" })
```

Increment `replans`.

Exit when the new plan created zero ready Tasks and the previous drain claimed zero Tasks. Otherwise update counts and return to Step 2.

## Step 4 -- Report

Append one block to `logs/ROUNDUP.md`:

```
== Headless run completed <ISO timestamp> ==
Objective: <objective>
SHARE_BOOKING=<n> DRAFT_OUTREACH=<n> SCRAPE_SOURCE=<n> ENRICH_CLIENT=<n> APPLY_FACTLET=<n> JUDGE_AFFECTED=<n> DISCOVER_SOURCES=<n>
Failed/Cancelled: <n>
Replans: <n>
Exit reason: queue_exhausted
```

On unrecoverable tool failure, write an aborted block with reason and last completed type.

Then exit. Do not call `plan_tasks` again.
