---
title: "feat: procedural conductor + one-shot workers (Thread 1)"
date: 2026-06-16
status: active
origin: DOCS/REDESIGN_2026-06-07.md Thread 1
target_repo: C:\Users\Scott\Desktop\WKG\PRECRIME
---

# feat: procedural conductor + one-shot workers (Thread 1)

**Target repo:** `C:\Users\Scott\Desktop\WKG\PRECRIME`
**Authority:** `DOCS/REDESIGN_2026-06-07.md` + `DOCS/STATUS.md` §2 + `DOCS/solutions/architecture-patterns/worker-task-one-target-one-call.md`

---

## Problem Frame

`mcp_server.js` is stdio JSON-RPC. One Goose (or Claude) session is both the
orchestrator and the executor, running Tasks serially inside a single context
window. Every worker result flows back into the orchestrator context; the
window bloats, the session stalls, and the system produces no results.

The fix is architectural: a procedural Node.js conductor loop lives inside
`mcp_server.js` and spawns one-shot workers (Goose or Claude) via
`child_process.spawn`. Workers connect to the MCP server over HTTP. The
conductor never reads worker LLM output — it only watches `task.status`
transition in the DB. Worker context stays isolated per process and dies on
exit. Context cannot accumulate.

---

## Key Technical Decisions

**KTD-1: The conductor is Node.js — no LLM.**
Putting an LLM in the orchestrator role recreates the context-bloat problem
one layer up. The conductor is a `while(true)` poll loop: query ready Tasks →
claim atomically → spawn process → watch exit code → fail-and-forget on
non-zero. Zero LLM tokens in the conductor path.

**KTD-2: HTTP transport, one server, N workers.**
Stdio MCP is 1:1 — each Goose worker would spawn its own `mcp_server.js`
child, meaning N SQLite handles, N cold-start penalties, N conflicting writers.
`StreamableHTTPServerTransport` on `127.0.0.1:5179` makes it 1:N: one server,
all workers connect over loopback. Prisma stays the only writer.

**KTD-3: Works identically for Goose workers and Claude workers.**
Both support `type: streamable_http` MCP connections. The worker's spawn
command and config file differ; the MCP protocol and skill markdown are
identical. The conductor can spawn either. Default is Goose
(`goose run --instructions <skill>.md --no-session --quiet --max-turns 6`).
Claude workers use `claude -p --mcp-config worker-mcp.json --system-prompt
<skill>.md`. Swap is a config change, not a code change.

**KTD-4: Task ID delivered via env var.**
`PRECRIME_TASK_ID` is set before spawn. The worker reads it at Step 1,
calls `claim_task` with that ID (confirming its assignment), does the work,
calls `complete_task`, and exits. Workers never call `plan_tasks`, `rescore`,
or `judge_affected`.

**KTD-5: Fail-and-forget — no reaper, no retry.**
A failed Task is garbage-collected. The factlet/source/client signal that
caused the planner to create it remains, so a future `plan_tasks` re-covers
the ground. No claim-lease, no TTL reaper, no restart counter in the
conductor. Hung workers: the conductor kills the process after
`workers.hungWorkerKillMs` (default 25s) and calls `failTask`.

**KTD-6: Module split before transport swap.**
`mcp_server.js` is 4938 lines doing three jobs. Cut it before adding the
conductor so the conductor can import `db.js` rather than calling functions
buried in a 5K-line file. Split: `db.js` (all Prisma CRUD) → `conductor.js`
(spawn + regroup loop) → `mcp_server.js` (transport + tool routing, shrunken).

**KTD-7: `headless_flow.md` heartbeat loop is retired.**
The conductor replaces Steps 2-3 of `headless_flow.md` (the claim/dispatch/
complete drain loop and the replan loop). The human-facing Goose session or
Claude session still calls `plan_tasks` to seed the queue (Step 1) and
`report_session` at the end (Step 4), but the execution loop is owned by the
conductor. Skills that were handed tasks by `headless_flow.md` now receive
them from the conductor via `PRECRIME_TASK_ID`.

---

## Process Tree (target state)

