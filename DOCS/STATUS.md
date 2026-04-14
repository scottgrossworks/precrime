# Pre-Crime — Developer Status

**Read this first. Then CLAUDE.md. Then read files referenced here as needed. Do not glob or explore.**

---

## What Is Pre-Crime

Manifest-driven agentic enrichment engine. Enriches contacts, scores warmth, composes outreach drafts, evaluates quality. v2.0 adds Bookings: when scraped intel contains a gig opportunity (trade + date + location), a Booking is created. `leed_ready` bookings post to The Leedz marketplace.

**Glass-of-water model:**
- Client: `warmthScore ≥ 9` → draft → evaluator (6 criteria) → `ready` → outreach
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
| **Tools** | 19 tools | createLeed + reads |

Marketplace sharing is handled by the optional `plugins/leedz-share/` plugin — not shipped in core. When a Booking hits `leed_ready`, core Pre-Crime logs it and stops. The plugin skill calls the Leedz API Gateway directly via HTTP.

**NAMING:** The Leedz marketplace tool is `createLeed`. It calls the `addLeed` Lambda. There is a separate SSR Lambda also named `createLeed` — do not invoke it.

### DB Path Resolution

The blank SQLite ships pre-built in the zip at `data/myproject.sqlite` (schema already applied — no `prisma db push` at runtime).

**DB path is set by `precrime.bat` via the `DATABASE_URL` environment variable.** No config.json needed.

```
precrime                         → DATABASE_URL=file:<root>\data\myproject.sqlite
precrime ca_schools_migrated     → DATABASE_URL=file:<root>\data\ca_schools_migrated.sqlite
```

`precrime.bat` resolves the full path, sets `DATABASE_URL`, and launches Claude. The env var is inherited by the MCP server process. `mcp_server.js` reads `DATABASE_URL` from env; if not set, defaults to `data/myproject.sqlite`. `mcp_server_config.json` is logging/metadata only.

The startup prompt includes `(database: <filename>)` so the init-wizard knows which DB is active. If the DB is blank (0 clients), init-wizard tells the user they can re-launch with a different DB name. No restart loop, no config file edits.

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
| `templates/precrime.bat` | User-facing launcher. Sets DATABASE_URL from optional arg (default: myproject.sqlite), runs setup, launches Claude. THE ONLY THING THE USER RUNS. |
| `templates/setup.bat` | npm install + prisma generate. Called by precrime.bat. Never run manually. |
| `templates/docs/CLAUDE.md` | What Claude reads in deployed workspace. Uses `{{TOKEN}}` substitution. |
| `templates/skills/init-wizard.md` | Startup skill — config walkthrough, then launches harvesters + enrichment |
| `templates/skills/enrichment-agent.md` | Full enrichment loop (runs AFTER init-wizard) |
| `templates/skills/evaluator.md` | Draft evaluator + Booking completeness gate |
| `templates/skills/factlet-harvester.md` | RSS → factlet pipeline |
| `templates/skills/fb-factlet-harvester/SKILL.md` | Facebook → factlet pipeline (needs Chrome) |
| `templates/skills/reddit-factlet-harvester/SKILL.md` | Reddit → factlet pipeline (Python script) |
| `templates/skills/ig-factlet-harvester/SKILL.md` | Instagram → factlet pipeline (needs Chrome) |
| `templates/skills/x-factlet-harvester/SKILL.md` | X/Twitter → factlet pipeline (Grok + Chrome) |
| `templates/skills/source-discovery.md` | Discover FB pages, subreddits, X accounts, IG accounts, RSS feeds, directories |
| **Server (source of truth)** | |
| `server/mcp/mcp_server.js` | Pre-Crime MCP — 19 tools, registered as `precrime-mcp`, Prisma → SQLite |
| `server/prisma/schema.prisma` | Prisma 5 schema — Client, Booking, Factlet, Config |
| `server/package.json` | npm deps: @prisma/client 5.22.0, dotenv |
| **Docs** | |
| `DOCS/ONTOLOGY.md` | v2.0 entity model. Four output paths. Booking→addLeed param mapping. |
| `DOCS/DEPLOYMENT.md` | Full deployment reference |

All paths relative to PRECRIME source root.

---

## What's Done (sessions 1-9)

- All 19 MCP tools in `mcp_server.js`; `search_clients` extended with `warmthScore` / `minWarmthScore` / `maxWarmthScore` filters; MCP server registered as `precrime-mcp`
- All skill templates: init-wizard, enrichment-agent, evaluator, factlet-harvester, fb-factlet-harvester, reddit-factlet-harvester, ig-factlet-harvester, relevance-judge
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
- Leedz marketplace sharing extracted to optional plugin (`plugins/leedz-share/`) — core ships clean, no Leedz dependencies
- **The Leedz MCP `createLeed` verified** with session JWT

