---
date: 2026-08-11
updated: 2026-08-12 (v2.1 — code-verified against discover-sources.md; build order fixed; #7 parked)
topic: precrime-refactor-autopsy
focus: why 5 months produced no results; refactor to FOUNDATION.md + the private-booking goal without losing what works
mode: repo-grounded
---

# Ideation v2: PRECRIME Refactor — The Water-in-Glass Model

## START HERE (cold session)

Read in this order before touching code:
1. `DOCS/Claude.md` — hard rules. Simplicity first, surgical changes, READ THE CODE
   don't assume, no architectural overthinking, monolith LOC goes DOWN.
2. `DOCS/FOUNDATION.md` — the demand-signal doctrine.
3. `DOCS/HANDOFF_2026-08-10.md` — architecture, data state, standing rules, and the
   log of what was already fixed. **Do not re-fix anything listed there.**
4. This document — the work queue. The doctrine section governs; the BUILD ORDER
   table sequences; each item names its own entry points.

**Two trees, edit BOTH.** Source of truth / git repo: `WKG/PRECRIME`. Deployed and
running: `WKG/TDS/precrime`. Workflow: edit in TDS → `node --check` + live smoke test
→ hash-verify sync to PRECRIME (`diff -q`) → commit + push from PRECRIME. Also update
the masters in `WKG/TDS/TMP/` when touching `precrime_config.json`, `VALUE_PROP.md`,
or `data/sources/*.md` — `deploy.bat` restores from there and will silently revert you.

**Shared DB:** `WKG/SCHEMA/data/leedz.sqlite` (Prisma via `leedz-db`). Running
`node server/mcp/mcp_server.js` by hand resolves the WRONG DB — `precrime.bat` is what
sets `DATABASE_URL`. Never write datetimes through raw SQL (mixed-type corruption).

**Verify before you build:** every "X doesn't exist" claim below was true on
2026-08-12. Re-check against the code — several v2 items shrank once the code was
actually read (see #1).

## The doctrine (Scott, 2026-08-12 — this section governs everything below)

**Every client is a glass, created empty. Every relevant fact is weighted water,**
recorded as a factlet, defensible in the dossier: a scraped date, a found location, a
published prom announcement, a past gig, a generated reason ("Halloween is 6 weeks out;
they threw a costume party in '24"), a predicted recurrence. Predictions may fill
*timing and likelihood* — never facts. Location is scraped or blank, never synthesized.

**ONE rim.** Outreach does NOT wait for the rim — **outreach is the instrument for
filling the glass**: it resolves the blanks we cannot scrape (demand for OUR service,
willingness to meet price, exact venue). The proprietary edge is timing — email the
prom coordinator while the glass is half full and no competitor knows the event exists.
**At the rim, the leed is a commodity** (complete information = competition) — so at
the rim you SELL it on the Leedz marketplace. Best case: the gig is booked to us
pre-rim and the client fills in the schema themselves.

**After outreach or share: done.** No reply tracking, no outcome loop, no booking
lifecycle. Other CRM tools own the sale. The client row persists because past bookings
are the best source of future bookings — nothing more.

**Why 5 months produced ~nothing** (measured): the machinery to fill glasses was
broken or mis-aimed — drills frozen/pointed at conventions, the demand scanner
pipe-deadlocked its whole life, sources self-polluted with out-of-state seller pages
(158 purged 2026-08-12), reddit/fb starved — while the gate asked for rim-level
completeness before anything could be called hot. The model was never wrong; the
plumbing never ran on the right targets.

## BUILD ORDER

Item numbers below are stable IDs, not sequence. Build in this order:

| Increment | Items | Goal |
|---|---|---|
| **1 — make it run** | #1, #2 | In-area demand sources actually enter and get read |
| **2 — make it smart** | #3, #8 | Right client, right day, defensible reason; predicted events reach the gate |
| **3 — widen the net** | #5, #6, #4 | School/permit calendars, Bookers, inbox demand |
| **parked** | #7 | See item |

NOTHING IS INVERTED. The architecture and FOUNDATION doctrine stand. Every item below
makes an existing component do the job it was designed for.

## Build list

### 1. Server-side source admission gate (+ un-break the FB channel)
**Description:** SMALLER THAN v2 IMPLIED — code-verified 2026-08-12: the smart generator
already exists. `skills/discover-sources.md` already reads VALUE_PROP, already makes
geography MANDATORY in every query, already prioritizes hunting real RSS feed URLs, and
already refuses other metros' pages. The pollution never came through it — scrape
workers register crawled links directly, bypassing the skill's rules. So the work is:
(a) enforce area + buyer-side + demand-bearing in the server's `add_sources` handler —
same choke-point pattern as banned-terms / competitor / self-exclusion gates, the fourth
instance of "a rule only holds in code"; (b) **delete the stale `facebook.com → SKIP
(FB unsupported)` rule in the skill** — chromeScrape has driven FB since July, and that
one line blocks the entire FB-group channel where the Santa Barbara bride lives;
(c) raise DISCOVER_SOURCES budget off 1/session; (d) planner wake-up adequacy audit —
channel thin or yieldless → auto-enqueue `DISCOVER_SOURCES {channel, goal}` (mandatory,
per Scott: discovery is queueable plumbing, not a config chore).
**Basis:** direct: 158 out-of-state seller URLs self-appended in 48h, purged by hand twice; discover-sources.md read in full 2026-08-12.
**Confidence:** 90% · **Complexity:** Low · **Status:** Unexplored

### 2. Demand-RSS wiring: Reddit search feeds + Google Alerts into the existing scorer
**Description:** The rss-scorer (55-min cron, VALUE_PROP keywords) exists but reads 6
vendor blogs — industry content, zero demand. Swap in demand feeds: Reddit search
`.rss` endpoints (free, no auth: `/r/LosAngeles/search.rss?q=...&sort=new`), Google
Alerts delivered as RSS (free). Craigslist has no public RSS — saved-search email
alerts route to the inbox catcher (#4) instead.
**Basis:** direct: rss_config.json audit; the SB-bride class of post exists and announces itself.
**Confidence:** 85% · **Complexity:** Low · **Status:** Unexplored

### 3. Daily sweep + semantic "why this client, why now" selector
**Description:** Every morning: (a) real bookings with `startDate − today ≤ ~40d`, not
recently contacted/dismissed → planner; (b) the reasoning half: LLM reads VALUE_PROP +
calendar + season and brainstorms TODAY's reasons (Halloween, Rosh Hashanah, a meteor
shower), each semantically matched to client histories (the APPLY_FACTLET matcher IS
this) — matches add weighted water; top glasses not recently touched → outreach
candidates, dossier carries the argument. Recency is a guard, never the key. Declined
today → water keeps accumulating, the case gets stronger.
**Basis:** direct: Scott's spec verbatim; the mining lane already proved the mechanics (155 sends/30d, $0).
**Confidence:** 85% · **Complexity:** Medium · **Status:** Unexplored

### 4. Inbox catcher via the INVOICER Chrome extension
**Description:** The extension (WKG/INVOICER) already reads Gmail content and writes
leedz.sqlite. Add demand-shape detection: FB group notifications, Nextdoor digests,
Google Alert emails, Craigslist alerts, direct inquiries → extract → save as leed
(`source: inbox`). The Santa Barbara bride email is this proposal working manually.
**Basis:** direct: the notification email Scott received 2026-08-12; extension infrastructure exists.
**Confidence:** 80% · **Complexity:** Medium · **Status:** Unexplored

### 5. School / PTA / permit source build-out
**Description:** Currently ZERO school-calendar, PTA, or event-permit sources exist
(only 3 wrong lacounty pages). Districts publish prom/carnival/fundraiser dates months
out — the flagship "predicted demand" case (the prom passes the gate via scraped date
+ drilled contact + predicted-evening time). Seed generator #1 with these categories;
209 school clients already imported and waiting.
**Basis:** direct: sources audit — the highest-signal published-calendar category is unmined.
**Confidence:** 85% · **Complexity:** Medium · **Status:** Unexplored

### 6. Bookers as a first-class client class
**Description:** `Client.clientClass = host | booker`. A booker (agency, planner,
venue coordinator) IS a client — they pay, they're the contact, the job site is
arbitrary. Same ontology, own template family ("keep me on your roster"), own cadence
(quarterly), competitor tie-break already protects them. Scrapeable, enqueueable,
drillable with existing machinery.
**Basis:** direct: Scott's spec; the crawler kept surfacing planner pages — the discoverable population.
**Confidence:** 80% · **Complexity:** Medium · **Status:** Unexplored

### 8. Predicted fields are water (with provenance) + drills aimed at the unfillable slots
**Description:** The prom case, made real — Scott's correction: *"we want a PREDICTIVE
system — some of the fields are predicted. The demand is predicted. The goal is to
predict with high probability, with supporting evidence (factlets)."* Two halves.
(a) **Predicted values count, tagged as predictions**: `startTime: "19:00"` +
provenance factlet ("school dances run evenings") fills the slot; classify stops
reporting it as missing; the judge weighs prediction + supporting factlets as
probability, not as fact. HARD LINE: predictions may fill *timing and likelihood* only
— location and contact are scraped or blank, NEVER synthesized (a prom may be at a
banquet hall, not the school). (b) **Drills target what prediction cannot fill**:
DRILL_DOWN already takes `missing:[...]` — aim it at contact + location for real
predicted events, instead of at conventions and "(untitled) — Paris". This is what
makes #5's calendars convert.
**Basis:** direct: Scott's prom correction 2026-08-12; DRILL_DOWN spawned on Collect-A-Con / Star Wars Celebration / Rescueverse-San-Francisco while zero private events got drilled.
**Confidence:** 85% · **Complexity:** Medium · **Status:** Unexplored

### 7. PARKED — Honest containers: bookings mean real events
**PARKED 2026-08-12.** Most invasive change in the set and not required by any other
item: the fake rows make reports lie, they do not stop the engine. Revisit after
increments 1–3 are running. Prereq inventory already done (below) so it can start cold.
**Description:** Stop minting "(seed)" stubs; work-tickets live in the task layer;
recall/rebooking attention keys off client fields + semantic selection (#3), not fake
bookings. Purge the 1,478 stubs + synthetic-date rows. Prereq check confirmed:
APPLY_FACTLET already matches clients; the bare-client drill path exists; only Stage 5
enrichment selection needs a client-centric query.
**Basis:** direct: 1,478/2,272 brewing rows are placeholders; every seed consumer inventoried.
**Confidence:** 80% · **Complexity:** Medium–High · **Status:** Unexplored

## Superseded from v1 (kept for the record)
- ~~Outcome ledger / REPLY_SWEEP / Square-diff attribution~~ — REJECTED by owner:
  no feedback loop; outreach out the door = done. One-time deliverability seed-inbox
  test allowed; nothing ongoing.
- ~~Two reachable hots~~ — replaced by the one-rim water model above.
- ~~Sentinel panel with owner-approved sources~~ — replaced by #1: agentic generation
  + code gate; no human approval loop.
- ~~Hunt referrers (as strategy pivot)~~ — became #6, a taxonomy feature, not a pivot.
- ~~Recall wheel (bare date column)~~ — subsumed into #3; selection must be semantic,
  not recency arithmetic alone.
- ~~"The architecture is inverted / stop optimizing for completeness"~~ — PROPOSED AND
  STRICKEN 2026-08-12. It contradicted this document's own finding ("the model was
  never wrong; the plumbing never ran on the right targets") and threw away 5 months of
  correct architecture over gaps that are plumbing bugs. The hot gate is not the
  problem; unfilled slots are. Do not re-propose.

## Entry points (verified 2026-08-12 — re-check before editing)

| Item | Files / symbols |
|---|---|
| **#1** gate | `server/mcp/sourceQueue.js` → `pipelineAddSources` (the choke point; wired at `mcp_server.js:306`) · `server/mcp/sourceStore.js` (channel files, `readySources`) · `skills/discover-sources.md` (delete the `facebook.com → SKIP` line) · `precrime_config.json` `tasks.limits/sessionBudgets.DISCOVER_SOURCES` · planner Stage 7 in `mcp_server.js` for the adequacy audit. Copy the enforcement pattern from `saveClient.js` `bannedTermHit` / `competitorHit`. |
| **#2** demand-RSS | `rss/rss-scorer-mcp/rss_config.json` (keywords already derive from VALUE_PROP) · `data/sources/rss.md` · `server/mcp/chromeBridge.js` (:12306) for the Google-Alerts setup task |
| **#3** selector | planner Stage 5 in `mcp_server.js:2632` (client selection query) · `server/mcp/factletMatch.js` `candidateClientIdsForFactlet` (the semantic matcher — this IS the engine) · `server/mcp/reasons/ReasonGenerator.js` + `ReasonPlanner.js` |
| **#4** inbox | `WKG/INVOICER` extension (already reads Gmail, already writes `leedz.sqlite` via the local server) |
| **#5** school/permit | no new code — discovery goals fed to #1's generator; 209 school clients already imported |
| **#6** Bookers | `WKG/SCHEMA/schema.prisma` (`Client.clientClass`) then regenerate `leedz-db` · `server/mcp/saveClient.js` · `server/mcp/workers/DRAFT_PROMPT.json` + VALUE_PROP for the booker template family |
| **#7** containers | `saveClient.js:26` `buildSeedBooking` (stop minting) · Stage 5 selection must go client-centric first |
| **#8** predicted water | `server/mcp/classification.js:160` `classify()` (predicted ≠ missing) · `server/mcp/factlets.js:404` `judgeLeed` (weigh prediction + provenance) · Stage 4.5 `mcp_server.js:2460` (drill targeting) |

## Done — do NOT re-fix (2026-08-10 → 08-12)
Tavily budgets un-zeroed · mining rotates (`ReasonPlanner.REHUNT_HOURS`) · LAST_30_DAYS
pipe deadlock (`ProceduralWorker.runCli` stdout discard + 240s kill) · reddit reserved
scrape slot (Stage 6) · DRILL_CONTAINER container-only allow-list (Stage 4.6) ·
competitor gate + 41 competitor clients purged · bounce → email-hunt drill (terminal
rows never swept) · enrichment stops on barren snippet · datetime columns normalized ·
draft role → `claude-sonnet-5` at `REASONING_EFFORT` high · sources purged twice
(directory 177→19, website 161→57) + TMP masters synced.

## Standing constraints (violations = rework)
No Thumbtack/GigSalad/TheBash/Bark — ever. No reply/outcome tracking. Drafting stays
user-triggered. Never budget 0. No vendor lock-in. LOC down. Rules in code. Prisma only.
