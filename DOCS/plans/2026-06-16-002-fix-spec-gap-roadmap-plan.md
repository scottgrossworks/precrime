---
title: "fix: bridge Thread 1 and Thread 2 spec gaps"
date: 2026-06-16
status: active
origin: DOCS/REDESIGN_2026-06-07.md
target_repo: C:\Users\Scott\Desktop\WKG\PRECRIME
---

# fix: bridge Thread 1 and Thread 2 spec gaps

**Target repo:** `C:\Users\Scott\Desktop\WKG\PRECRIME`
**Authority:** `DOCS/REDESIGN_2026-06-07.md` + `DOCS/START_HERE.md` (2026-06-07)

---

## Gap Audit: WANTED vs. GOT

This table is the single source of truth for what was agreed and what actually shipped.

| # | Specified in REDESIGN | Status | Notes |
|---|----------------------|--------|-------|
| T2-1 | Delete live-URL re-verification from save/share paths | ✓ DONE | Save path comment confirms. `verifyEvidenceUrl` no longer called at save/share. |
| T2-2 | Retire dead `verification` block from `SCORING.json` | ✓ DONE | Block gone. File now holds real config (`classification`, `factlet`, `demandSignal`). |
| T2-3 | Replace numeric 0-100 score + 60/90 thresholds as gates | ✓ DONE | `classification.js` procedural gates replace the score. |
| T2-4 | LLM judge for product-market-fit verdict | ✓ DONE | `judgeLeed()` in `mcp_server.js`. |
| T2-5 | **Store demand verdict on booking** (persist, recompute only on dossier-change) | ✗ MISSING | `judgeLeed()` result is not persisted. No `demandVerdict` field on Booking. LLM is re-called on every `computeBookingTargetScore()` invocation. |
| T2-6 | **Two independent labels** (`leed_ready` / `outreach_ready`), NOT a ladder | ✗ MISSING | Still a single `status` field with `cold \| brewing \| hot` ladder. |
| T2-7 | **`booking.status` = lifecycle only** (`brewing`, `shared`, `expired`) | ✗ MISSING | `status` still carries classification state (`cold`, `brewing`, `hot`). `SCORING.json` `statusRules` still documents `cold/brewing/hot`. |
| T2-8 | **Compute `shareable` and `emailable` at runtime** (not stored) | ✗ MISSING | No runtime derivation. No `shareable`/`emailable` logic anywhere. |
| T2-9 | `show_hot_leedz` query: `(shareable OR emailable) AND startDate within now..now+hotDaysOut` order by startDate asc, demand strength desc | ✗ MISSING | Query still uses old single-status logic. |
| T2-10 | **Missing end time must NOT block share**; `et` defaults to `startTime + configured duration` | ✗ MISSING | No `et` defaulting logic. |
| T2-11 | Markdown-tunable policy — every subtlety tunable in prose the engine reads | ~ PARTIAL | `VALUE_PROP.md` exists and `value_prop.js` reads it. `PROMPTS.json` is read. But the full policy surface (demand strength threshold, end-time default, share-without-et) is not in live markdown. |
| T1-1 | **HTTP transport** (`StreamableHTTPServerTransport` on `127.0.0.1:5179`) | ✗ MISSING | `mcp_server.js` is stdio JSON-RPC (`readline.createInterface`). Zero HTTP transport code. |
| T1-2 | **Procedural conductor loop** inside `mcp_server.js` (spawn workers, regroup) | ✗ MISSING | No conductor. No `child_process.spawn`. No worker lifecycle management. |
| T1-3 | **Push-claim**: conductor hands each worker exactly one Task | ✗ MISSING | `pipelineClaimTask` exists but no caller. Workers never spawn. |
| T1-4 | **One-shot workers**: claim one Task, do it, `complete_task`, exit | ✗ MISSING | No worker process model. |
| T1-5 | **Fail-and-forget**: failed Task garbage-collected, no reaper | ✗ MISSING | (N/A — conductor not built) |
| T1-6 | Process tree: `precrime.bat` starts `mcp_server.js` in HTTP mode first | ✗ MISSING | `precrime.bat` still starts in stdio mode. |
| T3-1 | Reconcile `precrime_config.json` drift before redeploy | ? UNKNOWN | `deploy.js` not yet read for overwrite vs. preserve behavior. |

**Root diagnosis:** Thread 2 was half-executed. The blocking code (URL re-verification) was removed, but the **architecture was not changed** — single-status ladder instead of two independent labels, no stored verdict, no `shareable`/`emailable` derivation. Bookings can now pass the save gate but still can't be correctly identified as shareable or emailable because the classification model was not rebuilt as designed.