## What's Done (sessions 10-14, 2026-04-14)

### Warmth Scoring Recalibration
- `warmthScore` is a holistic 0-10 agent assessment, set by enrichment-agent Step 4.5. NOT deprecated — actively used alongside `dossierScore`.
- **Two independent gates required for draft composition:**
  1. Procedural gate: `contactGate === true AND dossierScore >= 5`
  2. Agent gate: `warmthScore >= 9`
- Both must pass. Either failing → `draftStatus = "brewing"`.
- **Two hard gates for warmthScore 9+:**
  1. Verified direct email (pattern-inferred caps at 8)
  2. Specific event/buying occasion signal (general fit caps at 8)
- Full 0-10 rubric documented in enrichment-agent.md Step 4.5 and wiki `concepts/scoring.md`.
- Applied across 13+ files: enrichment-agent, evaluator, CLAUDE.md template, STATUS.md, ONTOLOGY.md, etc.

### Reddit Harvester Restructure
- Moved from flat file (`reddit-factlet-harvester.md`) to folder pattern matching FB/IG:
  - `templates/skills/reddit-factlet-harvester/SKILL.md`
  - `templates/skills/reddit-factlet-harvester/reddit_sources.md`
- `deploy.js` updated: directory creation, skill copy, checklist
- `source-discovery.md` updated: reads from `reddit_sources.md`, writes to both `reddit_sources.md` (human-readable) and `reddit/reddit_config.json` (operational)
- `init-wizard.md` updated: Step 7.5 writes subreddits to `reddit_sources.md`; Step 8 launches reddit harvester in both sequences

### X/Twitter Factlet Harvester (NEW)
- New skill: `templates/skills/x-factlet-harvester/SKILL.md` + `x_sources.md`
- **Grok-first architecture.** Grok searches X's full index — zero API keys, zero fetch scripts. Chrome X search as fallback if Grok tab unavailable.
- Three source types: `@accounts`, `#hashtags`, `keyword: "search phrase"`
- Same four-path classification as all other harvesters
- 7-day recency window (tighter than Reddit/RSS 30 days — X content decays fast)
- Spam/bot filtering, Grok refusal handling (`GROK_REFUSED` logged and skipped)
- `deploy.js` updated: directory, copy, checklist
- `source-discovery.md` updated: Step 0 dedup baseline, new Step 4.5 (X/Twitter discovery), source growth cross-ref, run log
- `init-wizard.md` updated: Step 7.5 accepts X handles/hashtags, Step 8 launches X harvester in both sequences

### Draft Send Tracking — `sentAt` Field
- **Problem:** No connection between Gmail MCP send and Pre-Crime DB. After sending a draft, nothing automatically marked it as sent. Sent drafts stayed in `get_ready_drafts()` queue. Re-enrichment could overwrite them.
- **Schema change:** Added `sentAt DateTime?` to Client model (`server/prisma/schema.prisma`)
- **MCP server:** `sentAt` added to `update_client` inputSchema, allowedFields, and Date-parsing branch
- **Enrichment agent Step 6.5 rewritten:** Gmail send + `update_client({ draftStatus: "sent", sentAt: now })` are treated as atomic. Never call gmail send without the update_client that follows. If gmail send fails, leave as "ready". Manual sends also get `sentAt` stamped.
- **Schema change rule applies:** `blank.sqlite` and `migrate-db.js` must be updated before next build.

### Instagram Factlet Harvester (REWRITTEN)
- Rewrote `templates/skills/ig-factlet-harvester/SKILL.md` from instaloader/Python-based to **Chrome-primary**, matching FB harvester pattern exactly.
- Chrome MCP required (same as FB harvester). No Python script dependency. No `ig_harvest.py`.
- Source file: `ig_sources.md` with @accounts and #hashtags sections (unchanged, was already correct).
- SESSION_AI/Gemini pre-filter, activity screen, deep scrape, four-path classification all match FB/X/Reddit harvesters.
- `source-discovery.md` updated: Step 0 reads ig_sources.md for dedup, new Step 4.7 (Instagram discovery).
- `init-wizard.md` updated: Step 7.5 accepts IG handles/hashtags, Step 8 launches IG harvester in both sequences.
- `deploy.js` already had IG wiring (directory creation, config merge, skill copy entries) from prior sessions. No changes needed.

---

## BLOOMLEEDZ Deployment — Session 2026-04-13 (DISASTER LOG)

### What was attempted

Deploy PRECRIME into `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime` with 351 legacy school principals migrated from `BLOOMLEEDZ\precrime_4_13\data\ca_schools.sqlite`.

### Pipeline (user-defined, stated multiple times)

