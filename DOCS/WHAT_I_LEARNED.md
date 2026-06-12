# PRECRIME Parallel Worker Runtime -- Coding Agent Handoff

Reference article: https://cursor.com/blog/scaling-agents

This document is the implementation brief for a coding agent with zero context. It records the intended architecture, the current real code state, the failure, and the required fix.

## Mandate

PRECRIME must become a planner + parallel worker system.

The current build has a procedural Planner and a Task table, but workflow execution is still effectively serial because Goose/Claude Desktop claims and executes one Task at a time. That is not sufficient.

Required runtime:

```text
User / Goose / Claude Desktop
  -> starts or monitors workflow
  -> calls plan_tasks
  -> starts worker supervisor
  -> presents hot leedz

Planner
  -> scans DB
  -> creates Task rows
  -> does not execute work

Worker Supervisor
  -> starts N worker processes
  -> each process owns one skill / task type
  -> workers claim Tasks atomically
  -> workers call LLM + MCP tools
  -> workers complete Tasks

Judge
  -> procedural scoring only
  -> promotes statuses

Presenter / Marketplace / Outreach
  -> acts only on judged hot work
```

Do not solve this with another markdown rewrite. The missing component is a real worker runtime.

## Source Of Truth

Source repo:

```text
C:\Users\Admin\Desktop\WKG\PRECRIME
```

Do not treat deployed verticals as source truth. They are test deployments copied from this repo, for example:

```text
C:\Users\Admin\Desktop\WKG\TDS\precrime
C:\Users\Admin\Desktop\WKG\VERTICALS\PB_DALLAS\precrime
```

Primary files:

```text
C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js
C:\Users\Admin\Desktop\WKG\PRECRIME\server\prisma\schema.prisma
C:\Users\Admin\Desktop\WKG\PRECRIME\server\sync-config.js
C:\Users\Admin\Desktop\WKG\PRECRIME\precrime_config.json
C:\Users\Admin\Desktop\WKG\PRECRIME\precrime_config.sample.json
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\GOOSE.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\init-wizard.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\headless_flow.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\apply-factlet.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\enrichment-agent.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\url-loop.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\outreach-drafter.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\show-hot-leedz.md
C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\share-skill.md
C:\Users\Admin\Desktop\WKG\PRECRIME\scripts\smoke_test_tasks.js
C:\Users\Admin\Desktop\WKG\PRECRIME\scripts\audit_build_zip.js
```

## Background

The project started from the scaling-agents idea: split a workflow into roles with bounded responsibility.

For PRECRIME, the roles are:

| Role | Meaning |
|---|---|
| Planner | Procedural code that decides what work exists and creates Tasks. |
| Worker | Separate execution process that claims one Task type, follows one skill, and completes Tasks. |
| Judge | Procedural scoring that decides whether Clients/Bookings are ready. |
| Presenter | Interactive UI step for hot leedz. |
| Session | Audit/run container, not the execution engine. |

The intended gain was parallelism and accountability:

- many factlets can be applied at once
- many clients can be enriched at once
- many sources can be scraped at once
- judging remains centralized and procedural
- hot leads interrupt lower-value work
- Goose remains a control surface, not the worker pool

## Current Real State

The code currently contains useful pieces:

- `pipelinePlanTasks(...)` in `server\mcp\mcp_server.js`
- `pipelineClaimTask(...)`
- `pipelineCompleteTask(...)`
- `pipelineJudgeAffected(...)`
- `share_booking`
- Task rows in SQLite
- per-task limits and session budgets
- skill files written as one-Task workers
- stage-gated planning logic
- objective gates: `marketplace`, `outreach`, `hybrid`
- startup sync from `DOCS\VALUE_PROP.md`

The current architecture still fails the parallelization mandate because no real worker supervisor exists.

Current runtime is effectively:

```text
Goose calls plan_tasks
Goose calls claim_task
Goose loads one skill
Goose executes one Task
Goose completes the Task
Goose repeats serially
```

That means "worker" is currently just a markdown role read by Goose. It is not a separate process.

## Critical Failure

The current system overlaps responsibilities:

