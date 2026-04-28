# MCP_REWRITE.md

**Full path:** `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\DOCS\MCP_REWRITE.md`

**Goal:** rewrite the precrime MCP server to expose **3 workflow-level tools** instead of 22 fine-grained CRUD tools. This is for the Goose port specifically, and benefits Claude Desktop too.

---

## Why this rewrite exists

Three structural problems are blocking the Goose deployment of an otherwise-working pipeline:

1. **Context bloat at startup.** All 22 MCP tool schemas (description + input properties) load into the model's working context every session. Combined with platform extensions, the session hits the 80% auto-compaction threshold *before bootstrap completes*. See `project_goose_context_bloat` memory.
2. **Goose's LLM-based tool router prunes tools dynamically.** With 22 fine-grained tools, only a relevance-filtered subset is surfaced to the model on any given turn. Skill files that say "every client found, call `create_client` immediately" hit `-32002 Tool not found` because the router hasn't surfaced `create_client` for that turn. Reproduced with anthropic/claude-sonnet-4.5 on 2026-04-27.
3. **The 22 tools are database primitives, not workflow operations.** Almost every skill .md file spends ink teaching the model how to compose CRUD ops back into pipeline steps (`get_next_client` → `get_client_factlets` → `update_client` → `score_target` → ...) that should be a single MCP call.

The fix is upstream of Goose: collapse 22 CRUD tools into 3 workflow tools. The new surface is small enough that no router needs to prune it, and the skills shrink because they stop teaching SQL.

---

## Current state (read this before touching anything)

**Active MCP server:** `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server.js` (1448 lines)

**Server config:** `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server_config.json` — read by the server for logging only. The `database.path` field is the canonical DB path source per CLAUDE.md.

**Prisma schema:** `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\prisma\schema.prisma` (112 lines, 5 models — Client, Booking, Factlet, ClientFactlet, Config)

**Goose extension registration:** `C:\Users\Admin\AppData\Roaming\Block\goose\config\config.yaml` lines 110-122. Currently maps extension name `precrime-mcp` → `node mcp_server.js`. Tool names exposed to the model take the form `precrime_mcp__<tool>` (dash converted to underscore).

**Claude Desktop registration:** wherever Claude Desktop's MCP config lives on this machine. Confirmed working with the current 22-tool server. **Do not break this** — Claude Desktop is the user's working pipeline. The rewrite must coexist.

**Skill files that call the 22 tools (these need updates after the rewrite, in a second phase):**
- `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\skills\init-wizard.md` (313 lines — calls `get_config`, `get_stats`, `update_config`, `get_trades`)
- `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\skills\enrichment-agent.md` (651 lines — calls 9 of the 22 tools throughout the enrichment loop)
- `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\skills\evaluator.md` (41 lines)
- `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\skills\share-skill.md` (221 lines — calls external `createLeed` HTTP API, not MCP. Out of scope for this rewrite.)
- `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\skills\client-finder.md`, `client-seeder.md`, `outreach-drafter.md`, `leed-drafter.md`, `relevance-judge.md`, `email-finder.md`, `enrichment-agent.md`, `evaluator.md`, `source-discovery.md`, `share-skill.md`, `convention-leed-pipeline.md`, `marketplace_flow.md`, `outreach_flow.md`, `draft-checker.md`, harvester subfolders.

**Routing config (Goose-specific):** `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\GOOSE.md` lines 96-117 hardcode the `precrime_mcp__` prefix and the legacy 22-tool names. This will need a sweep after the rewrite.

---

## The 22 → 3 collapse

### What the 22 tools currently do (grouped by intent)

| Group | Current tools | What they really are |
|---|---|---|
| **Read state** | `get_config`, `get_stats`, `get_trades` | Snapshot reads. `get_trades` is special — network call to Leedz API with caching. |
| **Write state** | `update_config` | Single-entity config writer. |
| **Pull next work item** | `get_next_client` | Atomic claim — fetch oldest `lastQueueCheck`, stamp now, return. |
| **Hydrate work item** | `get_client`, `get_client_factlets`, `get_client_bookings`, `get_ready_drafts` | "Give me everything about X." Always called together. |
| **Persist enrichment work** | `update_client`, `create_factlet`, `link_factlet`, `update_booking`, `score_target` | "Here is what I found about this client/booking." Always called together. |
| **Search / list** | `search_clients`, `get_bookings`, `get_new_factlets` | "Show me items matching criteria." |
| **Mutate one record** | `create_client`, `create_booking`, `delete_client`, `delete_factlet`, `delete_booking` | Direct CRUD, mostly used by harvesters and cleanup. |

