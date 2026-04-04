# Pre-Crime — Developer Status

**Read this first. Then read files referenced here as needed. Do not glob or explore.**

---

## What Is Pre-Crime

Agentic enrichment engine. Enriches contacts, scores warmth, composes outreach drafts, evaluates quality. v2.0 adds Bookings: when scraped intel contains a gig opportunity (trade + date + location), a Booking is created. `leed_ready` bookings post to The Leedz marketplace.

**Glass-of-water model:**
- Client: `warmthScore ≥ 5` → draft → evaluator (5 criteria) → `ready` → outreach
- Booking: `trade` + `startDate` + (`location` OR `zip`) → `leed_ready` → post to marketplace

---

## Two MCP Servers

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| **Purpose** | Enrichment pipeline DB | Marketplace CRUD |
| **File** | `server/mcp/mcp_server.js` | Remote Lambda |
| **Transport** | Local stdin/stdout | Remote `POST /mcp` on API Gateway |
| **Backend** | Prisma → SQLite | DynamoDB |
| **Tools** | 15 tools | createLeed + reads |

The bridge: Pre-Crime calls The Leedz MCP `createLeed` when a Booking hits `leed_ready`. `Booking.leedId` stores the returned marketplace ID.

**NAMING:** The MCP tool is `createLeed`. It calls the `addLeed` Lambda. There is a separate SSR Lambda also named `createLeed` — do not invoke it.

---

## What's Done

- **Pre-Crime MCP** — 15 tools in `mcp_server.js`. Schema: Client, Booking, Factlet, Config (all v2.0 fields including `segment`, `leedzEmail`, `leedzSession`).
- **`server/prisma/schema.prisma`** — v2.0 schema lives in PRECRIME source. deploy.js copies it automatically.
- **`server/package.json`** — exists in PRECRIME source. deploy.js copies it during build.
- **`build.bat`** — Usage: `build.bat` (no args). Runs `deploy.js --no-install` into a temp staging dir, copies `templates/setup.bat` into workspace root, zips as `dist/precrime-deploy-YYYYMMDD.zip` with `precrime/` folder at zip root.
- **`templates/setup.bat`** — Infra bootstrap: npm install + prisma generate + db push. Included in every zip. **Run automatically by init-wizard Step -1** — user never runs it manually.
- **`deploy.js --no-install` flag** — Skips all npm/prisma steps during build (node_modules are platform-specific; target machine runs `setup.bat`).
- **`templates/docs/CLAUDE.md`** — uses `{{DB_RELATIVE_PATH}}` (relative to workspace root). Never an absolute path.
- **`DOCS/DEPLOYMENT.md`** — full deployment reference: auto-steps, manual steps, troubleshooting.
- **`README.md`** — updated to v2.0: 15 tools, Booking schema, end-user flow.
- **deploy.js path fix** — `mcp_server_config.json` DB path corrected to `../data/` relative from `server/mcp/`. Committed `774d158`.
- **Booking Completeness Evaluator** — `templates/skills/evaluator.md`. Gate: `trade` + `startDate` + (`location` OR `zip`) → `leed_ready`. Handoff to share-skill.md on leed_ready.
- **Harvester four output paths** — classification tree in `enrichment-agent.md`, `factlet-harvester.md`, `fb-factlet-harvester/SKILL.md`.
- **JWT setup in init-wizard** — `init-wizard.md` Step 5a generates PyJWT token, writes `leedzEmail` + `leedzSession` to Config.
- **The Leedz MCP Phase 1** — `getTrades`, `getStats`, `getLeedz`, `getUser`, `createLeed` all implemented.
- **`share_booking` tool** — in `mcp_server.js`. Agent calls `share_booking({ id })`. Server fetches Booking + Client, lowercases trade, converts startDate → epoch ms, enforces lc/zip constraint, POSTs JSON-RPC to Leedz MCP endpoint, updates Booking on success.
- **`precrime.bat` launcher** — runs `setup.bat` before Claude starts (first run only), so MCP servers connect on first launch. Eliminates the mandatory restart that happened when setup.bat ran mid-session after MCP had already failed to connect.
- **Init wizard Step -1 simplified** — no longer runs setup.bat (precrime.bat handles it). Just verifies MCP tools are connected. If not, tells user to run precrime.bat. No diagnosing, no manual server starts.

