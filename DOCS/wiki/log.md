# Pre-Crime Wiki — Ingest Log

Append-only. One entry per source doc processed.

---

## [2026-04-18] session | RSS scorer: lower default threshold, diagnose zero-article returns, kill dead feeds surface

**Symptom:** PHOTOBOOTH precrime session reported `RSS: 0 articles returned - feeds may need new sources or the MCP server may need a restart` — generic and unactionable. Live probe of 4 PHOTOBOOTH feeds showed top-scoring articles coming in at 5–6 points against a threshold of 15. Zero passed.

**Root cause:** `templates/rss_config.json → processing.relevanceThreshold = 15` was tuned for an earlier, keyword-rich scoring regime. Current global keywords are mostly long-tail phrases ("photo booth rental", "Los Angeles events") that rarely appear in RSS `<description>` snippets. Without the 5-point recency bonus (article < 24h old), nothing clears 15.

**Fixes shipped to PRECRIME source:**

1. `templates/rss_config.json` — `relevanceThreshold` lowered from `15` → `6`. Also removed the vestigial `feeds: []` field; feeds are loaded from `skills/rss-factlet-harvester/rss_sources.md`, never from this JSON.

2. `rss/rss-scorer-mcp/index.js` — `getTopArticles()` now tracks a diagnostic payload (`feedsFetched`, `feedsFailed`, `itemsSeen`, `maxScoreSeen`, `maxScoreTitle`, `maxScoreFeed`) and, when returning zero articles, both logs a concrete "LIKELY CAUSE" line AND attaches a `diag` object to the MCP response. The agent can now distinguish "threshold too high" vs. "feeds all 404" vs. "no feeds configured" without guessing.

3. `deploy.js` — the `manifest.rssConfig.feeds` merge branch now prints a warning instead of silently writing a dead field into the output JSON. Agents tuning feeds via manifest were getting misled.

4. `manifests/manifest.generic.json` — `rssConfig.feeds` removed; a `_comment` field now documents that feeds live in `rss_sources.md`.

**PHOTOBOOTH fix (deployment-local, not source):** told the user to set `relevanceThreshold: 6` in their live `rss_config.json` and restart the RSS MCP server. Two feeds (`bizbash.com/feed`, `laist.com/feed/all`) are returning 404 — they can stay and just log errors until the user prunes them.

---

## [2026-04-18] session | Scoring policy extracted to scoring_config.json + share-skill Bash+curl fix

**Refactor:** `computeBookingScore`, `handleScoreClient`, `handleLinkFactlet`, and `isGenericEmail` used to have all their weights, thresholds, regex patterns, and the generic-email prefix list hardcoded as JS literals. Non-coders couldn't tune, and parallel deployments risked drifting. Lifted all policy into `server/mcp/scoring_config.json`. `mcp_server.js` loads it once at startup and fails fast if missing/malformed. `LOC_RX` regexes are compiled once from the JSON patterns. `deploy.js` now copies `scoring_config.json` alongside `mcp_server.js` into every generated deployment.

**Config surface exposed:**
- `client.draftThreshold`, `client.signalPoints`
- `booking.hardGates` (totalMin / tradeMin / locationMin / dateMin / contactMin)
- `booking.trade`, `booking.date`, `booking.location.{patterns,tiers}`, `booking.contact`, `booking.description`, `booking.time`
- `booking.genericEmailPrefixes`

**Bug fixed mid-refactor:** share-skill.md instructed Claude to "use WebFetch to POST" to the Leedz API Gateway. WebFetch is GET-only — it returned 404 as soon as a precrime deployment tried to share. Updated both `templates/skills/share-skill.md` and `plugins/leedz-share/share-skill.md` to use the Bash tool + `curl -X POST` with a heredoc JSON body. Added a "DO NOT use WebFetch" warning inline.

**Evaluator skill rubric updated** to show all six categories (trade/date/location/contact/description/time) with the full 0–20 tier table, and to replace the old "score ≥ 70 + contact ≥ 10" share gate with the five-condition hard-gate list.

**Docs updated:** `DOCS/SCORING_SYSTEM.md` and `DOCS/wiki/concepts/scoring.md` now point tuners at the JSON config and document every field.

---

## [2026-04-18] session | Hard API gates added to booking scorer (location, trade, date, contact)

**Bug:** Booking scorer's `shareReady` check was `total >= 70 AND contact >= 10` — no hard gate on location, trade, or date. A booking with no real location could still be marked shareReady if other categories summed high enough. The Leedz `addLeed` Lambda rejects POSTs without `tn`, `lc`, `zp`, `st`, `et` — the scorer was green-lighting leedz the API would reject (or worse, leedz that a vendor couldn't act on if accepted).

**Bonus bug found:** Bare city names ("Los Angeles" + zip) were scoring 15 because the `else` branch of the location tiering matched them as "non-vague text + zip". Fixed — no street AND no venue AND no campus keyword now scores 5.

**Fix applied in parallel** — the running PHOTOBOOTH session and this session both landed on the same hard-gate design:

