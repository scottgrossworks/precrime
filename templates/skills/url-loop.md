---
name: url-loop
description: One-Task SCRAPE_SOURCE worker. Consume one already-claimed SCRAPE_SOURCE Task, scrape its Source URL, save discoveries with judge:false, complete the Task, stop.
triggers:
  - scrape one source
  - run scrape source task
  - SCRAPE_SOURCE worker
---

# url-loop -- SCRAPE_SOURCE Worker

Execute exactly one already-claimed `SCRAPE_SOURCE` Task. Do not call `claim_task`, `plan_tasks`, `next_source`, `report_session`, `judge_affected`, or `rescore`. Complete the Task and stop.

## Step 1 -- Accept Claimed Task

The orchestrator has already called `claim_task` and handed you the Task packet.

Set:

- `taskId = task.id`
- `sourceId = task.targetId`
- `url = task.input.url`
- `channel = task.input.channel`

Expected Task: `{ type:"SCRAPE_SOURCE", targetType:"Source", targetId, input:{ url, channel } }`. If the Task is missing or not this type, stop and report `wrong_task_type`; do not claim another Task.

## Step 2 -- Scrape

Pick exactly one branch.

### Step 2.a -- channel === "rss"

Do NOT call `tavily__tavily_extract`.

```
precrime_rss__get_top_articles({ feedUrl: url, limit: 10 })
```

- If response is `{ articles: [], diag:{ cause } }`, use the RSS soft-fail completion below.
- Otherwise treat each article's `title + snippet + content?` as evidence and its `url` as `sourceUrl`.
- Extract relevant Clients, Factlets, Bookings, and article URLs worth scraping later.

Do NOT extract the feed URL with Tavily. Do NOT extract article URLs inside this Task; save article URLs as Sources and let the Planner schedule later `SCRAPE_SOURCE` Tasks.

### Step 2.b -- default web scrape

For `directory`, `blog`, `website`, `reddit`, `fb`, `ig`, `x`, or unknown channels:

```
tavily__tavily_extract({ url: url })
```

If extract fails, complete as `failed`.

From successful content, extract only VALUE_PROP-relevant:

- Clients: savable business/person records. Sparse company-only records are allowed.
- Factlets: reusable evidence such as event date, buying occasion, venue signal, budget clue, market trend, or demand signal. Use `skills/shared/factlet-rules.md`.
- Bookings: only when the page contains a plausible booking opportunity.
- New Sources: URLs likely to reveal more Clients or Factlets.
- RSS/Atom feeds: detect feed links (`rel="alternate"`, `/feed`, `/rss.xml`, `/atom.xml`, `/feed.xml`, `?feed=`, anchor text RSS/Subscribe/Atom) and save as `{ url:"<feedUrl>", channel:"rss", subtype:"feed", discoveredFrom:"<the scraped source url>" }`.

Do NOT write to `skills/rss-factlet-harvester/rss_sources.md` at runtime. It is a SEED only. Runtime queue writes go through `add_sources`.

## Step 3 -- Save

For each Client / Booking / Factlet group:

```
precrime__pipeline({
  action: "save",
  judge: false,
  patch: {
    name: "<if present>",
    company: "<if present>",
    email: "<if present>",
    phone: "<if present>",
    website: "<if present>",
    source: "<the scraped url>",
    segment: "<if known>",
    draftStatus: "brewing",
    clientNotes: "<short relevance note>",
    factlets: [/* if any */],
    bookings: [/* if any */]
  }
})
```

Collect returned `affectedClientIds`, `affectedBookingIds`, saved `factletIds`.

For discovered URLs, call once:

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "<discovered url>", channel: "directory|blog|website|reddit|fb|ig|x", discoveredFrom: "<the scraped source url>" },
    { url: "<discovered feed url>", channel: "rss", subtype: "feed", discoveredFrom: "<the scraped source url>" }
  ]
})
```

Collect returned source ids when present.

Every `pipeline.save` call MUST pass `judge:false`. Do not call `judge_affected` or `rescore`. Do not write `Booking.status`.

## Step 4 -- Mark Source

```
precrime__pipeline({ action: "mark_source", url: url, clientsFound: <save-call count> })
```

## Step 5 -- Complete

Success:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds: [<affected client ids>],
    bookingIds: [<affected booking ids>],
    factletIds: [<saved factlet ids>],
    sourceIds: [<added source ids>],
    summary: "Scraped <url>: <N> clients, <M> factlets, <K> new sources.",
    needsJudge: true
  }
})
```

If nothing relevant was found, use `status:"done"`, empty id arrays, summary `"no findings"`, and `needsJudge:false`.

Failure:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error: "<extract_failed | login_wall | js_only | irrelevant | empty>",
  output: { clientIds: [], bookingIds: [], summary: "Scrape failed for <url>: <reason>.", needsJudge: false }
})
```

RSS soft-fail:

```
precrime__pipeline({ action: "mark_source", url: url, clientsFound: 0 })
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds: [],
    bookingIds: [],
    factletIds: [],
    sourceIds: [],
    summary: "RSS feed yielded 0 articles above threshold: <diag.cause>",
    needsJudge: false
  }
})
```

Never leave a claimed Task open.

## Step 6 -- Stop

After `complete_task`, exit. Do not claim another Task.
