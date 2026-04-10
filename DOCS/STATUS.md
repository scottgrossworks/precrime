# Pre-Crime — Developer Status

**Read this first. Then CLAUDE.md. Then read files referenced here as needed. Do not glob or explore.**

---

## What Is Pre-Crime

Manifest-driven agentic enrichment engine. Enriches contacts, scores warmth, composes outreach drafts, evaluates quality. v2.0 adds Bookings: when scraped intel contains a gig opportunity (trade + date + location), a Booking is created. `leed_ready` bookings post to The Leedz marketplace.

**Glass-of-water model:**
- Client: `warmthScore ≥ 5` → draft → evaluator (5 criteria) → `ready` → outreach
- Booking: `trade` + `startDate` + (`location` OR `zip`) → `leed_ready` → post to marketplace

---

## Architecture

### Two MCP Servers

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| **Purpose** | Enrichment pipeline DB | Marketplace CRUD |
| **File** | `server/mcp/mcp_server.js` | Remote Lambda |
| **Transport** | Local stdin/stdout | Remote `POST /mcp` on API Gateway |
| **Backend** | Prisma 5 → SQLite | DynamoDB |
| **Tools** | 15 tools | createLeed + reads |

The bridge: Pre-Crime calls The Leedz MCP `createLeed` when a Booking hits `leed_ready`. `Booking.leedId` stores the returned marketplace ID.

**NAMING:** The MCP tool is `createLeed`. It calls the `addLeed` Lambda. There is a separate SSR Lambda also named `createLeed` — do not invoke it.

### DB Path Resolution

The blank SQLite ships pre-built in the zip at `data/myproject.sqlite` (schema already applied — no `prisma db push` at runtime).

MCP server resolves DB path via: `path.resolve(__dirname, '..', config.database.path)` in `mcp_server.js:35`. From `server/mcp/`, with config value `../data/myproject.sqlite`, this resolves to root `data/myproject.sqlite`. Verified working.

`server/.env` has `DATABASE_URL="file:../data/myproject.sqlite"` — relative to `server/`, also resolves to root `data/`.

### Prisma Version

Project uses **Prisma 5** (`@prisma/client` 5.22.0 in `server/package.json`). The schema uses `datasource db { url = env("DATABASE_URL") }` which is Prisma 5 syntax. **Prisma 7 breaks this** — if the dev machine has Prisma 7 globally, always use the local `npx prisma` from within `server/`.

---

## Build → Deploy → Run

### Developer builds the zip

```
cd PRECRIME
build.bat
# → dist\precrime-deploy-YYYYMMDD.zip
```

`build.bat` runs `deploy.js --no-install` → copies `templates/setup.bat` + `templates/precrime.bat` → zips with `precrime/` at root. The `--no-install` flag skips npm/prisma (node_modules are platform-specific). The blank DB (`data/blank.sqlite`) is copied into the zip as `data/myproject.sqlite`.

### End user runs precrime

```
# 1. Unzip → get precrime\ folder
# 2. cd precrime
# 3. precrime
```

That's it. Three steps. Nothing else.

### What `precrime.bat` does

1. Runs `setup.bat` unconditionally (idempotent — fast if already done)
2. Launches `claude --dangerously-skip-permissions "run precrime"`

Setup = `npm install` + `npx prisma generate`. Two commands. No `prisma db push` (DB ships pre-built). No permission dialogs. The "run precrime" prompt triggers the startup skill automatically.

### Why `precrime.bat` exists — hard sequencing constraint

Claude Code reads `.mcp.json` at startup and connects MCP servers immediately. On first run, `node_modules/` doesn't exist — MCP connection fails silently. There is no mid-session reconnect. `precrime.bat` runs setup BEFORE Claude starts. By the time Claude reads `.mcp.json`, deps exist, DB exists, MCP connects first try. Without it: two launches, one wasted session, user confusion.

---

## Key Files

