---
name: {{DEPLOYMENT_NAME}}-source-discovery
description: Discover new source channels for harvesting — FB pages, subreddits, RSS feeds, directories
triggers:
  - run source discovery
  - discover sources
  - find new sources
  - expand source list
  - discover sources for [occasion]
  - find [occasion] sources
---

# {{DEPLOYMENT_NAME}} — Source Discovery

You discover NEW source channels where potential clients congregate or post, then append them to the harvester config files so subsequent harvester runs can scrape them.

**Growth is intrinsic.** You do NOT start from scratch. You read what already exists in every config file and the client database, identify gaps, and expand. If fb_sources.md already has 5 pages, you look for 5 more — not the same 5.

**Sources you find:**
- Facebook pages/groups (event planners, industry orgs, local business pages)
- Subreddits (trade-specific, event planning, local markets)
- RSS feeds (industry news, trade publications, event listing sites)
- Directories and listing sites (convention calendars, trade association member lists, venue directories, Eventbrite pages)
- Any other URL where potential clients are known to appear

## MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp__precrime-mcp__get_config` | Read system config (trade, geography, business description) |
| `mcp__precrime-mcp__get_stats` | Get client counts, factlet counts, score distributions |
| `mcp__precrime-mcp__search_clients` | Search existing clients (check segment/geography coverage) |
| `mcp__precrime-mcp__create_factlet` | Save broadly applicable intel to the factlet queue |
| `Read` | Read local files (source configs, VALUE_PROP.md) |
| `Edit` | Append to local files (source configs) |

**Headless mode only (no Chrome):**

| Tool | Purpose |
|------|---------|
| `WebSearch` | Search the web for source channels (HEADLESS ONLY) |
| `WebFetch` | Scrape a URL for content (HEADLESS ONLY) |

**Interactive mode (Chrome available) — PRIMARY tools:**

| Tool | Purpose |
|------|---------|
| `mcp__Claude_in_Chrome__tabs_context_mcp` | Detect Chrome / get tab list |
| `mcp__Claude_in_Chrome__navigate` | Navigate a tab to a URL |
| `mcp__Claude_in_Chrome__get_page_text` | Extract text content from a page |
| `mcp__Claude_in_Chrome__computer` | Click, type, scroll, wait |
| `mcp__Claude_in_Chrome__find` | Find elements on page by description |

## Mode Detection

Check whether Chrome MCP tools are available:
```
mcp__Claude_in_Chrome__tabs_context_mcp({ createIfEmpty: false })
```
- Returns tabs → **interactive mode**. Chrome and SESSION_AI are your PRIMARY tools. Do NOT use WebSearch or WebFetch — they burn Claude tokens. All searches go through Gemini/Grok. All page scraping goes through Chrome navigate + get_page_text.
- Errors or returns nothing → **headless mode** (WebSearch + WebFetch only, no user interaction)

Additionally, scan returned tabs for AI assistants:
- **Gemini:** tab URL contains `gemini.google.com`
- **Grok:** tab URL contains `grok.com` or `x.com/i/grok`

Record: `SESSION_AI = { gemini: <tabId> | null, grok: <tabId> | null }`

**In interactive mode, SESSION_AI is your search engine. Not WebSearch. Not WebFetch. Gemini/Grok cost zero Claude tokens.**

---

## Occasion-Driven Mode

If the user prompt includes a **holiday, event, or occasion** (e.g., "discover sources for 4/20 cannabis events", "find Cinco de Mayo vendors", "July 4th corporate events"), the entire discovery shifts:

- **All search queries focus on the occasion** — not just general trade/audience sources. Search for events ON or NEAR that date, venues hosting those events, organizations planning those events.
- **Date awareness:** When the holiday falls on a weekday, most events cluster on the nearest weekend. Adjust search date ranges accordingly.
- **Segment tagging:** Tag all discovered sources and directories with the occasion (e.g., `# 420-2026` comment in fb_sources.md, `"segment": "cannabis_420"` in directory entries).
- **Also search the existing Booking table** — legacy bookings often contain event-specific keywords in title/description/notes that the Client table does not:
  ```
  mcp__precrime-mcp__get_bookings({ search: "[occasion keyword]", limit: 50 })
  ```
  Repeat with every synonym and related term. Cannabis example: cannabis, dispensary, marijuana, weed, 420, THC, CBD, smoke shop, pot shop. Cinco de Mayo example: cinco, mayo, mexican, fiesta, tequila, mariachi, latino, hispanic, festival, carnival.
- **Geographic parallelism (interactive mode):** If the geography is large (metro area), consider splitting discovery by sub-region and running in parallel. For LA: LA proper, Valleys, Orange County, Ventura County, big brands/festivals.

If no occasion is specified, run standard broad discovery.

---

## Procedure

### Step 0: Read Context

1. Read `DOCS/VALUE_PROP.md` — extract: product name, target audience, geography, trade, buying occasions, seasonal windows, pain points. **If VALUE_PROP.md contains placeholder text, STOP and tell the user to fill it in.**
2. Call `mcp__precrime-mcp__get_config()` — extract: defaultTrade, businessDescription, companyName.
3. Call `mcp__precrime-mcp__get_stats()` — how many clients? How many factlets? This tells you cold start vs expansion.
4. Read existing source configs (for dedup baseline):
   - `skills/fb-factlet-harvester/fb_sources.md` — current FB pages
   - `skills/reddit-factlet-harvester/reddit_sources.md` — current subreddits
   - `rss/rss-scorer-mcp/rss_config.json` — current RSS feeds
   - `skills/x-factlet-harvester/x_sources.md` — current X accounts/hashtags/keywords
   - `skills/ig-factlet-harvester/ig_sources.md` — current Instagram accounts/hashtags
   - `skills/source-discovery/discovered_directories.md` — previously found directories
5. **If occasion mode:** Search the Booking table for occasion keywords (see Occasion-Driven Mode above). Existing bookings with matching events are gold — the clients are already in the DB, they just need fresh outreach for this year's event.
6. **Interactive mode only:** Ask the user ONCE: "Do you have any starter URLs, FB pages, subreddits, or directories you want me to start with?" Accept whatever they give. Don't require it. Move on.

**Decision:** If stats show 0 clients and empty source configs → **COLD START**. Run broad discovery across all source types. If stats show existing clients and populated configs → **EXPANSION RUN**. Focus on gaps and new segments. If occasion specified → **OCCASION RUN**. Focus on that occasion across all source types.

### Step 1: Analyze Coverage Gaps

**Expansion run only (skip if cold start):**

1. `mcp__precrime-mcp__search_clients({ summary: true, limit: 20 })` — what segments and geographies are represented?
2. Compare against VALUE_PROP.md target audience — what's missing?
3. Review existing source configs — what types of sources are missing? (e.g., have FB pages but no subreddits? Have subreddits but no directories?)

Output: a prioritized list of discovery targets. Examples:
- "No convention/trade show sources — need event listing sites for [geography]"
- "No Reddit presence — need subreddits for [trade] in [geography]"
- "Have general industry sources but no local/regional ones"

**Cold start:** Skip gap analysis. Run broad discovery across all source types.

### Step 2: Discover Facebook Sources

**Interactive mode (PRIMARY):**
1. Use SESSION_AI (Gemini/Grok) to search:
   > "What are the most active Facebook pages and groups for [trade] professionals in [geography]? List URLs."
2. Navigate Chrome to `facebook.com/search/pages/?q=[trade] [geography]`
3. Navigate Chrome to `facebook.com/search/groups/?q=[target audience] [geography]`
4. Extract page/group URLs from results via `get_page_text`