### The 3 new tools

#### 1. `pipeline` — the verb-routed workflow tool

One tool with an `action` discriminator covers status, atomic-claim, hydrate, and atomic-save. This is the tool the enrichment loop hits 90% of the time.

| `action` | What it does internally | Replaces |
|---|---|---|
| `"status"` | Returns `{ config, stats, completeness, readyDrafts, brewingCount }` in one payload. `completeness` is a derived assessment of whether config has the fields needed for current `defaultBookingAction`. | `get_config` + `get_stats` + the manual "is config complete?" logic spread across init-wizard.md |
| `"configure"` | Updates Config fields. Same input shape as the old `update_config`. | `update_config` |
| `"next"` | Atomically claims the oldest unprocessed Client (or Booking, depending on `entity` arg), returns the **fully hydrated** record: client + linked factlets + bookings + last 5 dossier entries. | `get_next_client` + `get_client` + `get_client_factlets` + `get_client_bookings` (one call instead of four) |
| `"save"` | Atomically persists all enrichment work for one client in a single transaction: dossier append, draft+draftStatus, targetUrls, intelScore, new factlets (auto-creates and links), booking upserts, then runs `score_target` and returns the score. | `update_client` + `create_factlet` + `link_factlet` + `update_booking` + `score_target` (one call instead of up to 5) |

**Input schema sketch:**
```json
{
  "action": "status|configure|next|save",
  "entity": "client|booking",        // for "next" only
  "criteria": { ... },                // for "next" only — optional filters
  "id": "...",                        // for "save" — required
  "patch": {                          // for "save" or "configure"
    "dossierAppend": "string",
    "draft": "string",
    "draftStatus": "brewing|ready|sent",
    "targetUrls": [...],
    "intelScore": 7,
    "factlets": [{ content, source, signalType }],
    "bookings": [{ id?, ...fields }]
  }
}
```

The handler dispatches on `action`. The model only ever needs to know one tool name.

#### 2. `find` — read-only search across entities

| `action` | Replaces |
|---|---|
| `"clients"` (filters: company, name, segment, draftStatus, minDossierScore, contactGate, summary, limit) | `search_clients` |
| `"bookings"` (filters: status, trade, search, limit) | `get_bookings` |
| `"factlets"` (filters: sinceTimestamp, clientId, limit) | `get_new_factlets` + `get_client_factlets` (when not already hydrated by `pipeline.next`) |
| `"drafts"` (returns `draftStatus = "ready"` clients, sorted by score) | `get_ready_drafts` |

Default `summary: true` for `clients` and `bookings`. Full records only on explicit request. This is the token-safety rule already enforced in enrichment-agent.md, made structural.

#### 3. `trades` — canonical trade list (preserved as a dedicated tool)

Separate because it's a network call to the Leedz API with 10-min caching, not a DB op. Identical behavior to the current `get_trades`. Kept distinct so the model has a clear "external authoritative list" affordance.

### What about the other operations?

