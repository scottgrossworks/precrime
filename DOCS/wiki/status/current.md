---
title: Pre-Crime — Current Project State
tags: [status, done, pending, sessions, decisions, warmth, x-harvester, sentAt]
source_docs: [DOCS/STATUS.md]
last_updated: 2026-04-14 (sessions 10-14)
staleness: none
---

Current state of the Pre-Crime project as of 2026-04-14. This article mirrors `STATUS.md` — the authoritative current-state document. When STATUS.md and any other doc conflict, STATUS.md wins.

---

## What Is Pre-Crime

Manifest-driven agentic enrichment engine. Enriches contacts, scores warmth, composes outreach drafts, evaluates quality. v2.0 adds Bookings: when scraped intel contains a gig opportunity (trade + date + location), a Booking is created. `leed_ready` bookings post to The Leedz marketplace.

**Glass-of-water model:**
- Client: `canDraft` (contactGate + dossierScore ≥ 5) AND `warmthScore ≥ 9` → draft → evaluator (6 criteria) → `ready` → send → `sent` (with `sentAt` timestamp)
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
- All personal data scrubbed
- The Leedz MCP Phase 1: getTrades, getStats, getLeedz, getUser, createLeed
- JWT generation in init-wizard Step 5a
- Booking completeness evaluator with four output paths
- **End-to-end test passed**: unzip → `precrime` → MCP connected, init-wizard ran, enrichment launched
- Leedz marketplace sharing extracted to optional plugin (`plugins/leedz-share/`) — core ships clean
- **The Leedz MCP `createLeed` verified** with session JWT

## What's Done (Sessions 10-14, 2026-04-14)

- **Warmth scoring recalibration**: `warmthScore` is a holistic 0-10 agent assessment (NOT deprecated). Two independent gates for draft composition: procedural (`canDraft`) AND agent (`warmthScore >= 9`). Two hard gates for 9+: verified direct email + specific event signal. Full rubric in enrichment-agent Step 4.5. See [[scoring]].
- **Reddit harvester restructured**: flat file → folder pattern (`reddit-factlet-harvester/SKILL.md` + `reddit_sources.md`), matching FB/IG. deploy.js, source-discovery, init-wizard all updated.
- **X/Twitter factlet harvester (NEW)**: `x-factlet-harvester/SKILL.md` + `x_sources.md`. Grok-first fetch (zero API keys), Chrome X search fallback. Three source types: @accounts, #hashtags, keyword searches. 7-day recency window. deploy.js, source-discovery (Step 4.5), init-wizard all wired.
- **Draft send tracking (`sentAt`)**: New `sentAt DateTime?` field on Client schema. Gmail send + `update_client({ draftStatus: "sent", sentAt })` treated as atomic in enrichment-agent Step 6.5. MCP server accepts `sentAt` in update_client.
- **`sentAt` schema sync complete**: `migrate-db.js` PC_SCHEMA, `blank.sqlite`, and `template.sqlite` all updated.
- **Instagram harvester rewritten**: Chrome-primary (was instaloader/Python). Matches FB harvester pattern. source-discovery Step 4.7, init-wizard Step 7.5/8 all wired.

---

## Pending

### Low Priority

1. **`deploy.js` console output cosmetic fix** — old "SCAFFOLD COMPLETE" language. Developer-facing only.

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
| Tools | 19 | createLeed + reads |

---

## Related
- [[architecture]] — full architecture details
- [[mcp]] — all 19 MCP tools
- [[scoring]] — dual-gate scoring system, warmth rubric, sentAt tracking
- [[ontology]] — entity model, four output paths
- [[deployment]] — build system, end-user flow