```
precrime.bat
  └── node mcp_server.js          HTTP MCP @ 127.0.0.1:5179
        │                          + conductor + Planner + Judge + sole SQLite writer
        ├── goose run apply-factlet.md   precrime ext = streamable_http → :5179
        ├── goose run enrich-client.md   one Task each, exit on complete_task
        ├── goose run url-loop.md        ...
        └── (or: claude -p ...)          same streamable_http, same skill markdown
```

Human Goose/Claude session also connects as `streamable_http` to `:5179`. It
calls `plan_tasks` to seed the queue and `report_session` at the end. It does
not drive the dispatch loop — the conductor does.

---

## Implementation Units

### U1. Map mcp_server.js module boundaries (READ-ONLY, no code change)

**Goal:** Produce a definitive cut map before touching a line. The module
split in U2 must be surgical; an incorrect cut leaves dangling references.

**Requirements:** KTD-6

**Dependencies:** None

**Files:** `server/mcp/mcp_server.js` (read only)

**Approach:** Read the file fully. Identify every function that:
- Does a `prisma.*` call → belongs in `db.js`
- Manages the HTTP transport or routes tool calls → stays in `mcp_server.js`
- Manages Planner / Judge logic (plan_tasks, judge_affected, classify) → stays
  in `mcp_server.js` (these call db.js functions)
- Will move to `conductor.js` (spawn, poll, kill)

Produce an annotated function list: name, line range, destination module.
Known candidates for `db.js`: `candidateClientIdsForFactlet`, `getTerminalAppliedFactletIds`,
`computeWorkflowIntakeState`, `findLiveFactletsForClient`, `computeClientScore`,
`pipelineClaimTask`, `pipelineCompleteTask`, and all `prisma.*` call sites.

**Test scenarios:** None — this unit produces documentation, not code.

**Verification:** Every `prisma.*` call in the file is attributed to a
destination module with no conflicts.

---

### U2. Extract db.js

**Goal:** All Prisma CRUD lives in `server/mcp/db.js`. `mcp_server.js` imports
named exports; no behavior changes.

**Requirements:** KTD-6

**Dependencies:** U1 (cut map complete)

**Files:**
- `server/mcp/db.js` — new file
- `server/mcp/mcp_server.js` — remove extracted functions, add `require('./db')`

**Approach:**
- One `new PrismaClient()` instance in `db.js`, exported as `prisma` and used
  internally. `mcp_server.js` does not instantiate Prisma.
- Extract in dependency order — leaf helpers first (e.g., `findLiveFactletsForClient`),
  then callers (`computeClientScore`, then `computeBookingTargetScore`).
- `db.js` has zero MCP/HTTP/transport imports. It imports Prisma and nothing else.
- After extraction: `grep "new PrismaClient" server/mcp/mcp_server.js` returns zero hits.

**Patterns to follow:** `value_prop.js` and `classification.js` — pure named
exports, no side effects at module load.

**Test scenarios:**
- All existing MCP tool calls (pipeline, find, trades) return identical results
  before and after the split.
- `new PrismaClient` appears exactly once in the codebase (in `db.js`).
- `db.js` has no `readline`, `http`, or MCP SDK imports.

**Verification:** `node server/mcp/mcp_server.js` starts cleanly. A `pipeline.status`
call returns the same response as before.

---

### U3. Swap transport to HTTP

**Goal:** `mcp_server.js` listens on `127.0.0.1:5179` via
`StreamableHTTPServerTransport`. The raw `readline/process.stdin` loop is
removed. A `--stdio` CLI flag preserves the old transport for unit tests.

**Requirements:** KTD-2

**Dependencies:** U2

**Files:**
- `server/mcp/mcp_server.js` — transport section at `startMcpServer()` (~line 5340)
- `package.json` — confirm `@modelcontextprotocol/sdk` is already a dependency

**Approach:**
Current transport (lines 5352–5367):
```js
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', async (line) => { ... });
```
Replace with:
```js
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const http = require('http');
const transport = new StreamableHTTPServerTransport({ sessionIdHeader: 'mcp-session-id' });
const server = http.createServer((req, res) => transport.handleRequest(req, res));
server.listen(5179, '127.0.0.1', () => {
    console.error('[MCP] Listening on http://127.0.0.1:5179/mcp');
    startConductor(db, PRECRIME_CONFIG);  // U4 — call conductor after transport is up
});
```
`--stdio` flag: `if (process.argv.includes('--stdio')) { /* old readline path */ }` so
`classification.test.js` and `value_prop.test.js` can still boot the server.

