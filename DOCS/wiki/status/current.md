---
title: Pre-Crime — Current Project State
tags: [status, done, pending, sessions, decisions]
source_docs: [DOCS/STATUS.md]
last_updated: 2026-04-04 (session 9)
staleness: none
---

Current state of the Pre-Crime project as of 2026-04-04. This article mirrors `STATUS.md` — the authoritative current-state document. When STATUS.md and any other doc conflict, STATUS.md wins.

---

## What Is Pre-Crime

Manifest-driven agentic enrichment engine. Enriches contacts, scores warmth, composes outreach drafts, evaluates quality. v2.0 adds Bookings: when scraped intel contains a gig opportunity (trade + date + location), a Booking is created. `leed_ready` bookings post to The Leedz marketplace.

**Glass-of-water model:**
- Client: `warmthScore ≥ 5` → draft → evaluator (5 criteria) → `ready` → outreach
- Booking: `trade` + `startDate` + (`location` OR `zip`) → `leed_ready` → post to marketplace

---

## What's Done (Sessions 1-9)

- All 19 MCP tools in `mcp_server.js`; registered as `precrime-mcp`
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
- Leedz marketplace sharing extracted to optional plugin (`plugins/leedz-share/`) — core ships clean
- **The Leedz MCP `createLeed` verified** with session JWT

---

## Pending

### Low Priority

1. **`deploy.js` console output cosmetic fix**
   - Still prints old "SCAFFOLD COMPLETE" manual steps and "initialize this deployment" language
   - Only developer sees it.

### Active

- **Fine-tuning**: workflow is live and end-to-end verified. Ongoing refinement only.

---

## Critical Design Decisions — Do Not Undo

1. **Blank DB ships in zip.** No `prisma db push` at runtime.

2. **`precrime.bat` runs setup BEFORE Claude.** MCP connects at Claude startup. If deps don't exist at that moment, MCP fails silently with no recovery.

3. **`precrime.bat` runs setup unconditionally.** Idempotent. No conditional checks.

4. **`--dangerously-skip-permissions` + pre-seeded prompt.** User types one word. No dialogs.

5. **No engineer language in user-facing text.** No "initialization", "wizard", "configure", "deployment", "infrastructure", "bootstrap".

6. **Init wizard Step -1 does NOT diagnose.** If `get_config()` fails → "run precrime again." One sentence.

---

## Architecture Quick Reference

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| Purpose | Enrichment pipeline DB | Marketplace CRUD |
| File | `server/mcp/mcp_server.js` | Remote Lambda |
| Transport | Local stdin/stdout | Remote POST /mcp |
| Backend | Prisma 5 → SQLite | DynamoDB |
| Tools | 15 | createLeed + reads |

---

## Related
- [[architecture]] — full architecture details
- [[mcp]] — all 15 MCP tools
- [[ontology]] — entity model, four output paths
- [[deployment]] — build system, end-user flow