| Responsibility | Current owner | Correct owner |
|---|---|---|
| User command/menu | Goose / Claude Desktop | Goose / Claude Desktop |
| Planning Task rows | MCP server Planner | MCP server Planner |
| Claiming workflow Tasks | Goose / Claude Desktop | Worker processes |
| Loading worker skill text | Goose / Claude Desktop | Worker process |
| Calling LLM for worker work | Goose / Claude Desktop | Worker process |
| Completing worker Tasks | Goose / Claude Desktop | Worker process |
| Presenting hot leedz | Goose / Claude Desktop | Goose / Claude Desktop |
| Posting marketplace leed | `share_booking` only | `share_booking` only |

Because Goose is both UI and worker executor, it stalls, loses claimed Task context, invents menus, and serializes work. This is the wrong execution model.

## Explicit Non-Goal

Do not rewrite the whole project into LangSmith, LangGraph, Temporal, Celery, or another framework as a first move.

Reason: the repo already has:

- a Task table
- atomic claim/complete primitives
- procedural scoring
- skill boundaries
- marketplace safety gates
- deployment scripts

The missing piece is smaller: a worker supervisor/runtime that uses the existing primitives. A framework migration can be reconsidered only after the existing Task architecture has a real worker pool and still fails.

## Required Design

Add a real worker runtime under source control.

Recommended files:

```text
C:\Users\Admin\Desktop\WKG\PRECRIME\server\workers\supervisor.js
C:\Users\Admin\Desktop\WKG\PRECRIME\server\workers\worker.js
C:\Users\Admin\Desktop\WKG\PRECRIME\server\workers\skill_runner.js
C:\Users\Admin\Desktop\WKG\PRECRIME\server\workers\worker_config.js
```

If a smaller implementation is cleaner, `supervisor.js` and `worker.js` are enough. Do not create a large framework.

## Correct Runtime Split

### Goose / Claude Desktop

Goose is UI/control only.

It may:

- run startup
- verify config
- show the two-choice menu
- call `plan_tasks`
- start worker supervisor
- stop worker supervisor
- poll workflow status
- call hot presenter
- let user choose share/draft/skip

It must not:

- execute `APPLY_FACTLET`
- execute `ENRICH_CLIENT`
- execute `SCRAPE_SOURCE`
- execute `DRAFT_OUTREACH`
- execute `JUDGE_AFFECTED`
- run the whole claim/dispatch/complete loop itself
- invent workflow menus after planner output

### Planner

Planner is procedural code in:

```text
server\mcp\mcp_server.js
```

MCP action:

```text
precrime__pipeline({ action:"plan_tasks", mode, objective })
```

Planner:

- reads SQLite
- creates `Task` rows
- enforces stage gates
- enforces budgets/limits
- returns counts/status
- does not call an LLM
- does not execute a Task

### Worker Supervisor

Supervisor is a local process manager.

It:

- starts bounded worker processes
- assigns each worker an allowed Task type or allowed Task type set
- passes runtime config and skill path
- watches exit codes
- restarts crashed workers up to a limit
- stops cleanly on request
- reports status

Supervisor does not decide business order. Planner + claim priority decide order.

### Worker Process

Worker process:

- owns one skill file
- has its own LLM HTTP connection
- has access to the Precrime MCP endpoint
- claims only allowed Task types
- executes exactly one claimed Task at a time
- calls `complete_task`
- loops until stopped or idle timeout

Each worker must be independent. Parallelism comes from multiple OS processes claiming from the same Task table.

### Judge

Judge remains procedural.

`JUDGE_AFFECTED` should not require expensive LLM calls. A worker can claim the Task, call `pipeline.judge_affected`, and complete it.

### Presenter

`SHOW_HOT_LEEDZ` should normally remain interactive and handled by Goose/Claude Desktop. Do not run it in the background worker pool by default because it needs user choice.

## Task Types

Keep existing Task types:

```text
DISCOVER_SOURCES
SCRAPE_SOURCE
APPLY_FACTLET
ENRICH_CLIENT
JUDGE_AFFECTED
SHOW_HOT_LEEDZ
SHARE_BOOKING
DRAFT_OUTREACH
```

Parallel worker candidates:

| Task type | Parallel? | Worker |
|---|---:|---|
| `APPLY_FACTLET` | Yes | LLM worker using `apply-factlet.md` |
| `ENRICH_CLIENT` | Yes | LLM worker using `enrichment-agent.md` |
| `SCRAPE_SOURCE` | Yes | LLM/tool worker using `url-loop.md` |
| `DRAFT_OUTREACH` | Yes, headless only | LLM worker using `outreach-drafter.md` |
| `JUDGE_AFFECTED` | Yes | procedural worker |
| `SHARE_BOOKING` | Yes, headless only | procedural `share_booking` worker |
| `DISCOVER_SOURCES` | Usually low concurrency | discovery worker |
| `SHOW_HOT_LEEDZ` | No by default | interactive presenter |

## Planner Modes

Do not confuse these with interactive/headless user mode.

Planner `mode`:

| Planner mode | Meaning |
|---|---|
| `hot_only` | Only create hot-presenter work. Used when user chooses `SHOW_HOT_LEEDZ`. |
| `workflow` | Interactive workflow planning. Creates background work but hot leads are presented to user. |
| `headless` | Autonomous workflow planning. Hot leads become `SHARE_BOOKING` or `DRAFT_OUTREACH` depending on objective. |

Run mode:

| Run mode | Meaning |
|---|---|
| `interactive` | User is present. Default objective is `hybrid`. |
| `headless` | Autonomous. Default objective is `marketplace`. |

Objective:

| Objective | Meaning |
|---|---|
| `marketplace` | Hot marketplace bookings are shared through `share_booking`. |
| `outreach` | Hot outreach candidates get drafted via Gmail MCP. |
| `hybrid` | Both are allowed. |

## Planner Stage Gates

Planner must remain stage-gated. This is already partly implemented and must be preserved.

Business loop:

```text
consume known evidence
judge immediately
if hot, interrupt and act/present
if not hot, enrich
if evidence is sparse, scrape/discover more
```

Claim priority:

```text
JUDGE_AFFECTED
SHOW_HOT_LEEDZ
SHARE_BOOKING
DRAFT_OUTREACH
APPLY_FACTLET
ENRICH_CLIENT
SCRAPE_SOURCE
DISCOVER_SOURCES
```

Planner creation gates:

1. `hot_only`: create only `SHOW_HOT_LEEDZ`.
2. Judge needed: create `JUDGE_AFFECTED`, suppress lower stages.
3. Hot interrupt: create presenter/share/draft action, suppress lower stages.
4. Apply Factlets: consume live unprocessed Factlets.
5. Enrich Clients: improve existing Clients.
6. Scrape Sources: consume existing Source queue.
7. Discover Sources: only when sparse.

## Factlet Processing

Do not add DB fields.

Factlet processed marker:

```text
terminal APPLY_FACTLET Task for that Factlet targetId
```

Terminal means:

```text
done
failed
cancelled
```

Recycler must retain terminal `APPLY_FACTLET` Tasks at least as long as Factlets remain live, otherwise a Factlet can be reprocessed.

## Scoring Boundary

Only Judge promotes.

Workers:

- save evidence with `judge:false`
- return affected Client/Booking ids
- complete the Task
- do not write `Booking.status`
- do not call `rescore`
- do not call `judge_affected` unless they are the dedicated `JUDGE_AFFECTED` worker

Judge:

- calls procedural scoring
- writes `leed_ready`, `outreach_ready`, `brewing`, `shared`, expired/deprecated states as appropriate

## Marketplace Boundary

Direct Leedz tool access is forbidden.

Allowed path:

```text
share_booking -> server builds payload -> server posts to Leedz
```

Forbidden outside server:

```text
leedz__createLeed
```

LLM may draft only:

```text
titleDraft
dtDraft
rqDraft
```

Server owns:

```text
cn, em, ph, lc, zp, st, et, tn, pr, sh
```

LLM must not compute `st` or `et`.

## VALUE_PROP Startup Fixes Already Required

Startup must treat `DOCS\VALUE_PROP.md` as source truth.

Current parser requirements:

- explicit `**Trade:**` wins
- do not infer trade from the full body because relevance examples can mention adjacent trades
- signature parser accepts any markdown heading named `signature`, any capitalization, levels `##` through `######`