**Patterns to follow:** MCP SDK `StreamableHTTPServerTransport` docs. Existing
`handleInitialize`, `handleToolsList`, `handleCallTool` routing — these do not
change, they just receive requests from the transport instead of from readline.

**Test scenarios:**
- `node server/mcp/mcp_server.js` starts; `curl http://127.0.0.1:5179/mcp` returns
  a valid MCP initialize response.
- A Goose session configured with `type: streamable_http, url: http://127.0.0.1:5179/mcp`
  connects and lists three tools (`pipeline`, `find`, `trades`).
- `node server/mcp/mcp_server.js --stdio` starts without binding the HTTP port
  (existing test harness passes).
- Two simultaneous MCP clients connect without interference.

**Verification:** Human Goose session connects and `pipeline.status` responds.

---

### U4. Write conductor.js

**Goal:** The procedural Node.js conductor loop: poll ready Tasks → claim
atomically → spawn one-shot Goose worker → kill hung workers → fail-and-forget.

**Requirements:** KTD-1, KTD-3, KTD-4, KTD-5

**Dependencies:** U2 (db.js exports `claimTask`, `failTask`, `getReadyTasks`),
U3 (HTTP transport is up before conductor starts)

**Files:**
- `server/mcp/conductor.js` — new file
- `server/mcp/mcp_server.js` — add `startConductor` call after HTTP listen

**Approach:**

```js
// conductor.js — illustrative shape, not implementation spec
const { spawn } = require('child_process');
const path = require('path');

function skillPath(taskType) {
    const MAP = {
        APPLY_FACTLET:    'apply-factlet.md',
        ENRICH_CLIENT:    'enrichment-agent.md',
        SCRAPE_SOURCE:    'url-loop.md',
        FIND_CLIENT_SOURCES: 'find-client-sources.md',
        DRAFT_OUTREACH:   'outreach-drafter.md',
        SHARE_BOOKING:    null,   // server-side only, no worker skill
        JUDGE_AFFECTED:   null,   // server-side only
        SHOW_HOT_LEEDZ:   null,   // server-side only
    };
    const name = MAP[taskType];
    return name ? path.resolve(SKILLS_ROOT, name) : null;
}

async function conductorLoop(db, config) {
    const { pollMs, spawnStaggerMs, hungWorkerKillMs, maxWorkers } = config.workers;
    const active = new Map();  // taskId → { proc, timer, spawnedAt }

    while (true) {
        // Spawn up to (maxWorkers - active.size) new workers
        if (active.size < maxWorkers) {
            const slots = maxWorkers - active.size;
            const ready = await db.getReadyTasksWithSkill(slots);  // only types with a skill file
            for (const task of ready) {
                const skill = skillPath(task.type);
                if (!skill) continue;
                const claimed = await db.claimTask(task.id, `conductor-${Date.now()}`);
                if (!claimed) continue;   // lost the race — skip

                await sleep(spawnStaggerMs);  // smooth OpenRouter burst

                const proc = spawn('goose', [
                    'run', '--instructions', skill,
                    '--no-session', '--quiet', '--max-turns', '6'
                ], {
                    env: { ...process.env, PRECRIME_TASK_ID: task.id }
                });

                const killTimer = setTimeout(() => {
                    proc.kill();
                    db.failTask(task.id, 'hung_worker_timeout');
                    active.delete(task.id);
                }, hungWorkerKillMs);

                proc.on('exit', (code) => {
                    clearTimeout(killTimer);
                    if (code !== 0) db.failTask(task.id, `exit_code_${code}`);
                    // SUCCESS: worker already called complete_task via MCP — nothing to read here
                    active.delete(task.id);
                });

                active.set(task.id, { proc, timer: killTimer });
            }
        }
        await sleep(pollMs);
    }
}

exports.startConductor = (db, config) => {
    conductorLoop(db, config).catch(e => console.error('[conductor] fatal:', e));
};
```

