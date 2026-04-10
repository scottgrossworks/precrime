# Pre-Crime Wiki — Ingest Log

Append-only. One entry per source doc processed.

---

## [2026-04-04] ingest | DOCS/STATUS.md

**Authoritative current-state document.** Extracted: project description, two-MCP architecture table, DB path resolution, Prisma version constraint, build/deploy/run flow, key files table, sessions 1-8 done list, pending tasks (end-to-end test, share_booking test, Leedz MCP createLeed test), six critical design decisions, init wizard Step -1 behavior.

**Wiki pages created/updated:**
- `status/current.md` — primary mirror of STATUS.md
- `concepts/architecture.md` — architecture table, DB path resolution, Prisma version
- `concepts/deployment.md` — build flow, precrime.bat mechanics, critical decisions
- `concepts/mcp.md` — tool count, architecture note

**Staleness flags raised:** STATUS.md contradicts ONTOLOGY.md header ("design spec — not yet implemented") and MCP_BRIEFING.md issues list. STATUS.md wins.

---

## [2026-04-04] ingest | DOCS/ONTOLOGY.md

**Full v2.0 entity model, four output paths, conversion funnel, deployment archetypes, design rules.** Dated 2026-04-01. Extracted: Client schema + draftStatus values, Booking schema + status values + Pre-Crime-specific fields, Factlet schema, Config schema (including leedzEmail/leedzSession), four output paths with classification tree, conversion funnel diagram, Booking Action Criterion (trade + startDate + location/zip), addLeed param mapping table, seeded vs unseeded deployments, three deployment archetypes, implementation sequence, nine design rules.

**Wiki pages created/updated:**
- `concepts/ontology.md` — comprehensive extraction of all entity/path/funnel content

**Staleness flags raised:** ONTOLOGY.md header says "Status: Design spec — not yet implemented." STATUS.md says all 15 tools are done. The spec IS implemented. Header is stale artifact. Flagged in ontology.md.

---

## [2026-04-04] ingest | DOCS/DEPLOYMENT.md

**Full deployment reference.** Extracted: deploy.js automated steps (16 steps), manual post-deploy steps (VALUE_PROP.md, RSS scorer, load client records, initialize), zip build command, zip contents tree, what's NOT included, recipient instructions (9 steps), MCP server reference (15 tools table), troubleshooting table.

**Wiki pages created/updated:**
- `concepts/deployment.md` — primary extraction. Staleness warnings added.
- `concepts/mcp.md` — 15 tools table sourced here and from MCP_BRIEFING.md

**Staleness flags raised:**
1. DEPLOYMENT.md describes `node deploy.js --manifest <file>` as the user flow and "say: initialize this deployment" — contradicts STATUS.md v2.0 zip distribution model (three steps: unzip, cd, precrime).
2. DEPLOYMENT.md references `data/template.sqlite`; STATUS.md uses `data/blank.sqlite` copied as `data/myproject.sqlite`.
Both flagged in deployment.md.

---

## [2026-04-04] ingest | DOCS/MCP_BRIEFING.md

**Subprocess briefing for MCP server implementation.** Dated 2026-04-02. Extracted: two-MCP-server comparison table with file paths, transport, backend, purpose. Current 15 tools list. Four issues described as broken/missing (Prisma schema missing Booking model, Config missing v2.0 fields, update_booking missing auto-eval, get_stats missing booking counts). Code snippets for fixes. What NOT to do list. Files to edit. JWT generation details including JWT_SECRET.

**Wiki pages created/updated:**
- `concepts/mcp.md` — tools table, JWT details, constraints, what-not-to-do
- `concepts/architecture.md` — two-MCP comparison table

**Staleness flags raised:**
1. MCP_BRIEFING.md lists 4 issues as "broken/missing." STATUS.md says all 15 tools are done. Issues are resolved. MCP_BRIEFING.md is a historical implementation record, not a current bug list. Flagged in mcp.md.
2. MCP_BRIEFING.md says edit `BLOOMLEEDZ\server\prisma\schema.prisma`. BLOOMLEEDZ is old project name. Correct path is `PRECRIME\server\prisma\schema.prisma`. Flagged in mcp.md.

---

## [2026-04-04] ingest | DOCS/REDDIT_NOTES.md

**Sparse setup notes (12 lines).** Extracted: Reddit app creation steps at reddit.com/prefs/apps, four environment variables (CLIENT_ID, CLIENT_SECRET, USER_AGENT, REDDIT_USERNAME, REDDIT_PASSWORD).

**Wiki pages created/updated:**
- `marketing/reddit.md` — captures setup steps; adds context from IG_NOTES.md about API being blocked since Nov 2025

**Staleness flags raised:** REDDIT_NOTES.md describes official Reddit API credential setup. IG_NOTES.md (also a source doc) explicitly states Reddit killed self-service API keys in November 2025. The credential-based approach may be blocked for new apps. Working implementation uses public `.json` endpoints without auth. Flagged in reddit.md.

