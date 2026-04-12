# DISCOVERY_TODO.md — Source Discovery Skill Implementation Plan

**Date:** 2026-04-09
**Author:** Claude (session with Scott)
**Target:** `PRECRIME/templates/skills/source-discovery.md`

---

## What This Skill Does

Given a VALUE_PROP.md (product, audience, geography, trade) and optionally an existing database of clients and source URLs, this skill discovers NEW source channels where potential clients congregate or post. It appends discovered sources to the existing config files so harvesters can scrape them on subsequent runs.

**Sources it finds:**
- Facebook pages/groups (event planners, industry orgs, local business pages)
- Subreddits (trade-specific, event planning, local markets)
- RSS feeds (industry news, trade publications, event listing sites)
- Directories and listing sites (convention calendars, trade association member lists, venue directories, Eventbrite pages)
- Any other URL where potential clients are known to appear

**Growth is intrinsic:** The skill does NOT start from scratch every time. It reads what already exists in the source config files and the client database, identifies gaps, and expands. If fb_sources.md already has 5 pages, the skill looks for 5 more, not the same 5. If the DB already has 40 clients in a particular segment, the skill looks for underrepresented segments or geographies.

---

## Context for the Coding Agent

### Project Structure

```
PRECRIME/
├── .mcp.json                          ← MCP server config (do not edit)
├── server/
│   ├── mcp/mcp_server.js             ← 19 MCP tools (SQLite via Prisma)
│   └── prisma/schema.prisma          ← Client, Booking, Factlet, ClientFactlet, Config
├── templates/
│   ├── skills/
│   │   ├── init-wizard.md            ← bootstrap skill (runs on first launch)
│   │   ├── enrichment-agent.md       ← main enrichment pipeline
│   │   ├── factlet-harvester.md      ← RSS harvester
│   │   ├── reddit-factlet-harvester.md ← Reddit harvester
│   │   ├── fb-factlet-harvester/
│   │   │   ├── SKILL.md              ← Facebook harvester
│   │   │   └── fb_sources.md         ← one FB URL per line, # for comments
│   │   ├── source-discovery.md       ← ** YOU ARE BUILDING THIS **
│   │   └── evaluator.md              ← draft quality checker
│   ├── docs/
│   │   ├── VALUE_PROP.md             ← product identity (audience, geography, trade, pain points)
│   │   └── CLAUDE.md                 ← binding rules
│   ├── reddit/
│   │   └── reddit_config.json        ← subreddits + keywords
│   └── rss/
│       └── rss-scorer-mcp/
│           └── rss_config.json       ← RSS feeds + keywords + scoring
├── DOCS/
│   └── wiki/concepts/scoring.md      ← scoring system reference
└── data/
    └── myproject.sqlite              ← active database
```

### Source Config File Formats

**`skills/fb-factlet-harvester/fb_sources.md`:**
```
# Facebook pages to monitor
# One URL per line. Lines starting with # are comments.

https://www.facebook.com/LAEventPlanners
https://www.facebook.com/WeddingPlannersOfLA
```

**`reddit/reddit_config.json`:**
```json
{
  "subreddits": [
    {
      "name": "weddingplanning",
      "keywords": ["caricature", "artist", "entertainment", "vendor"]
    }
  ],
  "global_keywords": ["event", "booking", "vendor", "entertainment"],
  "recency_days": 7,
  "min_score": 5
}
```

**`rss/rss-scorer-mcp/rss_config.json`:**
```json
{
  "feeds": [
    {
      "name": "Event Industry News",
      "url": "https://www.specialevents.com/rss",
      "category": "events",
      "keywords": ["convention", "trade show", "corporate event"]
    }
  ],
  "global_keywords": ["event", "booking", "entertainment"],
  "relevanceThreshold": 0.5
}
```

### MCP Tools Available

