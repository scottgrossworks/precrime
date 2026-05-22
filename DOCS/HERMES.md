# Hermes Integration — Pre-Crime Pipeline

**Last updated: 2026-04-17 (day 3 of integration — still debugging)**

## What This Is

Hermes is an alternative AI orchestrator (by Nous Research) that runs the Pre-Crime pipeline using Gemini 2.5 Flash via OpenRouter. It replaces Claude as the agent but uses the same MCP tools, same database, and same Prisma schema.

Hermes runs inside Docker. No WSL, no Python version hell, no manual pip installs.

---

## Current Status (2026-04-17)

**WORKING:**
- Docker image builds cleanly (Ubuntu 24.04 + Python 3.12 + Node 20 + Hermes git clone)
- Hermes boots, loads personality, connects to OpenRouter (Gemini 2.5 Flash)
- `precrime-mcp` MCP server connects, tools register, reads work
- Tavily web search (`web_search`, `web_extract`) configured and usable

**BLOCKERS RESOLVED:**
- SQLite writes hang on Windows volume mount (SQLite WAL mode requires memory-mapped I/O that does not work across Windows→WSL2→Linux-container boundary). Fix: entrypoint.sh copies the DB from the Windows bind mount into the container-native `/db/` directory on startup, `DATABASE_URL` points at `/db/myproject.sqlite`, and an EXIT trap syncs the DB back to Windows on container shutdown.
- `browser_console` (Hermes built-in browser tool) gets triggered by skill "mode detection" steps that check for Chrome. Fix: SOUL.md explicitly bans all browser tools and tells Hermes to skip every Chrome detection step entirely.
- `mcporter` CLI reference in init-wizard/enrichment-agent skill steps (Claude-specific). Fix: SOUL.md tells Hermes to skip all mcporter/RSS verification steps that say "if this fails, STOP."
- Skill closing line hardcoded to "Can I show it to you over Zoom?" (BloomLeedz holdover). Fix: SOUL.md overrides — closing line always comes from DOCS/VALUE_PROP.md of the active deployment.

**OPEN:**
- RSS MCP server (`precrime-rss`) crashes at startup with `ENOENT: /precrime/rss/rss-scorer-mcp/rss_config.json`. Under investigation — the file IS present in the deployment folder. Most likely cause: hermes.bat was run from the PRECRIME build directory instead of the deployment folder, so the wrong directory was mounted as `/precrime`. A diagnostic `ls` was added to entrypoint.sh to confirm on next run.
- Facebook/LinkedIn scraping: skipped in headless Docker (no Chrome). `SCRAPE_SKIPPED_HEADLESS` logged and harvest proceeds without.
- End-to-end enrichment run not yet completed.

---

## Architecture

### Shared Layer (Claude and Hermes both use this)

| What | Where |
|---|---|
| MCP server (19 tools) | `server/mcp/mcp_server.js` |
| RSS MCP server | `rss/rss-scorer-mcp/index.js` |
| Prisma schema | `server/prisma/schema.prisma` |
| SQLite database | `data/myproject.sqlite` (in the deployment folder) |
| Skill playbooks | `skills/` (in the deployment folder) |

### Hermes-Only Layer (lives in `docker/`, never touches shared layer)

| What | Where |
|---|---|
| Hermes config (model, MCP wiring, personality) | `docker/hermes-config.yaml` |
| Agent soul / behavior rules / Docker overrides | `docker/SOUL.md` |
| Precrime startup skill (Hermes format) | `docker/skills/precrime/precrime-skill/SKILL.md` |
| Container entrypoint script | `docker/entrypoint.sh` |

### Deployment Layer (per-deployment, not in PRECRIME source)

| What | Where (example: PHOTOBOOTH) |
|---|---|
| Windows launcher | `PHOTOBOOTH\precrime\hermes.bat` |
| Database | `PHOTOBOOTH\precrime\data\myproject.sqlite` |
| Product identity | `PHOTOBOOTH\precrime\DOCS\VALUE_PROP.md` |
| Skills (Claude-format) | `PHOTOBOOTH\precrime\skills\` |
| Source URLs | `PHOTOBOOTH\precrime\skills\fb-factlet-harvester\fb_sources.md`, etc. |

---

## How It Differs From precrime.bat + Claude

| | precrime.bat + Claude | Docker + Hermes |
|---|---|---|
| AI doing the work | Claude (Anthropic) | Gemini 2.5 Flash (OpenRouter) |
| Agent runtime | Claude Code CLI | Hermes Python agent in Docker |
| MCP server started by | precrime.bat (Windows) | entrypoint.sh (inside container) |
| Database location at runtime | Windows path direct | Container `/db/` with sync on exit |
| Runs on | Windows + WSL | Anywhere Docker runs |
| Chrome / browser scraping | Yes (via Claude-in-Chrome MCP) | No (headless) |

---

## hermes.bat — Run From the Deployment Folder

**The hermes.bat file lives in each deployment folder (copied by robocopy/build).**
**You MUST run it from inside that folder, because it uses `%CD%` as the Docker volume mount source.**

```bat
@echo off
docker run -it --rm ^
  -e OPENROUTER_API_KEY=... ^
  -e TAVILY_API_KEY=... ^
  -v "%CD%:/precrime" ^
  hermes-precrime
