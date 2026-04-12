---
title: Pre-Crime Deployment — Build System & End-User Flow
tags: [deployment, build, precrime.bat, setup.bat, deploy.js, zip, manifest]
source_docs: [DOCS/STATUS.md, DOCS/DEPLOYMENT.md]
last_updated: 2026-04-04
staleness: suspected
---

Pre-Crime v2.0 ships as a distributable zip. The developer builds the zip; the end user unzips and runs one command. The system is designed to eliminate all manual setup steps — no permission dialogs, no "say this phrase", no npm commands visible to the user.

> WARNING — STALE? `DEPLOYMENT.md` describes an older deployment flow: `node deploy.js --manifest <file>`, manual npm/prisma steps, and "say: **initialize this deployment**". This predates the v2.0 zip-distribution model. The current authoritative flow is in `STATUS.md` (three steps: unzip, cd, precrime). `DEPLOYMENT.md`'s zip structure section (what's included/excluded) may also reflect older state — notably it lists `data/template.sqlite` while `STATUS.md` calls it `data/blank.sqlite`.

---

## End-User Flow — The Only Acceptable Flow

```
1. Unzip → get precrime\ folder
2. cd precrime
3. precrime
```

That's it. Three steps. No other commands. Never tell users to run `setup.bat` manually. Never tell users to run `node deploy.js`. Never say step 3 is `claude`.

---

## What `precrime.bat` Does

1. Runs `setup.bat` unconditionally (idempotent — fast if already done)
2. Launches `claude --dangerously-skip-permissions "run precrime"`

The "run precrime" auto-prompt triggers the init-wizard skill automatically. User sees no permission dialogs.

`setup.bat` = `npm install` + `npx prisma generate`. Two commands. No `prisma db push` (DB ships pre-built with schema applied).

---

## Why `precrime.bat` Exists — Hard Constraint

Claude Code reads `.mcp.json` at startup and connects MCP servers immediately. On first run, `node_modules/` doesn't exist — MCP connection fails silently. **There is no mid-session reconnect.** Setup must complete before Claude launches.

`precrime.bat` runs setup BEFORE Claude starts. By the time Claude reads `.mcp.json`, deps exist, DB exists, MCP connects first try.

Without this: two launches (first wasted), user confusion.

---

## Critical Design Decisions — Do Not Undo

1. **Blank DB ships in zip.** No `prisma db push` at runtime. DB exists from the moment of unzip. Eliminates "table does not exist" errors entirely.

2. **`precrime.bat` runs setup BEFORE Claude.** Hard constraint of Claude Code's architecture (see above).

3. **`precrime.bat` runs setup unconditionally.** No `if not exist node_modules` check. Setup is idempotent. Conditional checks add failure modes for zero benefit.

4. **`--dangerously-skip-permissions` and pre-seeded prompt.** User types one word (`precrime`). Everything is automatic.

5. **No engineer language in user-facing text.** Never say "initialization", "wizard", "configure", "deployment", "infrastructure", "bootstrap". CLAUDE.md and init-wizard.md enforce this. Claude mirrors the language it reads.

6. **Init wizard Step -1 does NOT diagnose.** If `get_config()` fails, it says "run precrime again" and stops. One sentence. No reading files, no checking paths, no running npm.

7. **Fix the source. Never fix deployments.** `PRECRIME\` is the source of truth. Deployed instances (e.g. `TDS\precrime\`) are built artifacts. All bug fixes go in `PRECRIME\server\` only. Deployments are rebuilt via `build.bat` → re-deploy. Never edit a deployment directory directly — even when an error message shows a deployment file path as diagnostic context.

---

## Developer Build Flow

```
cd PRECRIME
build.bat
→ dist\precrime-deploy-YYYYMMDD.zip
```

`build.bat` runs `deploy.js --no-install` → copies `templates/setup.bat` + `templates/precrime.bat` → zips with `precrime/` at root.

`--no-install` skips npm/prisma (node_modules are platform-specific — must be installed on user's machine, not bundled).

`data/blank.sqlite` is copied into the zip as `data/myproject.sqlite`.

If a zip for today's date already exists, it is deleted and rebuilt.

---

## Zip Contents

```
precrime/
  deploy.js
  build.bat
  README.md
  data/
    myproject.sqlite        (blank.sqlite renamed — schema pre-applied)
  server/
    mcp/
      mcp_server.js
    package.json
    prisma/
      schema.prisma
  templates/
    mcp.json
    rss_config.json
    reddit_config.json
    ig_config.json
    docs/
      CLAUDE.md
      STATUS.md
      VALUE_PROP.md
    skills/
      enrichment-agent.md
      evaluator.md
      relevance-judge.md
      factlet-harvester.md
      init-wizard.md
      fb-factlet-harvester/
      reddit-factlet-harvester.md
      ig-factlet-harvester/
  scripts/
    migrate-db.js
