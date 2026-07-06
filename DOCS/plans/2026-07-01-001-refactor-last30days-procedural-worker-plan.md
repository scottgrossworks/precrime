---
title: "refactor: LAST_30_DAYS as a procedural (non-LLM) worker"
type: refactor
status: active
date: 2026-07-01
governed_by: DOCS/Claude.md
---

# refactor: LAST_30_DAYS as a procedural (non-LLM) worker

## Summary

Convert `LAST_30_DAYS` from a goose/LLM worker (which currently picks its own topic
with the model and reads the entire multi-MB `last30days` JSON into its context) into a
**procedural, pure-JS, zero-model** worker. Node runs the CLI, parses + filters the JSON
procedurally, and only the high-score survivors become Clients (+Booking +Factlet) with a
follow-up `DRILL_DOWN` queued. Topic selection moves to deterministic Node.

The worker logic lives in a small OOP hierarchy under `server/mcp/workers/`
(`Worker` -> `ProceduralWorker` -> `Last30DaysWorker`). It runs on the conductor's
**existing** in-process path (the same mechanism as `JUDGE_AFFECTED` / `SHOW_HOT_LEEDZ`)
— no new dispatch framework. The goose/LLM spawn path is untouched.

Governed by `DOCS/Claude.md`: minimum code, surgical changes, reuse over duplication, no
architectural overthinking, JS only.

---

## Problem Frame

`LAST_30_DAYS` today is `createTask('LAST_30_DAYS', { targetType:'none' })` with **no topic**
(mcp_server.js Stage 8). A spawned goose worker (`templates/skills/last-30-days.md`) then:
1. picks a topic with the model (non-deterministic), and
2. `type`s the full CLI JSON into its context and hand-filters it (tens of thousands of
   context tokens per run).

Both are waste. The filtering is pure data work Node can do for free; the topic is a fixed
buyer-occasion list we can rotate deterministically. Ingestion (create Client/Booking/Factlet
+ queue DRILL_DOWN) needs **zero** model tokens.

A secondary defect surfaced while reading the code: the task-creation **primitive** is trapped
inside the planner's session-scoped `createTask` closure (mcp_server.js:1213), so nothing
outside `pipelinePlanTasks` can enqueue a task. The worker needs to enqueue `DRILL_DOWN`, so
the primitive must be lifted to the shared task module.

---

## Key Technical Decisions

- **In-process, reuse existing mechanism.** `LAST_30_DAYS` moves from `WORKER_SKILL_MAP` to
  `IN_PROCESS_TYPES` (db.js). The conductor already polls, claims, and runs in-process types
  via the injected `runInProcess` hook (`runInProcessTask`, mcp_server.js:1073); each branch
  completes its own task via `pipelineCompleteTask`. We add one branch. No new framework.
- **OOP on the execution side only.** `Worker` (abstract `run(task)`), `ProceduralWorker`
  (marks the non-LLM lane; holds the shared python-spawn + read-JSON helper), `Last30DaysWorker`
  (concrete). Classes stay minimal — no methods nobody asked for. Persistence stays a *module of
  functions* (db.js) per the established convention; we do NOT introduce a Task class.
- **Lift the task primitive, keep the budget wrapper.** Extract `createTaskRow(type, fields)`
  (raw `prisma.task.create`) to `db.js`, beside its sibling task helpers. The planner's
  `createTask` closure keeps its budget gate + session accounting and simply calls
  `createTaskRow` internally. The worker imports `createTaskRow` directly.
- **Deterministic topic, no DB, no persisted cursor.** A small `last30daysTopics.js` module
  holds `L30D_TOPICS` (buyer-occasion phrasing, no city-only sports-noise) and an in-memory
  `nextTopic()` counter. Because `LAST_30_DAYS` is serialized to limit 1, Stage 8's `for (i...)`
  loop only ever runs at `i=0` — a bare `topics[i % len]` would never rotate. `nextTopic()`
  advances one integer per call (resets on restart; no persistence).