| Tool | Purpose |
|------|---------|
| `mcp__precrime-mcp__get_config` | Read system config (trade, geography, business description) |
| `mcp__precrime-mcp__get_stats` | Get client counts, factlet counts, score distributions |
| `mcp__precrime-mcp__search_clients` | Search existing clients (check what segments/geographies are covered) |
| `mcp__precrime-mcp__create_factlet` | Save broadly applicable intel to the factlet queue |
| `WebSearch` | Search the web for source channels |
| `WebFetch` | Scrape a URL for content |
| `Read` | Read local files (source configs, VALUE_PROP.md) |
| `Edit` | Append to local files (source configs) |

If Chrome MCP is available (interactive mode):
| `mcp__Claude_in_Chrome__*` | Browser automation for Facebook search, directory browsing |

### How to Detect Interactive vs Headless Mode

The skill should check whether Chrome MCP tools are available:
```
Call mcp__Claude_in_Chrome__tabs_context_mcp({ createIfEmpty: false })
```
- If it returns tabs → **interactive mode** (Chrome available, can browse Facebook, can ask user questions)
- If it errors or returns nothing → **headless mode** (web_search + web_fetch only, no user interaction)

Additionally, check whether SESSION_AI assistants (Gemini/Grok) are available in Chrome tabs. If so, use them for research queries that web_search can't answer.

---

## Implementation Plan

### Step 0: Read Context

1. Read `DOCS/VALUE_PROP.md` — extract: product name, target audience, geography, trade, buying occasions, seasonal windows, pain points
2. Call `get_config()` — extract: defaultTrade, businessDescription, companyName
3. Call `get_stats()` — how many clients exist? How many factlets? This tells the skill whether this is a cold start or an expansion run.
4. Read existing source configs:
   - `skills/fb-factlet-harvester/fb_sources.md` — current FB pages
   - `reddit/reddit_config.json` — current subreddits
   - `rss/rss-scorer-mcp/rss_config.json` — current RSS feeds
5. If interactive mode: check if user has additional context to offer (starter URLs, client lists, industry knowledge). Ask ONCE, accept whatever they give, move on.

**Decision:** If stats show 0 clients and empty source configs → this is a COLD START. Run broad discovery. If stats show existing clients and populated configs → this is an EXPANSION RUN. Focus on gaps and new segments.

### Step 1: Analyze Coverage Gaps

If expansion run:
1. `search_clients({ summary: true, limit: 20 })` — what segments and geographies are represented?
2. Compare against VALUE_PROP.md target audience — what's missing?
3. Review existing source configs — what types of sources are missing? (e.g., have FB pages but no subreddits? Have subreddits but no directories?)

Output: a prioritized list of discovery targets. Example:
- "No convention/trade show sources — need event listing sites for [geography]"
- "No Reddit presence — need subreddits for [trade] in [geography]"
- "Have general industry sources but no local/regional ones"

If cold start: skip gap analysis, run broad discovery across all source types.

### Step 2: Discover Facebook Sources

**Search queries (WebSearch):**
- `"[trade]" "[geography]" site:facebook.com group`
- `"[target audience]" "[geography]" site:facebook.com`
- `"event planning" "[geography]" site:facebook.com`
- `"[buying occasion keywords from VALUE_PROP]" site:facebook.com`

**If Chrome available (interactive mode):**
- Navigate to `facebook.com/search/pages/?q=[trade] [geography]`
- Navigate to `facebook.com/search/groups/?q=[target audience] [geography]`
- Extract page/group URLs from results

**Validation:** For each discovered FB URL:
- Does the page exist? (WebFetch or Chrome check)
- Is it active? (posts within last 60 days)
- Is it relevant to the trade/audience? (check page description/about)
- Is it already in fb_sources.md? (dedup against existing entries)

**Output:** Append new validated URLs to `skills/fb-factlet-harvester/fb_sources.md` using the Edit tool. One URL per line. Add a comment line above each batch: `# Added by source-discovery [date] — [search that found it]`

**Target:** 5-15 new FB sources per run.

### Step 3: Discover Reddit Sources