**Headless mode (no Chrome):**
- `WebSearch`: `"[trade]" "[geography]" site:facebook.com group`
- `WebSearch`: `"[target audience]" "[geography]" site:facebook.com`
- `WebSearch`: `"event planning" "[geography]" site:facebook.com`

**Validation — for each discovered FB URL:**
1. Does the page exist? (Chrome `navigate` + `get_page_text` in interactive; `WebFetch` in headless)
2. Is it active? (posts within last 60 days)
3. Is it relevant to the trade/audience? (check page description/about)
4. Is it already in fb_sources.md? (dedup against existing entries)

**Output:** Append new validated URLs to `skills/fb-factlet-harvester/fb_sources.md` using the Edit tool. One URL per line. Add a comment line above each batch:
```
# Added by source-discovery [date] — [search that found it]
```

**Target:** 5-15 new FB sources per run.

**Source growth:** While scraping any FB page, look for "Related Groups", "Liked by this Page", or sidebar links to other relevant pages. Validate and add any new ones found.

### Step 3: Discover Reddit Sources

**Interactive mode (PRIMARY):** Use SESSION_AI:
> "List active subreddits for [trade] professionals, [trade] vendors, or event planning in [geography]. Include subscriber counts if known."

**Headless mode:** `WebSearch`:
- `reddit "[trade]" "[geography]" subreddit`
- `site:reddit.com "[target audience]" "[buying occasion]"`
- `reddit "[trade] vendor" OR "[trade] booking" subreddit`

**For each discovered subreddit:**
1. Check activity: Chrome `navigate` to `reddit.com/r/{subreddit}/new/` + `get_page_text` (interactive), or `WebFetch("https://www.reddit.com/r/{subreddit}/new.json?limit=5")` (headless)
2. Check relevance: do post titles match VALUE_PROP keywords?
3. Check size: subscriber count (from the JSON response)
4. Dedup against existing entries in `reddit/reddit_config.json`

**Output:** Append validated subreddits to BOTH files:
1. `skills/reddit-factlet-harvester/reddit_sources.md` — human-readable list, one per line:
   ```
   # Added by source-discovery [date] — [search that found it]
   r/subredditname — description
   ```
2. `reddit/reddit_config.json` — operational config for the Python script. Add entries to the `subreddits` array:
   ```json
   {
     "name": "subredditname",
     "keywords": ["keyword1", "keyword2", "keyword3"],
     "category": "descriptive_category"
   }
   ```

**Target:** 3-8 new subreddits per run.

**Source growth:** When fetching subreddit JSON, check the sidebar/description for links to related subreddits. Validate and add any new ones found.

### Step 4: Discover RSS / News Sources

**Interactive mode (PRIMARY):** Use SESSION_AI:
> "List RSS feeds, trade publications, and news sources for the [trade] industry in [geography]. Include feed URLs where possible."

**Headless mode:** `WebSearch`:
- `"[trade] industry news" RSS feed`
- `"[target audience] news" RSS`
- `"[geography] event listings" RSS OR feed`
- `"[trade] magazine" OR "journal" OR "publication"`

**For each discovered feed:**
1. Validate: Chrome `navigate` to feed URL + `get_page_text` (interactive), or `WebFetch(url)` (headless) — does it return valid RSS/Atom XML?
2. Check freshness: most recent item within last 30 days?
3. Dedup against existing entries in `rss/rss-scorer-mcp/rss_config.json`

**Output:** Edit `rss/rss-scorer-mcp/rss_config.json` — add new entries to the `feeds` array. Format:
```json
{
  "name": "Feed Name",
  "url": "https://example.com/rss",
  "category": "descriptive_category",
  "keywords": ["keyword1", "keyword2"]
}
```

**Target:** 3-10 new RSS feeds per run.

**Source growth:** When fetching feed content, look for links to partner publications or related feeds mentioned in articles. Validate and add any new ones found.

### Step 4.5: Discover X/Twitter Sources

