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
| `mcp__precrime-rss__get_top_articles` | Fetch top-scoring articles from configured RSS feeds |
| `mcp__leedz-mcp__create_factlet` | Save a qualifying article as a factlet |
| `mcp__leedz-mcp__get_new_factlets` | Check existing queue (avoid duplicates) |
| `WebFetch` | Fetch full article content if snippet is insufficient |

## Procedure

### Step 0: Read VALUE_PROP.md

Read `DOCS/VALUE_PROP.md` before running. Note:
- **PRODUCT_NAME**: what is being sold
- **AUDIENCE_DESCRIPTION**: who the buyers are
- **RELEVANT_TOPICS**: what topics matter to this audience (see relevance signals section in VALUE_PROP.md)
- **NOT_RELEVANT_TOPICS**: topics to exclude

Use these in all prompts and relevance checks below.

### Step 0.5: Discover AI Assistant (optional but recommended)

Check for a Gemini or Grok tab:
```
mcp__Claude_in_Chrome__tabs_context_mcp({ createIfEmpty: false })
```
Scan tabs for `gemini.google.com` or `grok.com`. Store as `SESSION_AI = { gemini: <tabId> | null, grok: <tabId> | null }`. If Chrome isn't connected, set `SESSION_AI = null` and skip Gemini steps.

### Step 1: Fetch Articles

```
mcp__precrime-rss__get_top_articles({ limit: 100 })
```

Returns scored articles: url, title, pubDate, feedName, category, score, snippet, content.

### Step 2: Check Existing Factlets

```
mcp__leedz-mcp__get_new_factlets({ since: "{{TODAY}}T00:00:00Z", limit: 100 })
```

Use a 30-day lookback. If an article covers the same topic as an existing factlet, skip it.

### Step 2.5: Bulk Relevance Pre-filter via Gemini (if SESSION_AI available)

**Skip to Step 3 if SESSION_AI is null.**

Offload the bulk relevance pass to Gemini — zero Claude tokens for the filtered-out articles.

1. Compile a numbered list of all articles: `[N] [title] — [snippet, first 20 words]`
2. Navigate to Gemini tab and paste:
   > "We sell [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]. From this numbered article list, return ONLY the numbers of articles that are relevant buying signals, industry trends, or pain points for this audience. Comma-separated numbers only, no explanation."
   (Fill [PRODUCT_NAME] and [AUDIENCE_DESCRIPTION] from DOCS/VALUE_PROP.md)
3. Wait 5 seconds. Read response via `get_page_text`.
4. Parse the comma-separated list. Only run Step 3 full evaluation on those numbered articles. Skip all others.
5. Log: `Gemini pre-filter: [N total] → [M passed]`

### Step 3: Evaluate Each Article

For each article (pre-filtered if Gemini was available), answer three questions:

**Q1: Is this relevant to selling [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]?**
(Use product name and audience from DOCS/VALUE_PROP.md)

RELEVANT topics:
(See "Relevance Signals — Relevant" section in DOCS/VALUE_PROP.md)

NOT RELEVANT:
(See "Relevance Signals — Not Relevant" section in DOCS/VALUE_PROP.md)

If not relevant: skip. Move to next article.

**Q2: Is this broadly applicable — or specific to one org/person?**

BROAD (proceed to Q3):
- Industry-wide trends, policy changes, market shifts
- Statistics or studies that apply across your entire audience
- Competitor moves that all your clients should know about

SPECIFIC to one org/person → four-path classification:
- Already in DB? `search_clients({ company: "[name]", limit: 1 })` → YES: append to dossier, no factlet. NO: continue.
- Has trade + date + location/zip AND `leadCaptureEnabled`? → Lead HOT: `create_client` + `create_booking(status:"leed_ready")`, run Booking Completeness Check.
- Missing booking details AND `leadCaptureEnabled`? → Lead THIN: `create_client` only, dossier note.
- `leadCaptureEnabled = false`? → skip. Log: `LEAD_CAPTURE_OFF — [org]`

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
- Sentence 2: Why it matters for the target decision-makers (per VALUE_PROP.md) specifically.
- Sentence 3 (optional): Implication for buying or urgency.
- No opinion. No editorializing. Facts only.
- No mention of the product in the factlet. The factlet is intelligence. The Composer connects it to the product later.

**Good factlet example:**
"[Industry body] reported a 34% increase in [relevant trend] across [geography] in Q1 2026. Organizations that have not addressed [pain point] face [consequence] by [deadline]. [Implication for the buying decision]."

**Bad factlet:**
"There's a new trend in [industry]. Organizations should look into tools like [the product]." (Too vague. Editorializing. Mentions product.)

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
