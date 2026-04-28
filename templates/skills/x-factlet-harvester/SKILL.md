---
name: MyProject-x-factlet-harvester
description: Harvest X/Twitter posts via Grok and create factlets or capture leads
triggers:
  - harvest x factlets
  - harvest twitter factlets
  - scrape x
  - scrape twitter
  - run the x harvester
  - check x for news
  - check twitter for news
  - check x for leads
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# MyProject — X/Twitter Factlet & Lead Harvester

You harvest X (Twitter) posts using Grok (via Chrome) and classify each post into one of four output paths. Grok searches X's full index — zero API keys, zero fetch scripts. You handle the judgment.

**Detect mode at Step 0.** Chrome + Grok is preferred. If unavailable, use tavily__tavily_search as fallback. Do NOT stop.

## Source File

`skills/x-factlet-harvester/x_sources.md`

Three source types: `@accounts`, `#hashtags`, and `keyword:` searches. Source-discovery and init-wizard populate this file.

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__Claude_in_Chrome__tabs_context_mcp` | Verify Chrome is connected |
| `mcp__Claude_in_Chrome__navigate` | Navigate to Grok or X search |
| `mcp__Claude_in_Chrome__computer` | Type queries, scroll, wait |
| `mcp__Claude_in_Chrome__get_page_text` | Read Grok responses / X search results |
| `precrime__pipeline({ action: "save", id, patch: { factlets: [...] } })` | Attach factlet under a client (v2 has no standalone factlets) |
| `precrime__find({ action: "factlets" })` | Check existing queue (dedup) |
| `precrime__find({ action: "clients" })` | Check if a person/org is already a client |
| `precrime__pipeline({ action: "save", id, patch: { dossier } })` | Append to existing client's dossier |
| `precrime__pipeline({ action: "save", patch: { bookings: [...] } })` | Create a booking under client (Lead Capture hot path) |

## Procedure

### Step 0: Pre-flight

1. **Detect mode:** if `mcp__Claude_in_Chrome__tabs_context_mcp` is in your available tools, call it. If the tool is missing or fails → **HEADLESS mode** automatically. Do NOT stop. Do NOT mention Chrome.
2. Chrome only: scan open tabs for `grok.com` or `x.com/i/grok`. Store as `GROK_TAB = <tabId> | null`. Scan for `x.com` → `X_TAB = <tabId> | null`.
3. Read `x_sources.md`. Parse all entries (skip lines starting with `#` or blank). Separate into: `accounts`, `hashtags`, `keywords`.
4. `precrime__find({ action: "factlets", filters: { since: "1970-01-01T00:00:00Z" } })` — load full queue for dedup.

**If HEADLESS:** skip Steps 1 (Grok path). Go directly to Step 1H.

### Step 1H: Headless X Harvesting (tavily__tavily_search)

For each `@account` in x_sources.md:
`tavily__tavily_search({ query: "from:{account} site:x.com 2026" })`

For each `#hashtag`:
`tavily__tavily_search({ query: "#{hashtag} site:x.com 2026" })`

For each `keyword:` entry:
`tavily__tavily_search({ query: "{keyword phrase} site:x.com 2026" })`

Evaluate snippets using the same classification in Steps 3–4. Jump to Step 5 (report) when done.

### Step 1: Fetch Posts via Grok (Primary)

**If `GROK_TAB` is available (preferred):**

Process sources in batches by type. For each batch, navigate to the Grok tab and submit a query.

**Account batch:**
For each `@handle` in `accounts` list, ask Grok:
> "Show the most recent tweets from @{handle} in the last 7 days. For each tweet, include: the full tweet text, the date posted, and the number of likes/retweets if visible. List them numbered."

**Hashtag batch:**
For each `#hashtag` in `hashtags` list, ask Grok:
> "Show the most popular tweets using #{hashtag} from the last 7 days. Focus on tweets from businesses, organizations, or professionals — not personal opinions. For each tweet, include: the author @handle, the full tweet text, and the date posted. List them numbered."

**Keyword batch:**
For each `keyword:` entry in `keywords` list, ask Grok:
> "Search X for: {search phrase}. Show the most relevant tweets from the last 7 days. For each tweet, include: the author @handle, the full tweet text, and the date posted. List them numbered."

After each query:
1. Wait 3 seconds for Grok to respond
2. `get_page_text` to read the response
3. Parse the numbered list into individual posts. Extract: author, text, date, engagement (if available), source URL (construct as `https://x.com/{author}/status/{id}` if ID visible, otherwise `https://x.com/{author}`)
4. Move to next query

**Pacing:** Wait 2 seconds between Grok queries. Grok is fast but don't rapid-fire.

### Step 1-fallback: Chrome X Search (if no Grok)

**Only if `GROK_TAB` is null and `X_TAB` is available:**

For each source entry:
1. Navigate to `x.com/search?q={query}&f=live` where `{query}` is:
   - For accounts: `from:{handle}`
   - For hashtags: `#{hashtag}`
   - For keywords: the search phrase
2. Wait 3 seconds for page to load
3. Scroll down twice: `scroll down 5 ticks` → wait 1s → `scroll down 5 ticks`
4. `get_page_text` — extract tweet content from the feed
5. Parse visible tweets into individual posts

**Note:** X search via Chrome requires the user to be logged into X. Results are less structured than Grok. If X blocks or requires login, log `X_SEARCH_BLOCKED` and skip.

