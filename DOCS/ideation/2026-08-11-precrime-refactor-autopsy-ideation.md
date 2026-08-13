---
date: 2026-08-11
updated: 2026-08-12 (v2 — corrected to Scott's water-in-glass model; v1 ideas superseded where marked)
topic: precrime-refactor-autopsy
focus: why 5 months produced no results; refactor to FOUNDATION.md + the private-booking goal without losing what works
mode: repo-grounded
---

# Ideation v2: PRECRIME Refactor — The Water-in-Glass Model

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

## Build list (ranked)

### 1. Source admission gate + smart source generator
**Description:** One code chokepoint through which EVERY source enters (crawler-found
or LLM-proposed): in service area, buyer-side, demand-bearing — or refused. Paired
with an LLM generator that brainstorms sources from VALUE_PROP + geography ("LA
quinceañera FB groups", "SFV parent groups", school/PTA calendars, permit feeds) —
names no human would think of. Machine proposes, machine vets, code decides. No manual
approval (standing rule). Link-following alone is not discovery.
**Basis:** direct: 158 out-of-state seller URLs self-appended in 48h, purged by hand twice.
**Confidence:** 90% · **Complexity:** Low–Medium · **Status:** Unexplored

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

### 7. Honest containers: bookings mean real events
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

## Standing constraints (violations = rework)
No Thumbtack/GigSalad/TheBash/Bark — ever. No reply/outcome tracking. Drafting stays
user-triggered. Never budget 0. No vendor lock-in. LOC down. Rules in code. Prisma only.