**Interactive mode (PRIMARY):** Use SESSION_AI:
> "List active X/Twitter accounts for [trade] professionals, [trade] industry news, event planning in [geography], and relevant trade associations. Include follower counts if known."

**Headless mode:** `WebSearch`:
- `site:x.com "[trade]" "[geography]"`
- `x.com "[target audience]" "[trade] vendor"`
- `twitter "[trade] industry" account`

**For each discovered source:**
1. Classify as account (`@handle`), hashtag (`#tag`), or keyword search
2. Check activity: is the account/hashtag active within the last 7 days? (Use SESSION_AI or WebSearch to verify)
3. Check relevance: does the content match VALUE_PROP keywords?
4. Dedup against existing entries in `skills/x-factlet-harvester/x_sources.md`

**Output:** Append validated sources to `skills/x-factlet-harvester/x_sources.md` — one per line in the appropriate section:
```
# Added by source-discovery [date] — [search that found it]
@handle — description
#hashtag — what it signals
keyword: "search phrase" — why this matters
```

**Target:** 3-8 accounts, 2-5 hashtags, 1-3 keyword searches per run.

**Source growth:** When checking an account's profile, look at who they follow and who follows them for more relevant accounts. Validate and add any new ones found.

### Step 4.7: Discover Instagram Sources

**Interactive mode (PRIMARY):** Use SESSION_AI:
> "List active public Instagram accounts for [trade] professionals, [trade] industry news, event planning in [geography], and relevant trade associations. Include follower counts if known."

Then navigate Chrome to `instagram.com/{handle}/` for each candidate to verify it exists and is public.

**Headless mode:** `WebSearch`:
- `site:instagram.com "[trade]" "[geography]"`
- `instagram "[target audience]" "[trade] vendor"`
- `"[trade] industry" instagram account`

**For each discovered source:**
1. Classify as account (`@handle`) or hashtag (`#tag`)
2. Check activity: is the account active within the last 60 days? (Chrome navigate to profile + get_page_text, or WebSearch to verify)
3. Check accessibility: is the profile public? If private or login-gated, skip.
4. Check relevance: does the content match VALUE_PROP keywords?
5. Dedup against existing entries in `skills/ig-factlet-harvester/ig_sources.md`

**Output:** Append validated sources to `skills/ig-factlet-harvester/ig_sources.md` — one per line in the appropriate section:
```
# Added by source-discovery [date] — [search that found it]
@handle — description
#hashtag — what it signals
```

**Target:** 3-8 accounts, 2-5 hashtags per run.

**Source growth:** When checking an account's profile, look at tagged accounts, "Suggested for you" profiles, and hashtags used in recent posts for more relevant sources. Validate and add any new ones found.

### Step 5: Discover Directories and Listing Sites

This is the highest-value discovery for client seeding. These are pages where many potential clients are listed.

**Interactive mode (PRIMARY):** Use SESSION_AI:
> "List directories, trade associations, convention exhibitor lists, and vendor marketplaces for [trade] in [geography]. Include URLs."

Then navigate Chrome to each result for validation.

**Headless mode:** `WebSearch`:
- `"[trade] directory" "[geography]"`
- `"[trade] association" members list`
- `"[geography] event vendors" directory`
- `"convention" OR "trade show" "[trade]" "[geography]" exhibitors`
- `eventbrite "[trade]" "[geography]"`
- `"[target audience]" directory "[geography]"`

**For each discovered directory/listing site:**
1. Validate: Chrome `navigate` + `get_page_text` (interactive), or `WebFetch` (headless) — does the page load? Does it contain a list of names/companies/contacts?
2. Classify: is this a one-time list (convention exhibitors) or an ongoing directory (trade association)?
3. Estimate size: how many potential clients are listed?
4. Dedup against existing entries in `skills/source-discovery/discovered_directories.md`