| Old tool | Where it goes |
|---|---|
| `create_client`, `create_booking` | Folded into `pipeline.save` (when `id` is omitted, it's a create). Also exposed via a thin internal helper for harvester scripts that hit Prisma directly outside the MCP. **Harvesters do not need to go through MCP.** |
| `delete_client`, `delete_booking`, `delete_factlet` | **Removed from the MCP surface.** Cleanup is a maintenance op, not a workflow op. The model should never delete records during enrichment. If needed, expose a separate admin script (`tools/cleanup.js`) that hits Prisma directly. |

This is deliberate. Removing destructive ops from the agent's surface is a feature.

---

## Implementation plan

### Phase 0 — agree on the design (1 round of review)

Before writing code: read this file end-to-end. If the action discriminator approach in `pipeline` is wrong (e.g. some MCP hosts don't handle multi-action tools well), adjust now, not after writing 1000 lines. **Decision lock:** action discriminator approach is approved by user 2026-04-27. Proceed.

### Phase 1 — build `mcp_server_v2.js` alongside the existing server

**Do NOT edit `mcp_server.js`.** The current server is the user's working Claude Desktop pipeline. Per the "never destroy working markdown" rule (also applies to working code that the user depends on daily), build the new server as a sibling file and prove it before deprecating anything.

1. Copy `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server.js` to `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server_v2.js`.
2. In `mcp_server_v2.js`:
   - Keep the database resolution logic at the top (lines 1-62 of the original) verbatim.
   - Keep the logging utilities (~lines 65-130).
   - **Replace** the `tools/list` response with exactly 3 tools: `pipeline`, `find`, `trades`. The schemas for these are sketched above — write them out fully with descriptions that name the action discriminator and document each sub-action.
   - **Replace** the tool handler dispatch with three top-level handlers: `handlePipeline`, `handleFind`, `handleTrades`. Each one switches on `action` and calls the existing internal Prisma logic — most of which can be lifted from the original handlers wholesale.
   - **`pipeline.save` must be transactional.** Use `prisma.$transaction([...])` so a partial save never leaves the DB in a half-state. This is a real upgrade over the current code, where the model has to call 4 separate tools and a crash mid-sequence corrupts state.
   - **`pipeline.next` must atomically claim and hydrate in one Prisma transaction.** Currently the model does `get_next_client` (which atomically claims) then `get_client_factlets` separately — there's a race window. Fix it.
3. Wire it up in Goose's config as a NEW extension entry, not a replacement:
   ```yaml
   precrime:
     enabled: true
     type: stdio
     name: precrime
     description: Pre-Crime workflow tools — pipeline, find, trades
     cmd: node
     args:
       - C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server_v2.js
     envs: {}
     timeout: 60
   ```
   Keep the old `precrime-mcp` entry but set `enabled: false` while testing v2. Goose tool names will be `precrime__pipeline`, `precrime__find`, `precrime__trades`.
4. Do **not** register v2 with Claude Desktop yet. Claude Desktop continues using the 22-tool server until v2 is proven.

### Phase 2 — verify v2 in isolation

Before any skill changes:

1. Start v2 manually: `node C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server_v2.js` and confirm it logs `[MCP] Server ready`.
2. Pipe a `tools/list` JSON-RPC request via stdin and confirm exactly 3 tools come back with valid schemas.
3. Pipe a `pipeline` call with `action: "status"` and confirm it returns config + stats + completeness in one payload.
4. Pipe a `pipeline` call with `action: "save"` against a test record and confirm the transaction commits all fields.
5. Pipe a `pipeline` call with `action: "next"` and confirm the returned object includes both client and linked factlets (single round trip).

If any of these fail, fix v2 before touching skills.

### Phase 3 — skill migration (do NOT do this in Phase 1)

Skills currently pepper `precrime_mcp__<tool>` calls throughout. After v2 is verified:

1. **Branch, don't rewrite in place.** Create `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\skills_v2\` and copy in the skills that the v2 surface changes. Edit those copies. The original skills/ stays intact for Claude Desktop.
2. Sweep replacements in the v2 copies:
   - `precrime_mcp__get_config` + `precrime_mcp__get_stats` → `precrime__pipeline({ action: "status" })`
   - `precrime_mcp__update_config` → `precrime__pipeline({ action: "configure", patch: {...} })`
   - `precrime_mcp__get_next_client` + `precrime_mcp__get_client_factlets` → `precrime__pipeline({ action: "next", entity: "client" })`
   - `precrime_mcp__update_client` + `precrime_mcp__create_factlet` + `precrime_mcp__link_factlet` + `precrime_mcp__score_target` → `precrime__pipeline({ action: "save", id: clientId, patch: {...} })`
   - `precrime_mcp__search_clients` → `precrime__find({ action: "clients", ... })`
   - `precrime_mcp__get_bookings` → `precrime__find({ action: "bookings", ... })`
   - `precrime_mcp__get_trades` → `precrime__trades()`
3. Update `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\GOOSE.md`:
   - Replace the prefix table at lines 96-117 with the new 3-tool table.
   - Update routing skill references to point to `skills_v2/init-wizard.md` if mode = goose-v2 testing.

### Phase 4 — flip Goose to v2 and run end-to-end

1. In Goose config.yaml: `precrime-mcp.enabled: false`, `precrime.enabled: true`.
2. Restart Goose: `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\goose.bat`.
3. Run `run precrime` and observe:
   - Tool list at session start shows only 3 `precrime__*` tools.
   - 80% auto-compaction does NOT fire pre-bootstrap.
   - `init-wizard.md` Step 0 succeeds (no `-32002`).
   - End-to-end one-client enrichment completes.

### Phase 5 — promote v2 to Claude Desktop (optional, deferred)

Once v2 has run a clean week in Goose:

1. Register v2 with Claude Desktop alongside the old `precrime-mcp`.
2. Verify Claude Desktop pipeline still works using v2's surface.
3. Eventually delete the 22-tool server and remove the old `precrime-mcp` extension. Not before.

---

## Hard rules for the implementing agent

1. **Read the existing `mcp_server.js` end-to-end before writing v2.** Lift the Prisma logic — don't rewrite query semantics. The bug surface is in the tool surface, not the queries.
2. **Do not edit `mcp_server.js`.** Build v2 as a sibling. Working pipeline must keep working.
3. **Do not edit existing skills/ files in place.** Branch to `skills_v2/`. Per memory rule `feedback_never_destroy_working`.
4. **Use absolute paths in any markdown you write.** Per memory rule `feedback_bulletproof_paths`. Goose-facing skills break with relative paths.
5. **Transactional saves.** `pipeline.save` must be a single Prisma `$transaction` — don't ship the same race condition the old multi-call pattern has.
6. **No new dependencies.** The current server uses only `@prisma/client`, `readline`, `fs`, `path`. Keep it that way.
7. **No TypeScript.** This project is JS only — see `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\CLAUDE.md` binding rules.
8. **No HTTP server.** Stdio JSON-RPC only, same as the existing server.
9. **Logging stays compatible.** Reuse the existing logging utilities (`writeLogEntry`, `LOG_FILE_PATH`) so v2 logs land in the same `mcp_server.log` file the user already monitors.
10. **Tool descriptions matter.** The model will be reading them on every cold session — write them as crisp imperatives. Each `action` sub-mode in `pipeline` and `find` needs its own paragraph in the description so the router doesn't have to guess.
11. **Em-dashes are banned project-wide** per CLAUDE.md (corrupt in email clients downstream). Use commas or periods.
12. **Verify the DB path source is `mcp_server_config.json → database.path`.** This is documented in `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\CLAUDE.md`. Do not hardcode any other source.

---

## Reference: schema for the 3 tools (full)

### `pipeline`

```
description: "Pre-Crime workflow operations. One tool, four actions: status (read full system state), configure (update settings), next (atomically claim and hydrate the next work item), save (atomically persist all enrichment work for one item in a transaction). Use this for 90% of pipeline work. Returns hydrated objects with linked factlets and bookings, never raw records."

inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: ["status", "configure", "next", "save"]
    entity:
      type: string
      enum: ["client", "booking"]
      description: "For action=next only. Defaults to client."
    criteria:
      type: object
      description: "For action=next only. Optional filters (e.g. company, segment)."
    id:
      type: string
      description: "For action=save only. Client or booking ID."
    patch:
      type: object
      description: "For action=save or action=configure. See action-specific shapes."
  required: ["action"]
```

### `find`

```
description: "Read-only search across the Pre-Crime DB. action=clients|bookings|factlets|drafts. Defaults to summary records (slim) — pass summary:false only when you need full dossier/draft text. Default limit 10."

inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: ["clients", "bookings", "factlets", "drafts"]
    filters:
      type: object
      description: "action-specific. clients: company, name, segment, draftStatus, minDossierScore, contactGate. bookings: status, trade, search. factlets: sinceTimestamp, clientId. drafts: minScore."
    summary:
      type: boolean
      default: true
    limit:
      type: number
      default: 10
  required: ["action"]
```

### `trades`

```
description: "Fetch the canonical Leedz marketplace trade names from the Leedz API. Returns a sorted array of trade strings. Cached 10 minutes. The ONLY authoritative source for valid trades — never guess from training data."

inputSchema:
  type: object
  properties: {}
```

---

## Acceptance test (one-shot verification)

A single end-to-end test the implementing agent must run and pass:

```
1. node mcp_server_v2.js > /dev/null &
2. echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | nc localhost <port>
   → expect 3 tool entries
3. Start Goose with v2 enabled, run "run precrime"
   → expect: no -32002 errors, no auto-compaction trigger pre-bootstrap, init-wizard Step 0 succeeds
4. Run one full enrichment loop on a test client
   → expect: pipeline.next returns hydrated record, pipeline.save persists in one transaction, scored back to DB
```

If all 4 pass, the rewrite is done. Move to Phase 3.
