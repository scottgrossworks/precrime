---
module: source-discovery
tags: [recursion, source-queue, scrape, channels, planner]
source_docs: [FOUNDATION.md, url-loop.md, headless_flow.md, init-wizard.md, mcp_server.js]
staleness: none
---

# The Recursive Source Loop

How PRECRIME discovers, scrapes, and re-discovers sources. Queue mechanics (Source schema, claim/release, normalization) live in `concepts/source-queue.md`; this page is the operational loop and channel routing.

## The loop

1. **Plan.** `pipeline.plan_tasks` emits one `SCRAPE_SOURCE` Task per claimable `Source` row (and `DISCOVER_SOURCES` when the queue is thin).
2. **Claim + dispatch.** The orchestrator (`headless_flow.md` headless, `init-wizard.md` interactive loop) calls `claim_task` and dispatches by `task.input.channel` (see routing below).
3. **Scrape.** The worker renders the one source, extracting VALUE_PROP-relevant Clients, Factlets, Bookings, and new source URLs.
4. **Save.** `pipeline.save({ judge:false, ... })` persists discoveries. Workers never set `Booking.status` -- the Judge owns it.
5. **Recurse.** Discovered URLs are queued via `pipeline.add_sources` with `discoveredFrom` set to the scraped URL (lineage). Any channel can enqueue any channel: an RSS page yields new feeds, a Facebook page yields new groups. Server dedups on normalized URL.
6. **Release + judge.** `mark_source` releases the claim and stamps `scrapedAt`; `complete_task({ needsJudge:true })` triggers `JUDGE_AFFECTED`.
7. **Repeat.** The next planner pass pops the sources added in step 5. Re-scrape is automatic once `scrapedAt` is older than `maxAgeDays` (default 30).

Recursion is **queue-mediated**, not inline: a scrape enqueues links for a later Task rather than following them itself. This bounds depth and keeps claims atomic.

## Channel routing

`VALID_CHANNELS = directory | rss | fb | ig | reddit | x | blog | website`.

- `rss` -> url-loop via `precrime_rss.get_top_articles` (never Tavily on a feed).
- `directory` / `blog` / `website` / `reddit` -> url-loop via `tavily.tavily_extract`.
- `fb` / `ig` -> dedicated browser workers (`{fb,ig}-factlet-harvester/SKILL.md`). **Browser-only**: need an interactive browser MCP (chrome-mcp). Tavily returns login-wall chrome here, so headless skips them (`browser_channel_skipped_headless`).
- `x` -> `x-factlet-harvester/SKILL.md`: Grok/Chrome when interactive, Tavily `site:x.com` fallback when headless (so X runs in both modes).

This is why `next_source` excludes `fb`/`ig`/`x` from its default (no-channel) claim: only an explicit channel pass should surface browser-only rows.

## Seeding the queue

- `pipeline.import_sources` -- one-time load from `*_sources.md` / `discovered_directories.md` seed files.
- `DISCOVER_SOURCES` Task -- a bounded search that enqueues directory/feed URLs.
- `demand-radar.md` -- option-B seeder: runs the external `last30days` skill on VALUE_PROP topics and feeds named orgs/events/URLs as sources + demand factlets.
