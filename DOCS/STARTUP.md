# PRECRIME — Cold-Start Handoff for a New Coding Agent

> NEWEST AUTHORITY: read `C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\START_HERE.md`
> FIRST. It carries the 2026-06-07 redesign and supersedes parts of this file
> (the supervisor specifics in section 2 and the "demand never stored" rule in
> section 1). This file remains the architecture-in-place reference.

You have zero prior knowledge of this project. This file is everything you need to
resume work safely. Read it top to bottom before touching code.

Last updated: 2026-06-02. Author: prior coding agent, after a long architecture
session that settled the parallel-worker plan. The conclusions live in
`DOCS/STATUS.md`. Read this file first, then `STATUS.md`, then
`WHAT_I_LEARNED.md`. The previous version of this file is preserved at
`DOCS/STARTUP.legacy.md`.

---

## 0. The hard rules (read first, never violate)

1. **Source of truth is the PRECRIME root, never a deployed vertical.**
   ```
   C:\Users\Admin\Desktop\WKG\PRECRIME
   ```
   Deployed copies exist under `C:\Users\Admin\Desktop\WKG\VERTICALS\...`,
   `C:\Users\Admin\Desktop\WKG\TDS\...`, and others. They are generated from
   `templates/` + source by `build.bat` / `deploy.js`.
   **Edit the source. Never hand-edit a vertical as the canonical fix.**

2. **Never destroy working markdown or code.** Adapt by adding/branching. If you
   must replace a working skill/doc, keep a `.legacy.md` backup (sibling,
   `_archive/`, or `TMP/_archive__X.legacy.md` — the smoke tests accept all
   three locations). This file's prior version is at `DOCS/STARTUP.legacy.md`.

3. **No em dashes in prose. No recap/summary blocks at the end of responses.**
   Use full absolute paths in agent-facing markdown. The user picks the LLM
   model deliberately. Never propose a model swap as a fix. Never propose an
   orchestrator swap as a fix unless the swap is genuinely justified by
   evidence (see `DOCS/STATUS.md` section 1).

4. **Simplify, no redundancy.** One source of truth per concern. Read it
   directly. Do not seed, sync, or copy between stores.

---

## 1. What PRECRIME is

A lead-discovery and enrichment system. It finds people likely to buy a
deployment's VALUE_PROP, enriches them, and produces either **marketplace leeds**
(posted to the Leedz marketplace) or **outreach email drafts**.

The soul of the product is **demand-signal detection**: predicting when a
buyer's "hair is about to catch fire" so outreach lands at the moment of need.
Cold outreach without a demand signal does not convert. Read
`DOCS/FOUNDATION.md` for the parable and `DOCS/SCORING.json` for the gate
policy. Demand signal is NEVER stored on a row; it is recomputed at
scoring/enrichment time.

The mental model is a funnel, not a throughput queue:
```
Evidence  ->  Judgment  ->  Action
```
Only when the funnel is empty does the system gather more evidence.

---

## 2. Architecture: Planner / Worker / Judge / Presenter, with a Supervisor

Wilson Lin's "scaling agents" roles, enforced procedurally:

- **Planner** — procedural code in `mcp_server.js`, action `plan_tasks`. Decides
  what Tasks to create. Owns workflow order. The LLM does NOT decide global
  order.
- **Claimer** — `mcp_server.js`, action `claim_task`. Atomically flips one
  `ready` Task to `claimed` and returns it. Default priority order is the
  business loop.
- **Worker** — one-Task LLM skills: `apply-factlet.md`, `enrichment-agent.md`,
  `url-loop.md`, `outreach-drafter.md`. Each claims one Task, does it,
  completes it, exits.
- **Judge** — procedural scoring, action `judge_affected`. The ONLY thing that
  promotes `Booking.status`. Workers must use `pipeline.save({ judge:false })`
  and never score.
- **Presenter** — `show-hot-leedz.md` (interactive) or the `share_booking` /
  `DRAFT_OUTREACH` action paths (headless).