---

## Problem Frame

The redesign had one business goal: **make hot leedz findable and actionable** — bookings with a real contact, a real event, and a real demand signal should surface as `shareable` or `emailable` without manual intervention.

Two blockers remain:

1. **Thread 2 architecture mismatch.** Even with URL re-verification gone, the classification still produces one status (`cold/brewing/hot`). The design requires two independent runtime labels (`shareable`, `emailable`) derived from a stored demand verdict + procedural field checks. Without this, `show_hot_leedz` can't distinguish share-ready from email-ready, and the user still can't act on the right bookings.

2. **Thread 1 not built.** The system is still serial. One Goose process drives everything sequentially. The conductor + one-shot worker architecture is completely unbuilt.

---

## Scope

**In scope (this plan):**
- Complete Thread 2: stored demand verdict, two-label architecture, `shareable`/`emailable` runtime derivation, `show_hot_leedz` query, `et` defaulting, and `booking.status` lifecycle-only.
- Complete Thread 1: HTTP transport, conductor loop, push-claim worker spawn, fail-and-forget, `precrime.bat` update.
- Thread 3 config reconciliation (`deploy.js` audit, `precrime_config.json` merge check).

**Out of scope:**
- Data migration (redesign says: rebuild fresh, no migration scripts).
- New factlet types, new client enrichment sources.
- Leedz API or marketplace changes.

---

## Key Technical Decisions

**KTD-1: Two-label architecture uses runtime derivation, not stored booleans.**
`shareable` and `emailable` are computed on read from the stored demand verdict + procedural field checks (from `classification.js`). Not added as Prisma columns. Only the LLM verdict (`demandVerdict`, `demandVerdictAt`) is stored. Rationale: avoids stale stored booleans; derivation is cheap once the verdict is cached.

**KTD-2: Demand verdict stored as string on Booking.**
`demandVerdict: String?` (`"hot" | "brewing"`) and `demandVerdictAt: BigInt?` (epoch ms) added to Booking. `judgeLeed()` persists its result. Re-judging triggered only when a factlet is added/updated, enrichment runs, or contact changes. Rationale: removes redundant LLM calls on every classification.

**KTD-3: `booking.status` lifecycle semantics only.**
Allowed values: `brewing` (default / in-progress), `shared` (sent to marketplace), `expired` (event passed). Remove `cold` and `hot` from the `status` field. Classification state (`shareable`/`emailable`) is runtime, never stored in `status`. `SCORING.json` `statusRules` must reflect this.

**KTD-4: `et` defaults to `startTime + configured duration` per trade.**
Missing end time does NOT block share. Default durations per trade in `SCORING.json` or a new `POLICY.md`. `classifyBooking` derives `et` before the hot-eligibility check.

**KTD-5: Conductor lives in `mcp_server.js`, HTTP transport on port 5179.**
Matches REDESIGN exactly. Module split: extract `db.js` (Prisma CRUD) and `conductor.js` (spawn + regroup loop) from `mcp_server.js`. `mcp_server.js` shrinks to HTTP transport + tool wiring.

**KTD-6: Build order is Thread 2 first, Thread 1 second.**
Thread 2 fixes the business-critical booking promotion bug. Thread 1 is an architectural improvement; without Thread 2, parallelism accelerates broken scoring. Fix the model first, then parallelize it.

---

## Implementation Units

### U1. Stored demand verdict — Prisma migration

**Goal:** Add `demandVerdict` and `demandVerdictAt` to the Booking model so `judgeLeed()` results persist.

**Requirements:** T2-5

**Dependencies:** None

**Files:**
- `server/prisma/schema.prisma` — add two fields to Booking
- `server/prisma/migrations/` — new migration file

**Approach:**
- Add `demandVerdict String?` and `demandVerdictAt BigInt?` to the Booking model.
- Run `prisma migrate dev` to generate the migration.
- No data backfill. Existing bookings start with `demandVerdict = null`; a `pipelineRescore` run re-judges them.

**Patterns to follow:** Existing nullable BigInt fields (`sharedAt`, `leedId`) in schema.prisma.

**Test scenarios:**
- Migration runs cleanly on a fresh DB and on a DB with existing bookings (null fields populated by migration default).
- `demandVerdict` and `demandVerdictAt` appear in Prisma client type after regeneration.

---

### U2. Persist demand verdict in `judgeLeed()`

**Goal:** After `judgeLeed()` returns a verdict, write it to the Booking row and skip the LLM call if the verdict is still fresh.

**Requirements:** T2-5

**Dependencies:** U1

**Files:**
- `server/mcp/mcp_server.js` — `judgeLeed()` and `computeBookingTargetScore()`

