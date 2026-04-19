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
| `mcp__precrime-rss__get_top_articles` | Fetch top-scoring articles from configured RSS feeds |
| `mcp__precrime-mcp__create_factlet` | Save a qualifying article as a factlet |
| `mcp__precrime-mcp__get_new_factlets` | Check existing queue (avoid duplicates) |
| `WebFetch` | Fetch full article content when snippet is insufficient |
| `WebSearch` | Research a story's broader context when needed |

## Procedure

### Step 0: Read VALUE_PROP.md

Read `DOCS/VALUE_PROP.md` before running. Note:
- PRODUCT_NAME
- AUDIENCE_DESCRIPTION
- RELEVANT_TOPICS (from "Relevance Signals — Relevant" if present)
- NOT_RELEVANT_TOPICS (from "Relevance Signals — Not Relevant" if present)

Use these in all relevance checks below.

### Step 1: Fetch Articles

```
mcp__precrime-rss__get_top_articles({ limit: 100 })
```

Returns scored articles with url, title, pubDate, feedName, category, score, snippet, content.

### Step 2: Check Existing Factlets

```
mcp__precrime-mcp__get_new_factlets({ since: "<30 days ago>", limit: 100 })
```

If an article covers the same topic as an existing factlet, skip it.

### Step 3: Evaluate Each Article

Three questions per article:

**Q1 — Relevant?** To selling PRODUCT_NAME to AUDIENCE_DESCRIPTION per VALUE_PROP.md. If not: skip.

**Q2 — Broadly applicable, or specific to one org/person?**

BROAD → proceed to Q3 (becomes a factlet candidate).

SPECIFIC to one org/person → four-path classification:
- Already in DB (`search_clients`)? → YES: append to dossier, no factlet.
- Has trade + date + location/zip AND `leadCaptureEnabled`? → Lead HOT: `create_client` + `create_booking(status:"leed_ready")`.
- Missing booking details AND `leadCaptureEnabled`? → Lead THIN: `create_client` only.
- `leadCaptureEnabled = false` → skip, log `LEAD_CAPTURE_OFF`.

**Q3 — Recent enough?**
- Within 7 days: strong candidate
- 7–30 days: include only if major trend or policy piece
- 30+ days: skip unless landmark event still unfolding

### Step 4: Create Factlets

For each article that passes all three questions:

```
mcp__precrime-mcp__create_factlet({
  content: "[2-3 sentence summary]",
  source: "https://article-url/..."
})
```

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