- **Session** — audit container only. It must NOT decide workflow.
- **Supervisor** (the design conclusion from 2026-06-02, not yet implemented) —
  lives inside the same Node process as `mcp_server.js`. Spawns N Goose worker
  child processes via `child_process.spawn`, watches PIDs, restarts on crash,
  timeouts hung workers. See `DOCS/STATUS.md` section 2 for the full layered
  diagram. **This replaces the current Goose-as-serial-executor heartbeat
  inside `init-wizard.md` and `headless_flow.md`.**

### Current heartbeat (about to be replaced)

There is no timer inside `mcp_server.js` today. The "heartbeat" currently lives
in the orchestrator skills (interactive: `templates/skills/init-wizard.md`;
headless: `templates/skills/headless_flow.md`). The skills loop
`claim_task -> dispatch by task.type -> complete_task` serially under a single
Goose process. This is the architecture the supervisor design replaces.

### Target heartbeat (post-supervisor)

A Node supervisor inside `mcp_server.js` calls `plan_tasks` itself, then spawns
N Goose workers per type concurrently (`Promise.all` over
`child_process.spawn`). Each worker is one-shot: claim one Task, do it, exit.
Goose is demoted from "the loop" to "the brain inside one worker." Skills get
pared down to single-job, single-life prompts. See
`DOCS/STATUS.md` section 2 for the layered diagram and section 3 for the
concrete code changes required.

---

## 3. Task types and the dispatch table

```
DISCOVER_SOURCES   -> supervisor inline (bounded search + add_sources), then complete_task
SCRAPE_SOURCE      -> templates/skills/url-loop.md
ENRICH_CLIENT      -> templates/skills/enrichment-agent.md
APPLY_FACTLET      -> templates/skills/apply-factlet.md
JUDGE_AFFECTED     -> supervisor inline (pipeline.judge_affected), then complete_task
SHOW_HOT_LEEDZ     -> templates/skills/show-hot-leedz.md (interactive only; cancelled in headless)
SHARE_BOOKING      -> supervisor inline (pipeline.share_booking), then complete_task
DRAFT_OUTREACH     -> templates/skills/outreach-drafter.md
```

Do NOT introduce new Task types unless the user explicitly asks.

---

## 4. The control law (the stage-gated Planner)

The spec is `DOCS/WHAT_I_LEARNED.md`. `plan_tasks` is **strictly stage-gated**.
This is the current behavior and stays unchanged under the new supervisor
design.

### 4a. Claim priority (`TASK_CLAIM_PRIORITY` in mcp_server.js)
```
JUDGE_AFFECTED
SHOW_HOT_LEEDZ
SHARE_BOOKING
DRAFT_OUTREACH
APPLY_FACTLET
ENRICH_CLIENT
SCRAPE_SOURCE
DISCOVER_SOURCES
```

### 4b. Stage-gated planner (`pipelinePlanTasks`)

Six rules. Higher stage that creates OR already has open work suppresses ALL
lower stages for that single `plan_tasks` call. Spelled out in plain English in
`DOCS/WHAT_I_LEARNED.md` and implemented at
`server/mcp/mcp_server.js:3844-4345` (function `pipelinePlanTasks`).

1. **hot_only mode** — only `SHOW_HOT_LEEDZ` when hot items exist. Returns early.
2. **Stage 2 JUDGE_AFFECTED** — for done worker Tasks whose output carries
   affected ids but no `judgedAt`. Suppress every lower stage if any open.
3. **Stage 3 Hot Interrupt** — if hot future unshared Bookings exist:
   interactive `workflow` -> `SHOW_HOT_LEEDZ`; headless marketplace/hybrid ->
   `SHARE_BOOKING` for `leed_ready`; headless outreach/hybrid ->
   `DRAFT_OUTREACH` for qualified Clients. Suppress apply/enrich/scrape/discover.
4. **Stage 4 APPLY_FACTLET** — consume unprocessed live Factlets. Suppress
   enrich/scrape/discover if any open.
5. **Stage 5 ENRICH_CLIENT** — stale/thin Clients. Suppress scrape/discover.
6. **Stage 6 SCRAPE_SOURCE** — claimable Sources. Suppress discover.
7. **Stage 7 DISCOVER_SOURCES** — last; only when funnel is empty.