**Search queries (WebSearch):**
- `reddit "[trade]" "[geography]" subreddit`
- `site:reddit.com "[target audience]" "[buying occasion]"`
- `reddit "[trade] vendor" OR "[trade] booking" subreddit`

**For each discovered subreddit:**
- Check activity: `WebFetch("https://www.reddit.com/r/{subreddit}/new.json?limit=5")` — are there recent posts?
- Check relevance: do post titles match VALUE_PROP keywords?
- Check size: subscriber count (from the JSON response)
- Dedup against existing entries in `reddit/reddit_config.json`

**Output:** Edit `reddit/reddit_config.json` — add new entries to the `subreddits` array. Each entry includes subreddit name + trade-specific keywords derived from VALUE_PROP.md.

**Target:** 3-8 new subreddits per run.

### Step 4: Discover RSS / News Sources

**Search queries (WebSearch):**
- `"[trade] industry news" RSS feed`
- `"[target audience] news" RSS`
- `"[geography] event listings" RSS OR feed`
- `"[trade] magazine" OR "journal" OR "publication"`

**For each discovered feed:**
- Validate: `WebFetch(url)` — does it return valid RSS/Atom XML?
- Check freshness: most recent item within last 30 days?
- Dedup against existing entries in `rss_config.json`

**Output:** Edit `rss/rss-scorer-mcp/rss_config.json` — add new entries to the `feeds` array with name, url, category, and keywords from VALUE_PROP.md.

**Target:** 3-10 new RSS feeds per run.

### Step 5: Discover Directories and Listing Sites

This is the highest-value discovery for client seeding. These are pages where many potential clients are listed.

**Search queries (WebSearch):**
- `"[trade] directory" "[geography]"`
- `"[trade] association" members list`
- `"[geography] event vendors" directory`
- `"convention" OR "trade show" "[trade]" "[geography]" exhibitors`
- `eventbrite "[trade]" "[geography]"`
- `"[target audience]" directory "[geography]"`

**For each discovered directory/listing site:**
- Validate: WebFetch — does the page load? Does it contain a list of names/companies/contacts?
- Classify: is this a one-time list (convention exhibitors) or an ongoing directory (trade association)?
- Estimate size: how many potential clients are listed?

**Output:** These are NOT added to harvester configs (harvesters process feeds, not directories). Instead, write them to a NEW file: `skills/source-discovery/discovered_directories.md`

Format:
```
# Discovered directories and listing sites
# These are scraped by the client-seeder skill, not by harvesters.
# One entry per line: URL | type | estimated_clients | discovered_date

https://example.com/vendors | trade_directory | ~50 | 2026-04-09
https://convention.com/exhibitors | exhibitor_list | ~200 | 2026-04-09
```

**Target:** 5-20 directory/listing URLs per run.

### Step 6: Source Growth — Follow Links

During Steps 2-5, when scraping any discovered page, look for LINKS to other relevant sources:
- A Facebook group's "Related Groups" section → more FB sources
- A directory page linking to partner organizations → more directories
- An RSS feed article mentioning another publication → more RSS feeds
- A subreddit sidebar linking to related subreddits → more Reddit sources

For each discovered link:
- Classify: what type of source is it?
- Validate: is it active and relevant?
- Dedup: is it already known?
- If new and valid: add to the appropriate config file

This is NOT a separate step. It happens during every scrape in Steps 2-5. The skill should actively watch for links as it works.

### Step 7: Create Factlets from Discovery

During discovery, the skill will encounter broadly applicable intelligence (industry trends, policy changes, market data). These should be captured as factlets:
```
mcp__precrime-mcp__create_factlet({
  content: "2-3 sentence summary",
  source: "URL where found"
})
```

Do NOT create factlets for client-specific intel. Only broadcast-applicable findings.

### Step 8: Run Log