**Approach:**
- `judgeLeed(booking)`: before calling the LLM, check `booking.demandVerdict`. If it is set and the dossier has not changed since `demandVerdictAt` (no factlets added after that timestamp), return the cached verdict.
- After an LLM call, `prisma.booking.update({ demandVerdict, demandVerdictAt: Date.now() })`.
- Dossier-change trigger: `pipelineSave()` must clear `demandVerdict = null` when it creates/updates factlets or contact fields, so the next classification re-judges.

**Patterns to follow:** `pipelineClaimTask()` atomic update pattern (optimistic write with where clause). `computeClientScore()` freshness check pattern.

**Test scenarios:**
- First call to `judgeLeed()` with `demandVerdict = null`: LLM is called, verdict persisted.
- Second call with unchanged dossier: LLM is NOT called, cached verdict returned.
- After `pipelineSave()` adds a factlet: `demandVerdict` is cleared on the booking, next classification re-judges.
- After `pipelineSave()` updates `email` field: same clearance behavior.
- `demandVerdictAt` is updated on every fresh LLM call.

---

### U3. Two independent labels — runtime derivation

**Goal:** Replace the single-status hot/brewing/cold ladder with `shareable` and `emailable` computed at runtime from the stored verdict + field checks.

**Requirements:** T2-6, T2-7, T2-8, T2-10

**Dependencies:** U1, U2

**Files:**
- `server/mcp/classification.js` — add `deriveLabels(booking, verdict)` function
- `server/mcp/mcp_server.js` — update `computeBookingTargetScore()`, `pipelineSave()`, `pipelineRescore()`
- `server/prisma/schema.prisma` — update status field comment; add migration to normalize existing statuses
- `DOCS/SCORING.json` — update `statusRules`, add `etDefaultByTrade` block

**Approach:**

`classification.js` gains `deriveLabels(booking, demandVerdict)`:
```
emailable = (hasRealDirectContact) AND (hasLocation) AND (hasStartDate) AND (dossierRich)
shareable = (emailable) AND (demandVerdict === 'hot') AND (hasZip) AND (hasStartTime) AND (hasTrade) AND (hasTitle)
```
`et` defaulting: before the above checks, if `booking.endTime` is null, derive it as `startTime + etDefaultByTrade[booking.trade] ?? etDefaultByTrade['default']`. This derived value is used only for the check, not persisted.

`booking.status` becomes lifecycle-only. Allowed writes: `brewing` (default), `shared` (set by `pipelineShareBooking`), `expired` (set by a date-check in `pipelineRescore`). Remove all writes of `cold` and `hot` to `status`. Existing `cold` rows: migrate to `brewing`. Existing `hot` rows: migrate to `brewing` (they will re-derive as `shareable` on next rescore).

`computeBookingTargetScore()` now returns `{ shareable, emailable, demandVerdict }` instead of writing to `booking.status`. Callers decide what (if anything) to write.

**Patterns to follow:** `classification.js` existing gate pattern (pure functions, no side effects, no DB calls). `classifyBooking()` return shape.

**Test scenarios:**
- Booking with real contact, location, zip, startDate, startTime, trade, title, `demandVerdict='hot'`: `shareable=true, emailable=true`.
- Booking with real contact and location but no zip: `emailable=true, shareable=false`.
- Booking with `demandVerdict='brewing'`: `shareable=false` regardless of other fields.
- Booking with null `endTime` and a trade that has a default duration: `et` is derived, check passes if other fields present.
- Booking with null `endTime` and no default for that trade: uses `etDefaultByTrade.default`, does not block.
- `pipelineRescore()` on a booking previously status=`hot`: after migration, status is `brewing`, labels derived correctly on next call.
- Status writes `cold` and `hot` no longer appear anywhere after this unit.

---

### U4. Update `show_hot_leedz` and `share_booking` for two-label query

**Goal:** `show_hot_leedz` returns bookings that are `shareable OR emailable` within the hot window, ordered soonest first then by demand strength. `share_booking` checks `shareable` not `status === 'hot'`.

**Requirements:** T2-9, T2-6

**Dependencies:** U3

**Files:**
- `server/mcp/mcp_server.js` — `pipelineShowHotLeedz()`, `pipelineShareBooking()`

**Approach:**

`pipelineShowHotLeedz()`:
- Query: all bookings with `status !== 'shared'` AND `status !== 'expired'` AND `startDate` between now and `now + hotDaysOut * 86400000`.
- For each result, derive `{ shareable, emailable }` via `deriveLabels()` (uses stored `demandVerdict`).
- Filter to those where `shareable OR emailable`.
- Sort: `startDate ASC`, then `demandVerdict === 'hot'` first within same date.
- Return each booking annotated with `{ shareable, emailable }` so the worker knows which action is available.

