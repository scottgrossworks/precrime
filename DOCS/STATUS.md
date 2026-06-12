# PRECRIME STATUS — 2026-06-02

Authored end of long architecture conversation. Records the conclusions on
orchestrator choice and the supervisor/parallel-worker design that will
follow. Read alongside `DOCS/STARTUP.md` and `DOCS/WHAT_I_LEARNED.md`.

---

## 1. Orchestrator choice — final

### 1a. Stay on Goose as the worker brain

Goose is actively maintained (daily commits, weekly releases through May 2026,
v2.0 RC in flight). In December 2025 Block donated it to the Linux Foundation's
Agentic AI Foundation (AAIF); repo is now `aaif-goose/goose`, governance is
vendor-neutral, original maintainers (`baxen`, `michaelneale`, `jh-block`) still
commit. The X silence the user observed is real but is downstream of the AAIF
donation plus Block's Feb 2026 layoffs gutting DevRel, not code abandonment.

OpenRouter is a first-class provider, MCP support is native across stdio /
streamable_http transports, and the existing PRECRIME skill markdown ports
verbatim. The user's earlier Hermes rejection was correct on tool-calling and
instruction-following grounds. Goose remains the right substrate.

Caveat that frames the next sections: Goose is built for **interactive
augmentation of one developer**. Block's "deployed to 12K employees" stat is
engineers pair-programming, not headless fleets. PRECRIME uses `goose run` as
a side door. The product was not designed for our shape.

### 1b. Codex CLI is the swap-in backup

`codex exec` is purpose-built for non-interactive runs, has native parallel
MCP tool calls, OpenRouter routes any model including grok-4-fast, and the
tool-call loop is battle-tested at ~2M weekly actives. Same supervisor design
works against it. If Goose's known bugs bite hard (issue #8437 30s stream
timeout regardless of `GOOSE_TIMEOUT`, v1.25 instruction-following regression
#7353) the swap is a config flip in the supervisor's spawn command. Keep Codex
CLI in the back pocket; do not adopt by default.

### 1c. Do NOT adopt LangChain / DeepAgents / LangGraph / CrewAI / AutoGen

Investigated all four during this session. None are the right fit:

- **Claude Code + Agent SDK**: gold-standard parallel subagents but
  Anthropic-locked in practice. OpenRouter routing for non-Anthropic models is
  documented broken (anthropics/claude-agent-sdk-python#789, April 2026).
  Hard NO given user's OpenRouter constraint.
- **LangChain DeepAgents (v0.6.7, May 2026)**: no native parallel-skill
  primitive. Inline `task` tool parallelism depends on the model emitting
  batched `tool_use` blocks (Claude does this well; grok-4-fast via OpenRouter
  degrades, exactly where we need it most). Async subagents (v0.5 preview) need
  a separate Agent Protocol / ASGI server. Adopting it would require either
  rewriting `mcp_server.js` in Python (multi-week port) OR keeping stdio
  transport across a Python/Node boundary (defeats the "in-proc shared MCP"
  framing the user reached for).
- **LangGraph as orchestrator**: model-agnostic, OpenRouter compatible, has
  genuinely-native parallel node execution. Realistic port size for the
  six-stage Planner is 200-300 lines of Python, smaller than originally
  framed. Still rejected as a first move because it adds a second language
  (Python alongside Node), takes a heavy framework dependency for a problem
  that does not require it, and pushes scheduling out of `mcp_server.js`
  (the current source of truth for execution order).
- **CrewAI / AutoGen**: CrewAI async-parallel is bolted on, not native.
  AutoGen is in maintenance mode after being absorbed into Microsoft Agent
  Framework. Neither solves the actual problem.

The "in-proc shared MCP" idea with the existing Node `mcp_server.js` is a
category error: Python (DeepAgents) and V8 (mcp_server.js) do not share
address space. The only way to realize it literally is to rewrite the MCP
server in Python. Not happening.

### 1d. The architectural truth uncovered

"Native parallelism at the skill level" is a category error. Parallelism is
**architectural**, owned by a supervisor one layer above the worker, not by
the agent runtime itself. The supervisor IS the orchestrator. The agent
runtime is the worker brain. Stop looking for a CLI flag that does not and
should not exist. This conclusion drove the design in section 2.

---

## 2. Design — supervisor + parallel Goose workers + HTTP MCP

### 2a. Three-layer stack

```
┌──────────────────────────────────────────────────────────────────┐
│ LAUNCHER (top layer)                                             │
│   precrime.bat / hermes.bat / docker entrypoint                  │
│   Reads CLI flags (--interactive | --headless,                   │
│     --marketplace | --outreach | --hybrid).                      │
│   Sets env. Starts the middle layer.                             │
│   Owns "should the whole thing run right now?"                   │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│ MIDDLE LAYER (one Node process, long-lived)                      │
│   server/mcp/mcp_server.js                                       │
│   - HTTP MCP server listening on 127.0.0.1:5179                  │
│   - Planner (pipelinePlanTasks, existing stage-gated logic)      │
│   - Judge (pipelineJudgeAffected, existing procedural scoring)   │
│   - share_booking, find, trades, etc. (existing actions)         │
│   - NEW: Worker supervisor section (~150 lines)                  │
│       child_process.spawn('goose', ['run', '--instructions',     │
│         skill_path, '--no-session', '--quiet',                   │
│         '--output-format', 'stream-json',                        │
│         '--max-turns', '6'])                                     │
│       Promise.all over N concurrent spawns per task type.        │
│       Watch PIDs, restart on crash, timeout hung workers (~25s   │
│         per Goose issue #8437), kill+requeue on stall.           │
│       Stop on budget exhaustion or empty queue.                  │
│   Owns "which worker runs next and how many in parallel?"        │
└──────────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
┌──────────────────────────────────────────────────────────────────┐
│ WORKER LAYER (N ephemeral Goose processes, ~1 min lifetime each) │
│   goose run --instructions templates/skills/<skill>.md ...       │
│   Each worker opens an HTTP MCP client to 127.0.0.1:5179.        │
│   Claims one Task. Does the work. Calls complete_task. Exits.    │
│   Owns ONE skill, ONE Task, ONE exit.                            │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│ DATA (single shared SQLite file)                                 │
│   data/precrime.sqlite, WAL mode, synchronous=NORMAL             │
│   Only the middle-layer Node process holds an open handle.       │
│   Workers reach the DB only via MCP calls. One writer.           │
└──────────────────────────────────────────────────────────────────┘
```

### 2b. Why this shape

- **One MCP server, many workers.** Stdio MCP is 1:1 (each Goose would spawn
  its own `mcp_server.js` child = N processes, N SQLite handles, N config
  caches, N cold-start penalties). HTTP MCP is 1:many: one server, all
  workers connect over loopback. Memory drops from ~N * 80 MB to ~80 MB,
  worker startup goes from cold to instant, in-memory state is unified.
- **Goose workers are one-shot.** Per worker: claim one Task, do it,
  `complete_task`, exit. No claim loop inside the skill. The supervisor
  decides whether to spawn another. The skill markdown gets pared to "single
  job, single life, no orchestration" (current `init-wizard.md` and
  `headless_flow.md` encode the heartbeat loop in the skill and must be
  cleaved for this).
