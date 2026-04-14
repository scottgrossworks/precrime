---
title: Pre-Crime System Architecture
tags: [architecture, mcp, prisma, sqlite, leedz, data-flow]
source_docs: [DOCS/STATUS.md, DOCS/MCP_BRIEFING.md, DOCS/DEPLOYMENT.md, DOCS/EMAIL_FINDER.md]
last_updated: 2026-04-11
staleness: none
---

Pre-Crime is a manifest-driven agentic enrichment engine. It enriches contacts, scores warmth, composes outreach drafts, evaluates quality, and — in v2.0 — captures and posts gig opportunities to The Leedz marketplace. The system runs entirely on the user's machine via Claude Code with a local MCP server.

---

## Two MCP Servers — Do Not Conflate

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| **Purpose** | Enrichment pipeline DB | Marketplace CRUD |
| **File** | `server/mcp/mcp_server.js` | `FRONT_3\py\mcp_server\lambda_function.py` (AWS us-west-2) |
| **Transport** | Local stdin/stdout JSON-RPC 2.0 | Remote `POST /mcp` on API Gateway |
| **Backend** | Prisma 5 → SQLite | boto3 → existing Lambdas → DynamoDB |
| **Tools** | 19 tools | createLeed + reads (getTrades, getStats, getLeedz, getUser) |
| **Design doc** | `PRECRIME\README.md` | `FRONT_3\DOCS\AGENTIC_FUTURE.md` |

Marketplace sharing is handled by the optional `plugins/leedz-share/` plugin — not in core. When a Booking reaches `leed_ready`, core Pre-Crime logs and stops. The plugin calls the Leedz API Gateway directly via HTTP.

**CRITICAL NAMING:** The MCP tool is `createLeed`. It calls the `addLeed` Lambda. There is a separate SSR Lambda also named `createLeed` — never invoke that one.

---

## Pre-Crime MCP Architecture

```
Claude Code session
    |
    | stdin/stdout (JSON-RPC 2.0)
    |
server/mcp/mcp_server.js   (19 tools, precrime-mcp)
    |
    | PrismaClient (Prisma 5)
    |
data/myproject.sqlite
```

No HTTP server. No Express. Stdio transport only.

`claude -p` (headless) does NOT load `.mcp.json` — always use interactive mode.

---

## DB Path Resolution

The SQLite DB ships pre-built in the zip at `data/myproject.sqlite` (schema already applied — no `prisma db push` at runtime).

- MCP server config: `server/mcp/mcp_server_config.json` — key `database.path = "../data/myproject.sqlite"`
- Resolution: `path.resolve(__dirname, '..', config.database.path)` in `mcp_server.js:35`
- From `server/mcp/`, this resolves to root `data/myproject.sqlite`. Verified working.
- Prisma env: `server/.env` has `DATABASE_URL="file:../data/myproject.sqlite"` — relative to `server/`, also resolves to root `data/`.

---

## Prisma Version

Project uses **Prisma 5** (`@prisma/client` 5.22.0 in `server/package.json`). Schema uses `datasource db { url = env("DATABASE_URL") }` — Prisma 5 syntax.

**WARNING:** Prisma 7 breaks this. If the dev machine has Prisma 7 globally, always use local `npx prisma` from within `server/`.

---

## Harvester Architecture — Token-Zero Pattern

```
Harvest script (Python, zero Claude tokens)
    |
    | runs, fetches from platform (Reddit, RSS, Instagram, etc.)
    | dumps structured JSON to ./scrapes/{date}/
    |
Claude reads the JSON
    | classifies each item → four output paths
    | calls MCP tools to write results
    |
Pre-Crime MCP server
    | writes to SQLite
```

The script does the fetch. Claude does the classification. This keeps token costs low for high-volume sources.

Facebook and Instagram use a different variant (browser-based via Chrome MCP extension) when public JSON endpoints are unavailable.

---

## Data Flow: Full Pipeline

```
manifest.json (deployment config)
    ↓ deploy.js (or build.bat for zip distribution)
Workspace scaffolded:
  .mcp.json → wires Claude Code to Pre-Crime MCP
  server/mcp/mcp_server_config.json → DB path
  server/.env → DATABASE_URL
  rss/rss-scorer-mcp/rss_config.json → feeds + keywords
  reddit/reddit_config.json → subreddits + keywords
  ig/ig_config.json → accounts + hashtags
  skills/*.md → enrichment-agent, init-wizard, evaluator, harvesters
    ↓
precrime.bat → setup.bat (npm install + prisma generate) → claude --dangerously-skip-permissions "run precrime"
    ↓
init-wizard.md skill:
  Step -1: get_config() health check
  Step 1-4: confirm business config
  Step 5a: generate leedzSession JWT
  Step 5b: discover harvest sources
  Step 6: auto-launch harvesters + enrichment-agent
    ↓
enrichment-agent.md skill: per-client enrichment loop
  → discover → scrape → warmth score → draft → evaluate
  → draftStatus: "ready" → outreach
    ↓
leed_ready Booking → logged, stop (optional: plugins/leedz-share/)
```

---

## Skill Files

All skills live in `templates/skills/` (source) and are copied/token-substituted into the workspace by `deploy.js`.

| Skill | Purpose |
|-------|---------|
| `init-wizard.md` | Startup — config walkthrough + auto-launch |
| `enrichment-agent.md` | Full enrichment loop (runs after init-wizard) |
| `evaluator.md` | Draft evaluator + Booking completeness gate |
| `factlet-harvester.md` | RSS → factlet pipeline |
| `fb-factlet-harvester/SKILL.md` | Facebook → factlet pipeline (needs Chrome) |
| `reddit-factlet-harvester/SKILL.md` | Reddit → factlet/lead pipeline (Python script) |
| `ig-factlet-harvester.md` | Instagram → factlet/lead pipeline (TBD approach) |
| `x-factlet-harvester/SKILL.md` | X/Twitter → factlet/lead pipeline (Grok + Chrome) |
| `relevance-judge.md` | Scores relevance of harvested content |
| `email-finder.md` | 5-phase direct-email hunt invoked by enrichment-agent Step 3.6 |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `deploy.js` | Manifest-driven workspace generator. `--no-install` flag skips npm/prisma. |
| `build.bat` | Zero args → `dist/precrime-deploy-YYYYMMDD.zip` |
| `manifest.json` | Default manifest — edit per deployment |
| `manifest.sample.json` | Annotated template with all fields and comments |
| `data/blank.sqlite` | Pre-built blank DB. Copied into zip as `data/myproject.sqlite`. |
| `templates/precrime.bat` | User-facing launcher. The ONLY thing the user runs. |
| `templates/setup.bat` | npm install + prisma generate. Called by precrime.bat. Never run manually. |
| `templates/docs/CLAUDE.md` | What Claude reads in deployed workspace. Uses `{{TOKEN}}` substitution. |
| `server/mcp/mcp_server.js` | Pre-Crime MCP — 19 tools, registered as `precrime-mcp`, Prisma → SQLite |
| `server/prisma/schema.prisma` | Prisma 5 schema — Client, Booking, Factlet, Config |
| `server/package.json` | npm deps: @prisma/client 5.22.0, dotenv |

All paths relative to PRECRIME source root.

---

## Related
- [[ontology]] — entity definitions, output paths, design rules
- [[mcp]] — all 19 MCP tools, configuration details
- [[deployment]] — build system, end-user flow, file inventory
- [[email-finder]] — direct-email hunt sub-skill
- [[current]] — current project state