### Step 2: Load Existing Factlets (dedup)

```
precrime__find({ action: "factlets", filters: { since: "30 days ago ISO" } })
```

Build a list of existing factlet topics. Any post covering the same ground gets skipped.

### Step 3: Classify Each Post — Four Output Paths

For every post collected from Grok or X search, answer the classification questions IN ORDER:

**Skip the post entirely if:**
- Date is older than 7 days (X moves fast — stale posts have low signal value)
- Text is empty or unintelligible
- Post is clearly a bot, spam, or engagement bait

**For each remaining post:**

**1. Is this about a specific person or organization?**

- **NO** → evaluate as **Factlet** candidate (Step 4A)
- **YES** → continue to question 2

**2. Is this person/org already in the DB?**

```
precrime__find({ action: "clients", filters: { search: "{name or org}" }, summary: true, limit: 1 })
```

- **YES (match found)** → **Dossier** update (Step 4B)
- **NO** → continue to question 3

**3. Does this post contain booking details?**

Check for ALL THREE:
- **Trade** — what service is needed? (maps to a Leedz trade name)
- **Date** — when is the event?
- **Location or zip** — where?

- **YES (all three present)** → **Lead Capture HOT** (Step 4D)
- **NO (missing any)** → **Lead Capture THIN** (Step 4C)

### Step 4A: Factlet Path

Apply the three-question relevance filter:

**Q1: Relevant to selling [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]?**
(Use product name and audience from DOCS/VALUE_PROP.md)

RELEVANT topics:
(See "Relevance Signals — Relevant" section in DOCS/VALUE_PROP.md)

NOT RELEVANT:
(See "Relevance Signals — Not Relevant" section in DOCS/VALUE_PROP.md)

**Q2: Broadly applicable to multiple clients?**

Industry-wide trends, policy changes, market shifts → YES.
One person's rant, personal opinion, or one org's internal matter → NO.

X has a much higher noise-to-signal ratio than other platforms. Be strict on Q2. Hot takes and viral threads are NOT factlets unless they report actual news.

**Q3: Recent enough to matter?**

- Posted within 3 days: strong candidate
- 3–7 days: include if major trend
- 7+ days: skip (X content decays faster than other platforms)

If all three pass: v2 requires a client target.

OPTION A (preferred): if the post maps to an existing client, attach via `precrime__pipeline({ action: "save", id: clientId, patch: { factlets: [{ content: "[2-3 sentences...]", source: "https://x.com/{author}/status/{id}", signalType: "context" }] } })`.

OPTION B (fallback): if no client target yet, append the entry to `logs/UNLINKED_INTEL.md` with content + source. Promote to a client save when one surfaces. Do not invent a placeholder client.

Rules: 2-3 sentences. No opinions. No mention of the product.
One factlet per distinct topic — not one per post. Multiple tweets about the same news = one factlet.

### Step 4B: Dossier Path

This post is about an existing client. Append to their dossier:

```
precrime__pipeline({
  action: "save",
  id: "{clientId}",
  patch: { dossier: "{existing dossier}\n[{today}] X @{author}: {finding}" }
})
```

### Step 4C: Lead Capture THIN

New potential client, vague — no concrete booking details.

**Only if `leadCaptureEnabled` is true in config.** Skip otherwise.

Note in the report: "Thin lead: @{author} — {summary}. Flagged for review."

When lead capture is active, the orchestrator creates the client. This skill flags only.

### Step 4D: Lead Capture HOT

New client WITH booking details — trade + date + location all present.

**Only if `leadCaptureEnabled` is true in config.** Skip otherwise.

Note in the report with full details:
- **Who:** {author or org name}
- **Trade:** {what service they need}
- **Date:** {when}
- **Location:** {where}
- **Source:** `https://x.com/{author}/status/{id}`
- **Snippet:** {relevant quote from tweet}

When lead capture is active, the orchestrator creates client + booking. Skill flags and reports.

## Step 5: Report

After processing all sources:

```
X Harvest Report — {date}
================================
Fetch method: Grok | X search
Accounts queried: N
Hashtags queried: N
Keyword searches: N
Posts collected: N
Posts evaluated: N (after recency/spam filter)

Output path breakdown:
  Factlets created:     N (with summaries)
  Dossier updates:      N (client name + finding)
  Lead Capture thin:    N (flagged for review)
  Lead Capture hot:     N (flagged with full details)
  Duplicates skipped:   N
  Irrelevant skipped:   N
  Too old skipped:      N
  Spam/bot skipped:     N
```

## Rules

- Grok is the fetch layer. Claude does the judgment. Never use tavily__tavily_extract for X.
- One factlet per distinct topic — not one per post. A trending topic with 10 tweets = one factlet.
- X has high noise. Be stricter on relevance than with Reddit or RSS. Hot takes are not factlets.
- Recency window is tighter: 7 days max, prefer 3. X content decays fast.
- Do NOT interact with X (no posting, no liking, no retweeting, no following, no DMs).
- Do NOT follow external links in tweets. Evaluate the tweet text only.
- Do NOT scrape private/protected accounts.
- Lead Capture is opt-in. If `leadCaptureEnabled` is false, flag but do not create records.
- Dossier entries are timestamped prose. Include the @handle.
- If Grok returns "I can't help with that" or similar refusal, skip that query and log `GROK_REFUSED — {query}`.

---

