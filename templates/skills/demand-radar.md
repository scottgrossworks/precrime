---
name: {{DEPLOYMENT_NAME}}-demand-radar
description: Demand-radar seeder. Run the last30days research skill on VALUE_PROP topics, parse the brief, and feed named orgs/events/URLs into the Source queue (add_sources) plus demand evidence into Factlets. Decoupled upstream seeder -- not a SCRAPE_SOURCE worker.
triggers:
  - demand radar
  - seed demand
  - scan last 30 days
---

# demand-radar -- Demand Seeder (option B)

A decoupled seeder that sits UPSTREAM of the Source queue. It does not scrape sources itself and is not a Task worker. It asks the external `last30days` research skill "what has the market been talking about in the last 30 days, for my trade and buyers," then converts the answer into queue entries (`add_sources`) and demand `Factlets`. Those sources are later scraped + recursed by the normal SCRAPE_SOURCE loop (see `DOCS/wiki/concepts/recursive-loop.md`).

Run it manually, or on a schedule (cron / Task Scheduler) as a periodic top-up of fresh sources. Independent of headless/interactive workflow runs.

## Requirements

`last30days` must be installed (the `/last30days` slash skill, or the CLI at `last30days/skills/last30days/scripts/last30days.py`). If neither is reachable, STOP with `DEMAND_RADAR_UNAVAILABLE: install the last30days skill`.

Cost: the keyless sources (Reddit, Hacker News, Polymarket, GitHub, YouTube) need NO API keys -- run free. Social sources are optional and off by default. Reasoning is provided by the host model when invoked via the slash command, so no LLM key is required interactively.

Keys are configured ONCE in `precrime_config.json` -> `apiKeys` (not in a last30days `.env`): `scrapecreators` unlocks Instagram / TikTok / Threads / Pinterest; `xai` unlocks X / Twitter. The launcher (`bootstrap_config.js`) exports them as `SCRAPECREATORS_API_KEY` / `XAI_API_KEY`, which last30days reads from the environment. Edit `precrime_config.json`, restart, done.

## Step 1 -- Build topics from VALUE_PROP

Read `DOCS/VALUE_PROP.md` (or `pipeline.get_config`). Construct 2-5 topic strings from: `trade`, buyer/`segment` language, and geography. Examples for a caricature artist:

- `"corporate event entertainment <city>"`
- `"<trade> trade show booth ideas"`
- `"company holiday party planning <region>"`

Keep topics buyer-occasion shaped (events, buying moments), not your own service name -- you are sensing demand, not searching yourself.

## Step 2 -- Run last30days per topic

Interactive (preferred): `/last30days "<topic>" --days=30`.
Headless / scripted: `python3 last30days/skills/last30days/scripts/last30days.py "<topic>" --emit=compact`.

Each run writes a markdown brief to `${LAST30DAYS_MEMORY_DIR:-~/Documents/Last30Days}/<slug>-raw.md`. Note the path from the run's footer line.

## Step 3 -- Parse the brief

Read the brief file. Extract, with citation URLs:

- **Named organizations / venues / event series** that plausibly book your trade -> candidate Clients/Sources.
- **Dated buying occasions** (a convention, festival, conference, seasonal window) -> candidate Bookings / demand Factlets.
- **Source URLs** worth scraping for more leads (directories, subreddits, RSS-bearing blogs, social accounts).

Skip anything not relevant to VALUE_PROP. The brief is evidence, not gospel.

## Step 4 -- Feed the queue (add_sources) + factlets

For discovered URLs, classify the channel by host and enqueue once (recursion lineage points at the brief topic):

```
precrime__pipeline({ action:"add_sources", entries:[
  { url:"<directory or blog url>", channel:"directory|blog|website", discoveredFrom:"demand-radar:<topic>" },
  { url:"https://reddit.com/r/<sub>", channel:"reddit", subtype:"subreddit", discoveredFrom:"demand-radar:<topic>" },
  { url:"<feed url>", channel:"rss", subtype:"feed", discoveredFrom:"demand-radar:<topic>" },
  { url:"https://instagram.com/<acct>", channel:"ig", subtype:"account", discoveredFrom:"demand-radar:<topic>" }
]})
```

For demand evidence with no immediate URL to scrape, save a Factlet (judge:false) so it informs later judging:

```
precrime__pipeline({ action:"save", judge:false, patch:{
  company:"<org if any>", source:"<citation url>", draftStatus:"brewing",
  clientNotes:"demand-radar: <topic>",
  factlets:[{ content:"<buying-occasion / trend, with date>", source:"<citation url>" }]
}})
```

Never invent a URL. Only enqueue URLs the brief actually cited. Do NOT write `Booking.status`; the Judge owns it.

## Step 5 -- Report

Print: topics run, briefs read, sources added (by channel), factlets created, duplicates skipped. Then stop. The normal SCRAPE_SOURCE loop will pick up the new sources on its next planner pass.
