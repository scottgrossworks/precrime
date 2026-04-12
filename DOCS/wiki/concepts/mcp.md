---
title: Pre-Crime MCP Server — All 19 Tools
tags: [mcp, tools, prisma, sqlite, json-rpc, booking, client, factlet, config, scoring]
source_docs: [DOCS/STATUS.md, DOCS/MCP_BRIEFING.md, DOCS/DEPLOYMENT.md, DOCS/PLAN.md]
last_updated: 2026-04-08
staleness: none
---

The Pre-Crime MCP server is a local stdio JSON-RPC 2.0 subprocess. Uses Prisma 5, writes to a local SQLite DB, and exposes 19 tools to Claude Code. No HTTP server. No Express. No additional npm packages beyond Prisma, readline, fs, and path.

> WARNING — STALE? `MCP_BRIEFING.md` (dated 2026-04-02) lists 4 issues as "broken/missing" (Prisma schema has no Booking model, Config missing v2.0 fields, `update_booking` doesn't auto-evaluate `leed_ready`, `get_stats` missing booking counts). `STATUS.md` (authoritative, sessions 1-8 complete) says all 15 tools are done and working, and the blank DB ships pre-built with the full schema. The issues in MCP_BRIEFING.md have been resolved. Treat MCP_BRIEFING.md as a historical implementation record, not a current bug list.

> WARNING — STALE? `MCP_BRIEFING.md` says the schema to edit is at `BLOOMLEEDZ\server\prisma\schema.prisma`. `STATUS.md` uses `PRECRIME\server\prisma\schema.prisma`. BLOOMLEEDZ is the old project name. The correct path is `PRECRIME\server\prisma\`.

---

## Transport

```
Claude Code ←→ server/mcp/mcp_server.js (stdin/stdout JSON-RPC 2.0)
```

Wired via `.mcp.json` in the workspace root. Claude Code reads `.mcp.json` at startup. MCP connects once — no mid-session reconnect.

---

## Configuration Files

| File | Contents |
|------|---------|
| `server/mcp/mcp_server_config.json` | DB path: `../data/myproject.sqlite` (relative to `server/mcp/`) |
| `server/.env` | `DATABASE_URL="file:../data/myproject.sqlite"` (relative to `server/`) |
| `server/package.json` | `@prisma/client: 5.22.0`, dotenv |
| `server/prisma/schema.prisma` | Prisma 5 schema — Client, Booking, Factlet, ClientFactlet, Config |

---

## All 19 Tools

### Client Tools (8)

| Tool | Args | Purpose |
|------|------|---------|
| `get_next_client` | `criteria?` | Atomic cursor fetch — stamps `lastQueueCheck`. Use for the enrichment loop. |
| `get_client` | `id` | Fetch one client by CUID |
| `create_client` | `fields` | Create a new client. Requires `name` OR `company`. Defaults `draftStatus` to `"brewing"`. Always set `source`. |
| `search_clients` | `query` | Filter by name, company, segment, draftStatus |
| `update_client` | `id, fields` | Write any Client columns. Use for dossier append, draftStatus change, etc. |
| `get_ready_drafts` | — | All clients with `draftStatus=ready`, sorted by dossierScore desc |
| `get_stats` | — | Counts by draftStatus, contactGate pass/fail, dossierScore distribution, factlet/linked factlet counts, booking counts by status |
| `get_config` | — | Read the Config table (single row, id="config") |

**`get_stats` response includes:**
- Client counts: total, by draftStatus (brewing, ready, sent)
- Contact gate: pass/fail counts
- Dossier scores: high (>=10), mid (5-9), low (<5), unscored
- Factlet counts: total factlets, total linked factlet associations
- Booking counts: total, by status (new, leed_ready, taken, shared, expired)

### Factlet Tools (3)

| Tool | Args | Purpose |
|------|------|---------|
| `create_factlet` | `content, source` | Add to broadcast queue |
| `get_new_factlets` | `since` | Factlets after a timestamp (ISO date). Use for dedup check. |
| `delete_factlet` | `id` | Remove from broadcast queue |

### Config Tools (1)

| Tool | Args | Purpose |
|------|------|---------|
| `update_config` | `fields` | Write any Config columns |

**Config fields writable via `update_config`:**
- `businessName`, `description`, `serviceArea`
- `activeEntities` (JSON string)
- `defaultTrade`, `marketplaceEnabled`, `leadCaptureEnabled`
- `leedzEmail` — user's theleedz.com email (set during init-wizard Step 5a)
- `leedzSession` — pre-generated HS256 JWT for The Leedz MCP `createLeed` calls

### Booking Tools (4)

| Tool | Args | Purpose |
|------|------|---------|
| `create_booking` | `clientId, fields` | Create Booking record. Auto-evaluates Booking Action Criterion. |
| `update_booking` | `id, fields` | Update booking status, leedId, etc. Also auto-evaluates Booking Action Criterion. |
| `get_bookings` | `filters?` | List bookings, optionally filtered by status |
| `get_client_bookings` | `clientId` | All bookings for one client |

**Booking Action Criterion (auto-evaluated by both `create_booking` and `update_booking`):**
- If `trade` + `startDate` + (`location` OR `zip`) are all present AND status wasn't explicitly set → auto-set `status: "leed_ready"`
- For `update_booking`: fetches existing record, merges with update, then re-evaluates

### Scoring Tools (3) — added 2026-04-08

| Tool | Args | Purpose |
|------|------|---------|
| `link_factlet` | `clientId, factletId, signalType` | Associate a broadcast factlet with a client. Signal types: `pain` (2 pts), `occasion` (2 pts), `context` (1 pt). Idempotent — upserts on unique(clientId, factletId). |
| `get_client_factlets` | `clientId` | Hydrate all linked factlets for a client. Returns factlet content, signalType, points, appliedAt. Used at start of enrichment to load broadcast intel context. |
| `score_client` | `clientId, intelScore?` | Procedural client scoring (no LLM). Computes contactGate (binary), factletScore (sum from join table), dossierScore (intel + factlets), canDraft (gate AND threshold). Writes scores back to DB. Returns full breakdown + recommended action. |

**`score_client` details:**
- Contact gate reuses `isGenericEmail()` — same 34-prefix list used by `score_booking`
- Draft threshold: `dossierScore >= 5` (hardcoded, derived from evaluator minimum requirements)
- `intelScore` param (D2+D3, max 7) set by enrichment agent after scraping. Stored on client for recomputation.
- See [[scoring]] for the full scoring system design.

---

## JWT for The Leedz MCP (leedz-share plugin only)

`Config.leedzSession` stores a pre-generated HS256 JWT. Only needed if the `plugins/leedz-share/` plugin is installed. Generated at workspace setup (init-wizard Step 5a).

```
jwt.encode(
  {'email': leedzEmail, 'type': 'session', 'exp': <1yr from now>},
  JWT_SECRET,
  algorithm='HS256'
)
```

JWT_SECRET: `648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c`

If the leedzEmail doesn't exist in Leedz_DB yet, `addLeed` will auto-create a stub user on first post.

---

## What NOT To Do With This Server

- Do NOT add an HTTP server. stdin/stdout only.
- Do NOT modify tool handler signatures or tool names. Skill files reference exact names.
- Do NOT add new npm packages. Prisma + readline + fs + path is the full dependency list.
- Do NOT touch the RSS scorer (`rss-scorer-mcp/`). Separate concern.
- Do NOT wire marketplace posting in this server. Marketplace sharing is handled by the optional `plugins/leedz-share/` plugin.

---

## Skill References to Tool Names

Skill files in `templates/skills/` reference tools using the `mcp__precrime-mcp__` prefix format when called from Claude:

```
mcp__precrime-mcp__create_client
mcp__precrime-mcp__create_factlet
mcp__precrime-mcp__get_new_factlets
mcp__precrime-mcp__search_clients
mcp__precrime-mcp__update_client
mcp__precrime-mcp__create_booking
mcp__precrime-mcp__get_config
mcp__precrime-mcp__link_factlet
mcp__precrime-mcp__get_client_factlets
mcp__precrime-mcp__score_client
```

---

## The Leedz MCP (Separate — Reference Only)

Not part of this server. Listed here to prevent conflation.

| | Value |
|--|--|
| File | `FRONT_3\py\mcp_server\lambda_function.py` |
| Transport | Remote `POST /mcp` on API Gateway |
| Backend | boto3 → Lambdas → DynamoDB |
| Phase 1 tools | `getTrades`, `getStats`, `getLeedz`, `getUser`, `createLeed` |

`createLeed` calls the `addLeed` Lambda. There is a separate SSR Lambda also named `createLeed` — never invoke it.

---

## Related
- [[scoring]] — Client scoring system, contact gate, dossier score, draft eligibility
- [[ontology]] — Booking entity, status values, field definitions
- [[architecture]] — DB path resolution, Prisma version constraint
- [[deployment]] — MCP config file locations, troubleshooting
- [[current]] — `createLeed` with JWT verified; `share_booking` removed (see `plugins/leedz-share/`)