`pipelineShareBooking(bookingId)`:
- Derive labels. Reject with `booking_not_shareable` if `shareable === false`. (Not `booking_not_leed_ready` — update error key.)
- Rest of share logic unchanged.

**Patterns to follow:** Existing `pipelineShowHotLeedz()` date-window query. `pipelineSave()` error-key convention.

**Test scenarios:**
- `show_hot_leedz` with a mix of shareable, emailable-only, and neither bookings in the window: returns only shareable + emailable, annotated correctly.
- A booking past `hotDaysOut`: excluded.
- A booking with `status='shared'`: excluded.
- Sort: booking with `startDate` sooner appears first regardless of demand strength. Within same `startDate`, `shareable` (hot verdict) before `emailable` (brewing verdict).
- `share_booking` on an `emailable`-only booking (demand not hot): returns `booking_not_shareable`.
- `share_booking` on a `shareable` booking: proceeds.

---

### U5. Module split: extract `db.js`

**Goal:** Pull all Prisma CRUD out of `mcp_server.js` into `server/mcp/db.js` so the conductor (U6) and the HTTP-wired tools both import from one place.

**Requirements:** T1 (pre-condition for clean conductor addition)

**Dependencies:** U3 (so the split includes updated classification calls)

**Files:**
- `server/mcp/db.js` — new file
- `server/mcp/mcp_server.js` — remove extracted CRUD, import from `db.js`

**Approach:**
- Read `mcp_server.js` fully before cutting. Map every `prisma.*` call site to its owning function.
- Extract: all `prisma.booking.*`, `prisma.client.*`, `prisma.factlet.*`, `prisma.task.*` CRUD into `db.js` as named exports.
- `mcp_server.js` imports those exports. No behavior change — pure refactor.
- Prisma client instantiated once in `db.js`, not in `mcp_server.js`.

**Patterns to follow:** Existing module pattern (`value_prop.js`, `classification.js`) — named exports, no side effects at module load.

**Test scenarios:**
- All existing tool calls (`pipeline`, `find`, `trades`) return identical results before and after the split.
- No duplicate Prisma client instances (only one `new PrismaClient()` in the process).
- `db.js` has no HTTP or MCP transport imports.

---

### U6. HTTP transport + procedural conductor

**Goal:** Switch `mcp_server.js` from stdio to HTTP (`StreamableHTTPServerTransport` on `127.0.0.1:5179`). Add a procedural conductor loop that spawns one-shot Goose workers, push-claims one Task each, and applies fail-and-forget on failure.

**Requirements:** T1-1, T1-2, T1-3, T1-4, T1-5

**Dependencies:** U5

**Files:**
- `server/mcp/conductor.js` — new file
- `server/mcp/mcp_server.js` — replace stdio transport with HTTP, add conductor import + start call

**Approach:**

`conductor.js`:
- `startConductor(db)` — exported entry point.
- Regroup loop: `SELECT id FROM tasks WHERE status='ready' ORDER BY createdAt LIMIT N` (N = concurrency ceiling from config).
- For each ready Task, spawn a Goose worker: `child_process.spawn('goose', ['run', '--config', workerConfigPath], { env: { PRECRIME_TASK_ID: taskId } })`.
- Before spawning, claim the Task via `db.claimTask(taskId, workerId)`. If claim fails (race), skip.
- Worker exits (any code): log result. If exit code non-zero or no `complete_task` call within timeout: `db.failTask(taskId)`. No retry, no reaper — fail-and-forget. The signal that spawned the Task remains; a future `plan_tasks` re-covers the ground.
- Loop interval: configurable, default 2 seconds.

`mcp_server.js` transport change:
- Replace `readline.createInterface` + stdout write with `StreamableHTTPServerTransport` on `127.0.0.1:5179`.
- On server ready, call `startConductor(db)`.
- Workers connect to `127.0.0.1:5179` via `type: streamable_http` in their precrime extension config.

Worker config: workers are given a stripped Goose config with `type: streamable_http` pointed at `127.0.0.1:5179`. They receive their Task ID via env var. They call `claim_task` then `complete_task`. They do NOT call `plan_tasks`, `rescore`, or `judge_affected`.

**Patterns to follow:** `pipelineClaimTask()` atomic claim. `pipelineCompleteTask()` finalize. MCP SDK `StreamableHTTPServerTransport` docs.