```

**Not included:** `node_modules/`, `manifests/`, `DOCS/`, `TMP/`, generated workspaces.

> WARNING — STALE? `DEPLOYMENT.md` lists `data/template.sqlite` in the zip. `STATUS.md` calls it `data/blank.sqlite` copied as `data/myproject.sqlite`. The STATUS.md naming is authoritative.

---

## What deploy.js Does (Manifest-Driven Scaffolding)

When `node deploy.js --manifest <file>` runs, it:

1. Creates full directory tree in the target workspace
2. Copies `server/mcp/mcp_server.js`, `server/package.json`, `server/prisma/schema.prisma`
3. Runs `npm install` + `npx prisma generate` (skipped with `--no-install`)
4. Copies DB template
5. Generates `server/.env` (DATABASE_URL), `server/mcp/mcp_server_config.json` (DB path), `.mcp.json`
6. Generates `rss/rss-scorer-mcp/rss_config.json`, `reddit/reddit_config.json`, `ig/ig_config.json` from manifest
7. Copies + token-substitutes all skill playbooks and DOCS stubs
8. Creates `logs/ROUNDUP.md`

`{{TOKEN}}` substitution: `manifest.json` values are substituted into templates. All user-facing text uses these tokens — never hardcoded values.

---

## Manifest Structure

Key sections in `manifest.json`:
- Business/seller info: `businessName`, `description`, `serviceArea`, `defaultTrade`
- Config flags: `activeEntities`, `marketplaceEnabled`, `leadCaptureEnabled`
- `rssConfig` — feeds + keywords for RSS harvester
- `redditConfig` — subreddits + keywords
- `igConfig` — accounts + hashtags
- `fbSources` — Facebook pages to scrape

Full annotated template: `manifest.sample.json`

---

## Post-Deploy Manual Steps (Pre-v2.0 Flow — Reference Only)

These steps from `DEPLOYMENT.md` are for direct `deploy.js` deployments, NOT the zip-distribution end-user flow:

1. Fill in `DOCS/VALUE_PROP.md` (critical — Composer reads this for every draft)
2. Verify RSS scorer at `{rootDir}/rss/rss-scorer-mcp/index.js`
3. Load client records (migrate from existing SQLite or insert manually)
4. `cd "{rootDir}" && claude` → say "initialize this deployment"

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| npm install failed during deploy.js | `cd {rootDir}\server && npm install && npx prisma generate` |
| MCP tools not available in Claude | Launch Claude from `{rootDir}` (where `.mcp.json` lives). Not `claude -p` (headless). |
| `get_stats()` fails / DB errors | Check `server/mcp/mcp_server_config.json` DB path. Check `server/.env` DATABASE_URL. Run `npx prisma generate` in `server/`. |
| RSS scorer returns nothing | Verify `rss/rss-scorer-mcp/index.js` exists. Check `rss_config.json` has feeds defined. |
| All drafts stay brewing | warmthScore < 5 = always brewing. Check ROUNDUP.md for THIN_DOSSIER entries. Check `targetUrls` populated after discovery. |
| Facebook scraping not working | Requires Claude Code desktop app (not standalone CLI). Chrome MCP extension must be installed and connected. |

---

## Related
- [[architecture]] — system architecture overview
- [[mcp]] — MCP server config details
- [[current]] — current project state, pending tests
