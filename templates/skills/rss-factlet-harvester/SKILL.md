---
name: rss-factlet-harvester
description: Scan RSS feeds for relevant news, create factlets.
triggers:
  - harvest rss
  - check the news
  - refresh factlets
---

# RSS Factlet Harvester

Scan configured RSS feeds and create factlets -- short, broadly applicable intelligence items attached to relevant clients.

---

## Procedure

### Step 0: Open Session

```
precrime__pipeline({ action: "start_session", workflow: "rss-factlet-harvester", target_count: 25 })
```

Hold the returned `session_id` as `sid`. Pass it to `next_source`, every `save`, every `mark_source`, and final `report_session`.

### Step 1: Fetch Articles

Call `precrime-rss__get_top_articles({ limit: 100 })`.

**If tool not available:** iterate RSS feeds from the DB via `precrime__pipeline({ action: "next_source", channel: "rss", maxAgeDays: 0, session_id: sid })` -- each row's `url` is the feed URL. `tavily__tavily_extract` each one and parse `<item>` or `<entry>` elements. Pair every `next_source` with `mark_source`. Do NOT read `rss_sources.md` -- it's a seed file.

### Step 2: Check Existing Factlets

```
precrime__find({ action: "factlets", filters: { sinceTimestamp: "<ISO timestamp for 30 days ago>" }, limit: 100 })
```

Same topic as an existing factlet -> skip.

### Step 3: Evaluate Each Article

**Relevant?** To selling the product to the target audience per VALUE_PROP config. If not: skip.

**Broadly applicable or specific to one org/person?**
- BROAD -> factlet candidate (Step 4).
- SPECIFIC -> run `skills/shared/classify-contact.md`.

**Recent enough?** Within 7 days: strong. 7-30 days: major trends only. 30+: skip.

### Step 4: Create Factlets

Follow `skills/shared/factlet-rules.md` for format, rules, and save procedure.

### Step 5: Feed Growth

Scan articles for unfamiliar publications. Try RSS autodiscovery (`/feed`, `/rss`, `/feed.xml`). Valid + fresh + relevant -> add to the Source table:

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "<feed url>", channel: "rss", subtype: "feed", label: "<publication name>", category: "<events|industry|local>", discoveredFrom: "<source article url>" }
  ]
})
```

Max 3 new feeds per run. Server dedups on URL; do NOT touch `rss_sources.md`.

### Step 6: Report

For every claimed RSS source:

```
precrime__pipeline({
  action: "mark_source",
  url: "<feed url>",
  clientsFound: <factlets created + leads captured>,
  failedReason: <only if fetch/parse failed or yielded nothing useful>
})
```

Then close:

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Report articles fetched, relevance pass, factlets created, leads captured, duplicates skipped, feeds added.