**Test scenarios:**
- Server starts, HTTP endpoint responds to MCP initialize at `127.0.0.1:5179`.
- Conductor loop fires, finds a ready Task, spawns a worker, worker claims and completes the Task — Task reaches `done`.
- Worker exits non-zero: Task transitions to `failed`, conductor does not retry, loop continues with next Task.
- Two ready Tasks: conductor spawns two workers concurrently (up to concurrency ceiling).
- Worker calls `plan_tasks` or `rescore`: rejected (workers must not call planner tools — enforce via a worker-mode flag or by not exposing those tools on the worker endpoint).
- Stdio transport is gone: attempting to connect a stdio Goose process returns an error.

---

### U7. Update launcher and docker config

**Goal:** `precrime.bat` and docker entrypoint start `mcp_server.js` in HTTP mode first; Goose user-session connects via `streamable_http`.

**Requirements:** T1-6

**Dependencies:** U6

**Files:**
- `precrime.bat` (or equivalent launcher)
- `docker/` — Dockerfile / entrypoint if present
- `mcp_server_config.json` — worker config template (add `type: streamable_http`)
- `DOCS/STARTUP.md` — update process tree diagram

**Approach:**
- `precrime.bat`: `node server/mcp/mcp_server.js` (no Goose invocation — the conductor spawns workers).
- The human-facing Goose session also connects via `type: streamable_http` to `127.0.0.1:5179` (same server, same tools, no separate process).
- Update `STARTUP.md` section 2 to reflect new process tree.

**Test scenarios:**
- Running `precrime.bat` starts `mcp_server.js` and the HTTP server binds on 5179.
- A Goose session configured with `type: streamable_http` connects and lists tools.
- `STARTUP.md` process tree matches actual process model.

---

### U8. Thread 3 — Config reconciliation

**Goal:** Confirm `deploy.js` overwrite behavior. Merge `precrime_config.json` drift. Redeploy to `TDS/precrime`.

**Requirements:** T3-1

**Dependencies:** U6, U7 (build must be clean before deploy)

**Files:**
- `deploy.js` — read for overwrite vs. preserve behavior
- `C:\Users\Scott\Desktop\WKG\TDS\precrime\precrime_config.json` — merge target

**Approach:**
- Read `deploy.js`. Confirm whether it overwrites `precrime_config.json` and `DOCS/SCORING.json` or preserves them.
- If overwrite: manually merge the live keys (openrouter/tavily API keys) from the TDS copy before running deploy.
- If preserve: run deploy directly; old config retains its live keys.
- After deploy, run the full pipeline from scratch. Old data discarded and rebuilt.
- Add `DRAFT_OUTREACH` to `tasks.limits` and `tasks.sessionBudgets` in the TDS config if deploy does not overwrite it.
- Add `tasks.workflowStrategy` block to TDS config if not already present.

**Test scenarios:**
- `deploy.js` read confirms overwrite vs. preserve behavior.
- After deploy, `TDS/precrime/precrime_config.json` contains live API keys + all required config blocks.
- Pipeline runs from scratch and produces bookings without crashing.

---

## Scope Boundaries

### Deferred to Follow-Up Work
- Staggered spawn ignition (tabled in REDESIGN — not a problem hit yet).
- Claim-lease / TTL reaper (rejected as over-engineering in REDESIGN).
- Transactional outbox (rejected in REDESIGN).
- Epoch/generation fencing (rejected in REDESIGN).
- Any new enrichment sources or factlet types.

### Outside This Plan
- Leedz API changes.
- New client-facing UI.
- Changes to the Goose skill markdown (skills decide how to call the MCP tools, not this plan).

---

## Build Order

1. **U1 → U2 → U3 → U4** (Thread 2 completion — business-critical, no Thread 1 dependency)
2. **U5** (module split — pre-condition for clean conductor)
3. **U6 → U7** (Thread 1 — parallelism)
4. **U8** (Thread 3 — deploy)

U1-U4 can land as working code before U5-U7 are started. That gives the evidence model fix sooner.

---

## Open Questions

- **OQ-1 (blocking U8):** Does `deploy.js` overwrite or preserve `precrime_config.json` and `DOCS/SCORING.json`? Read the file before running deploy.
- **OQ-2 (design decision, U3):** What are the `etDefaultByTrade` values? E.g., wedding = 4h, corporate = 2h, concert = 3h. Needs a value per trade type in config or `POLICY.md`.
- **OQ-3 (design decision, U6):** What is the conductor concurrency ceiling (max simultaneous workers)? Suggest: read from `precrime_config.json` as `conductor.maxWorkers`, default 3.
- **OQ-4 (design decision, U6):** What is the worker path / Goose binary path on the target machine? Must be hard path or resolvable in PATH.

End.