### 4c. Done / processed semantics (NO new DB fields)
- Factlet processed = a terminal `APPLY_FACTLET` Task exists for that Factlet
  id. Recycler must retain terminal APPLY_FACTLET Tasks long enough that live
  Factlets cannot be reprocessed.
- Worker output judged = `complete_task` stamps `judgedAt` + `judgedByTaskId`
  onto the source worker Task after `JUDGE_AFFECTED`.
- Booking shared = `shared=true`, `sharedAt` set, `status="shared"`.

### 4d. Mode vs Objective (two orthogonal axes)
- **Run mode**: `interactive` (user present) | `headless` (autonomous).
- **Planner mode** (arg to plan_tasks): `hot_only` | `workflow` | `headless`.
- **Objective**: `marketplace` | `outreach` | `hybrid`.
  - Defaults: interactive -> `hybrid`; headless -> `marketplace`.
  - `SHARE_BOOKING` legal only for marketplace/hybrid. `DRAFT_OUTREACH` legal
    only for outreach/hybrid.
  - Headless outreach/hybrid requires the Gmail MCP; fail fast with
    `OUTREACH_REQUIRES_GMAIL` if missing.

### 4e. Marketplace safety
- Direct Leedz posting is forbidden outside `share_booking`. Skills must not
  call `leedz__createLeed`.
- LLM may draft only prose fields `titleDraft`, `dtDraft`, `rqDraft`. Server
  owns hard fields `cn, em, ph, lc, zp, st, et, tn, pr, sh`. `share_booking`
  rejects caller-supplied `st`, `et`, `timezone`.

---

## 5. Orchestrator / runtime decisions (2026-06-02)

Detail in `DOCS/STATUS.md` section 1. Summary:

- **Stay on Goose** as the worker brain. Goose is actively maintained at AAIF
  (post-Dec 2025 donation). OpenRouter native, MCP native, skill markdown
  ports verbatim. The X silence the user observed is corporate-OSS thinness,
  not code abandonment. Pin a known-good version (currently v1.36.0). Avoid
  v1.25 (instruction regression).
- **Codex CLI is the swap-in backup**. Same supervisor design works against
  `codex exec`. Flip in config if Goose bites hard.
- **Do NOT adopt** Claude Code (Anthropic-locked in practice, breaks OpenRouter
  routing for non-Anthropic models), DeepAgents (no native parallel skill
  primitive, would need Python-rewriting `mcp_server.js` for the "in-proc
  shared MCP" idea), LangGraph (cleanest framework option but adds Python and
  takes ownership of scheduling away from `mcp_server.js`), CrewAI, or
  AutoGen (in maintenance mode).
- **Parallelism is architectural, not orchestrator-native.** The supervisor IS
  the orchestrator. The agent runtime is the worker brain.

---

## 6. Target deployment shape

Single Docker image. Single EC2 box. `tini -g` PID 1. supervisord manages two
long-lived processes (`mcp_server.js` is the main one). N Goose workers spawned
by Node via `child_process.spawn`. EBS gp3 mount for SQLite at `/app/data`.
HTTP MCP on 127.0.0.1:5179, closed to the world. SSH from user IP only.

EC2: **t4g.large** (ARM, 2 vCPU, 8 GB, ~$49/mo) if Goose ships arm64; t3.large
(~$63/mo) as the safe x86 default. Workers are I/O-bound on OpenRouter HTTP,
so burstable CPU credits are a feature.

No RDS, no Fargate, no ECS, no Lambda, no Step Functions, no EventBridge. The
architecture IS cloud-shaped so migration is graceful when needed; do not
pre-build for that scale.

---

## 7. Key files

### Code (source of truth)
```
C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js   <- the heart. ONLY mcp_server.js in PRECRIME.
                                                                  HTTP transport + supervisor section to be added.
C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_gmail.js    <- gmail send via Chrome OAuth
C:\Users\Admin\Desktop\WKG\PRECRIME\server\prisma\schema.prisma
C:\Users\Admin\Desktop\WKG\PRECRIME\server\sync-config.js      <- mirrors VALUE_PROP.md -> Config at launch
C:\Users\Admin\Desktop\WKG\PRECRIME\rss\rss-scorer-mcp\index.js<- RSS scorer MCP
```