Write a summary to `logs/DISCOVERY_LOG.md`:
```
## Source Discovery Run — [date]

### Context
- Mode: interactive | headless
- Cold start | Expansion (N existing clients, M existing sources)
- Trade: [defaultTrade]
- Geography: [from VALUE_PROP]

### Results
- Facebook: [N new] added (total now [M])
- Reddit: [N new] added (total now [M])
- RSS: [N new] added (total now [M])
- Directories: [N new] discovered
- Factlets: [N] created during discovery

### Sources Added
[list each new source with the search query that found it]

### Sources Rejected
[list sources checked but rejected, with reason: stale, irrelevant, duplicate, dead link]
```

---

## Parameterization — The -p Prompt

The skill must work in both modes:

**Headless (cron / -p flag):**
```
claude -p --dangerously-skip-permissions "run source discovery"
```
- No user interaction. Read VALUE_PROP.md and config. Discover and append. Log results.
- Growth behavior: compare existing sources against what's discoverable. Fill gaps.

**Interactive (CLI):**
```
User types: "run source discovery" or triggers via init-wizard
```
- Same discovery flow, but:
  - At Step 0, ask user: "Do you have any starter URLs, FB pages, subreddits, or directories you want me to start with?" Accept whatever they give. Don't require it.
  - At Step 5 (directories), show the user what was found and ask: "Any of these look wrong? Anything I should skip?"
  - Otherwise, run autonomously.

**Detection:** Check Chrome MCP availability. If Chrome responds → interactive. If not → headless.

---

## Skill File Structure

Create: `templates/skills/source-discovery.md`

Follow the existing skill file format (see enrichment-agent.md for reference):
```
---
name: {{DEPLOYMENT_NAME}}-source-discovery
description: Discover new source channels for harvesting — FB pages, subreddits, RSS feeds, directories
triggers:
  - run source discovery
  - discover sources
  - find new sources
  - expand source list
---
```

The skill body follows the steps above. Reference MCP tools by their full names (`mcp__precrime-mcp__get_config`, etc.).

---

## Files to Create

1. `templates/skills/source-discovery.md` — the skill itself
2. `templates/skills/source-discovery/discovered_directories.md` — output file for directory/listing URLs (created by the skill on first run, appended on subsequent runs)

## Files to Edit

1. `templates/skills/fb-factlet-harvester/fb_sources.md` — appended with new FB URLs
2. `templates/reddit/reddit_config.json` — new subreddits added to array
3. `templates/rss/rss-scorer-mcp/rss_config.json` — new feeds added to array

## Files to Read (not edit)

1. `templates/docs/VALUE_PROP.md`
2. `templates/docs/CLAUDE.md`
3. All source config files (for dedup)

---

## Testing Checklist

- [ ] Cold start: empty source configs, 0 clients → skill discovers and populates sources
- [ ] Expansion: populated configs, 40+ clients → skill finds NEW sources, does not duplicate
- [ ] Headless: runs with -p flag, no user interaction, completes and logs
- [ ] Interactive: Chrome available, asks user for starters, accepts input, proceeds
- [ ] Dedup: running twice in a row does not add duplicate sources
- [ ] Source growth: discovered pages' links are followed to find additional sources
- [ ] Factlet creation: broadly applicable intel found during discovery is saved
- [ ] Log: DISCOVERY_LOG.md written with full run summary

---

## Critical Rules

1. **Read VALUE_PROP.md FIRST.** Every search query must be derived from the actual product/audience/geography. Do not guess.
2. **Dedup against existing sources.** Read all config files before adding anything.
3. **Validate before adding.** Every source must be checked: does it exist? Is it active? Is it relevant?
4. **Growth, not replacement.** Never overwrite existing config files. Always APPEND.
5. **No architectural changes.** Do not create new database tables. Do not modify the MCP server. Do not change existing skill files. You are creating ONE new skill file and ONE new output file.
6. **Follow existing patterns.** Read enrichment-agent.md and factlet-harvester.md for style, tool usage, and logging conventions.
7. **The discovered_directories.md file is for the client-seeder skill** (SEEDING_TODO.md). Source discovery finds directories; client seeding scrapes them for contacts.
