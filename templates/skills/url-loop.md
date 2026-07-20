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

### channel === "reddit" — old.reddit `.json` through the bridge (NOT tavily)
Reddit blocks Tavily AND plain Chrome fetches; the reliable path (proven live 2026-07-20)
is old-Reddit's raw JSON endpoints through `precrime__pipeline({ action:"browse", url })`:
1. Rewrite the source url to its old-Reddit JSON listing:
   `https://old.reddit.com/r/<sub>/new.json` — and for a targeted pass,
   `https://old.reddit.com/r/<sub>/search.json?q=<VALUE_PROP trade term>&restrict_sr=1&sort=new`.
2. `browse` it. The returned text is Reddit's listing JSON: each post has `title`,
   `selftext` (the body), `author`, `permalink`, `ups`, `created_utc`.
3. Extract per the default-web rules below (BUYERS ONLY, service area, engagement floor
   on `ups`). An "ask" post you cannot attribute → `signal` with
   `url: "https://old.reddit.com" + permalink` and the verbatim `title + selftext`.
4. `browse` errors ("bridge busy"/unavailable — Chrome may be closed) → retry once, then
   fall back to `tavily__tavily_extract({ url })`; if that also fails → complete `failed`
   `reddit_blocked`.

### default web (directory, blog, website, fb, ig, x, unknown)
`tavily__tavily_extract({ url })`. Fails → complete `failed`.
From content, extract only VALUE_PROP-relevant:
- Clients: **BUYERS ONLY** — people/businesses that could plausibly HIRE the VALUE_PROP
  trade (match against VALUE_PROP Buyer Roles: event planners, agencies, venues, hosts,
  schools, corporations, organizers). Sparse company-only records allowed.
  **NEVER save a SELLER of event services as a client.** A business whose own product is
  the VALUE_PROP trade (a competitor) or any other event vendor service — photo booth,
  DJ, magician, face painting, catering, florals, rentals, AV, photography, staffing —
  is NOT a client; skip it entirely (no client, no enrichment, no booking). Exception:
  event planners, event agencies, and venues ARE buyers (they hire entertainment).
  On a mixed vendor-directory page, extract ONLY the planner/agency/venue entries.
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
- **SERVICE AREA (hard rule): only extract clients, bookings, and sources INSIDE the
  VALUE_PROP Geography.** A page listing events/vendors in many cities (a national
  directory, multi-metro listing site, national association) yields ONLY its in-area
  entries — skip every out-of-area city, state, and venue entirely: no client, no
  booking, no factlet, no child source. Never register per-city child sources for
  other metros. The server also enforces this by zip (out-of-area saves are refused),
  so extracting out-of-area entries only wastes your own turn.
- New Sources: URLs likely to reveal more clients/factlets (in-area only).
- Feeds: detect feed links (`rel="alternate"`, `/feed`, `/rss.xml`, `/atom.xml`, `?feed=`, anchor RSS/Subscribe/Atom) → save `{ url:"<feedUrl>", channel:"rss", subtype:"feed", discoveredFrom:"<scraped url>" }`.

**Engagement floor:** consult the `engagement` block of `DOCS/PEER_SOURCES.json` for this
`channel`. Drop posts whose `signal` (e.g. reddit→upvotes) is below `floor`; convert the
highest-engagement posts first. `floor:0` channels (rss/directory/blog/website) keep everything.

Do NOT write source files by hand at runtime — writes go through `add_sources` (server is sole writer; it appends to data/sources/<channel>.md).

## Step 2 — Save findings (judge:false)
**SMALL CALLS ONLY (hard rule): one save call per client, max 5 bookings + 5 factlets per
call, clientNotes under 300 chars.** A page with 15 clients = 15 sequential small save
calls, never one giant call — an oversized tool call gets TRUNCATED mid-JSON by the LLM
host ("Could not interpret tool use parameters") and the whole task dies with all work
lost. Same for add_sources: max 10 entries per call; make several calls if needed.
**Shell note: developer__shell is Windows cmd.exe — NEVER use bash syntax (heredocs
`<<`, `$()`, pipes to python). You do not need the shell to parse content: extract from
the tavily text directly and make tool calls.**
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

**DEMAND YOU CANNOT ATTRIBUTE — signal it (bird-dog rule):** a post/thread where someone is
ASKING for an event vendor/planner/entertainment but you cannot capture their real name or
contact: do NOT drop it, do NOT save a nameless client — call
`precrime__pipeline({ action:"signal", url:"<the post/thread url>", note:"<verbatim demand text incl. any date/venue>" })`.
A DRILL_DOWN worker will chase the poster to a real person + booking.

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