Important anchors inside `mcp_server.js`:
- `TASK_CLAIM_PRIORITY` (line ~3664) — claim order array
- `pipelinePlanTasks` (line ~3844) — the stage-gated planner
- `pipelineClaimTask`, `pipelineCompleteTask`
- `pipelineJudgeAffected`, `pipelineShareBooking`
- `normalizeObjective`, `getActiveSessionObjective`
- `computeWorkflowIntakeState`, `getTerminalAppliedFactletIds`
- `computeBookingTargetScore`, `detectDemandSignal`

### Config
```
C:\Users\Admin\Desktop\WKG\PRECRIME\precrime_config.json          <- runtime knobs
C:\Users\Admin\Desktop\WKG\PRECRIME\precrime_config.sample.json
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\SCORING.json             <- canonical scoring policy
```

`tasks` block current values (concurrency caps and per-session budgets) live in
`precrime_config.json`. A `workers` block must be added to land the supervisor
design (see `DOCS/STATUS.md` section 3 item 4).

### Docs (read in this order)
```
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\STARTUP.md       <- you are here
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\STATUS.md        <- current architectural conclusions (2026-06-02)
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\WHAT_I_LEARNED.md <- parallel-worker mandate, control-loop spec
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\FOUNDATION.md    <- the soul: parable, demand signal
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\Claude.md        <- the user's hard rules. Obey them.
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\FUCKUPS.md       <- failure-mode log
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\STARTUP.legacy.md <- pre-supervisor version of this file
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\WHAT_I_LEARNED.legacy.md <- original redesign spec
```

### Skills (active, ship into deployments)
```
templates/skills/init-wizard.md        startup + router. Heartbeat loop to be REMOVED.
templates/skills/headless_flow.md      headless orchestrator. Heartbeat loop to be REMOVED.
templates/skills/url-loop.md           SCRAPE_SOURCE worker
templates/skills/enrichment-agent.md   ENRICH_CLIENT worker
templates/skills/apply-factlet.md      APPLY_FACTLET worker
templates/skills/show-hot-leedz.md     SHOW_HOT_LEEDZ presenter
templates/skills/outreach-drafter.md   DRAFT_OUTREACH worker
templates/skills/share-skill.md        marketplace share helper
templates/skills/client-finder.md      contact/email finder
templates/skills/shared/               classify-contact.md, booking-detect.md, factlet-rules.md
```

Under the supervisor design, every worker skill becomes single-job-single-life:
no claim loop, no replan, exit after one Task.

### Build + deploy
```
build.bat        runs deploy.js, copies launchers (FATAL if missing), zips to dist/
deploy.js        token substitution + allowlist file copy templates/ -> deployment dir
templates/setup.bat       npm install + prisma generate (idempotent)
templates/precrime.bat    Claude Code launcher
templates/goose.bat       Goose launcher
templates/hermes.bat      Docker/Hermes launcher
scripts/audit_build_zip.js  post-build verification of the deploy zip
```

Launchers parse `--headless`/`--interactive` (mode) and `--marketplace`/
`--outreach`/`--hybrid` (objective), set `PRECRIME_OBJECTIVE`, and apply
defaults. **All `.bat` files MUST use CRLF line endings.**

---

## 8. Data model (Prisma SQLite)

Models: `Client`, `Booking`, `Factlet`, `Session`, `SessionEvent`, `Source`,
`Task`, `Config`.

- `Booking.status` is a plain String:
  `brewing | outreach_ready | leed_ready | shared | taken | expired`. Set only
  by `computeBookingTargetScore`; `share_booking` owns the operational `shared`
  flip.
- `Task`: `type`, `status (ready|claimed|done|failed|cancelled)`, `sessionId?`,
  `targetType?`, `targetId?`, `input?` (JSON), `output?` (JSON with affected
  ids), timestamps.
