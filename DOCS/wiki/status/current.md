---
title: Pre-Crime — Current Project State
tags: [status, done, pending, sessions, decisions, warmth, x-harvester, sentAt, hermes, docker, pass-1, pass-2, source-queue]
source_docs: [DOCS/STATUS.md, DOCS/HERMES.md]
last_updated: 2026-05-06 (session 17 — Pass 1 + Pass 2 workflow refactor)
staleness: none
---

## Session 17 — Workflow refactor (Pass 1 + Pass 2), 2026-05-06

**Goal:** make the recursive workflow legible and durable to any tool-calling orchestrator (goose, hermes, claude code), not just frontier models.

**Pass 1 — markdown surface cleanup (no server changes):**
- `templates/skills/url-loop.md` rewritten from pseudocode to numbered tool-call procedure with explicit Step 7 termination contract.
- `templates/skills/marketplace_flow.md` got Step 9 RECURSE; existing share-error rule renumbered to Step 10.
- `templates/skills/outreach_flow.md` got Step 7 RECURSE.
- `templates/docs/FOUNDATION.md` gained the **Numbered Orchestrator Procedure** section: 9-step state machine with branches, three named recursion arms (source/client/booking), four-condition termination, and a server-vs-agent ownership table.
- `templates/skills/headless_flow.md` (NEW) — non-interactive marketplace pipeline with explicit override-map for every approval gate. Init-wizard now routes `headless` mode here instead of `marketplace_flow.md`.

**Pass 2 — queue moved to DB (server changes):**
- New `Source` model in `server/prisma/schema.prisma`. Fields: url (unique), channel, subtype, label, category, scrapedAt, claimedAt, claimedBy, clientsFound, failedReason, discoveredAt, discoveredFrom. Indexes on channel, scrapedAt, claimedAt.
- `server/mcp/mcp_server.js` — added `ensureSourceTable()` startup migration (CREATE TABLE IF NOT EXISTS, idempotent — handles deployed DBs without rebuild). Added four pipeline actions: `next_source`, `mark_source`, `add_sources`, `import_sources`. Channel taxonomy: directory|rss|fb|ig|reddit|x|blog|website. Server normalizes handle/tag inputs (`r/sub`, `@handle`, `#tag`) to canonical URLs. Work-stealing semantics: 10-min claim timeout means crashed agents auto-release their rows.
- `pipeline` tool description in tools/list updated to enumerate all 13 actions. inputSchema enum extended; new fields added (channel, maxAgeDays, url, scrapedAt, clientsFound, failedReason, entries).
- `scripts/migrate-db.js` PC_SCHEMA — Source entry added per the three-file schema sync rule.
- Skills migrated off shell-echo: url-loop.md (next_source / mark_source), source-discovery.md (add_sources per channel), client-seeder.md "Follow Links" (add_sources), each harvester's Source Growth step (rss / fb / reddit). init-wizard.md Step 1.5 calls `import_sources` (idempotent, safe on every startup).
- `templates/GOOSE.md` — the 14-line "FORBIDDEN syntax" block for shell echo to `_sources.md` files dropped; replaced with one line pointing at `add_sources`.

**State management decision (locked):** the DB IS the state. Agents hold session_id and the in-flight URL only. Work-stealing queue pattern. No per-agent state object, no continuation tokens, no stateful agent-side files.

**Source-agnostic confirmed:** Source table covers RSS / FB / IG / Reddit / X / blog / directory / generic website via channel taxonomy + URL normalization. LLM queries (Gemini, Grok) are explicitly out of scope -- they're transient lookups inside source-discovery, not durable sources.

**Pending follow-ups:**
- Regenerate `data/blank.sqlite` and `data/template.sqlite` via `npx prisma db push --force-reset` against absolute path. Not strictly required (CREATE TABLE IF NOT EXISTS handles deployed DBs) but per three-file sync rule.
- Rebuild zip via `build.bat` and redeploy DALLAS, OR copy server/ + scripts/ + templates/ into DALLAS\precrime and run setup.bat to regenerate Prisma client.
- Watch first DALLAS run for QUEUE_EMPTY reports to confirm import_sources picked up all seed files.

---

## Session 16 — Hermes Integration (in progress)

See [[hermes]] for full technical writeup. Short version:
- Docker image builds; Hermes boots; `precrime-mcp` connects; Tavily web search works.
- SQLite writes fixed via `/db/` copy-in/sync-out in entrypoint.sh (WAL mode does not survive Windows volume mount).
- Browser/Chrome tool calls, mcporter CLI, and Zoom closing line all overridden in SOUL.md.
- RSS MCP server still failing on startup with ENOENT — likely hermes.bat was run from the wrong folder (PRECRIME source instead of deployment). Entrypoint now prints a clear diagnostic.
- Skill startup checks `/precrime/skills/` (not `/precrime/templates/skills/`) — fix needs rebuild.
- End-to-end enrichment run not yet completed.

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

- All MCP tools in `mcp_server.js` (originally 22 CRUD tools, since collapsed into 3 workflow tools — pipeline / find / trades — see [[mcp]]); registered as `precrime-mcp`
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
| Tools | 3 (pipeline / find / trades — pipeline has 13 actions) | createLeed + reads |

---

## Related
- [[architecture]] — full architecture details
- [[mcp]] — current 3-tool MCP, all action enumerations
- [[source-queue]] — Pass 2 work-stealing source queue
- [[scoring]] — dual-gate scoring system, warmth rubric, sentAt tracking
- [[ontology]] — entity model, four output paths, Source entity
- [[deployment]] — build system, end-user flow
