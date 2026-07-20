---
name: {{DEPLOYMENT_NAME}}-fb-factlet-harvester
description: One-Task SCRAPE_SOURCE worker for channel="fb". Render one claimed Facebook page/group via the browser MCP, save discoveries with judge:false, recurse via add_sources, complete the Task, stop.
triggers:
  - harvest facebook
  - scrape fb
  - SCRAPE_SOURCE fb worker
---

# fb-factlet-harvester -- SCRAPE_SOURCE Worker (channel="fb")

Execute exactly one already-claimed `SCRAPE_SOURCE` Task whose `input.channel` is `fb`. The orchestrator already called `claim_task`. Do NOT call `claim_task`, `plan_tasks`, `next_source`, `start_session`, `report_session`, `judge_affected`, or `rescore`. Complete the Task and stop.

Facebook requires a rendered browser session. This worker is dispatched only when the deployment has browser scraping enabled (`chromeScrape: true` in precrime_config.json): your worker recipe carries the `chrome` MCP (mcp-chrome), which drives the user's installed, logged-in Chrome through the bridge. Browse HUMAN-PACED: one page at a time, no rapid-fire navigation — this is the user's real account. If the `chrome` tools are not available or the bridge refuses the connection, complete `cancelled` with `error:"browser_unavailable_fb"` and stop -- do not fall back to Tavily (it returns login-wall chrome, not posts).

## Step 1 -- Accept Claimed Task

- `taskId = task.id`
- `sourceId = task.targetId`
- `url = task.input.url`
- `channel = task.input.channel`  (expect `fb`; if not, stop and report `wrong_channel`)

## Step 2 -- Render

```
chrome__chrome_navigate({ url })
chrome__chrome_get_web_content({ textContent: true })   // reads the rendered, logged-in page
```

For more posts on an infinite-scroll feed, re-call `chrome__chrome_get_web_content` after the page has loaded further (mcp-chrome reads the live DOM of the tab). From the returned text, extract only posts within the last 30 days that are relevant to `DOCS/VALUE_PROP.md`:

- Clients: savable business/person records (sparse company-only allowed).
- Factlets: reusable demand evidence (event date, buying occasion, venue, budget clue, market trend). Use `skills/shared/factlet-rules.md`. BROAD post -> factlet; SPECIFIC contact -> `skills/shared/classify-contact.md`.
- Bookings: only on a plausible booking opportunity (trade + date + location) -- see `skills/shared/booking-detect.md`.
- New Sources: linked FB pages/groups worth scraping later.

If the page is a login wall or yields nothing, complete `failed` (Step 5).

**Engagement floor (C#2):** consult `DOCS/PEER_SOURCES.json` -> `engagement.channels.fb`. Drop posts whose reactions+comments fall below `floor`; process the highest-engagement posts first.

## Step 3 -- Save (judge:false)

For each Client / Booking / Factlet group:

```
precrime__pipeline({ action:"save", judge:false, patch:{
  name, company, email, phone, website,
  source: url, segment, draftStatus:"brewing",
  clientNotes:"<short relevance note>",
  factlets:[/* if any */], bookings:[/* if any */]
}})
```

Collect `affectedClientIds`, `affectedBookingIds`, saved `factletIds`. Every save MUST pass `judge:false`. Do not write `Booking.status`.

For discovered FB pages/groups, call once (recursion):

```
precrime__pipeline({ action:"add_sources", entries:[
  { url:"https://facebook.com/<page>",      channel:"fb", subtype:"page",  discoveredFrom: url },
  { url:"https://facebook.com/groups/<id>", channel:"fb", subtype:"group", discoveredFrom: url }
]})
```

Server dedups on URL. Do NOT write source files by hand -- use `add_sources` (the server is the sole writer; it appends to data/sources/).

## Step 4 -- Mark Source

```
precrime__pipeline({ action:"mark_source", url: url, clientsFound: <save-call count> })
```

## Step 5 -- Complete

Success:

```
precrime__pipeline({ action:"complete_task", taskId, status:"done", output:{
  clientIds:[...], bookingIds:[...], factletIds:[...], sourceIds:[...],
  summary:"Scraped <url>: <N> clients, <M> factlets, <K> new fb sources.", needsJudge:true
}})
```

Nothing relevant: `status:"done"`, empty arrays, summary `"no findings"`, `needsJudge:false`.
Failure: `status:"failed"`, `error:"<login_wall | empty | browser_unavailable_fb>"`, `needsJudge:false`. Then `mark_source` with `clientsFound:0` and a `failedReason`.

Never leave a claimed Task open.

## Step 6 -- Stop

After `complete_task`, exit. Do not claim another Task.