- No DB field was added for the control-loop work or the supervisor design.
  Worker-judged and Factlet-processed state are derived from terminal Tasks /
  output stamps.

---

## 9. MCP pipeline actions (the tool surface)

All invoked as `precrime__pipeline({ action: "...", ... })` (plus
`precrime__find`, `precrime__trades`). Actions in the switch:
```
status, initialize, start_session, configure, get_config
plan_tasks, claim_task, complete_task, tasks, work_status
judge_affected, rescore, resolve_dates
save, delete, find, present, matches, next
clients, bookings, factlets, drafts, trades
add_sources, import_sources, next_source, mark_source
share_booking, recycler, audit_session, report_session
```

Transport today: stdio. Target after supervisor refactor: HTTP via MCP SDK's
`StreamableHTTPServerTransport` listening on `http://127.0.0.1:5179/mcp`.
Workers (Goose child processes) connect as HTTP MCP clients over loopback.

---

## 10. How to verify your changes (no build needed)

The full smoke test can fail at Prisma `db push` with a schema-engine error
before assertions run on some machines. On a working environment the suite
runs. Always do the cheap checks first:

```
node --check C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js
node --check C:\Users\Admin\Desktop\WKG\PRECRIME\scripts\smoke_test_tasks.js
node --check C:\Users\Admin\Desktop\WKG\PRECRIME\scripts\audit_build_zip.js
```
Then the full smoke test (from the PRECRIME root):
```
cd C:\Users\Admin\Desktop\WKG\PRECRIME
node scripts\smoke_test_tasks.js
```
Last known status: **473 passed, 0 failed** (pre-supervisor work).

---

## 11. Source vs deployed copies (so you do not edit the wrong file)

`mcp_server.js` exists once in PRECRIME (source) and in each deployed/snapshot
vertical:

```
SOURCE (edit this):
  C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js

DEPLOYED COPIES (do NOT edit as the fix; regenerated by build):
  C:\Users\Admin\Desktop\WKG\VERTICALS\PB_DALLAS\precrime\...
  C:\Users\Admin\Desktop\WKG\TDS\precrime\...
  (plus dated snapshots; ignore all directories with date suffixes)
```

The supervisor design lives ONLY in source. `build.bat` propagates to verticals.

---

## 12. Git state at this handoff

Branch: `master`. Working tree has uncommitted modifications from the prior
control-loop session. No code changes were made in this 2026-06-02
architecture session; only documentation (`DOCS/STATUS.md`, this file, and a
`DOCS/STARTUP.legacy.md` backup). Run `git status` and `git diff` before
committing. Do NOT commit unless the user asks. Do NOT force-push, do NOT
amend, do NOT skip hooks.

---

## 13. Open items / watch-outs

- Goose arm64 build verification before EC2 launch (15 min check).
- SQLITE_BUSY counter behavior at 25 concurrent workers under HTTP MCP is
  unverified; ship and watch.
- OpenRouter opening-burst 429 risk mitigated by 100ms spawn stagger; verify
  in load test.
- LLM demand-signal fallback exists but is largely untested in production.
- The Goose orchestrator path (`goose.bat`) ships but has been exercised less
  than the Claude Code path (`precrime.bat`).
- The full smoke test failing at Prisma `db push` on some machines is an
  environment issue, not a code issue.

---

## 14. Where to start reading, in order

1. `DOCS/STARTUP.md` (this file).
2. `DOCS/STATUS.md` — 2026-06-02 architectural conclusions (orchestrator
   choice, supervisor design).
3. `DOCS/WHAT_I_LEARNED.md` — the parallel-worker mandate.
4. `DOCS/FOUNDATION.md` — what PRECRIME sells and why demand signal matters.
5. `DOCS/SCORING.json` — the gate policy.
6. `server/mcp/mcp_server.js` — `pipelinePlanTasks`, `computeBookingTargetScore`,
   `detectDemandSignal`, `pipelineSave`, `pipelineShareBooking`.
7. `templates/skills/init-wizard.md` and `headless_flow.md` — the heartbeat
   that is about to be removed.
8. `scripts/smoke_test_tasks.js` — executable spec of expected behavior.

End.