| File | Purpose |
|------|---------|
| **Build & Deploy** | |
| `deploy.js` | Manifest-driven workspace generator. Reads `manifest.json`, substitutes `{{TOKENS}}`, copies files. `--no-install` skips npm/prisma. |
| `build.bat` | `build.bat` (no args) → `dist/precrime-deploy-YYYYMMDD.zip` |
| `manifest.json` | Default manifest — edit for each deployment |
| `manifest.sample.json` | Annotated template with all fields and comments |
| `data/blank.sqlite` | Pre-built blank DB with schema. Copied into zip as `data/myproject.sqlite`. |
| **Templates (copied into zip)** | |
| `templates/precrime.bat` | User-facing launcher. Runs setup, launches Claude with prompt. THE ONLY THING THE USER RUNS. |
| `templates/setup.bat` | npm install + prisma generate. Called by precrime.bat. Never run manually. |
| `templates/docs/CLAUDE.md` | What Claude reads in deployed workspace. Uses `{{TOKEN}}` substitution. |
| `templates/skills/init-wizard.md` | Startup skill — config walkthrough, then launches harvesters + enrichment |
| `templates/skills/enrichment-agent.md` | Full enrichment loop (runs AFTER init-wizard) |
| `templates/skills/evaluator.md` | Draft evaluator + Booking completeness gate |
| `templates/skills/share-skill.md` | leed_ready → leedz_api / email_share / email_user |
| `templates/skills/factlet-harvester.md` | RSS → factlet pipeline |
| `templates/skills/fb-factlet-harvester/SKILL.md` | Facebook → factlet pipeline (needs Chrome) |
| **Server (source of truth)** | |
| `server/mcp/mcp_server.js` | Pre-Crime MCP — 15 tools, Prisma → SQLite |
| `server/prisma/schema.prisma` | Prisma 5 schema — Client, Booking, Factlet, Config |
| `server/package.json` | npm deps: @prisma/client 5.22.0, dotenv |
| **Docs** | |
| `DOCS/ONTOLOGY.md` | v2.0 entity model. Four output paths. Booking→addLeed param mapping. |
| `DOCS/DEPLOYMENT.md` | Full deployment reference |

All paths relative to PRECRIME source root.

---

## What's Done (sessions 1-9)

- All 15 MCP tools in `mcp_server.js` including `share_booking`; `search_clients` extended with `warmthScore` / `minWarmthScore` / `maxWarmthScore` filters
- All skill templates: init-wizard, enrichment-agent, evaluator, share-skill, factlet-harvester, fb-factlet-harvester, reddit-factlet-harvester, ig-factlet-harvester, relevance-judge
- `deploy.js` with `--no-install` flag and correct path resolution
- `build.bat` — zero args, handles staging/zipping/cleanup
- `precrime.bat` — setup + Claude launch + auto-prompt + skip-permissions
- `setup.bat` — npm install + prisma generate (no db push — DB ships pre-built)
- Blank template DB (`data/blank.sqlite`) — schema pre-applied, no runtime DB creation
- DB path bug fixed: `mcp_server_config.json` correctly uses `../data/` relative to `server/mcp/`
- All personal data scrubbed (no BLOOMLEEDZ, no TDS, no Scott Gross, no scottgrossworks)
- The Leedz MCP Phase 1: getTrades, getStats, getLeedz, getUser, createLeed
- JWT generation in init-wizard Step 5a
- Booking completeness evaluator with four output paths
- **End-to-end test passed**: unzip → `precrime` → MCP connected, init-wizard ran, enrichment launched
- **`share_booking` verified**: `leed_ready` Booking → `shared` + `leedId` set — leed posted to marketplace
- **The Leedz MCP `createLeed` verified** with session JWT

---

## Pending

- **Fine-tuning**: workflow live. Ongoing refinement only.
- **Token optimization**: strategies 1–7 implemented (session 9). Strategy 8 (Gemini bulk pre-filter) partially implemented in factlet-harvester. See `DOCS/OPTIMIZATION.md`.

---

## Critical Design Decisions — DO NOT UNDO

1. **Blank DB ships in zip.** No `prisma db push` at runtime. The DB exists from the moment of unzip. This eliminates the "table does not exist" class of errors entirely.

2. **`precrime.bat` runs setup BEFORE Claude.** MCP connects at Claude startup. If deps don't exist, MCP fails silently with no mid-session recovery. Setup must happen before Claude launches. This is a hard constraint of Claude Code's architecture.

3. **`precrime.bat` runs setup unconditionally.** No `if not exist node_modules` check. Setup is idempotent. Conditional checks add failure modes for zero benefit.

4. **`precrime.bat` passes `--dangerously-skip-permissions` and pre-seeds prompt.** User types one word (`precrime`). No permission dialogs. No "say start the workflow." Everything is automatic.

5. **No engineer language in user-facing text.** Never say "initialization", "wizard", "configure", "deployment", "infrastructure", "bootstrap". The CLAUDE.md and init-wizard.md enforce this. Claude mirrors the language it reads.

6. **Init wizard Step -1 does NOT diagnose.** If `get_config()` fails for any reason, it says "run precrime again" and stops. One sentence. No reading files, no checking paths, no running npm.

7. **Fix the source. Never fix deployments.** `PRECRIME\` is the source. `TDS\`, and any other deployed instance, are deployments. Bug fixes go in `PRECRIME\server\` only. Deployments are rebuilt from source via `build.bat`. Never edit a deployment directory — not even when the error message shows a deployment file path as diagnostic context.