---

## Key Files

| File | Purpose |
|------|---------|
| `DOCS/ONTOLOGY.md` | v2.0 entity model. Four output paths. Booking→addLeed param mapping. |
| `server/mcp/mcp_server.js` | Pre-Crime MCP — 15 tools, Prisma → SQLite |
| `server/prisma/schema.prisma` | v2.0 Prisma schema — Client, Booking, Factlet, Config |
| `server/package.json` | npm deps: @prisma/client, dotenv |
| `templates/skills/evaluator.md` | Draft evaluator + Booking completeness gate |
| `templates/skills/init-wizard.md` | Conversational setup — generates JWT, writes leedzEmail/leedzSession |
| `templates/skills/share-skill.md` | leed_ready sharing: leedz_api / email_share / email_user |
| `templates/skills/enrichment-agent.md` | Full enrichment loop |
| `deploy.js` | Manifest-driven workspace generator. `--no-install` skips npm/prisma (used by build.bat). |
| `build.bat` | `build.bat` → `dist/precrime-deploy-YYYYMMDD.zip` with `precrime/` at zip root |
| `templates/precrime.bat` | **User-facing launcher.** Runs setup.bat on first run, then launches Claude. This is what the user runs — never setup.bat directly, never claude directly. |
| `templates/setup.bat` | Infra bootstrap (npm + prisma). Called by precrime.bat on first run. Never run manually. |
| `DOCS/DEPLOYMENT.md` | Full deployment reference |
| `manifest.json` | Default manifest — edit this for your deployment |
| `manifest.sample.json` | Annotated manifest template with all fields and comments |

All PRECRIME paths relative to the PRECRIME source root.

---

## End-User Deployment Workflow

```
# Build a distributable zip (from PRECRIME root):
build.bat
# → dist\precrime-deploy-YYYYMMDD.zip

# On target machine:
# 1. Unzip → get precrime\ folder
# 2. cd precrime
# 3. precrime
# 4. Say: start the precrime workflow
```

### Why `precrime.bat` exists — this is not bloat

The MCP connection problem is a hard sequencing constraint, not a preference:

1. Claude Code reads `.mcp.json` **at startup** and tries to connect MCP servers immediately.
2. On first run, `node_modules/` doesn't exist yet. The MCP server requires `@prisma/client`. Connection fails silently.
3. The init wizard runs `setup.bat` which installs deps — but MCP is already dead for this session. There is no mid-session reconnect.
4. Without `precrime.bat`, the user must: run Claude → setup runs → Claude says "restart me" → user closes → runs Claude again → says "start precrime" again. Two launches, one wasted session, confusing for a non-technical user.

`precrime.bat` solves this by running `setup.bat` **before** Claude starts (only on first run — it checks for `node_modules`). By the time Claude reads `.mcp.json`, the Prisma client exists and MCP connects on the first attempt.

This is 15 lines of batch script. It eliminates an entire failure mode and a mandatory restart. It's not abstraction — it's sequencing.

---

## Marketplace Wire-Up — share_booking end-to-end test

`share_booking` tool is in `mcp_server.js`. To test end-to-end:

1. Set `leedzSession` + `leedzEmail` in Config (init wizard Step 5a)
2. Set `marketplaceEnabled: true` in Config
3. Create a `leed_ready` Booking with: `trade`, `title`, `startDate`, `zip`, `location`
4. Call `share_booking({ id: bookingId })`
5. Verify Booking status → `shared`, `leedId` is set

Use a non-production trade (e.g., `tennis`) for testing to avoid broadcasting to real vendors.
