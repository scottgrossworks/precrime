# Pre-Crime — Session Status

**Last updated:** 2026-04-02 (session 2)
**Read this first. Then read files referenced here as needed. Do not glob or explore.**

---

## What Is Pre-Crime

Agentic enrichment engine. Enriches contacts, scores warmth, composes outreach drafts, evaluates quality. v2.0 adds Bookings: when scraped intel contains a gig opportunity (trade + date + location), a Booking is created. `leed_ready` bookings post to The Leedz marketplace.

**Glass-of-water model:**
- Client: `warmthScore ≥ 5` → draft → evaluator (5 criteria) → `ready` → outreach
- Booking: `trade` + `startDate` + (`location` OR `zip`) → `leed_ready` → post to marketplace

Reference deployment: BloomLeedz (`C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ`) — 351 LA school principals, outreach-only mode.

---

## Two MCP Servers

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| **Purpose** | Enrichment pipeline DB | Marketplace CRUD |
| **File** | `PRECRIME\server\mcp\mcp_server.js` | `LEEDZ\FRONT_3\py\mcp_server\lambda_function.py` |
| **Transport** | Local stdin/stdout | Remote `POST /mcp` on API Gateway |
| **Backend** | Prisma → SQLite | boto3 → Lambdas → DynamoDB |
| **Status** | 15 tools written, schema update in progress | Phase 1 reads + `createLeed` implemented |

The bridge: Pre-Crime calls The Leedz MCP `createLeed` (→ `addLeed` Lambda) when a Booking hits `leed_ready`. `Booking.leedId` stores the returned marketplace ID.

**NAMING:** The MCP tool is `createLeed`. It calls the `addLeed` Lambda. There is a separate SSR Lambda also named `createLeed` — do not invoke it.

---

## What's Done

- **Pre-Crime MCP** — 15 tools in `mcp_server.js`. Prisma schema update in progress (subprocess per `DOCS\MCP_BRIEFING.md`).
- **Booking Completeness Evaluator** — `templates\skills\evaluator.md`. Gate: `trade` + `startDate` + (`location` OR `zip`) → `leed_ready`.
- **The Leedz MCP Phase 1** — `getTrades`, `getStats`, `getLeedz`, `showUserPage` (DDB direct, returns JSON). urllib3 → boto3 internal invocations.
- **The Leedz MCP `createLeed`** — session JWT decoded → email → `addLeed` Lambda via boto3 with authorizer context. Auto-creates user if new. Defaults `sh="*"` (broadcast).
- **`AGENTIC_FUTURE.md` corrected** — `createLeed` tool calls `addLeed` Lambda. Naming clarified.
- **`MCP_BRIEFING.md` updated** — Config schema now includes `leedzEmail` and `leedzSession` fields.
- **Pre-Crime repo committed** — `24f7710`: DOCS/, IG/Reddit harvesters, booking MCP stats, leedzEmail/leedzSession, scrapes/.gitignore.

---

## The Leedz MCP Endpoint Testing (2026-04-02)

| Tool | Status | Notes |
|------|--------|-------|
| `tools/list` | PASSED | 5 tools returned |
| `getTrades` | PASSED | 36 trades, DJ=8 leedz |
| `getStats` | PASSED | 458 posted, 15 bought, 115 users |
| `getLeedz` | PASSED | sb="dj" → 4 unsold leedz |
| `showUserPage` | FIX DEPLOYED, RETEST | Decimal serialization bug fixed, redeployed |
| `createLeed` | NOT TESTED | Needs session JWT + test params |

**Bug fix:** `showUserPage` failed with `Decimal is not JSON serializable`. DynamoDB returns `Decimal` for numeric fields. Added `from decimal import Decimal` and Decimal-safe `default` to `json.dumps()` in `call_showUserPage`. Redeployed by user.

---

## In Progress

| Track | What |
|-------|------|
| **MCP Endpoint Testing** | 3 of 5 tools passed. `showUserPage` fix deployed, retest needed. `createLeed` untested. Session JWT available for `scottgrossworks@gmail.com`. |
| Subprocess | Pre-Crime MCP schema + code fixes per `DOCS\MCP_BRIEFING.md`. `leedzEmail` + `leedzSession` added to schema, pushed to SQLite. Prisma client regen pending (DLL lock — run `npx prisma generate` from standalone shell). |

---

## TODOs

### ~~TODO 1: Harvester Four-Output-Path Classification~~ DONE (2026-04-02 session 2)
Four-path classification tree added to `enrichment-agent.md`, `factlet-harvester.md`, `fb-factlet-harvester/SKILL.md`.
New files: `templates\skills\share-skill.md` (all sharing logic), `templates\skills\init-wizard.md` (conversational setup).
Init wizard: deployment mode question, getTrades API call, WHERE to harvest discovery, auto-launch harvesters.
Evaluator: simplified — hands off to share-skill.md on leed_ready.

### TODO 2: Session JWT Setup in Pre-Crime Config
Pre-Crime doesn't know the user's Leedz email. Setup skill must prompt for it, generate a session JWT, write both to Config (`leedzEmail`, `leedzSession`). `addLeed` auto-creates a stub user if email is new to platform.
- JWT: `{'email': leedzEmail, 'type': 'session', 'exp': +1yr}` signed HS256
- Secret: `648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c`
- Add as Step 5a in `init-wizard.md` (already present — verify it generates and writes the JWT)

### TODO 3: Action Decision + Marketplace Posting Wire-Up
`share-skill.md` is written and handles all paths. Wire `deploy.js` to copy it into new deployments.
Verify `createLeed` MCP tool end-to-end with a test Booking.
**Depends on:** TODO 2 (needs leedzSession in Config for leedz_api path)

---

## Key Files

| File | Purpose |
|------|---------|
| `DOCS\ONTOLOGY.md` | v2.0 entity model. Four output paths. Booking→addLeed param mapping. |
| `DOCS\MCP_BRIEFING.md` | Subprocess: Pre-Crime MCP schema completion |
| `server\mcp\mcp_server.js` | Pre-Crime MCP — 15 tools, Prisma → SQLite |
| `templates\skills\evaluator.md` | Draft evaluator + Booking completeness gate |
| `templates\skills\enrichment-agent.md` | Full enrichment loop (needs TODO 1 + TODO 3) |
| `LEEDZ\FRONT_3\py\mcp_server\lambda_function.py` | The Leedz MCP — Phase 1 + createLeed |
| `LEEDZ\FRONT_3\DOCS\AGENTIC_FUTURE.md` | The Leedz MCP design spec |
| `deploy.js` | Manifest-driven workspace generator |

All PRECRIME paths relative to `C:\Users\Scott\Desktop\WKG\PRECRIME\`.
