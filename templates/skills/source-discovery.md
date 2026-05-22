---
name: {{DEPLOYMENT_NAME}}-source-discovery
description: Discover new source channels (FB pages, subreddits, RSS feeds, directories, IG/X handles, blogs) and add them to the Source table.
triggers:
  - run source discovery
  - discover sources
  - find new sources
  - expand source list
---

# Source Discovery

Find new places where potential clients congregate. This feeds the DISCOVER function in `DOCS/FOUNDATION.md` -- the more sources, the more clients the seeder and harvesters find.

The Source queue lives in the DB. New entries go in via `precrime__pipeline({action:"add_sources", entries:[...]})`. The server dedups on URL and normalizes handle/tag inputs to canonical URLs.

**Do NOT** edit `_sources.md` or `discovered_directories.md` files. Those are read-only seeds, imported once at first deploy.

---

## Setup

1. **Use latched mode.** The caller already selected interactive or headless. If unset, default to interactive and do not run tree/session scans.
2. **Hold VALUE_PROP config** -- extract product name, target audience, geography, trade, buying occasions.
3. **Read pipeline status.** `precrime__pipeline({ action: "status" })` -- client count tells you cold start vs expansion.

The server already holds the dedup baseline. Do NOT re-read `_sources.md` files; `add_sources` rejects duplicates by URL.

---

## Coverage Gap Analysis (expansion runs only)

```
precrime__find({ action: "clients", summary: true, limit: 20 })
```

Compare existing segments / geographies against VALUE_PROP. What's missing? Prioritize discovery accordingly. Cold start: skip gap analysis, run broad discovery.

---

## Discovery Channels

For each channel, search using Tavily (or SESSION_AI in interactive mode). Validate before adding: does the URL load? Is the source active (content within 60 days)? Is it relevant to the trade/audience? Do NOT ask the user for input. Do NOT stop between channels. Run all channels, batch-add results, proceed.

**MINIMUM TARGETS per run:**
- Facebook: 10 pages/groups
- Instagram: 10 accounts/hashtags
- RSS: 5 feeds
- Reddit: 5 subreddits
- Directories: 5 URLs
- X/Twitter: 5 accounts/hashtags

Run at least 1 search per channel even if the channel already has many entries -- the goal is finding NEW sources not already in the DB.

**Search strategy:** Do NOT use a single generic query. Use MULTIPLE specific queries per channel:
- Query 1: `"[trade]" "[geography]"` (direct match)
- Query 2: `"[related trade]" "[geography]"` (adjacent trades that hire your trade)
- Query 3: `"event planner" OR "wedding planner" "[geography]"` (buyers)

For each channel, collect candidates as you go, then issue ONE `add_sources` call with the full batch.

### Facebook Pages/Groups

Search: `"[trade]" "[geography]" site:facebook.com`, etc.

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "https://facebook.com/some-page", channel: "fb", subtype: "page", label: "..." },
    { url: "https://facebook.com/groups/123",  channel: "fb", subtype: "group", label: "..." }
  ]
})
```

### Subreddits

Search: `"[geography]" events site:reddit.com`, etc.

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "r/eventplanning", channel: "reddit" },
    { url: "r/weddingvendors", channel: "reddit" }
  ]
})
```

(Server normalizes `r/foo` -> `https://www.reddit.com/r/foo`.)

### RSS Feeds

For discovered publications, try `/feed`, `/rss`, `/feed.xml`, `/atom.xml`. Validate the feed loads.

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "https://example.com/feed", channel: "rss", label: "Example Blog", category: "events" }
  ]
})
```

### Instagram

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "@some_handle", channel: "ig", subtype: "account" },
    { url: "#someevent",   channel: "ig", subtype: "hashtag" }
  ]
})
```

(Server normalizes `@handle` and `#tag` to instagram.com URLs.)

### X / Twitter

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "@some_account",  channel: "x", subtype: "account" },
    { url: "#someevent",     channel: "x", subtype: "hashtag" },
    { url: "event vendors",  channel: "x", subtype: "keyword" }
  ]
})
```

### Directories

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "https://example.com/vendor-list", channel: "directory", category: "exhibitor_list" }
  ]
})
```

---

## Recursion lineage

When a discovery search finds a source via another known source (e.g., a directory page links to a smaller niche directory), pass `discoveredFrom: "<parent url>"` in the entry. The server stores the lineage, which helps audit which sources are productive and which are dead ends.

---

## Capture Factlets

If discovery turns up broadly applicable intel (industry trends, policy changes, market data) -> follow `skills/shared/factlet-rules.md`.

---

## Run Log

Append to `logs/DISCOVERY_LOG.md`: searches attempted, sources added (by channel), sources rejected as duplicates, factlets created. The server's `add_sources` response gives you exact `added / duplicates / invalid` counts -- echo those.

---

## Return value

When you finish all channels, summarize the totals you saw across all `add_sources` calls and return to the caller. The url-loop skill checks whether `total_added > 0` to decide whether to keep looping or terminate.