```

Correct usage:
```
cd C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime
.\hermes.bat
```

If you run it from `C:\Users\Admin\Desktop\WKG\PRECRIME` instead, you will mount the source folder (no database, no deployment skills, no rss_config.json) and everything will crash. The entrypoint now prints `RSS config found OK` or a warning naming the exact problem.

---

## API Keys

Stored in each deployment's `hermes.bat` and passed as runtime environment variables. Never baked into the image.

| Key | Variable | Used For |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | Gemini 2.5 Flash LLM calls |
| Tavily | `TAVILY_API_KEY` | `web_search` and `web_extract` |

Backup of all keys: `C:\Users\Admin\Desktop\hermes-save\.env`.

---

## Build the Image

Run from PRECRIME (only place the Dockerfile and docker/ directory exist):

```
cd C:\Users\Admin\Desktop\WKG\PRECRIME
docker build -t hermes-precrime .
```

Rebuild is required when you change any of:
- `Dockerfile`
- `docker/hermes-config.yaml`
- `docker/SOUL.md`
- `docker/entrypoint.sh`
- `docker/skills/precrime/precrime-skill/SKILL.md`

No rebuild needed for changes to deployment folders (skills, VALUE_PROP.md, data, hermes.bat) — those are mounted live.

---

## Run Hermes (Example: PHOTOBOOTH deployment)

```
cd C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime
.\hermes.bat
```

Then, at the Hermes prompt:
```
run enrichment
```

---

## entrypoint.sh — What Happens at Startup

1. Wires OPENROUTER_API_KEY and TAVILY_API_KEY env vars into Hermes.
2. Copies `/precrime/data/myproject.sqlite` → `/db/myproject.sqlite` (Linux ext4) so SQLite writes work.
3. Registers an EXIT trap that copies `/db/myproject.sqlite` → `/precrime/data/myproject.sqlite` on shutdown so changes persist to Windows.
4. Verifies RSS config file exists at `/precrime/rss/rss-scorer-mcp/rss_config.json`. If missing, prints a clear warning that hermes.bat was run from the wrong folder.
5. Runs `npm install` + `npx prisma generate` in `/precrime/server`.
6. Runs `npm install` in `/precrime/rss/rss-scorer-mcp`.
7. Launches `hermes chat` (NOT `exec hermes chat` — the shell must stay alive so the EXIT trap fires on shutdown).

---

## MCP Servers (in hermes-config.yaml)

```yaml
mcp_servers:
  precrime-mcp:
    command: "node"
    args: ["/precrime/server/mcp/mcp_server.js"]
    env:
      DATABASE_URL: "file:/db/myproject.sqlite"
    timeout: 120
    connect_timeout: 60
  precrime-rss:
    command: "node"
    args: ["/precrime/rss/rss-scorer-mcp/index.js"]
    cwd: "/precrime/rss/rss-scorer-mcp"
    timeout: 60
    connect_timeout: 30
```

Hermes spawns both as stdio subprocesses. Tools register automatically at boot.

---

## SOUL.md — Docker Environment Overrides

SOUL.md explicitly overrides skill instructions that assume a Claude-on-Windows runtime:

- Never call Chrome MCP tools (`mcp__Claude_in_Chrome__*`). Skip every "Step A: Initialize Chrome" step.
- Never call browser tools (`browser_console`, `browser_navigate`, etc.).
- All web access via `WebSearch` / `WebFetch` (backed by Tavily).
- If a skill says "if RSS fails, STOP" — ignore it. Proceed without RSS.
- Facebook / LinkedIn scraping: log `SCRAPE_SKIPPED_HEADLESS` and continue.
- Draft closing line: always from `DOCS/VALUE_PROP.md` of the active deployment. Skill-level hardcoded closings are ignored.

---

## Verifying It Works

After `hermes.bat` launches, watch the output for these lines in order:

1. `>>> Database copied to native Linux fs (/db/myproject.sqlite)`
2. `>>> RSS config found OK`
3. `>>> Preparing PRECRIME MCP server...`
4. `>>> Preparing RSS MCP server...`
5. `>>> Launching Hermes...`
6. `[MCP] Server ready - listening for JSON-RPC requests...`
7. Hermes chat prompt appears.

Then type:
```
run enrichment
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EOF` on `localhost:2375` | Docker Desktop not running | Start Docker Desktop |
| `error during connect ... 2375` | `DOCKER_HOST` env var points at TCP | `$env:DOCKER_HOST = ""` in PowerShell |
| `ENOENT: rss_config.json` | hermes.bat run from wrong folder | `cd` into the deployment folder first |
| MCP tools time out on `update_client` | Old image without /db/ copy fix | Rebuild: `docker build -t hermes-precrime .` |
| Hermes stops asking to open Chrome | Old image without SOUL.md overrides | Rebuild |
| `mcporter: command not found` | init-wizard calling Claude-specific CLI | SOUL.md override handles this; rebuild if missing |
