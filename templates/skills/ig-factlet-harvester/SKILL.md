---
name: {{DEPLOYMENT_NAME}}-ig-factlet-harvester
description: One-Task SCRAPE_SOURCE worker for channel="ig". Render one claimed Instagram account/hashtag via the browser MCP, save discoveries with judge:false, recurse via add_sources, complete the Task, stop.
triggers:
  - harvest instagram
  - scrape ig
  - SCRAPE_SOURCE ig worker
---

# ig-factlet-harvester -- SCRAPE_SOURCE Worker (channel="ig")

Execute exactly one already-claimed `SCRAPE_SOURCE` Task whose `input.channel` is `ig`. The orchestrator already called `claim_task`. Do NOT call `claim_task`, `plan_tasks`, `next_source`, `start_session`, `report_session`, `judge_affected`, or `rescore`. Complete the Task and stop.

Instagram requires a rendered browser session. Dispatched only in interactive mode where the `chrome` MCP (mcp-chrome) is connected, driving your installed, logged-in Chrome. If the `chrome` tools are not available, complete `cancelled` with `error:"browser_unavailable_ig"` and stop.

## Step 1 -- Accept Claimed Task

- `taskId = task.id`, `sourceId = task.targetId`, `url = task.input.url`, `channel = task.input.channel`
- `subtype = task.input.subtype` (`account` or `hashtag`). If channel != `ig`, stop and report `wrong_channel`.

## Step 2 -- Render

- `account` -> `chrome__chrome_navigate({ url: "https://instagram.com/<handle>" })` then `chrome__chrome_get_web_content({ textContent: true })`; read recent post captions.
- `hashtag` -> `chrome__chrome_navigate({ url: "https://instagram.com/explore/tags/<tag>" })` then `chrome__chrome_get_web_content({ textContent: true })`; read top post captions.

Extract only captions within the last 30 days relevant to `DOCS/VALUE_PROP.md`:

- Clients (sparse company-only allowed); Factlets (BROAD -> factlet via `skills/shared/factlet-rules.md`; SPECIFIC -> `skills/shared/classify-contact.md`); Bookings (trade+date+location via `skills/shared/booking-detect.md`); New Sources (linked IG accounts/hashtags).

If the page is a login wall or empty, complete `failed` (Step 5).

**Engagement floor (C#2):** consult `DOCS/PEER_SOURCES.json` -> `engagement.channels.ig`. Drop posts whose likes fall below `floor`; process the highest-engagement captions first.

## Step 3 -- Save (judge:false)

Same contract as url-loop:

```
precrime__pipeline({ action:"save", judge:false, patch:{
  name, company, email, phone, website,
  source: url, segment, draftStatus:"brewing",
  clientNotes:"<short relevance note>", factlets:[...], bookings:[...]
}})
```

Recursion -- discovered IG sources:

```
precrime__pipeline({ action:"add_sources", entries:[
  { url:"https://instagram.com/<handle>",        channel:"ig", subtype:"account", discoveredFrom: url },
  { url:"https://instagram.com/explore/tags/<t>", channel:"ig", subtype:"hashtag", discoveredFrom: url }
]})
```

Every save MUST pass `judge:false`. Do not write `Booking.status`. Do NOT write `ig_sources.md`.

## Step 4 -- Mark Source

```
precrime__pipeline({ action:"mark_source", url: url, clientsFound: <save-call count> })
```

## Step 5 -- Complete

Success: `complete_task({ taskId, status:"done", output:{ clientIds, bookingIds, factletIds, sourceIds, summary:"Scraped <url>: ...", needsJudge:true }})`.
No findings: `status:"done"`, empty arrays, `needsJudge:false`.
Failure: `status:"failed"`, `error:"<login_wall | empty | browser_unavailable_ig>"`, then `mark_source` with `clientsFound:0` and a `failedReason`. Never leave a claimed Task open.

## Step 6 -- Stop

After `complete_task`, exit. Do not claim another Task.