- **Clean file write, never `>`.** The CLI is run with `--deep --emit=json --save-dir data`
  so `last30days` writes its own UTF-8 file. (PowerShell `>` produces UTF-16 garble — the cause
  of the earlier empty/garbled output files.)
- **Filter thresholds (procedural).** Keep a `ranked_candidates` entry when
  `final_score >= 50` AND `source !== 'youtube'` AND its `explanation` does not match
  `/off-topic|lacks .* grounding|no .* date/i`. Testing showed real buyers cluster at 60-68,
  vendors ~38, noise <20; YouTube skews vendor/competitor.

---

## Implementation Units

### U1. Lift task primitive + reclassify LAST_30_DAYS (db.js + planner wrapper)

**Goal:** Make task creation callable outside the planner, and route `LAST_30_DAYS` to the
in-process lane.
**Files:** `server/mcp/db.js`, `server/mcp/mcp_server.js` (planner `createTask` closure only).
**Approach:**
- Add module-level `async function createTaskRow(type, fields)` to `db.js`: the raw
  `prisma.task.create({ data: { type, status:'ready', sessionId: fields.sessionId || null,
  targetType: fields.targetType || 'none', targetId: fields.targetId || null,
  input: fields.input ? JSON.stringify(fields.input) : null } })`, returning the row. Export it.
