# Pre-Crime Wiki — Master Catalog

Last updated: 2026-05-06 (Session 17 — Pass 1 numbered procedure + Pass 2 Source queue moved to DB)

---

## How to Use This Wiki

An LLM agent entering a new session should:
1. Read this index to find relevant articles
2. Read `status/current.md` for current project state
3. Read specific concept articles as needed

`STATUS.md` is the authoritative source. When wiki articles conflict with each other, the article that cites `STATUS.md` wins.

---

## Meta

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `SCHEMA.md` | Wiki conventions, directory structure, frontmatter fields, staleness flagging, doc hierarchy | — | none |
| `index.md` | This file. Master catalog. | — | none |
| `log.md` | Append-only ingest log. One entry per source doc processed. | All | none |

---

## Status

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `status/current.md` | Authoritative current project state. Sessions 1-14. 19 tools. Warmth recalibration (dual-gate: canDraft + warmthScore ≥ 9). Reddit restructured to folder pattern. X/Twitter harvester (Grok-first). sentAt draft tracking. Schema sync pending for sentAt. | STATUS.md | none |
| `status/best-leads.md` | 6 bookings with named/personal contact emails (not info@, not null). Strongest outreach candidates: Lisa Williams (AAAE), N. Davis (NAMA), C. Spann (EVS39), Lauren Douglas (LA Sparks), GM Jin Ki Lim (TKD), Terri (LA Auto Show). | DB bookings | none |
| `status/migration-disaster-2026-04-13.md` | 5+ hours burned on BLOOMLEEDZ deployment. Stale PC_SCHEMA, stale template DBs, no WAL checkpoint. 3 fuckups (#43-#45). Root cause: schema.prisma changes never propagated to migrate-db.js or template DBs. Binding rule: schema changes require 3-file sync. | Session log, FUCKUPS.md | none |

---

## Concepts

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `concepts/ontology.md` | Full v2.0 entity model (Client, Booking, Factlet, Config). Client fields updated: warmthScore (active, not deprecated), dossierScore, contactGate, sentAt. Dual-gate draft requirement documented. Four output paths including X/Twitter. Conversion funnel, Booking Action Criterion, addLeed param mapping, seeded/unseeded, three archetypes, nine design rules. | ONTOLOGY.md, STATUS.md, IG_NOTES.md | none |
| `concepts/architecture.md` | System architecture: two MCP servers, local stdio vs remote API, DB path resolution, Prisma 5 version constraint, harvester token-zero pattern, data flow diagram, skill files table, key files reference. | STATUS.md, MCP_BRIEFING.md, DEPLOYMENT.md | none |
| `concepts/deployment.md` | Build system and end-user flow: three-step user flow, precrime.bat mechanics, critical design decisions (blank DB, unconditional setup, skip-permissions), developer build flow, zip contents, deploy.js automated steps, manifest structure, troubleshooting table. | STATUS.md, DEPLOYMENT.md | suspected — DEPLOYMENT.md describes older flow (node deploy.js + manual steps) that predates v2.0 zip distribution |
| `concepts/mcp.md` | Current 3-tool MCP surface (`pipeline` / `find` / `trades`). All 13 `pipeline` actions including the four Pass 2 source-queue actions (next_source / mark_source / add_sources / import_sources). Session truth via report_session. Server-side guards. JWT for optional leedz-share plugin. | mcp_server.js, schema.prisma | none |
| `concepts/source-queue.md` | **Pass 2 (2026-05-06).** DB-backed work-stealing source queue. Source table schema, four MCP actions, claim/release semantics with 10-min timeout, normalization of handle/tag inputs, recursion lineage via discoveredFrom. Replaces markdown-as-queue (echo to *_sources.md) pattern. | mcp_server.js, schema.prisma, url-loop.md, source-discovery.md, FOUNDATION.md | none |
| `concepts/recursive-loop.md` | The end-to-end recursive scrape loop: plan_tasks -> claim -> channel-dispatched worker -> save(judge:false) -> add_sources(discoveredFrom) recursion -> mark_source -> judge -> replan. Channel routing table (rss/web via url-loop; fb/ig browser-only interactive harvesters; x Grok-or-Tavily). Browser-channel gate (headless skips fb/ig). Seeding via import_sources / DISCOVER_SOURCES / demand-radar. | FOUNDATION.md, url-loop.md, headless_flow.md, init-wizard.md, mcp_server.js | none |
| `concepts/scoring.md` | Pointer only. Canonical scoring policy lives in `DOCS/SCORING.json`; do not duplicate weights or gates in wiki prose. | DOCS/SCORING.json | none |
| `concepts/headless-deployment.md` | Headless PRECRIME on AWS: EC2 + Claude Code CLI + cron. Zero architecture changes. CLI flags for unattended execution. Pipeline as scheduled tasks. Comparison with Anthropic Managed Agents (orchestration-as-a-service). | PLAN.md, Claude Managed Agents docs | none |
| `concepts/email-finder.md` | Callable sub-skill invoked by enrichment-agent Step 3.6 when a client has a generic inbox, missing email, or pattern-constructed guess. 5-phase playbook: domain discovery, email-format lookup via RocketReach/Prospeo/ContactOut/Lead411 Google snippets (snippet-only, no paywall click-through), personnel discovery via LinkedIn People tab, format application, validation. 10-action hard cap. Returns found/high_confidence/guessed/failed. | EMAIL_FINDER.md, email-finder.md, enrichment-agent.md | none |

---

## Optimization

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `PRECRIME/DOCS/OPTIMIZATION.md` *(source only — not deployed)* | 8-strategy token efficiency plan. Cuts: CUSTOMIZATION comment stripping, parallel-mode extraction, dedup outreach rules, dedup four-path classifier, get_config caching, get_new_factlets limit, search_clients limit:1. Addition: browser LLMs (Gemini/Grok) as free satellite compute. Priority table included. | Session 9 audit | none |

---

## Marketing / Harvester Integration

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `marketing/reddit.md` | Reddit harvester setup. Restructured to folder pattern (`reddit-factlet-harvester/SKILL.md` + `reddit_sources.md`). Working approach: public JSON endpoints (no auth), token-zero Python script. Official Reddit API credential setup captured but likely blocked (API killed Nov 2025). | REDDIT_NOTES.md, IG_NOTES.md | suspected — REDDIT_NOTES.md describes official API setup that may be blocked |
| `marketing/instagram.md` | Full Instagram harvester integration spec. Scraping approaches in priority order (public JSON → Chrome MCP → instaloader → Playwright). Output JSON schema, DB source field formats, file placement, manifest addition, deploy.js changes required, skill playbook structure, 10 constraints, implementation checklist. | IG_NOTES.md, STATUS.md | none |

---

## Staleness Summary

| Issue | Source | Article | Resolution |
|-------|--------|---------|-----------|
| ONTOLOGY.md says "design spec — not yet implemented" | ONTOLOGY.md header (2026-04-01) vs STATUS.md (sessions 1-8 done) | `concepts/ontology.md` | STATUS.md wins. All 15 tools done. Header is stale. |
| MCP_BRIEFING.md lists 4 "broken/missing" items | MCP_BRIEFING.md (2026-04-02) vs STATUS.md | `concepts/mcp.md` | RESOLVED 2026-04-08. mcp.md updated to 19 tools, staleness cleared. |
| MCP_BRIEFING.md references BLOOMLEEDZ\server\prisma\schema.prisma | MCP_BRIEFING.md vs STATUS.md | `concepts/mcp.md` | RESOLVED 2026-04-08. Correct path noted in mcp.md. |
| DEPLOYMENT.md describes `node deploy.js --manifest` user flow | DEPLOYMENT.md vs STATUS.md | `concepts/deployment.md` | STATUS.md wins. v2.0 flow is: unzip → cd → precrime. |
| DEPLOYMENT.md references data/template.sqlite | DEPLOYMENT.md vs STATUS.md | `concepts/deployment.md` | STATUS.md wins. File is data/blank.sqlite → data/myproject.sqlite. |
| REDDIT_NOTES.md describes official API credential setup | REDDIT_NOTES.md vs IG_NOTES.md (Reddit API killed Nov 2025) | `marketing/reddit.md` | Working impl uses public endpoints. Credential setup may be blocked. |