---

## [2026-04-04] ingest | DOCS/IG_NOTES.md

**Full Instagram harvester integration spec (352 lines).** Extracted: What Pre-Crime does (4-line summary), four output paths (verbatim classification logic), factlet/dossier/lead capture rules, MCP tools list with key args, existing harvester patterns (RSS, Facebook/Chrome, Reddit/script), lessons from Reddit integration (API dead, public endpoints work, URS failed, token-zero pattern, config-driven design), Instagram scraping approaches in priority order, what to scrape, output JSON schema, DB source field formats, file placement tree, manifest addition, deploy.js changes, skill playbook structure template, entity schemas (Client, Booking), what NOT to do (10 rules), reference files list, implementation checklist.

**Wiki pages created/updated:**
- `marketing/instagram.md` — comprehensive extraction of full integration spec
- `marketing/reddit.md` — API lessons section sourced from this doc
- `concepts/ontology.md` — four output paths section reinforced with IG_NOTES verbatim classification logic

---

## [2026-04-04] added | Best Leads — Named Contacts

**6 bookings with personal/named contact emails** extracted from DB bookings table. Filtered criteria: email exists AND not info@ AND not null AND status = new. These are the strongest outreach candidates with real named contacts.

Leads: Lisa C. Williams/AAAE (May 3), N. Davis/NAMA (Apr 22), C. Spann/EDTA (Jun 21), Lauren Douglas/LA Sparks (May 10), GM Jin Ki Lim/K-Taekwondo (Apr 15), Terri/LA Auto Show (Nov 20).

**Wiki pages created/updated:**
- `status/best-leads.md` — new article, added YAML frontmatter and backlinks

**Conflicts flagged:** none

---

## [2026-04-08] feature | Client Scoring System & Draft Gate

**Major enrichment pipeline redesign.** Replaced manual warmthScore (0-10, LLM-assessed) with procedural two-mechanism scoring: binary contact gate + continuous unbounded dossier score. Factlets now stored as references (ClientFactlet join table) instead of duplicated as prose into each client's dossier.

**Schema changes:**
- Added `ClientFactlet` model (join table: clientId, factletId, signalType, points, appliedAt)
- Added to Client: `dossierScore` (Int), `contactGate` (Boolean), `intelScore` (Int)
- `warmthScore` deprecated (kept for backwards compat)

**MCP server changes (15 → 19 tools):**
- `link_factlet` — associate factlet with client, classify as pain/occasion/context
- `get_client_factlets` — hydrate linked factlets with content for a client
- `score_client` — procedural scoring: contactGate + factletScore + dossierScore + canDraft
- Updated `get_stats` with dossier score distribution + contact gate counts
- Updated `get_ready_drafts` to sort by dossierScore

**Enrichment agent changes:**
- Step 1 rewritten: factlets linked via `link_factlet`, not copied into dossier
- Step 3.5 added: intel scoring (D2+D3, max 7) after scraping
- Step 4 rewritten: one `score_client` call replaces manual warmth assessment
- Step 4.5 added: draft gate — canDraft false skips Steps 5-6

**Evaluator changes:**
- Removed warmthScore < 5 hard gate (handled by score_client)
- Removed generic inbox hard gate (handled by contactGate)
- Now evaluates draft quality only

**Wiki pages created/updated:**
- `concepts/scoring.md` — NEW: full scoring system documentation
- `concepts/mcp.md` — updated tool count 15→19, added scoring tools section, cleared staleness
- `index.md` — added scoring.md entry, updated mcp.md summary
- `SCHEMA.md` — added scoring.md to directory tree

**Source doc:** `DOCS/PLAN.md` (design document for this change)

**Conflicts flagged:** `concepts/ontology.md` does not yet include `ClientFactlet` entity. Should be updated when ontology is next revised.

---

## [2026-04-09] insight | Headless Deployment Architecture

**Key architectural insight:** PRECRIME runs headlessly on AWS with zero changes. Claude Code IS the orchestration backbone (prompt → API → parse tool calls → execute locally → patch results → resend). Install it on an EC2, point at the PRECRIME folder, trigger via cron with `claude -p --dangerously-skip-permissions "run enrichment"`. Same .md skills, same MCP server (stdin/stdout), same SQLite DB. No transport adapter needed.

**Anthropic Managed Agents** (beta 2026-04-01) is the hosted alternative — same agent loop, but Anthropic manages the runtime. Requires HTTP transport for MCP (breaking change from stdin/stdout). Adds value at scale; overkill for a single pipeline. Accurately described as "orchestration-as-a-service" — the cloud vendor play to pull self-hosting users back to managed infrastructure.

**Wiki pages created/updated:**
- `concepts/headless-deployment.md` — NEW: full architecture, CLI flags, cron schedule, Managed Agents comparison
- `index.md` — added entry
- `SCHEMA.md` — added to directory tree

**Conflicts flagged:** none