```js
shareReady = total >= 70
          && b.trade    >= 20   // addLeed tn
          && b.location >= 15   // addLeed lc
          && b.date     >= 20   // addLeed st/et
          && b.contact  >= 10   // buyer actionability
```

Action priority reordered: hard gates first (API will reject), then soft gaps (description, time). The running session's version and this session's version diverged only in the location tiering — merged both fixes: running-session provided the hard gates + improved action messages; this session fixed the bare-city-name bug.

**Authority:** `LEEDZ/FRONT_3/DOCS/wiki/api/addleed-api.md` — addLeed Params table marks tn/lc/zp/st/et as required.

**Files changed:**
- `PHOTOBOOTH/precrime/server/mcp/mcp_server.js` — location tier fix + already had hard gates from running session
- `PRECRIME/server/mcp/mcp_server.js` — full sync from PHOTOBOOTH (computeBookingScore + tool description + breakdown output)
- `PRECRIME/DOCS/SCORING_SYSTEM.md` — updated Share Threshold section, Location table, Action priority, Tuning Notes, Response examples
- `PRECRIME/DOCS/wiki/concepts/scoring.md` — same three sections in wiki form
- `PRECRIME/DOCS/wiki/log.md` — this entry

**Outstanding:**
- `share-skill.md` still marks addLeed `et` as optional; the addLeed API marks it required. Share skill should derive `et` from `startDate` (e.g., startDate + 4 hours) when `booking.endDate` is null. Not fixed in this session.
- Restart the PHOTOBOOTH precrime session so the updated location tiering is picked up.

---

## [2026-04-18] session | Booking readiness scoring documented from PHOTOBOOTH live-tuned source

**Source:** `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\precrime\server\mcp\mcp_server.js` — the PHOTOBOOTH deployment's running MCP server, where the booking scoring algorithm (`computeBookingScore`) has been actively tuned during live enrichment runs.

**Diff vs PRECRIME source:**
- **Date** — was 0/20 (present or not). Now 0/5/10/20: tiered by event window tightness. Multi-month ranges and ongoing series are penalized.
- **Location** — was 0/10/20 (zip + location present). Now 0/5/10/15/20 via three regexes (HAS_STREET, HAS_VENUE, CAMPUS_VAGUE): "CSUN" + zip no longer scores a perfect 20 — specific venue required.
- **Description** — was 0/10/20 (word-count tiered). Reduced to 0/10 — description is supporting detail, not a primary gate.
- **Time** — NEW category (0/10). Requires `startTime` or `duration > 0`. A date with no hours cannot be quoted.
- **Action ordering** — now prioritized by biggest gap first.

Totals still sum to 100: 20 + 20 + 20 + 20 + 10 + 10. shareReady threshold (≥70 total AND contact ≥10) unchanged.

**Docs updated:**
- `DOCS/SCORING_SYSTEM.md` — added Part II: Booking Readiness Score (full algorithm reference with regex source, action priority, response shape, tuning lineage).
- `wiki/concepts/scoring.md` — reframed as "two systems" page, added Booking Readiness section + Tuning Lineage.
- `wiki/index.md` — summary row updated to mention both systems.

**Divergence note:** PHOTOBOOTH is ahead of PRECRIME source. When tuning stabilizes, the tuned `computeBookingScore()` should be synced back to `PRECRIME/server/mcp/mcp_server.js` so future deployments inherit the improvements. Until then, PRECRIME's source version is stale.

**Outstanding:**
- Sync tuned `computeBookingScore()` back from PHOTOBOOTH → PRECRIME source.
- Verify VENDOR_OPPORTUNITY upstream gate is catching fair/festival entries before they ever reach this scorer (so the booking score never has to defend against that class of contamination).

---

## [2026-04-17] session | Hermes integration — day 3

**Session 16 — Hermes in Docker, running against PHOTOBOOTH deployment.**