`SHARE_BOOKING`, `JUDGE_AFFECTED`, `SHOW_HOT_LEEDZ` have no worker skill — the
server handles them in-process via `pipelineShareBooking`, `pipelineJudgeAffected`,
`pipelineShowHotLeedz`. The conductor skips Tasks of those types
(`getReadyTasksWithSkill` filters to types with a skill path).
Those types continue to be dispatched inline when the human session calls
`plan_tasks` and then handles the result — or we add a second conductor loop
for in-process tasks. Decide at build time.

**Patterns to follow:** `pipelineClaimTask` atomic claim pattern (optimistic
WHERE clause). `child_process.spawn` Node.js stdlib.

**Test scenarios:**
- Conductor starts; a ready `APPLY_FACTLET` Task exists; a Goose process is
  spawned within one poll cycle.
- Worker calls `complete_task` via MCP; conductor sees `active.delete`, Task is
  `done` in the DB.
- Worker exits non-zero (simulated); conductor calls `failTask`; Task is `failed`;
  no retry.
- Two concurrent Tasks: two workers run simultaneously.
- A hung worker (does not exit): killed after `hungWorkerKillMs`; `failTask` called.
- `SHARE_BOOKING` Task: conductor does NOT spawn a worker for it; Task stays
  `ready` until handled in-process.

**Verification:** A full `plan_tasks` → conductor run → `report_session` cycle
completes without the human session ever calling `claim_task`.

---

### U5. Update precrime_config.json — workers block

**Goal:** Conductor reads its tuning knobs from config, not hardcoded constants.

**Requirements:** KTD-1, KTD-5

**Dependencies:** None (config edit, can be done before or after code)

**Files:**
- `precrime_config.json` (PRECRIME source root, NOT TDS deployment)
- `server/mcp/mcp_server.js` — add `PRECRIME_CONFIG.workers` read at startup

**Approach:** Add to `precrime_config.json`:
```json
"workers": {
    "enabled": true,
    "pollMs": 1500,
    "spawnStaggerMs": 100,
    "hungWorkerKillMs": 25000,
    "maxWorkers": 10,
    "gooseBin": "goose",
    "gooseArgs": ["--no-session", "--quiet", "--max-turns", "6"],
    "skillsRoot": "templates/skills"
}
```
`RUNTIME_CONFIG` (built in `buildRuntimeConfig`) adds a `workers` field that
reads from `pcfg.workers` with safe defaults so the server still boots if
the key is missing.

**Test scenarios:**
- Server boots with the new block present; `RUNTIME_CONFIG.workers.pollMs === 1500`.
- Server boots with the block absent; `RUNTIME_CONFIG.workers` falls back to defaults.
- Setting `workers.enabled = false` suppresses `startConductor` call.

**Verification:** `console.error('[conductor] pollMs=1500 maxWorkers=10')` appears in server log.

---

### U6. Rewrite skills as one-task-one-life

**Goal:** Strip the heartbeat dispatch loop from `headless_flow.md` and
`init-wizard.md`. Each worker skill (APPLY_FACTLET, ENRICH_CLIENT, etc.) is
already structured as one-shot — confirm and harden. Workers receive
`PRECRIME_TASK_ID` from env; they call `claim_task` to confirm the assignment,
do the work, call `complete_task`, and stop.

**Requirements:** KTD-7

**Dependencies:** U4

**Files:**
- `templates/skills/headless_flow.md` — retire Steps 2–3 dispatch loop
- `templates/skills/init-wizard.md` — strip heartbeat, reduce to seed + plan_tasks + report
- `templates/skills/apply-factlet.md` — harden Step 3 relevance criteria (see **PAUSE** below)
- `templates/skills/enrichment-agent.md` — confirm one-shot, add env-var task receipt
- `templates/skills/url-loop.md` — same
- `templates/skills/find-client-sources.md` — same
- `templates/skills/outreach-drafter.md` — same

