---
name: url-loop
description: One-Task SCRAPE_SOURCE worker. Claim one SCRAPE_SOURCE Task, scrape its Source URL, save discoveries with judge:false, complete the Task, stop. Does not decide global workflow, does not iterate sources.
triggers:
  - scrape one source
  - run scrape source task
  - SCRAPE_SOURCE worker
---

# url-loop -- One-Task SCRAPE_SOURCE Worker

This skill is a worker. It executes exactly one `SCRAPE_SOURCE` Task and stops.

The Planner (`pipeline.plan_tasks`) decides what work exists. The Judge (`pipeline.judge_affected`) decides scoring. This skill does neither. It writes facts and completes its Task.

Do not iterate to another Source. Do not call `next_source`. Do not run `report_session`. Do not loop. Do not improvise. The legacy multi-step queue/budget version is preserved at `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\url-loop.legacy.md` for reference only.

---

## Step 1 -- Claim one Task

Call:

```
precrime__pipeline({
  action: "claim_task",
  role:   "url-loop",
  types:  ["SCRAPE_SOURCE"]
})
```

Response shape:

```json
{
  "status": "CLAIMED",
  "task": {
    "id": "task_...",
    "type": "SCRAPE_SOURCE",
    "status": "claimed",
    "targetType": "Source",
    "targetId": "src_...",
    "input": { "url": "https://...", "channel": "directory|blog|website|rss|reddit" }
  }
}
```

Branching:

- `status === "NO_TASK"` -> STOP. Do not claim, do not call any other action, do not look for work elsewhere. Exit the skill.
- `status === "CLAIMED"` -> hold `taskId = task.id`, `sourceId = task.targetId`, `url = task.input.url`, `channel = task.input.channel`. Proceed to Step 2.
- Any other status (`CONTENTION`, error) -> STOP. Do not retry in a tight loop. Exit the skill.

---

## Step 2 -- Scrape the one Source (channel-aware)

The scrape tool depends on `channel`. Pick exactly one branch.

### Step 2.a -- channel === "rss"  (RSS or Atom feed)

Do NOT call `tavily__tavily_extract`. Call the RSS MCP directly with the claimed feed URL:

```
precrime_rss__get_top_articles({ feedUrl: url, limit: 10 })
```

The RSS MCP fetches only that one feed (server-side override for the configured-feed list), scores items against the deployment keyword list, and returns at most `limit` articles above the relevance threshold, sorted by score.

The response is either `[{ url, title, pubDate, feedName, snippet, score, hasFullContent, content? }, ...]` OR `{ articles: [], diag: { cause, ... } }` when zero items passed threshold.

- If the response carries `diag` / zero articles: skip article extraction and route to the **soft-fail path** in Step 5 (mark_source with `clientsFound: 0`, complete the Task with `status: "done"`, `needsJudge: false`, and put `diag.cause` in the summary).
- Otherwise: for each returned article, derive Factlets / Client dossier evidence / potential Bookings using the same VALUE_PROP discipline as Step 2.b. The article's `title + snippet + content?` is the evidence body; the article's `url` is the per-factlet `sourceUrl`.

Do NOT also call `tavily__tavily_extract` on the feed URL itself -- the RSS MCP already pulled and scored each article. Do NOT call `tavily__tavily_extract` on individual article URLs in this Task either; that is a different SCRAPE_SOURCE Task and will be enqueued by `add_sources` + the next planner pass if the article URL warrants its own scrape.

### Step 2.b -- channel in {"directory", "blog", "website", "reddit", or anything else}  (default web scrape)

Call exactly once:

```
tavily__tavily_extract({ url: url })
```

If extract fails (`ok: false`, timeout, 4xx, 5xx, empty body), skip to Step 5 (failure path).

Otherwise, read `content` and `candidates`. Extract clients, factlets, and new source URLs that are relevant to the deployment VALUE_PROP. Use the same extraction discipline as before:

- A vendor/business name is a savable client even without contact details.
- Skip navigation chrome (`Home`, `About`, `Sign In`, ...), section headers, single city/state names, and generic single words.
- Factlets are broad reusable signals: event dates, hiring/buying occasions, market trend, budget clue, venue signal, demand signal. See `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\shared\factlet-rules.md`.
- New sources are URLs likely to reveal more clients or factlets later.
- RSS / Atom feed URLs are first-class sources too. Look for: (a) `<link rel="alternate" type="application/rss+xml" ... href="...">` tags if the raw markup survived extraction, (b) URLs ending in `/feed`, `/feed/`, `/rss`, `/rss.xml`, `/atom.xml`, `/feed.xml`, `/index.xml`, or carrying a `?feed=` query string, (c) anchor text "RSS" / "Subscribe" / "Atom feed" pointing at a URL. Save each in the Step 3 `add_sources` call as `{ url: "<feedUrl>", channel: "rss", subtype: "feed", discoveredFrom: "<the scraped source url>" }`. This is the cheap incidental-discovery path that grows the rss queue without a dedicated brainstorm Task. The discovered feed will surface as its own `SCRAPE_SOURCE` Task on the next planner pass and Step 2.a will handle it.