**Fixes applied:**
- `docker/entrypoint.sh` — copy SQLite DB to `/db/` on startup, sync back on exit (resolves SQLite WAL write-hang on Windows volume mount). Install deps for both precrime-mcp and precrime-rss servers. Print startup diagnostics including RSS config file presence check.
- `docker/hermes-config.yaml` — DATABASE_URL switched to `file:/db/myproject.sqlite`. Added `precrime-rss` MCP server wiring with explicit `cwd`.
- `docker/SOUL.md` — added "Environment — Headless Docker Container" override block: never call Chrome/browser tools, never stop for missing Chrome, ignore "if RSS fails STOP" skill instructions, always use VALUE_PROP.md closing line.
- `docker/skills/precrime/precrime-skill/SKILL.md` — File Access check changed from `/precrime/templates/skills/` to `/precrime/skills/` (templates/ doesn't exist in deployments).

**Wiki pages updated:**
- `status/current.md` — Session 16 block summarizing Hermes progress.
- (this file) — session log.

**Fuckups logged (this session):**
- Added `precrime-rss` MCP server to hermes-config.yaml without first reading `rss-scorer-mcp/index.js`. Violated FUCKUPS Rule 4.
- When RSS crashed on startup, removed it from hermes-config.yaml entirely instead of diagnosing. Violated FUCKUPS Rules 1 and 5. Restored it in the next response.
- Kept chaining one-symptom-at-a-time fixes rather than reading all relevant skills end-to-end at the start of the session. User called this out directly: "think of the problems ahead of time instead of waiting for me to fall into a trap."

**Outstanding:**
- ENOENT on RSS config file still needs confirmation. Diagnostic added to entrypoint.sh will make the root cause visible on next run.
- End-to-end Hermes enrichment not yet run.

**Source doc authority:** See `DOCS/HERMES.md` for full technical writeup. `DOCS/STATUS.md` Session 16 block is the session summary.

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

## [2026-04-11] feature | Email Finder Skill

**New callable sub-skill added to the enrichment pipeline.** Created `templates/skills/email-finder.md` — a generic, deployment-agnostic skill (uses `{{DEPLOYMENT_NAME}}` token) that hunts down direct email addresses when the contact gate would otherwise fail. Edited `templates/skills/enrichment-agent.md` Step 3.6 to replace ~27 lines of inline Gemini/WebSearch verification procedure with a concise handoff to the new skill.

**Key insight driving the design:** four commercial email aggregators (RocketReach, ContactOut, Prospeo, Lead411) expose email-format data directly in their Google search snippets without login. A targeted `site:rocketreach.co` query returns strings like `"uses 2 email formats: 1. first@domain.com (89.8%)"`. Reading the snippet sidesteps the paywall entirely. The skill explicitly forbids clicking through to these sites.

**5-phase algorithm:**
1. Domain Discovery (skip if domain provided) — `WebSearch` for company LinkedIn/knowledge panel
2. Email Format Discovery — five snippet-only Google queries against the four aggregators + one fallback
3. Personnel Discovery (fallback) — LinkedIn People tab, company staff pages, Facebook About, targeted Google
4. Apply Format to target — handles hyphens, suffixes, non-ASCII
5. Validation (optional) — quoted `WebSearch` of the constructed email

**Hard cap:** 10 browser/search actions per run.

**Returns:** `found | high_confidence | guessed | failed` plus `email`, `format`, `confidence`, `source`, `alt_contacts`, `notes`.

**Write-back behavior:** on `found` / `high_confidence` and when `client_id` is provided, the skill calls `update_client` to write `email` + dossier notes — but never touches `warmthScore` or `dossierScore`. The enrichment agent re-runs `score_client` after the handoff returns.

**Step 3.6 result handling in enrichment-agent:**
- `found` / `high_confidence` → Tier 1, full credit, contact gate flips to PASS
- `guessed` → Tier 2, cap downstream score at 6, log `GENERIC_EMAIL`
- `failed` → leave inbox in place, log `EMAIL_UNVERIFIED`

**Trigger conditions** (merged from both source specs): generic inboxes `info@, contact@, hello@, support@, sales@, admin@, office@, customerservice@, orders@, memberservices@`, missing email, or format-constructed guess not found verbatim.

**File location decision:** `templates/skills/` is for per-deployment skills copied into each workspace by `deploy.js`. The root `skills/` folder is for framework-level skills like `deployment-wizard.md`. Email-finder is per-deployment.

**Wiki pages created/updated:**
- `concepts/email-finder.md` — NEW: full skill documentation (interface, algorithm, decision tree, integration)
- `concepts/architecture.md` — added email-finder to skill files table, backlink, bumped last_updated and source_docs
- `concepts/scoring.md` — added contact-gate upgrade path note under Contact Gate section, backlink, bumped last_updated and source_docs
- `index.md` — new entry under Concepts, updated scoring.md summary, header date bump
- `SCHEMA.md` — added email-finder.md to directory tree

**Source doc:** `DOCS/EMAIL_FINDER.md` (implementation spec written earlier on 2026-04-10)

**Conflicts flagged:** none

---

## [2026-04-09] insight | Headless Deployment Architecture

**Key architectural insight:** PRECRIME runs headlessly on AWS with zero changes. Claude Code IS the orchestration backbone (prompt → API → parse tool calls → execute locally → patch results → resend). Install it on an EC2, point at the PRECRIME folder, trigger via cron with `claude -p --dangerously-skip-permissions "run enrichment"`. Same .md skills, same MCP server (stdin/stdout), same SQLite DB. No transport adapter needed.

**Anthropic Managed Agents** (beta 2026-04-01) is the hosted alternative — same agent loop, but Anthropic manages the runtime. Requires HTTP transport for MCP (breaking change from stdin/stdout). Adds value at scale; overkill for a single pipeline. Accurately described as "orchestration-as-a-service" — the cloud vendor play to pull self-hosting users back to managed infrastructure.

**Wiki pages created/updated:**
- `concepts/headless-deployment.md` — NEW: full architecture, CLI flags, cron schedule, Managed Agents comparison
- `index.md` — added entry
- `SCHEMA.md` — added to directory tree

**Conflicts flagged:** none