1. Migrate legacy DB at `BLOOMLEEDZ\precrime_4_13\data\ca_schools.sqlite` → `ca_schools_migrated.sqlite` in same folder
2. `build.bat` (no args) from `PRECRIME\` root → `dist\precrime-deploy-YYYYMMDD.zip`
3. Copy zip to `BLOOMLEEDZ\`, unzip → creates `BLOOMLEEDZ\precrime\`
4. Copy `ca_schools_migrated.sqlite` → `BLOOMLEEDZ\precrime\data\myproject.sqlite`
5. `cd precrime && precrime.bat`

### What was broken (5+ hours of user time burned)

**1. `migrate-db.js` PC_SCHEMA was stale.** Missing 4 Client columns (`segment`, `dossierScore`, `contactGate`, `intelScore`), entire `ClientFactlet` table, and `defaultBookingAction` on Config. Migrated DBs didn't match Prisma schema → runtime errors → precrime agent tried to auto-fix → wasted tokens.

**2. `blank.sqlite` was stale.** Missing `bookingScore`, `contactQuality` on Booking. Missing `dossierScore`, `contactGate`, `intelScore` on Client. Missing `ClientFactlet` table.

**3. `template.sqlite` was stale.** Missing `defaultBookingAction` on Config.

**4. Migration script had no WAL checkpoint.** Source DB had `-shm`/`-wal` files (unflushed writes). Script migrated without checkpointing → potential data loss. Output DB also produced `-shm`/`-wal` files. User caught both. Twice.

**5. Agent re-derived known paths from source code.** User had stated the exact directories across multiple sessions. Agent spent tokens reading manifest.json, deploy.js, build.bat to "figure out" a pipeline the user had already spelled out.

### What was fixed

- `scripts/migrate-db.js`: PC_SCHEMA updated to match Prisma schema exactly. ClientFactlet table added. WAL checkpoint added on source (Step 0) and target (Step 6d).
- `data/template.sqlite`: added `defaultBookingAction` to Config.
- `data/blank.sqlite`: added `dossierScore`, `contactGate`, `intelScore` to Client. Added `bookingScore`, `contactQuality` to Booking. Created `ClientFactlet` table. `defaultBookingAction` already present.
- Migrated DB produced: `BLOOMLEEDZ\precrime_4_13\data\ca_schools_migrated.sqlite` — 351 clients, 23 factlets, 1 config, all verified, WAL clean.

### Fuckups logged this session

- **#43**: Presented deployment pipeline as if learning it for the first time
- **#44**: Migrated without checkpointing WAL, then asked permission to re-run
- **#45**: Migration script doesn't checkpoint WAL on source or target
- **#46**: Edited BLOOMLEEDZ deployment copy of init-wizard.md instead of PRECRIME source (deployment is ephemeral)

### Root cause

The migration script and template DBs were written months ago and never updated when the Prisma schema evolved. Every schema change (adding `dossierScore`, `contactGate`, `intelScore`, `segment`, `ClientFactlet`, `defaultBookingAction`) was applied to `schema.prisma` but NOT to `migrate-db.js` PC_SCHEMA, NOT to `blank.sqlite`, and NOT fully to `template.sqlite`. The migration tool was untested against a real legacy DB with the current schema.

### Rule going forward

**When `schema.prisma` changes, three files MUST be updated in the same commit:**
1. `scripts/migrate-db.js` — PC_SCHEMA
2. `data/blank.sqlite` — ALTER TABLE or regenerate
3. `data/template.sqlite` — ALTER TABLE or regenerate

No schema change is complete until all three are in sync. See `FUCKUPS.md` in project root for full failure log.

**`sentAt` sync complete (2026-04-14):** All three files updated — `migrate-db.js` PC_SCHEMA, `blank.sqlite`, `template.sqlite`. No pending schema changes.

---

## DATABASE_URL Resolution Bug — Session 2026-04-14 (10+ iterations)

### Symptom

`get_config()` fails on first MCP call after fresh deploy. `echo $DATABASE_URL` in the Claude session shows `file:../data/template.sqlite` — a stale relative path pointing to a file that doesn't exist. Happened every rebuild for 10+ iterations.

### Root causes (TWO bugs, both required for failure)

**Bug 1: `templates/mcp.json` had `"env": {}`.**
When `.mcp.json` has `"env": {}`, Claude Code may launch the MCP server process with a stripped environment — the `DATABASE_URL` env var set by `precrime.bat` is not inherited. The MCP server starts with no DATABASE_URL at all.

**Bug 2: `mcp_server.js` imported PrismaClient BEFORE setting DATABASE_URL.**
`require('@prisma/client')` triggers dotenv loading at import time. If `server/.env` contains a stale relative path (e.g., `../data/template.sqlite` left by `deploy.js`), dotenv sets DATABASE_URL from that file BEFORE the fallback code on line 30 can set the correct absolute path. The fallback code was dead — it only ran when DATABASE_URL was unset, but dotenv had already set it.

### Fixes applied

1. **`templates/mcp.json`**: removed `"env": {}` from both server entries. Env vars now pass through to child processes naturally.

2. **`server/mcp/mcp_server.js`**: restructured top of file. DATABASE_URL is now resolved (with absolute path, quote stripping, and relative path resolution) BEFORE `require('@prisma/client')` on line 33. dotenv sees the var is already set and skips it.

3. **`server/mcp/mcp_server.js`**: added `fs.existsSync()` safety net after resolution. If the resolved DB path doesn't exist, falls back to `data/myproject.sqlite`. If that doesn't exist either, exits with a clear error message naming the exact path it tried.

### Why the stale `.env` existed

`deploy.js` line 310-314 generates `server/.env` with a RELATIVE path: `DATABASE_URL="file:../data/myproject.sqlite"`. This is correct relative to `server/`, but Prisma resolves `file:` paths relative to CWD, not `.env` location. `precrime.bat` overwrites this `.env` with an absolute path — but if Bug 1 stripped the env var, the MCP server fell back to dotenv, which loaded the stale `.env` value.

### Fuckups logged

- **#50**: Argued and explained instead of fixing
- **#51**: Read BLOOMLEEDZ deployment file with intent to edit it

---

## blank.sqlite Destruction & Rebuild — Session 2026-04-14 (13+ iterations, 5+ hours)

### What happened

This was a disaster. 13+ iterations across 5+ hours (past 2AM). Claude repeatedly failed to deliver a working build, compounding errors instead of fixing them.

### Timeline of failures

1. **DATABASE_URL bugs (iterations 1-10):** Two bugs in `mcp_server.js` and `templates/mcp.json` caused `get_config()` to fail on every fresh deploy. Documented above. Fixed, but only after 10+ iterations of arguing, explaining, and re-breaking.

2. **Stale blank.sqlite shipped (iteration 11):** After DATABASE_URL was fixed, `get_stats()` failed with "column main.Client.dossierScore does not exist." blank.sqlite was stale — missing columns added in recent schema changes. Claude had seen Glob return "No files found" for `data/*` and dismissed it instead of investigating. Told user to run `build.bat` anyway. Fuckup #52.

3. **Second deployment failure (iteration 12):** After verifying blank.sqlite had all 5 tables and correct columns, rebuilt and deployed. `get_stats()` failed again with "ClientFactlet table is missing." Root cause unclear — either the deployed Claude misdiagnosed or the build pipeline corrupted the DB.

4. **blank.sqlite destroyed (iteration 13):** Claude ran `rm -f data/blank.sqlite` to regenerate from scratch. `prisma db push` reported "already in sync" and "successfully reset" but produced a 0-byte file. Root cause: Prisma's relative `file:` path resolved to a different location than expected. The 0-byte file at the expected path was just what `rm` left behind.

5. **PowerShell syntax errors (iteration 13 continued):** While trying to regenerate blank.sqlite with an absolute path, Claude made repeated shell syntax errors — mixing bash and PowerShell, failing to escape `$env:` through the bash-to-PowerShell bridge. Fuckup #53.

6. **Resolution:** Wrote a `.ps1` script file to bypass the shell bridge entirely. Used absolute path `file:C:/Users/Scott/Desktop/WKG/PRECRIME/data/blank.sqlite`. `prisma db push --force-reset` succeeded. File: 53,248 bytes, all 5 tables verified with correct columns.

### Fuckups logged this session

- **#50**: Argued and explained instead of fixing
- **#51**: Read BLOOMLEEDZ deployment file with intent to edit it
- **#52**: Told user to run build.bat knowing blank.sqlite was missing
- **#53**: PowerShell syntax errors on env var — wasted tokens on 13th iteration

### Root cause (systemic)

Claude repeatedly violated its own rules: argued instead of fixing, dismissed red flags, made shell syntax errors it had been told not to make, edited deployment folders instead of source, and compounded failures by continuing after errors instead of stopping. The user lost confidence in Claude as a tool. Every "context compaction" erased prior corrections, causing the same mistakes to repeat. This session represents a total failure of the agent to follow its own documented rules.

### Lessons

1. **Shell bridge kills `$env:`** — bash eats `$`. For commands needing PowerShell env vars, write a `.ps1` file and run it with `powershell -File`.
2. **`prisma db push` with relative paths lies** — always use absolute paths for DATABASE_URL when targeting a specific file.
3. **"Already in sync" on a 0-byte file is a Prisma bug/misfeature** — verify file size after every `prisma db push`.
4. **Glob on Windows may fail silently** — when a directory listing returns "No files found" but the files exist, use PowerShell `Get-ChildItem` instead.

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
