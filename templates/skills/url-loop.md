---
name: url-loop
description: One-Task SCRAPE_SOURCE worker. Scrape one already-claimed Source URL, save discoveries with judge:false, mark the source, complete, stop.
triggers:
  - scrape one source
  - run scrape source task
  - SCRAPE_SOURCE worker
---

# url-loop — SCRAPE_SOURCE worker

Process ONE already-claimed SCRAPE_SOURCE task, then stop. Only the tools advertised
to you exist.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- Read the **ASSIGNED TASK** JSON block in these instructions as `task` (do NOT call get_task) → `sourceId = task.targetId`,
  `url = task.input.url`, `channel = task.input.channel`.
- Not `{ type:"SCRAPE_SOURCE", targetType:"Source" }` → complete `failed` `wrong_task_type`, stop.

## Step 1 — Scrape (one branch)

### channel === "rss"
`precrime_rss__get_top_articles({ feedUrl: url, limit: 10 })` (do NOT use tavily_extract).
- `{ articles:[], diag:{cause} }` → use the RSS soft-fail completion below.
- Else treat each article's `title + snippet + content?` as evidence, its `url` as `sourceUrl`.
  Extract relevant Clients/Factlets/Bookings. Save article URLs as Sources (don't extract them here).

### default web (directory, blog, website, reddit, fb, ig, x, unknown)
`tavily__tavily_extract({ url })`. Fails → complete `failed`.
From content, extract only VALUE_PROP-relevant:
- Clients: business/person records (sparse company-only allowed). A vendor/planner/venue
  profile with no specific dated event is a CLIENT.
- Factlets: reusable evidence (event date, buying occasion, venue/budget/market/demand signal).
  Rules: exactly 2-3 sentences — what happened (numbers/dates/names), why it matters to the
  target audience, optional urgency. Facts only, never mention the product, one factlet per
  story, source = the live URL proving the claim.
- **Bookings: a SPECIFIC UPCOMING DATED EVENT IS a booking — capture it.** If the page
  names a real event with a FUTURE date + location (a con, festival, fair, expo, gala,
  fundraiser, school/corporate event, party, "upcoming events" calendar entry, etc.),
  create ONE Booking per dated event: `dateText` **verbatim** from the page (never invent
  ISO dates — the server resolves it), `location`/`zip`, `sourceUrl` = the live page proving
  the event. Do NOT set a trade (server stamps it). Do NOT require a separate RFP/inquiry —
  the dated event is the signal. A page listing many events yields many bookings.
- New Sources: URLs likely to reveal more clients/factlets.
- Feeds: detect feed links (`rel="alternate"`, `/feed`, `/rss.xml`, `/atom.xml`, `?feed=`, anchor RSS/Subscribe/Atom) → save `{ url:"<feedUrl>", channel:"rss", subtype:"feed", discoveredFrom:"<scraped url>" }`.

**Engagement floor:** consult the `engagement` block of `DOCS/PEER_SOURCES.json` for this
`channel`. Drop posts whose `signal` (e.g. reddit→upvotes) is below `floor`; convert the
highest-engagement posts first. `floor:0` channels (rss/directory/blog/website) keep everything.

Do NOT write source files by hand at runtime — writes go through `add_sources` (server is sole writer; it appends to data/sources/<channel>.md).

## Step 2 — Save findings (judge:false)
Per Client/Booking/Factlet group:
```
precrime__pipeline({ action:"save", judge:false,
  patch:{ name:"<if present>", company:"<if present>", email:"<if present>", phone:"<if present>",
    website:"<if present>", source:"<scraped url>", segment:"<if known>", draftStatus:"brewing",
    clientNotes:"<short relevance note>", factlets:[/* if any */], bookings:[/* if any */] }})
```
Collect `affectedClientIds` + `affectedBookingIds` from each save response (factlet IDs are NOT returned → pass `factletIds:[]`).
Discovered URLs (one call):
```
precrime__pipeline({ action:"add_sources", entries:[
  { url:"<discovered url>", channel:"directory|blog|website|reddit|fb|ig|x", discoveredFrom:"<scraped url>" },
  { url:"<discovered feed url>", channel:"rss", subtype:"feed", discoveredFrom:"<scraped url>" } ]})
```
add_sources returns counts only, no IDs → pass `sourceIds:[]`. Always `judge:false`; never write `Booking.status`.

## Step 3 — Mark source
`precrime__pipeline({ action:"mark_source", url, clientsFound: <save count> })`

## Step 4 — Complete
Success:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[<affectedClientIds>], bookingIds:[<affectedBookingIds>], factletIds:[], sourceIds:[],
    summary:"Scraped <url>: <N> clients, <M> factlets, <K> new sources.", needsJudge:true }})
```
Nothing relevant: `status:"done"`, empty arrays, summary `"no findings"`, `needsJudge:false`.
Failure:
```
precrime__pipeline({ action:"complete_task", taskId, status:"failed",
  error:"<extract_failed|login_wall|js_only|irrelevant|empty>",
  output:{ clientIds:[], bookingIds:[], summary:"Scrape failed for <url>: <reason>.", needsJudge:false }})
```
RSS soft-fail:
```
precrime__pipeline({ action:"mark_source", url, clientsFound:0 })
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[], bookingIds:[], factletIds:[], sourceIds:[],
    summary:"RSS feed yielded 0 articles above threshold: <diag.cause>", needsJudge:false }})
```
Never leave a claimed task open. Then STOP.
