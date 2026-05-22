---
name: {{DEPLOYMENT_NAME}}-reddit-factlet-harvester
description: Harvest Reddit posts for relevant intel, create factlets or capture leads.
triggers:
  - harvest reddit
  - scrape reddit
  - check reddit
---

# Reddit Factlet Harvester

Harvest posts from curated subreddits. Reddit's public JSON API works without authentication.

---

## Procedure

### Step 0: Pre-flight

1. Open a session:
   ```
   precrime__pipeline({ action: "start_session", workflow: "reddit-factlet-harvester", target_count: 25 })
   ```
   Hold the returned `session_id` as `sid`.
2. Iterate Reddit sources from the DB via:
   ```
   precrime__pipeline({ action: "next_source", channel: "reddit", maxAgeDays: 0, session_id: sid })
   ```
   Each row's `url` is the canonical subreddit URL (e.g., `https://www.reddit.com/r/eventplanning`). Loop until `QUEUE_EMPTY`. Pair every `next_source` with `mark_source` before the next claim. Do NOT read `reddit_sources.md` -- it's a seed file, imported once at first deploy.
3. Load existing factlets for dedup.

### Step 1: Fetch Posts

For each subreddit, fetch via Tavily or direct URL:
```
tavily__tavily_extract({ url: "https://www.reddit.com/r/[subreddit]/new.json?limit=25" })
```

### Step 2: Evaluate Each Post

For each post with substantive text content:
- **Relevant?** Check title + selftext against VALUE_PROP config relevance signals. Skip if not.
- **Broad or specific?**
  - BROAD (industry trend, policy, market data) -> factlet candidate.
  - SPECIFIC to one person/org -> run `skills/shared/classify-contact.md`.
  - SPECIFIC with booking details (trade + date + location) -> run `skills/shared/booking-detect.md`.
- **Duplicate?** Same topic as existing factlet -> skip.

### Step 3: Create Factlets

Follow `skills/shared/factlet-rules.md`.

### Step 4: Source Growth

If posts reference other relevant subreddits, add them to the Source table:

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "r/<subreddit>", channel: "reddit", discoveredFrom: "<current post permalink>" }
  ]
})
```

Server normalizes `r/foo` -> `https://www.reddit.com/r/foo` and dedups on URL. Do NOT touch `reddit_sources.md`.

### Step 5: Report

For every claimed subreddit:

```
precrime__pipeline({
  action: "mark_source",
  url: "<subreddit source url>",
  clientsFound: <factlets created + leads captured>,
  failedReason: <only if fetch/parse failed or yielded nothing useful>
})
```

Then close:

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Report subreddits scraped, posts evaluated, factlets created, leads captured, duplicates skipped, sources added.