The parser should be simple:

```js
const sigMatch = text.match(/^#{2,6}\s+signature\b[^\n]*\n+([\s\S]*?)(?=\n---|\n#{1,6}\s+|$)/im);
```

Never let stale SQLite Config outrank explicit `VALUE_PROP`.

## Worker Supervisor Implementation Plan

### Step 1 -- Add Worker Config

Add config under `precrime_config.json` and sample:

```json
{
  "workers": {
    "enabled": true,
    "pollMs": 1500,
    "idleExitMs": 300000,
    "maxRestarts": 3,
    "concurrency": {
      "APPLY_FACTLET": 4,
      "ENRICH_CLIENT": 4,
      "SCRAPE_SOURCE": 2,
      "JUDGE_AFFECTED": 2,
      "SHARE_BOOKING": 1,
      "DRAFT_OUTREACH": 2,
      "DISCOVER_SOURCES": 1
    }
  }
}
```

These are worker process counts. They are separate from existing `tasks.limits`, which cap open Task rows.

### Step 2 -- Add Supervisor

Create:

```text
server\workers\supervisor.js
```

Responsibilities:

- load `precrime_config.json`
- resolve repo root
- spawn workers with `child_process.spawn`
- pass env:
  - `PRECRIME_WORKER_TYPE`
  - `PRECRIME_SKILL_PATH`
  - `PRECRIME_OBJECTIVE`
  - `DATABASE_URL`
  - LLM provider env/config
- write logs to:

```text
logs\workers\supervisor.log
logs\workers\<task-type>-<n>.log
```

Supervisor commands:

```text
node server\workers\supervisor.js start --mode workflow --objective hybrid
node server\workers\supervisor.js start --mode headless --objective marketplace
node server\workers\supervisor.js status
node server\workers\supervisor.js stop
```

Keep the first version simple. If persistent background management is hard on Windows, start foreground workers and let `Ctrl+C` stop them.

### Step 3 -- Add Worker

Create:

```text
server\workers\worker.js
```

Worker loop:

```text
while not stopped:
  claim_task(types:[allowed type])
  if NO_TASK:
    sleep pollMs
    exit after idleExitMs if configured
  if CLAIMED:
    run handler for task.type
    complete_task(done|failed)
```

Worker must claim its own Task. Goose must not pre-claim work for worker processes.

### Step 4 -- Worker Handlers

Procedural handlers:

| Task | Handler |
|---|---|
| `JUDGE_AFFECTED` | call `pipeline.judge_affected`, then `complete_task` |
| `SHARE_BOOKING` | call `pipeline.share_booking`, then `complete_task` |
| `DISCOVER_SOURCES` | bounded Tavily/source discovery, then `add_sources`, then `complete_task` |

LLM handlers:

| Task | Skill |
|---|---|
| `APPLY_FACTLET` | `templates\skills\apply-factlet.md` |
| `ENRICH_CLIENT` | `templates\skills\enrichment-agent.md` |
| `SCRAPE_SOURCE` | `templates\skills\url-loop.md` |
| `DRAFT_OUTREACH` | `templates\skills\outreach-drafter.md` |

The coding agent must decide the lowest-risk LLM execution method available in this repo. Acceptable first implementation:

- spawn a CLI model process with a strict prompt containing the claimed Task JSON and exactly one skill file
- or call configured LLM HTTP endpoint directly

The LLM worker prompt must include:

```text
You are a PRECRIME one-task worker.
Use only the provided claimed Task.
Do not call claim_task.
Complete exactly this task.id.
Stop after complete_task.
```

Do not load unrelated skills into the worker prompt.

### Step 5 -- MCP Access From Workers

Workers need a way to call Precrime pipeline actions.

Preferred simple path:

- factor pipeline core functions enough for local worker code to call them directly, or
- start the existing MCP server and have workers call it over stdio/http if already supported.

Do not duplicate scoring or share logic in worker files. Use existing server functions/actions.

If direct function import from `mcp_server.js` is too tangled, add a small internal module:

```text
server\pipeline_actions.js
```

Move reusable action implementations there, and have both MCP server and worker runtime call it.