**Interactive mode only:** After discovering directories, show the user what was found and ask: "Any of these look wrong? Anything I should skip?" Remove any the user flags. Don't require a response — if they say nothing, proceed.

**Output:** Append to `skills/source-discovery/discovered_directories.md`. One entry per line:
```
URL | type | estimated_clients | discovered_date
```

Types: `trade_directory`, `exhibitor_list`, `association_members`, `event_listing`, `venue_directory`, `vendor_marketplace`

**Target:** 5-20 directory/listing URLs per run.

**Source growth:** When scraping any directory page, look for links to partner organizations, related directories, or "see also" sections. Validate and add any new ones found.

### Step 6: Source Growth — Integrated

This is NOT a separate pass. During Steps 2-5, every time you scrape a discovered page, actively watch for links to OTHER relevant sources:
- A Facebook group's "Related Groups" section → more FB sources
- A directory page linking to partner organizations → more directories
- An RSS feed article mentioning another publication → more RSS feeds
- A subreddit sidebar linking to related subreddits → more Reddit sources
- An X account's followers/following → more X sources

For each discovered link:
1. Classify: what type of source is it? (FB, Reddit, RSS, directory)
2. Validate: is it active and relevant?
3. Dedup: is it already known?
4. If new and valid: add to the appropriate config file

### Step 7: Create Factlets from Discovery

During discovery, you will encounter broadly applicable intelligence (industry trends, policy changes, market data). Capture these as factlets:
```
mcp__precrime-mcp__create_factlet({
  content: "2-3 sentence summary",
  source: "URL where found"
})
```

**Factlet rules:**
- 2-3 sentences. No more.
- Facts only. No opinion. No editorializing.
- No mention of the product.
- Only broadly applicable findings — NOT client-specific intel.

### Step 8: Run Log

Write a summary to `logs/DISCOVERY_LOG.md` using the Edit tool (append, do not overwrite):

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
- X/Twitter: [N new] added (total now [M])
- Instagram: [N new] added (total now [M])
- Directories: [N new] discovered
- Factlets: [N] created during discovery

### Sources Added
[list each new source with the search query that found it]

### Sources Rejected
[list sources checked but rejected, with reason: stale, irrelevant, duplicate, dead link]
```

---

## Parameterization

**Headless mode** (no Chrome, no user — e.g. Docker/cron):
No user interaction. Read VALUE_PROP.md and config. Discover and append. Log results. Skip all interactive-mode steps.

**Interactive mode** (Chrome available, user present):
- At Step 0: ask user for starter URLs/pages/subreddits (once, optional)
- At Step 5: show discovered directories and ask for confirmation
- Otherwise, run autonomously

---

## Rules

1. **Read VALUE_PROP.md FIRST.** Every search query must be derived from the actual product/audience/geography. Do not guess.
2. **Dedup against existing sources.** Read all config files before adding anything.
3. **Validate before adding.** Every source must be checked: does it exist? Is it active? Is it relevant?
4. **Growth, not replacement.** Never overwrite existing config files. Always APPEND.
5. **No architectural changes.** Do not create new database tables. Do not modify the MCP server. Do not change existing skill files.
6. **Follow existing patterns.** Match the format of existing entries in each config file exactly.
7. **The discovered_directories.md file is for the client-seeder skill.** Source discovery finds directories; client seeding scrapes them for contacts.
8. **Never get stuck.** If a search returns nothing useful, move to the next source type. Log what was tried and why it failed.
9. **Log everything.** Every source added, every source rejected, every search attempted — goes in DISCOVERY_LOG.md.

## What NOT to Do

- Do not overwrite or reformat existing config files — append only
- Do not create factlets for client-specific intel (directories have client lists — those are for the seeder, not factlets)
- Do not add sources you haven't validated (URL loads, content is relevant, page is active)
- Do not add duplicate sources already present in the config files
- Do not skip the run log — every run, every result
- Do not modify the MCP server, database schema, or other skill files