**Do NOT write to `skills/rss-factlet-harvester/rss_sources.md` at runtime.** That file is a SEED only -- imported once at startup via `pipeline.import_sources`. The Source table in SQLite is the runtime queue; `add_sources` is the only sanctioned write path.

---

## Step 3 -- Save discoveries with judge:false

For EACH client extracted, call:

```
precrime__pipeline({
  action: "save",
  judge:  false,
  patch: {
    name:        "<if present>",
    company:     "<if present>",
    email:       "<if present>",
    phone:       "<if present>",
    website:     "<if present>",
    source:      "<the scraped url>",
    segment:     "<if known>",
    draftStatus: "brewing",
    clientNotes: "<short why-relevant tied to VALUE_PROP>"
  }
})
```

Each `save` response contains `affectedClientIds` and `affectedBookingIds`. Collect them across all saves.

For new sources discovered during the scrape, call once. `discoveredFrom` is the URL of the source you JUST scraped (i.e. `url` from Step 1, not the newly-discovered URL):

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "<discovered url>", channel: "directory|blog|website|reddit", discoveredFrom: "<the scraped source url>" },
    { url: "<discovered feed url>", channel: "rss", subtype: "feed", discoveredFrom: "<the scraped source url>" }
  ]
})
```

Collect returned source ids if present.

For factlets relevant to a client, attach via the standard `save` patch with a `factlets` entry on that client. Save each factlet under one client save call; do not invent a placeholder client just to hold a factlet.

CRITICAL: every `pipeline.save` call from this worker MUST pass `judge: false`. Scoring is owned by the Judge via the JUDGE_AFFECTED Task that the Planner will create from this Task's output. Do not call `pipeline.judge_affected` here. Do not call `pipeline.rescore` here. Do not set `Booking.status` directly.

---

## Step 4 -- Mark the Source row scraped

```
precrime__pipeline({
  action: "mark_source",
  url:    url,
  clientsFound: <count of save calls you issued>
})
```

This releases the Source claim and stamps `scrapedAt`. It is separate from completing the Task.

---

## Step 5 -- Complete the Task

If Step 2's extract succeeded and Step 3 ran:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds:   [<collected affected client ids>],
    bookingIds:  [<collected affected booking ids>],
    factletIds:  [<saved factlet ids if any>],
    sourceIds:   [<newly added source ids if any>],
    summary:     "Scraped <url>: <N> clients, <M> factlets, <K> new sources.",
    needsJudge:  true
  }
})
```

`needsJudge: true` is set whenever ANY client/booking/factlet id was produced. If nothing was produced, set `needsJudge: false` and the summary should say "no findings".

If extract failed, or the page yielded nothing useful and you want to record the failure cleanly:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error:  "<short reason: extract_failed | login_wall | js_only | irrelevant | empty>",
  output: {
    clientIds:  [],
    bookingIds: [],
    summary:    "Scrape failed for <url>: <reason>.",
    needsJudge: false
  }
})
```

**RSS soft-fail path (from Step 2.a):** when `get_top_articles` returned zero articles with a `diag.cause`, the source isn't broken -- it just produced nothing above threshold this round. Mark it scraped and complete the Task as **done** (not failed) so the Planner doesn't immediately re-queue it:

```
precrime__pipeline({ action: "mark_source", url: url, clientsFound: 0 })
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds:  [],
    bookingIds: [],
    factletIds: [],
    sourceIds:  [],
    summary:    "RSS feed yielded 0 articles above threshold: <diag.cause>",
    needsJudge: false
  }
})
```

Never leave a claimed Task uncompleted. If you cannot do the work for any reason, call `complete_task` with `status: "failed"` and a short `error`. The server will not let stale claims live forever (recycler reclaims them), but a worker should always close its own Task explicitly.

---

## Step 6 -- Stop

After `complete_task` returns, exit the skill. Do not claim another Task. Do not iterate to another Source. Do not call `report_session`. Do not call `plan_tasks`. The Planner decides what is next; the worker is done.