Keep this refactor narrow.

### Step 6 -- Goose Instructions

Update:

```text
templates\GOOSE.md
templates\skills\init-wizard.md
templates\skills\headless_flow.md
```

New interactive behavior:

```text
User chooses RUN_WORKFLOW
Goose calls plan_tasks(mode:"workflow", objective)
Goose starts worker supervisor if not running
Goose polls work_status/tasks
Goose calls plan_tasks periodically or when workers drain queue
Goose presents SHOW_HOT_LEEDZ when planner creates it
```

New headless behavior:

```text
startup detects headless
call plan_tasks(mode:"headless", objective)
start supervisor
loop: poll status, re-plan when queue drains, stop on budgets/idle
```

Goose must not execute worker skills itself except `SHOW_HOT_LEEDZ`.

### Step 7 -- Planner Replan Trigger

Add one of these, simplest first:

Option A:

- Goose/supervisor calls `plan_tasks` every N seconds while active.
- Existing planner dedup/budgets prevent duplicate flood.

Option B:

- Supervisor calls `plan_tasks` when all worker queues go idle.

Option C:

- Worker completion of source/evidence Tasks triggers a lightweight replan.

Start with A or B. Avoid event frameworks.

## What To Remove Or Demote

Demote these instructions:

- Goose as full workflow executor
- serial claim/dispatch/complete heartbeat in Goose for all Task types
- any language saying "worker skill claims next task" when running under Goose
- any workflow menu invented after planner output

Keep:

- startup wizard
- config checks
- hot presenter
- audit/status commands

## Sessions

Sessions are audit/run containers only.

They must not be used as the execution engine.

Rules:

- Planner may create/reuse Session for a run.
- Tasks may have `sessionId`.
- Worker completions may log to Session.
- Session failure must not be based solely on `save` count.
- A run with completed Tasks and zero saves can be valid: `completed_no_new_evidence`.

## Required Tests

Add or update tests in:

```text
scripts\smoke_test_tasks.js
scripts\audit_build_zip.js
```

Minimum tests:

1. `plan_tasks(mode:"workflow")` creates Task rows but does not execute them.
2. Supervisor starts configured worker counts.
3. Two `APPLY_FACTLET` workers can claim different Tasks concurrently.
4. A worker cannot claim a Task outside its allowed type.
5. Claimed Task context is preserved through completion.
6. Worker skill prompt contains one skill file only.
7. Goose docs no longer instruct serial execution of all workflow Tasks.
8. `SHOW_HOT_LEEDZ` remains interactive and is not claimed by background pool by default.
9. `JUDGE_AFFECTED` worker calls procedural judge and stamps source Task judged metadata.
10. `SHARE_BOOKING` worker uses only `share_booking`.
11. No direct `leedz__createLeed` active instruction exists.
12. `VALUE_PROP` explicit trade parser is protected against body false positives.
13. Signature parser accepts `### Signature`.
14. Full syntax checks pass:

```text
node --check server\mcp\mcp_server.js
node --check server\sync-config.js
node --check server\workers\supervisor.js
node --check server\workers\worker.js
node --check scripts\smoke_test_tasks.js
node --check scripts\audit_build_zip.js
```

If full smoke fails at Prisma schema engine startup, report that exact infrastructure failure and still run targeted unit/static tests.

## Acceptance Criteria

The fix is complete only when:

- There is a real worker supervisor.
- Multiple worker OS processes can run at once.
- Each worker has its own LLM call path.
- Workers claim Tasks atomically from SQLite.
- Goose no longer executes ordinary workflow Tasks serially.
- Planner remains procedural and stage-gated.
- Judge remains procedural.
- Hot lead interrupt still works.
- Marketplace posting still routes only through `share_booking`.
- TDS/PB_DALLAS style deployments can run without stale `defaultTrade` or missing signature startup failures.

## Mental Model

PRECRIME is not a chat flow.

PRECRIME is:

```text
Planner fills queue.
Workers drain queue in parallel.
Judge scores evidence.
Presenter/action handles hot leads.
Goose is the control panel.
```

Any implementation that leaves Goose as the only worker executor has not implemented the requested architecture.
