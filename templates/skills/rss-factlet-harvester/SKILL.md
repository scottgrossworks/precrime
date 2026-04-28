---
name: rss-factlet-harvester
description: Scan RSS feeds for relevant news and create factlets for the broadcast queue. Follows the same folder pattern as fb/ig/reddit/x harvesters.
triggers:
  - harvest factlets
  - harvest rss
  - check the news
  - refresh factlets
  - run the rss harvester
  - run the factlet harvester
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# RSS Factlet Harvester

You scan configured RSS feeds and create factlets — short, broadly applicable intelligence items broadcast to every client in the enrichment pipeline.

## Source Configuration

**Feeds:** `skills/rss-factlet-harvester/rss_sources.md` — the ONLY place feeds are listed. The RSS MCP server reads this file at startup. Edit this file to add, remove, or reorganize feeds.

**Scoring + keywords:** `rss/rss-scorer-mcp/rss_config.json` — holds keyword lists, blacklist, scoring weights, and runtime parameters. No feeds.

## When to Run

- At the start of an enrichment session, before processing any clients
- On a schedule (daily or every few days)
- When the user says "check the news" or "refresh factlets"

## Tools

| Tool | Purpose |
|------|---------|
| `precrime_rss__get_top_articles` | Fetch top-scoring articles from configured RSS feeds |
| `precrime__pipeline({ action: "save", id, patch: { factlets: [...] } })` | Attach a qualifying article as a factlet under a client (v2 has no standalone factlets) |
| `precrime__find({ action: "factlets" })` | Check existing queue (avoid duplicates) |
| `precrime__find({ action: "clients" })` | Look up the target client to attach factlets to |
| `tavily__tavily_extract` | Fetch full article content when snippet is insufficient |
| `tavily__tavily_search` | Research a story's broader context when needed |

## Procedure

### Step 0: Read VALUE_PROP.md

Read `DOCS/VALUE_PROP.md` before running. Note:
- PRODUCT_NAME
- AUDIENCE_DESCRIPTION
- RELEVANT_TOPICS (from "Relevance Signals — Relevant" if present)
- NOT_RELEVANT_TOPICS (from "Relevance Signals — Not Relevant" if present)

Use these in all relevance checks below.

### Step 1: Fetch Articles

Call `precrime_rss__get_top_articles` with `limit: 100`.

**If that tool is not available** (not in your toolset), fall back: read `skills/rss-factlet-harvester/rss_sources.md`, then call `tavily__tavily_extract({ url: "..." })` on each feed URL directly and parse the returned content for `<item>` or `<entry>` elements (title, link, pubDate, description).

Returns scored articles with url, title, pubDate, feedName, category, score, snippet, content.

### Step 2: Check Existing Factlets

Call `precrime__find({ action: "factlets", filters: { since: "30 days ago ISO" }, limit: 100 })`.

If an article covers the same topic as an existing factlet, skip it.

### Step 3: Evaluate Each Article

Three questions per article:

**Q1 — Relevant?** To selling PRODUCT_NAME to AUDIENCE_DESCRIPTION per VALUE_PROP.md. If not: skip.

**Q2 — Broadly applicable, or specific to one org/person?**

BROAD → proceed to Q3 (becomes a factlet candidate).

SPECIFIC to one org/person → four-path classification:
- Already in DB (`precrime__find({ action: "clients", filters: { search: "..." }, summary: true, limit: 1 })`)? → YES: append to dossier via `precrime__pipeline({ action: "save", id, patch: { dossier } })`, no broadcast factlet.
- Has trade + date + location/zip AND `leadCaptureEnabled`? → Lead HOT: `precrime__pipeline({ action: "save", patch: { name, company, source, bookings: [{ status: "leed_ready", trade, startDate, location, zip }] } })`.
- Missing booking details AND `leadCaptureEnabled`? → Lead THIN: `precrime__pipeline({ action: "save", patch: { name, company, source } })`.
- `leadCaptureEnabled = false` → skip, log `LEAD_CAPTURE_OFF`.

**Q3 — Recent enough?**
- Within 7 days: strong candidate
- 7–30 days: include only if major trend or policy piece
- 30+ days: skip unless landmark event still unfolding

### Step 4: Create Factlets

For each article that passes all three questions, attach to a client (v2 has no standalone factlets):

OPTION A (preferred): if the article maps to an existing client, look them up and attach:
```
precrime__find({ action: "clients", filters: { company: "[name]" }, summary: true, limit: 1 })
precrime__pipeline({ action: "save", id: clientId, patch: { factlets: [{ content: "[2-3 sentence summary]", source: "[article URL]", signalType: "context" }] } })
```

OPTION B (fallback): if the article is broad-applicable but has no client target yet, append to `logs/UNLINKED_INTEL.md` with content + source. Promote to a client save when one surfaces. Do not invent a placeholder client.

**Factlet content rules:**
- 2–3 sentences. No more.
- S1: what happened (numbers, dates, names where available).
- S2: why it matters for the target audience per VALUE_PROP.md.
- S3 (optional): implication for buying / urgency.
- No opinion. No editorializing. Facts only.
- Never mention the product in the factlet. The factlet is intelligence — the composer connects it to the product later.

**Good factlet example:**
"[Industry body] reported a 34% increase in [relevant trend] across [geography] in Q1 2026. Organizations that have not addressed [pain point] face [consequence] by [deadline]. [Implication for the buying decision]."

**Bad factlet (pitches the product — don't):**
"There's a new trend in [industry]. Organizations should look into tools like [the product]."

### Step 5: Report

After processing:
- Articles fetched: N
- Articles passing relevance: N
- Factlets created: N (with one-line summaries)
- Duplicates skipped: N
- Irrelevant/old skipped: N

## Expected Volume

- Typical harvest converts 10–20% of articles into factlets.
- >50% conversion = relevance filter too loose.
- 0 factlets from a full pull is fine — not every cycle has broadly applicable intel.

## Deduplication

Before creating a factlet, check: does an existing factlet already cover this same event, policy, or study? Two articles about the same thing produce ONE factlet.