- **SQLite is fine here.** Workers do not write to SQLite directly; they go
  through MCP. The middle-layer Node process serializes all writes
  internally before they hit the file lock. WAL absorbs the rest. No write
  contention story until ~hundreds of writes/sec, which we will never hit.
- **Goose tuned lean.** Per spawn: disable every Goose built-in extension
  except the precrime MCP, override system prompt via skill markdown
  (`--instructions`), `--max-turns 6`, `--no-session`, `--quiet`,
  `--output-format stream-json`. Pin a known-good Goose version (currently
  v1.36, latest stable May 27 2026; avoid v1.25 due to regression #7353).
- **Stagger spawns by ~100ms.** Smooths the OpenRouter opening burst when
  N workers all hit the API at once.

### 2c. Concurrency target, from current `precrime_config.json`

| Task type        | tasks.limits (open at once) |
| ---------------- | --------------------------: |
| ENRICH_CLIENT    | 10                          |
| SCRAPE_SOURCE    | 5                           |
| APPLY_FACTLET    | 5                           |
| JUDGE_AFFECTED   | 5                           |
| DRAFT_OUTREACH   | 5                           |
| SHARE_BOOKING    | 3                           |
| DISCOVER_SOURCES | 1                           |
| SHOW_HOT_LEEDZ   | 1                           |

Theoretical peak ~35; realistic steady state under stage gating ~10-25.
Workers are I/O-bound on OpenRouter HTTP, not CPU-bound.

### 2d. Deployment shape (single Docker image, single EC2 box)

One image. One container. One box. `tini -g` as PID 1, supervisord
managing two long-lived processes (`mcp_server.js` + the launcher loop), and
Goose workers spawned by the middle-layer Node process via
`child_process.spawn` (NOT by supervisord — one owner per concern). EBS gp3
mount for `/app/data` (the SQLite file plus `-wal` and `-shm` sidecars).
HTTP MCP port 5179 closed to the world (loopback only). SSH from user IP
only. No RDS, no Fargate, no ECS, no Lambda, no Step Functions, no
EventBridge.

EC2 sizing: **t4g.large** (ARM, 2 vCPU, 8 GB RAM, ~$49/mo on-demand
us-east-1) if Goose ships an arm64 build; t3.large (x86, ~$63/mo) as the
safe default if ARM verification fails. Workers are I/O-bound so burstable
CPU credits are a feature.

Worst-case memory at 25 concurrent workers: ~4.4 GB resident with 46%
headroom on 8 GB. Token spend on OpenRouter will dwarf infra cost by 10-100x.

### 2e. Future migration to AWS managed services — explicit non-goal for v1

The architecture is cloud-shaped (one stateless Node service + N stateless
workers + one shared DB) so migration to Fargate + RDS + EventBridge IS the
graceful path IF and only if PRECRIME outgrows a single t4g.large. We will
not pre-build for that scale. Document it as a future option in
`DOCS/WHAT_I_LEARNED.md`; do not engineer for it now.

---

## 3. What changes in the codebase to land this design

Not implemented yet, recorded so the next session can pick it up:

1. **`server/mcp/mcp_server.js`**: add an HTTP transport via MCP SDK's
   `StreamableHTTPServerTransport` listening on 127.0.0.1:5179. Keep stdio
   mode behind a `--stdio` CLI flag for unit tests. ~30 lines.
2. **`server/mcp/mcp_server.js`**: add a worker-supervisor section.
   `child_process.spawn` Goose workers, `Promise.all` for fan-out per type,
   PID watch, crash restart, 25s hung-worker kill, budget-aware stop.
   ~150 lines.
3. **`templates/skills/init-wizard.md`** and
   **`templates/skills/headless_flow.md`**: strip the heartbeat loop. Each
   skill becomes "one Task, one life." Move the claim/dispatch/complete loop
   logic out of skill markdown and into the supervisor.
4. **`precrime_config.json`**: add a `workers` block:

   ```json
   "workers": {
     "enabled": true,
     "pollMs": 1500,
     "idleExitMs": 300000,
     "maxRestarts": 3,
     "gooseVersion": "v1.36.0",
     "spawnStaggerMs": 100,
     "hungWorkerKillMs": 25000,
     "concurrency": {
       "APPLY_FACTLET": 5,
       "ENRICH_CLIENT": 10,
       "SCRAPE_SOURCE": 5,
       "JUDGE_AFFECTED": 5,
       "SHARE_BOOKING": 3,
       "DRAFT_OUTREACH": 5,
       "DISCOVER_SOURCES": 1
     }
   }
   ```
5. **`.mcp.json`** in workspace: flip precrime extension from `type: stdio`
   to `type: streamable_http`, `url: http://127.0.0.1:5179/mcp`.
6. **Goose recipes are NOT needed.** Use `goose run --instructions
   <skill>.md` directly with the skill markdown as the prompt anchor. Goose
   extensions remain configured globally in `~/.config/goose/config.yaml`
   with everything disabled except the precrime extension.
7. **`Dockerfile`**: `node:20-bookworm-slim` base, install Goose via pinned
   official install script, supervisor + tini + ca-certificates,
   `VOLUME /app/data`, `EXPOSE 5179`, `HEALTHCHECK` on `/health`. ENTRYPOINT
   `tini -g -- supervisord -c /etc/supervisord.conf -n`.
8. **`supervisord.conf`**: one `[program:mcp-server]` (the Node process).
   Workers are spawned by Node, not by supervisord.

---

## 4. Open questions answered this session

| Question                                     | Answer                                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| ARM64 or x86 EC2?                            | ARM `t4g.large` if Goose arm64 ships; verify pre-launch |
| Worker write pattern to SQLite?              | "Honestly not sure yet" — ship on SQLite + WAL, watch  |
|                                              | SQLITE_BUSY counters in production, decide based on    |
|                                              | real data                                              |
| MCP port 5179 reachable from outside?        | Closed, ssh only                                       |
| Goose recipes vs `--instructions`?           | `--instructions` direct, skip recipes                  |
| stdio vs HTTP MCP for workers?               | HTTP (one server, N clients via loopback)              |
| Python alongside Node in one container?      | Standard; not needed for v1 (no LangGraph adoption)    |
| Fork Goose to build PRECRIME inside?         | No. Goose is an external dependency, PRECRIME is its   |
|                                              | own repo. Forks are for upstream PRs, not products.    |

---

## 5. Open questions NOT yet answered

- Goose arm64 build verification (15 min check before EC2 launch).
- Real-world SQLITE_BUSY counter behavior under 25 concurrent workers.
- Whether OpenRouter rate limits actually bite at the opening-burst
  moment (mitigation: 100ms spawn stagger) or only mid-run.
- Goose issue #6797 (Linux "Failed to initialize automation" warning)
  log-pipeline filter shape.
- Whether the "telepathy" pattern from goosetown (push messages from
  supervisor to running workers) is worth porting for kill-in-flight
  semantics, or whether SIGTERM via PID is sufficient.

---

## 6. References pulled this session (for next-session continuity)

- Wilson Lin, "Scaling Agents", https://cursor.com/blog/scaling-agents
  (originating reference for the Planner/Worker/Judge/Presenter split)
- Block / AAIF Goose: `github.com/aaif-goose/goose` (the worker brain)
- LangChain DeepAgents: `github.com/langchain-ai/deepagents` (rejected)
- Goosetown (AAIF): `github.com/aaif-goose/goosetown` (six-commit reference
  architecture for parallel orchestrator on Goose; useful for the telepathy
  and crossfire patterns; NOT a dependency)
- Anthropic MCP Streamable HTTP transport spec
- Goose issues #8437 (stream timeout bug), #7353 (v1.25 instruction
  regression), #6797 (Linux automation warning), #4389 (Unify Agent
  Execution discussion, shipping incrementally)

End.