**headless_flow.md changes:**
Steps 2 and 3 (the claim/dispatch/complete drain loop and the replan loop) are
DELETED. The conductor owns execution. The new `headless_flow.md` has:
- Step 1: `plan_tasks` to seed the queue (unchanged)
- Step 2: WAIT — the skill exits after seeding. The conductor drives workers.
  When workers complete, the human session receives the results via the next
  `plan_tasks` / `report_session` call.
- Step 3: `report_session` (unchanged)

**init-wizard.md changes:**
The startup skill seeds sources (`import_sources`), verifies config, runs
`plan_tasks`, then exits. The wizard does NOT claim or dispatch any Task. The
conductor handles dispatch from the moment the HTTP server is up.

**Other worker skills (enrichment-agent.md, url-loop.md, find-client-sources.md,
outreach-drafter.md):**
Each already receives a Task packet from `headless_flow.md`. Adapt to receive
from env var:
```
Step 0: taskId = env.PRECRIME_TASK_ID
        Call: pipeline({ action: "claim_task", taskId })
        Confirm the Task matches expected type. If not, stop.
```
Everything else in the skill is unchanged.

---

#### APPLY_FACTLET Step 3: VALUE_PROP Relevance Criteria — LOCKED

**Decisions locked in (2026-06-17):**

**KTD-8: VALUE_PROP delivery — receive via `get_config`.**
Worker calls `get_config` at Step 0. VALUE_PROP text appears once in the worker
context window. Task input JSON stays small (`{factletId, clientId}`). No SQLite
bloat (vs. embedding: N tasks × ~600 tokens per task stored in DB). VALUE_PROP
always current at execution time — not baked at task creation and not stale if
VALUE_PROP.md is edited while tasks are queued. One extra loopback MCP round-trip
(~1ms) is the only cost.

**KTD-9: `factletMentionsValueProp()` is an LLM judgment, not a regex.**
The existing server function (token overlap) serves as a cheap hint for planning.
The authoritative relevance decision is the worker's LLM in Step 3. Lean toward
RELEVANT: factlet value is cumulative. A marginal factlet now may become the
tipping piece combined with a future factlet. False negatives cost more than
false positives.

**KTD-10: `candidateClientIdsForFactlet()` uses OR logic with two paths.**
- Path A (existing): factlet text contains any one of client name / company /
  website hostname tokens (already OR, not AND — no change to internal logic).
- Path B (new): factlet text passes a VALUE_PROP keyword signal check (trade
  tokens, relevanceSignals terms) without necessarily naming any specific client.
  When Path B fires alone (no client identity match), the factlet is general
  trade intelligence. Create tasks for the top N clients by least-recently-enriched.
  Worker's LLM then filters per client.

  This requires a server-side change to `candidateClientIdsForFactlet()`:
  union of Path A clients and Path B clients, deduplicated, capped at N.
  **Add to U2 (db.js extraction) — this function lives there after the split.**

**Locked relevance rubric for the worker (five criteria, any one fires):**

```
RELEVANT — lean toward inclusion — append/update dossier if ANY of:

A. Event/occasion signal: factlet describes an event, occasion, venue booking,
   gathering, conference, or activity where [trade] services are needed.
   Match against audienceSegments. Factlet need not name this specific client --
   industry-level event context is valid background intelligence.

B. Demand signal: factlet contains explicit or implied demand for [trade] or a
   closely related service (RFP, "looking for vendors" post, booking in progress).

C. Contact intelligence: factlet names a SPECIFIC PERSON at this client's
   organization with a role relevant to booking/authorizing [trade] services.
   Requires: person name + role + affiliation with this specific client (all three).
   A role without a name, or a person at a different org, does not qualify.

D. Geography/market confirmation: factlet places this client's activities within
   the service area (geography, serviceZips) -- confirms reachable prospect.
   Also note if the factlet reveals out-of-area activity.

E. Trade/buyer-profile intelligence: factlet reveals this client's industry,
   scale, event cadence, or org type that maps to buyerRoles or audienceSegments.
   Negative signal also counts: if client matches notBuyer, record it.

no_change ONLY if ALL of: clearly unrelated to [trade] AND no contact intel AND
no geography confirmation AND no event/occasion activity. Also no_change for:
exact duplicate of existing dossier content; name collision (different entity
with same token -- use company, website, Booking context to detect).

Do NOT exclude for: factlet does not name this client; implied vs. explicit demand;
competitor subject matter; weak/marginal signal (marginal is still inclusion).
```