- Repoint the planner's `createTask` closure (mcp_server.js:1213) to call `createTaskRow(type,
  { ...fields, sessionId })` instead of inlining `prisma.task.create`. It keeps its
  `createBudget` gate and the `created`/`counts`/`sessionCreatedSoFar` accounting verbatim.
- In `db.js`, remove `LAST_30_DAYS` from `WORKER_SKILL_MAP` and add `'LAST_30_DAYS'` to
  `IN_PROCESS_TYPES`.
**Patterns to follow:** existing `conductor*` helpers in db.js; the current closure body.
**Test scenarios:**
- `createTaskRow('DRILL_DOWN', { targetType:'Booking', targetId:'b1', input:{a:1}, sessionId:null })`
  inserts a `ready` row with JSON-stringified input and returns it.
- Planner `createTask` still refuses (returns null) when `createBudget().eff <= 0`, and still
  increments `sessionCreatedSoFar` on success (behavior unchanged).
- `conductorGetReadyInProcessTasks` now returns `LAST_30_DAYS` rows; `conductorGetReadyTasks`
  (worker types) no longer does.
**Verification:** planner behavior identical for all existing types; a `LAST_30_DAYS` ready task
is picked up by the in-process poll, not the goose poll.

### U2. Topic module (workers/last30daysTopics.js)

**Goal:** Deterministic buyer-occasion topics + in-memory rotation.
**Files:** `server/mcp/workers/last30daysTopics.js` (new).
**Approach:** export `const L30D_TOPICS = [...]` (buyer-intent strings, e.g. "corporate holiday
party entertainment ideas los angeles", "wedding reception entertainment vendors los angeles",
"quinceanera entertainment ideas los angeles", "kids birthday party entertainment los angeles",
"school carnival festival vendors los angeles", "bar mitzvah bat mitzvah entertainment los
angeles") and `function nextTopic()` returning `L30D_TOPICS[n++ % L30D_TOPICS.length]` with a
module-local `n`. No DB, no config read.
**Test scenarios:**
- `nextTopic()` called `L30D_TOPICS.length + 2` times cycles through all topics then wraps to
  index 0, 1 again.
- `L30D_TOPICS` is non-empty and contains no bare city-only strings.
**Verification:** repeated calls rotate; process restart resets to index 0 (acceptable).

### U3. Worker base classes (workers/Worker.js, workers/ProceduralWorker.js)

**Goal:** Minimal OOP hierarchy for the procedural lane.
**Files:** `server/mcp/workers/Worker.js` (new), `server/mcp/workers/ProceduralWorker.js` (new).
**Approach:**
- `Worker`: `constructor(task, deps){ this.task=task; this.deps=deps; }` and
  `async run(){ throw new Error('Worker.run is abstract'); }`.
- `ProceduralWorker extends Worker`: the non-LLM lane. Holds the one genuinely shared helper —
  `async runCli(topic)`: spawn `python` with the fixed args, `cwd` = repo root (resolved from
  `__dirname`), wait for exit, read + `JSON.parse` the saved `data/<slug>-raw.json`, return the
  parsed object (or throw on non-zero exit / missing file). No speculative extras.
**Patterns to follow:** child-process spawn style already used by the conductor for goose (env
inheritance, exit handling), minus the goose specifics.
**Test scenarios:**
- `new Worker(...).run()` throws the abstract error.
- `ProceduralWorker.runCli` rejects when the python exit code is non-zero or the output file is
  absent (so U4 can complete the task `failed`).
- `runCli` resolves with the parsed object when the CLI writes a valid file.
**Verification:** classes load; `Last30DaysWorker` extends the chain without redefining the helper.

### U4. Last30DaysWorker (workers/Last30DaysWorker.js)

**Goal:** The concrete procedural worker: run -> parse -> filter -> ingest -> queue DRILL_DOWN.
**Files:** `server/mcp/workers/Last30DaysWorker.js` (new).
**Dependencies:** U2, U3, U1 (`createTaskRow`).
**Approach:** `run()`:
1. `topic = this.task.input?.topic`; if missing, return `{ status:'failed', error:'missing_topic' }`.
2. `data = await this.runCli(topic)` (U3).
3. Filter `data.ranked_candidates`: keep `final_score >= 50` AND `source !== 'youtube'` AND
   `!/off-topic|lacks .* grounding|no .* date/i.test(explanation||'')`.
4. For each survivor: build the save patch (organizer/author -> `company`; snippet -> a
   `factlets[]` entry; url -> `source`/`sourceUrl`; a `bookings[]` entry with the canonical trade
   + verbatim date text when present) and call the injected `pipelineSave('inproc-l30d', null,
   patch, null, false)` (judge:false, no sessionId, clientId null = create). Extract the new
   booking id from the response.
5. Enqueue a follow-up via injected `createTaskRow('DRILL_DOWN', { targetType:'Booking',
   targetId:<newBookingId>, input:{ clientId:<newClientId>, missing:['client_email'] },
   sessionId: this.task.sessionId })`.
6. Return `{ status:'done', output:{ clientIds, bookingIds, kept, total }, summary }`. Nothing
   kept -> `{ status:'done', summary:'no high-score candidates', output:{...} }`.
- Export a thin `run(task, deps)` = `new Last30DaysWorker(task, deps).run()` for U5 to call.
**Patterns to follow:** the save-patch shape in `templates/skills/last-30-days.md` Step 4;
`pipelineSave` signature `(id, clientId, patch, sessionId, judge, factletId)` (saveClient.js:58);
the DRILL_DOWN field shape at mcp_server.js:1699.
**Test scenarios (feature-bearing):**
- Happy path: a fixture JSON with two `>=50` non-youtube candidates + several noise items yields
  exactly two `pipelineSave` calls and two `createTaskRow('DRILL_DOWN', ...)` calls.
- A `final_score:68` reddit buyer is kept; a `final_score:38` youtube vendor is dropped; a
  `final_score:55` item whose explanation says "off-topic" is dropped.
- Missing `task.input.topic` -> returns `status:'failed'`, makes no saves.
- CLI failure (runCli throws) -> returns `status:'failed'` with the error, makes no saves.
- Zero survivors -> `status:'done'`, no saves, summary states none kept.
- Booking-id extraction: survivor with no parseable date still creates the Client + Factlet and
  still queues DRILL_DOWN (targeted at whatever booking the seed/save produced).
**Verification:** run against a saved fixture file; assert save + task counts and that no model /
goose process is invoked.

### U5. Wire in-process branch + deterministic topic (mcp_server.js)

**Goal:** Route the in-process dispatch to the worker and hand it a rotating topic.
**Files:** `server/mcp/mcp_server.js` (two small edits).
**Dependencies:** U1, U2, U4.
**Approach:**
- In `runInProcessTask` (mcp_server.js:1073), add before the unknown-type fallback:
  `if (task.type === 'LAST_30_DAYS') { const r = await require('./workers/Last30DaysWorker')
  .run(task, { pipelineSave, createTaskRow }); await pipelineCompleteTask('inproc-l30d',
  { taskId: task.id, status: r.status || 'done', output: r.output, error: r.error }); return
  { type: task.type, summary: r.summary }; }` (mirrors the JUDGE/SHOW_HOT branches).
- In Stage 8 (mcp_server.js:1952-1957), import `nextTopic` from `./workers/last30daysTopics` and
  change the create call to `createTask('LAST_30_DAYS', { targetType:'none', input:{ topic:
  nextTopic() } })`.
**Test scenarios:**
- A ready `LAST_30_DAYS` task with `input.topic` set runs the worker and is completed `done` with
  the worker's summary; an unknown in-process type still fails as before.
- Stage 8 creates the `LAST_30_DAYS` task with a non-empty `input.topic`.
**Verification:** boot the server; a planned `LAST_30_DAYS` completes in-process with a summary,
no goose spawn in the logs.

### U6. Deprecate the goose skill (templates/skills/last-30-days.md)

**Goal:** Mark the LLM skill unused without deleting it (Claude.md: comment + notify, don't delete).
**Files:** `templates/skills/last-30-days.md`.
**Approach:** add a top-of-file note: `LAST_30_DAYS now runs in-process (server/mcp/workers/
Last30DaysWorker.js); this skill is retained for reference and is no longer dispatched.` No other
change.
**Test expectation:** none -- documentation-only.
**Verification:** `WORKER_SKILL_MAP` no longer references this file; nothing spawns it.

---

## Risks & Trade-offs

- **R1 — In-process run blocks new dispatch for the CLI duration (~20-60s).** The conductor
  `await`s `runInProcess` sequentially; a `--deep` run pauses *new* task claiming/dispatch for its
  duration (already-running goose workers and their exit reaping are event-driven and unaffected).
  Accepted for v1 because `LAST_30_DAYS` is serialized (limit 1) and occasional. Escape hatch if it
  hurts: promote to the async spawned-worker path (the goose `active`-map machinery) later — out of
  scope now.
- **R2 — Child-process env must carry the last30days keys.** The spawned python must inherit the
  SC/OpenRouter keys the CLI needs. Confirm the MCP server process env exposes them (the manual CLI
  runs worked from the shell env); if not, pass them through explicitly. Verify at implementation.
- **R3 — `pipelineSave` return shape.** U4 needs the created client/booking ids from the save
  response (saveClient.js:468 `createSuccessResponse`). Confirm the field names at implementation
  and extract accordingly; if a booking id is not surfaced, look it up by the just-created client.

---

## Out of Scope / Deferred

- No Task class; persistence stays functional in db.js.
- No dispatch registry framework; reuse `IN_PROCESS_TYPES` + `runInProcess`.
- Do not lift `JUDGE_AFFECTED` / `SHOW_HOT_LEEDZ` out of mcp_server.js.
- Do not touch the goose/LLM spawn path.
- Async spawned-procedural-worker path (R1 escape hatch) — future only.

## Success Criteria

- `LAST_30_DAYS` runs as JS on the in-process path — no goose spawn, no model tokens for ingestion.
- Topic is deterministic from `nextTopic()`; only `final_score>=50` non-youtube on-topic survivors
  become Clients + a queued `DRILL_DOWN`.
- `createTaskRow` is callable from any module; planner behavior is unchanged.
- All new JS lives under `server/mcp/workers/`; `mcp_server.js` grows by only the small in-process
  branch + the one-line topic param.
