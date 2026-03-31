---
name: {{DEPLOYMENT_NAME}}-factlet-harvester
description: Scan RSS feeds for relevant news and create factlets for the broadcast queue
triggers:
  - harvest factlets
  - check the news
  - refresh factlets
  - run the factlet harvester
---

# {{DEPLOYMENT_NAME}} — Factlet Harvester

You scan configured news feeds and create factlets — short, broadly applicable intelligence items that get broadcast to every client in the enrichment pipeline.

## When to Run

- At the start of an enrichment session, before processing any clients
- On a schedule (daily or every few days)
- When the user asks to "check the news" or "refresh factlets"

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__bloomleedz-rss__get_top_articles` | Fetch top-scoring articles from configured RSS feeds |
| `mcp__leedz-mcp__create_factlet` | Save a qualifying article as a factlet |
| `mcp__leedz-mcp__get_new_factlets` | Check existing queue (avoid duplicates) |
| `WebFetch` | Fetch full article content if snippet is insufficient |

## Procedure

### Step 1: Fetch Articles

```
mcp__bloomleedz-rss__get_top_articles({ limit: 100 })
```

Returns scored articles: url, title, pubDate, feedName, category, score, snippet, content.

### Step 2: Check Existing Factlets

```
mcp__leedz-mcp__get_new_factlets({ since: "{{TODAY}}T00:00:00Z" })
```

Use a 30-day lookback. If an article covers the same topic as an existing factlet, skip it.
Adjust the date window as needed (longer lookback = stronger dedup, more processing).

### Step 3: Evaluate Each Article

For each article, answer three questions:

**Q1: Is this relevant to selling {{PRODUCT_NAME}} to {{AUDIENCE_DESCRIPTION}}?**

RELEVANT topics:
{{FACTLET_RELEVANT_TOPICS}}

NOT RELEVANT:
{{FACTLET_NOT_TOPICS}}

If not relevant: skip. Move to next article.

**Q2: Is this broadly applicable to multiple clients — or specific to one?**

Factlets are for BROAD intel only. If an article is about one specific organization's internal event, it belongs in that org's dossier during enrichment — not here.

BROAD (create factlet):
- Industry-wide trends, policy changes, market shifts
- Statistics or studies that apply across your entire audience
- Competitor moves that all your clients should know about

NOT BROAD (skip):
- One specific company's internal announcement
- One individual's achievement or news

**Q3: Is this recent enough to matter?**

- Published within 7 days: strong candidate
- Published 7–30 days ago: include if it's a major trend or policy piece
- Published 30+ days ago: skip unless it's a landmark event still unfolding

### Step 4: Create Factlets

For each article that passes all three questions:

```
mcp__leedz-mcp__create_factlet({
  content: "[2-3 sentence summary]",
  source: "https://article-url.com/..."
})
```

**Factlet content rules:**
- 2–3 sentences. No more.
- Sentence 1: What happened. Include numbers, dates, names where available.
- Sentence 2: Why it matters for {{TARGET_ROLES}} specifically.
- Sentence 3 (optional): Implication for buying or urgency.
- No opinion. No editorializing. Facts only.
- No mention of {{PRODUCT_NAME}} in the factlet. The factlet is intelligence. The Composer connects it to the product later.

**Good factlet example:**
"[Industry body] reported a 34% increase in [relevant trend] across [geography] in Q1 2026. Organizations that have not addressed [pain point] face [consequence] by [deadline]. [Implication for the buying decision]."

**Bad factlet:**
"There's a new trend in [industry]. Organizations should look into tools like {{PRODUCT_NAME}}." (Too vague. Editorializing. Mentions product.)

### Step 5: Report

After processing all articles:
- Articles fetched: N
- Articles that passed relevance screening: N
- Factlets created: N (with one-line summaries)
- Duplicates skipped: N
- Irrelevant/old skipped: N

## Expected Volume

- A typical harvest converts 10–20% of articles into factlets
- If you're creating factlets from more than half the articles: relevance filter is too loose
- If zero factlets from a full pull: that's normal — not every news cycle has broadly applicable intel

## Deduplication

Before creating a factlet, check: does an existing factlet already cover this same event, policy, or study? Two articles from different sources about the same thing should produce ONE factlet.

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER
     ================================
     The factlet harvester is only as good as the RSS feeds it reads.
     See rss/rss-scorer-mcp/rss_config.json to add/remove feeds and tune keywords.

     After the first few harvests, check:
     - Which feeds produce the most relevant articles?
     - Which feeds produce mostly noise?
     - Are there topic areas your clients care about that aren't covered by any feed?

     The relevance filter above (Q1) mirrors the relevance-judge.md criteria.
     Keep them in sync — if you add a new relevant topic to relevance-judge.md,
     add the same topic here.

     RECENCY NOTE: The "30 days ago" cutoff in Q3 is a default. For fast-moving
     industries (events, news, finance), tighten to 7 days. For slow-moving
     industries (regulation, compliance, academic research), relax to 90 days.
-->