**apply-factlet.md rewritten to v2.0 with this rubric. Skill is now done.**

---

### U7. Update launcher and Goose/Claude transport config

**Goal:** `precrime.bat` starts `mcp_server.js` in HTTP mode. The human Goose
session and any Claude Code session connect via `streamable_http`.

**Requirements:** KTD-2, KTD-3

**Dependencies:** U3

**Files:**
- `precrime.bat` (or equivalent launcher)
- `templates/GOOSE.md` — update precrime extension config from stdio to streamable_http
- Worker MCP config template: `server/mcp/worker-mcp.json` (new file, used when
  spawning Claude workers)
- `DOCS/STARTUP.md` — update process tree diagram

**Approach:**

`precrime.bat` (simplified):
```bat
@echo off
node C:\Users\Scott\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js
```
That's it. The conductor starts inside `mcp_server.js`. No Goose spawn in the launcher.

`templates/GOOSE.md` Goose config update:
```yaml
extensions:
  precrime:
    type: streamable_http
    url: http://127.0.0.1:5179/mcp
    timeout: 30
    retries: 0
```
Goose workers inherit this from their config. The human session also uses this.

`server/mcp/worker-mcp.json` (Claude worker config):
```json
{ "mcpServers": { "precrime": {
    "type": "streamable_http",
    "url": "http://127.0.0.1:5179/mcp"
}}}
```
Used when `config.workers.gooseBin` is overridden to `claude` for testing.

**Test scenarios:**
- Running `precrime.bat` binds `:5179` and the conductor starts.
- A Goose session started with the updated config connects; `pipeline.status` responds.
- `DOCS/STARTUP.md` process tree matches the actual running process model.
- Old stdio-style Goose launch fails fast with a clear error (not a silent hang).

**Verification:** `netstat -an | findstr 5179` shows the port bound after
`precrime.bat`. A worker Goose process appears in Task Manager during a run.

---

## Scope Boundaries

**In scope:** Transport swap, conductor loop, module split, skill heartbeat
removal, config block, launcher update.

**Out of scope:**
- Thread 2 gaps (two-label arch, stored demand verdict) — separate plan.
- Docker/EC2 deployment — Thread 3.
- Stagger spawn ignition beyond `spawnStaggerMs` — not yet a problem.
- Claim-lease / TTL reaper — rejected as over-engineering.
- `SHARE_BOOKING` / `JUDGE_AFFECTED` / `SHOW_HOT_LEEDZ` worker spawning —
  these are in-process server calls, not LLM workers. Handled by the existing
  pipeline actions.

### Deferred to Follow-Up Work
- `SHARE_BOOKING` via a standalone worker skill (only needed if the in-process
  path becomes a bottleneck — unlikely).
- Epoch/generation fencing for concurrent plan_tasks calls.
- Prometheus/metrics on conductor loop (worker spawn rate, failure rate).

---

## Build Order

U1 (map) → U2 (db.js) → U5 (config block, can run in parallel with U2) →
U3 (transport) → U4 (conductor) → U6 (skills — after PAUSE resolved) → U7 (launcher).

U6 is blocked on the PAUSE above. U7 can be written while awaiting the answer.

---

## Open Questions

- **OQ-1 (blocks U6 APPLY_FACTLET):** VALUE_PROP relevance rubric — see PAUSE
  section above. Answers needed before the APPLY_FACTLET skill rewrite.
- **OQ-2:** Does the conductor handle `SHARE_BOOKING` in-process (call
  `pipelineShareBooking` directly from the conductor loop) or leave it for the
  human session to trigger via `plan_tasks`?
- **OQ-3:** What Goose binary path/version is installed on the target machine
  and in the Docker image? `workers.gooseBin` must be an absolute path or
  confirmed in PATH.
- **OQ-4 (from plan-002):** Does `deploy.js` overwrite `precrime_config.json`?
  Must know before adding the `workers` block in U5.

End.
