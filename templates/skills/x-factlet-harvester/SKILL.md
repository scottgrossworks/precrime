---
name: {{DEPLOYMENT_NAME}}-x-factlet-harvester
description: One-Task SCRAPE_SOURCE worker for channel="x". Search one claimed X/Twitter account/hashtag/keyword (Grok or Chrome when interactive, Tavily site:x.com fallback when headless), save discoveries with judge:false, recurse via add_sources, complete the Task, stop.
triggers:
  - harvest x
  - harvest twitter
  - SCRAPE_SOURCE x worker
---

# x-factlet-harvester -- SCRAPE_SOURCE Worker (channel="x")

Execute exactly one already-claimed `SCRAPE_SOURCE` Task whose `input.channel` is `x`. The orchestrator already called `claim_task`. Do NOT call `claim_task`, `plan_tasks`, `next_source`, `start_session`, `report_session`, `judge_affected`, or `rescore`. Complete the Task and stop.

Unlike fb/ig, X is reachable in BOTH modes: interactive drives your logged-in Chrome via the `chrome` MCP (mcp-chrome); headless falls back to Tavily `site:x.com` queries (fewer results but functional). This is why X SCRAPE_SOURCE Tasks are dispatched in headless too.

## Step 1 -- Accept Claimed Task

- `taskId = task.id`, `sourceId = task.targetId`, `url = task.input.url`, `channel = task.input.channel`
- `subtype = task.input.subtype` (`account` | `hashtag` | `keyword`). If channel != `x`, stop and report `wrong_channel`.

## Step 2 -- Search (pick one branch by tool availability)

Interactive (the `chrome` MCP present) -- build a query by subtype, then drive logged-in Chrome:
- `account`  -> `from:<handle> <VALUE_PROP keywords>`
- `hashtag`  -> `#<tag>`
- `keyword`  -> the keyword phrase
- `chrome__chrome_navigate({ url: "https://x.com/search?q=<url-encoded query>&f=live" })` then `chrome__chrome_get_web_content({ textContent: true })`.

Headless (no `chrome` MCP): `tavily__tavily_extract` / search `site:x.com <query>` for the same subtype query.

Extract only posts within the last 30 days relevant to `DOCS/VALUE_PROP.md`:
- Clients (sparse allowed); Factlets (BROAD -> `skills/shared/factlet-rules.md`; SPECIFIC -> `skills/shared/classify-contact.md`); Bookings (trade+date+location via `skills/shared/booking-detect.md`); New Sources (referenced X accounts/hashtags, or off-X URLs worth scraping).

If the search fails or is empty, complete `failed` (Step 5).

**Engagement floor (C#2):** consult `DOCS/PEER_SOURCES.json` -> `engagement.channels.x`. Drop posts whose likes+reposts fall below `floor`; process the highest-engagement posts first.

## Step 3 -- Save (judge:false)

```
precrime__pipeline({ action:"save", judge:false, patch:{
  name, company, email, phone, website,
  source: url, segment, draftStatus:"brewing",
  clientNotes:"<short relevance note>", factlets:[...], bookings:[...]
}})
```

Recursion -- discovered sources (X or off-X):

```
precrime__pipeline({ action:"add_sources", entries:[
  { url:"https://x.com/<handle>", channel:"x",       subtype:"account", discoveredFrom: url },
  { url:"<off-x url>",            channel:"website",  discoveredFrom: url }
]})
```

Every save MUST pass `judge:false`. Do not write `Booking.status`. Do NOT write source files by hand -- use `add_sources` (server is sole writer).

## Step 4 -- Mark Source

```
precrime__pipeline({ action:"mark_source", url: url, clientsFound: <save-call count> })
```

## Step 5 -- Complete

Success: `complete_task({ taskId, status:"done", output:{ clientIds, bookingIds, factletIds, sourceIds, summary:"Searched <url>: ...", needsJudge:true }})`.
No findings: `status:"done"`, empty arrays, `needsJudge:false`.
Failure: `status:"failed"`, `error:"<search_failed | empty>"`, then `mark_source` with `clientsFound:0` and a `failedReason`. Never leave a claimed Task open.

## Step 6 -- Stop

After `complete_task`, exit. Do not claim another Task.
