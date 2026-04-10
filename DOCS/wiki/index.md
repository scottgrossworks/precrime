# Pre-Crime Wiki — Master Catalog

Last updated: 2026-04-08 (scoring system)

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
| `status/current.md` | Authoritative current project state. Sessions 1-9 done list. End-to-end verified, share_booking verified, createLeed verified. Workflow live — fine-tuning phase. Six critical design decisions. | STATUS.md | none |
| `status/best-leads.md` | 6 bookings with named/personal contact emails (not info@, not null). Strongest outreach candidates: Lisa Williams (AAAE), N. Davis (NAMA), C. Spann (EVS39), Lauren Douglas (LA Sparks), GM Jin Ki Lim (TKD), Terri (LA Auto Show). | DB bookings | none |

---

## Concepts

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `concepts/ontology.md` | Full v2.0 entity model (Client, Booking, Factlet, Config), four output paths with classification tree, conversion funnel, Booking Action Criterion, addLeed param mapping, seeded/unseeded deployments, three deployment archetypes, nine design rules. | ONTOLOGY.md, STATUS.md, IG_NOTES.md | suspected — ONTOLOGY.md header says "design spec not yet implemented" but STATUS.md says all tools are done |
| `concepts/architecture.md` | System architecture: two MCP servers, local stdio vs remote API, DB path resolution, Prisma 5 version constraint, harvester token-zero pattern, data flow diagram, skill files table, key files reference. | STATUS.md, MCP_BRIEFING.md, DEPLOYMENT.md | none |
| `concepts/deployment.md` | Build system and end-user flow: three-step user flow, precrime.bat mechanics, critical design decisions (blank DB, unconditional setup, skip-permissions), developer build flow, zip contents, deploy.js automated steps, manifest structure, troubleshooting table. | STATUS.md, DEPLOYMENT.md | suspected — DEPLOYMENT.md describes older flow (node deploy.js + manual steps) that predates v2.0 zip distribution |
| `concepts/mcp.md` | All 19 MCP tools with args and purpose, transport config (3 config files), JWT details for leedzSession, what-not-to-do constraints, skill tool name format. Includes 3 scoring tools (link_factlet, get_client_factlets, score_client) added 2026-04-08. | STATUS.md, MCP_BRIEFING.md, DEPLOYMENT.md, PLAN.md | none |
| `concepts/scoring.md` | Client scoring system: binary contact gate + continuous dossier score. Factlet storage model (join table, not prose duplication). Draft eligibility formula. Intel scoring rubric (D2+D3). score_client response format. Pipeline flow diagram. | PLAN.md, mcp_server.js, enrichment-agent.md, evaluator.md | none |
| `concepts/headless-deployment.md` | Headless PRECRIME on AWS: EC2 + Claude Code CLI + cron. Zero architecture changes. CLI flags for unattended execution. Pipeline as scheduled tasks. Comparison with Anthropic Managed Agents (orchestration-as-a-service). | PLAN.md, Claude Managed Agents docs | none |

---

## Optimization

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `PRECRIME/DOCS/OPTIMIZATION.md` *(source only — not deployed)* | 8-strategy token efficiency plan. Cuts: CUSTOMIZATION comment stripping, parallel-mode extraction, dedup outreach rules, dedup four-path classifier, get_config caching, get_new_factlets limit, search_clients limit:1. Addition: browser LLMs (Gemini/Grok) as free satellite compute. Priority table included. | Session 9 audit | none |

---

## Marketing / Harvester Integration

| File | Summary | Source docs | Staleness |
|------|---------|-------------|-----------|
| `marketing/reddit.md` | Reddit harvester setup. Working approach: public JSON endpoints (no auth), token-zero Python script. Official Reddit API credential setup captured but likely blocked (API killed Nov 2025). URS failure documented. | REDDIT_NOTES.md, IG_NOTES.md | suspected — REDDIT_NOTES.md describes official API setup that may be blocked |
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
