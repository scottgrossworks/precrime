---
title: Pre-Crime MCP Server — 3 tools, current surface
tags: [mcp, tools, prisma, sqlite, json-rpc, pipeline, find, trades, pass-2]
source_docs: [server/mcp/mcp_server.js, server/prisma/schema.prisma]
last_updated: 2026-05-06
staleness: none
---

The Pre-Crime MCP server is a local stdio JSON-RPC 2.0 subprocess. Prisma 5 → SQLite. Three tools. The 22-tool CRUD surface from the early sessions was collapsed into 3 workflow-level tools (the MCP_REWRITE) so weaker orchestrators (goose, hermes) don't drown in a tool router. Pass 2 added four queue actions to the `pipeline` tool.

---

## Transport

```
Orchestrator (Claude Code | goose | hermes) ←→ server/mcp/mcp_server.js  (stdin/stdout JSON-RPC 2.0)
                                                  |
                                                  | PrismaClient (Prisma 5)
                                                  |
                                              data/myproject.sqlite
```

Wired via `.mcp.json` in the workspace root. MCP connects once at orchestrator startup — no mid-session reconnect.

---

## Three tools

| Tool | Purpose |
|---|---|
| `pipeline` | All write operations + read-state. 13 actions. Queue management, sessions, scoring, sources. |
| `find` | Read-only search. 4 actions: clients / bookings / factlets / drafts. |
| `trades` | Canonical Leedz trade names. 10-minute cache. |

All other interactions (skill files, agent prose) reference these names verbatim. There are no `create_client`, `update_booking`, `score_client`, etc. tools anymore — those collapsed into `pipeline.save` and `pipeline.next`.

---

## `pipeline` — 13 actions

| action | Purpose |
|---|---|
| `status` | Full system state in one call. config + stats + completeness + readyDrafts + brewingCount. |
| `configure` | Update Config fields. |
| `next` | Atomically claim and return the next client (or booking) work item, fully hydrated. Stamps `lastQueueCheck` so other agents skip it. |
| `save` | Create or update a Client. Server auto-dedups by company, auto-scores, auto-promotes attached Bookings to `leed_ready` only when `DOCS/SCORING.json` passes. |
| `delete` | Remove a Booking, Client, or Factlet. Cascades. |
| `rescore` | Re-evaluate every non-terminal Booking against the current `DOCS/SCORING.json`. Use after editing scoring policy. |
| `start_session` | Open a server-issued workflow session. Returns `session_id`. |
| `report_session` | Close session and return server-computed truth: `requested / actually_saved / failed / saved_clients[] / failures[]`. ONLY sanctioned summary. |
| `audit_session` | Inspect session events without closing. Use when the user says "what did you do" / "show the audit". |
| `next_source` | (Pass 2) Atomically claim a Source row for scraping. Returns `CLAIMED` or `QUEUE_EMPTY`. |
| `mark_source` | (Pass 2) Release the claim and persist scrape result. |
| `add_sources` | (Pass 2) Bulk-insert new Source URLs with dedup on URL. |
| `import_sources` | (Pass 2) One-time migration: read seed `_sources.md` files, populate Source table. Idempotent. |

See [[source-queue]] for the four Pass 2 actions in detail and the work-stealing semantics.

### `pipeline.save` — what the server enforces

Every save call:
- Rejects empty patches (-32602).
- Dedups by company name (merges with existing record).
- Runs `score_target` on the client.
- Re-scores every booking under that client.
- Writes `leed_ready` status back when the canonical `DOCS/SCORING.json` gate passes.
- If `session_id` is passed, logs a `SessionEvent` row.

Agents do not call score_client manually. Save is the only write path; scoring is its side effect.

### Session truth: `start_session` / `report_session`

`report_session` is the ONLY sanctioned summary of session results. It returns `{session_id, workflow, requested, actually_saved, failed, saved_clients[], failures[], duration_ms}` derived from the server-side `SessionEvent` log. The agent cannot fake counts because the events are server-recorded.

`start_session` enforces a 60s cooldown if you re-open the same `workflow` string. A 3-min save-or-terminate watchdog applies on the read actions (`status`, `next`, `rescore`) — if you read state but never save, the server terminates your access until you save.

---

## `find` — 4 read actions

| action | Filters |
|---|---|
| `clients` | search, name, email, company, segment, draftStatus, warmthScore, minWarmthScore, maxWarmthScore |
| `bookings` | status, trade, search, id |
| `factlets` | sinceTimestamp, clientId |
| `drafts` | minScore (drafts with `draftStatus=ready`) |

Default `summary=true` returns slim records (no dossier/draft/targetUrls). Pass `summary=false` only when you need full records.

---

## `trades`

Returns canonical Leedz trade names from the Leedz API. Cached 10 minutes. Serves stale cache on network failure. The ONLY authoritative source for valid Leedz trade names — never guess from training data.

---

## Configuration files

| File | Contents |
|---|---|
| `server/mcp/mcp_server_config.json` | Logging metadata (DB path is set via `DATABASE_URL` env var, not this file). |
| `DOCS/SCORING.json` | Canonical booking + client scoring weights, gates, regex patterns, generic-email prefixes, and Leedz readiness requirements. |
| `server/.env` | `DATABASE_URL="file:../data/myproject.sqlite"` — set by `precrime.bat`. |
| `server/package.json` | `@prisma/client: 5.22.0`, dotenv. |
| `server/prisma/schema.prisma` | Prisma 5 schema — Client, Booking, Factlet, ClientFactlet, Session, SessionEvent, **Source**, Config. |

---

## JWT for The Leedz MCP (leedz-share plugin only)

`Config.leedzSession` stores a pre-generated HS256 JWT. Required only when the optional `plugins/leedz-share/` plugin is installed and the user posts a leed via `leedz__createLeed`. Generated at workspace setup.

---

## What NOT to do with this server

- Do NOT add an HTTP server. stdin/stdout only.
- Do NOT split `pipeline` back into per-entity tools. The collapse to 3 was deliberate and fixed weaker orchestrators' tool routers.
- Do NOT add new npm packages. Prisma + readline + fs + path is the full dependency list.
- Do NOT touch the RSS scorer (`rss/rss-scorer-mcp/`). Separate MCP, separate concern.
- Do NOT bypass `pipeline.save` to write the DB. Direct Prisma writes from anywhere outside this file skip scoring + session logging.

---

## Related
- [[source-queue]] — Pass 2 queue: Source table, four new actions, work-stealing
- [[ontology]] — entity definitions
- [[scoring]] — pointer to canonical `DOCS/SCORING.json`
- [[architecture]] — DB path resolution, Prisma version constraint
- [[current]] — session log
