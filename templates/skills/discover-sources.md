---
name: {{DEPLOYMENT_NAME}}-discover-sources
description: One-Task DISCOVER_SOURCES worker. Read VALUE_PROP, run a few bounded Tavily searches for NEW scrape sources that match the trade/buyers/geography across ALL channels (incl. RSS feeds + social + directories — the channels recursion never grows), register them via add_sources, complete, stop. This is the cold-start engine: with an empty source list and a clear VALUE_PROP it goes out and finds the first sources.
triggers:
  - discover sources
  - run discover sources task
  - DISCOVER_SOURCES worker
---

# discover-sources — DISCOVER_SOURCES worker (source finder)

Process ONE already-claimed DISCOVER_SOURCES task. Find NEW places to scrape that fit
the product, and register them. You add SOURCES (feeds, accounts, directories, pages),
never clients/bookings/factlets. Mechanical: read VALUE_PROP → search → classify →
add_sources → complete. You never save clients/bookings. Only the tools advertised to you exist.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- Read the **ASSIGNED TASK** JSON block in these instructions as `task` (do NOT call get_task). If `task.type` is not `DISCOVER_SOURCES` → complete `failed` `wrong_task_type`, stop.

## Step 1 — Read VALUE_PROP (what to search for)
`developer__shell(command="type \"DOCS\\VALUE_PROP.md\"")` (relative to the deployment root; or `precrime__pipeline({action:"get_config"})`)
Pull out, for query building:
- **trade** (e.g. caricatures) — also available via `precrime__trades` if you want the canonical name
- **buyer types** the pitch names (parties, schools, corporate, conventions, festivals, fairs, brand activations, weddings, …)
- **geography** (cities/regions)
Do NOT invent a business it isn't. Search for who books THIS trade in THIS area.

## Step 2 — Build 3–5 bounded queries across channels
Aim each query at SOURCE-BEARING pages (feeds, accounts, directories, listings) — NOT
individual leads. Deliberately cover the channels recursion never finds: **RSS feeds,
social handles, directories.** Combine trade/buyer/geography from Step 1. Templates:
- **rss / blog (PRIORITIZE — feeds are chronically under-discovered; spend 2+ queries here when `data/sources/rss.md` is thin):** hunt ACTUAL feed URLs, not just pages. `<region> <buyer type> blog inurl:feed OR inurl:rss` · `<segment> events OR wedding OR party blog "/feed/"` · `<region> <trade> OR event entertainment blog rss` · `<buyer type> newsletter OR blog subscribe rss`. Most event/wedding/party blogs are WordPress and expose their feed at `<site>/feed/` — if a query surfaces a promising blog HOME page but no explicit feed link, register the blog URL with `/feed/` appended as an `rss` source (the scorer skips a feed that 404s, so a wrong guess is harmless).
- **directory:** `<region> event vendor directory`  ·  `<region> <buyer type> association OR vendors list`
- **reddit:** `site:reddit.com <region> events OR <buyer type>`
- **ig:** `site:instagram.com <region> <buyer type>`
- **x:** `site:x.com <region> <buyer type> OR events`
Pick the 3–5 that best fit the VALUE_PROP. Keep it bounded — this is a sweep, not a crawl.

## Step 3 — Search
Run `tavily__tavily_search` per query (default depth, small count, e.g. max_results 5).
Tavily unavailable → complete `cancelled` `tavily_unavailable`, stop. Collect candidate
URLs from results (and any feed/handle URLs surfaced). Skip login walls and obvious junk.

## Step 4 — Classify channel + register (add_sources)
Classify each URL to a channel by these rules (first match wins):
- contains `/feed`, `/rss`, `feeds.`, or ends `.xml` → **rss**
- `reddit.com` → **reddit**   ·   `instagram.com` → **ig**   ·   `x.com`/`twitter.com` → **x**   ·   `facebook.com` → **SKIP** (FB unsupported — do NOT register)
- a vendor/association/listing/directory page → **directory**
- a `/blog` or WordPress-style blog → **blog**
- anything else (a normal site/page) → **website**
For social handles, the bare handle is fine (`@name`, `r/sub`) — the server normalizes.
Register everything in ONE call (the server is the sole writer; it appends to
`data/sources/<channel>.md`, dedups on URL, and the new sources are immediately scrapeable):
```
precrime__pipeline({ action:"add_sources", entries:[
  { url:"<url>", channel:"<channel>", label:"<short name>" },
  ...
]})
```
Quote the returned `{ added, duplicates, invalid }` in your summary.

## Step 5 — Complete
Found sources:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[], bookingIds:[], factletIds:[], sourceIds:[],
    summary:"Discovered <added> new source(s) across <channels> (dupes <duplicates>).", needsJudge:false }})
```
Nothing usable: `status:"done"`, summary `"no new sources found"`.
Tavily down / error: `status:"cancelled"|"failed"`, `error:"<tavily_unavailable|tool_error>"`,
summary `"DISCOVER_SOURCES failed: <reason>."`.
Never leave a claimed task open. Then STOP.
