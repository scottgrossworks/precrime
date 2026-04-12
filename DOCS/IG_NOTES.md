# Instagram Harvester Integration — Briefing for Claude Subprocess

**Context:** You are building an Instagram harvester plugin for Pre-Crime, a deployment-agnostic client enrichment and marketplace supply engine. This document gives you everything you need to match the established patterns.

---

## What Pre-Crime Does

Pre-Crime is a framework that scrapes the internet, classifies what it finds, and either:
1. Creates **factlets** (broadly applicable intel broadcast to all clients)
2. Updates **dossiers** (intel about a specific existing client)
3. Captures **leads** (discovers new clients from the wild)
4. Captures **hot leads** with booking details (new client + gig opportunity)

Each deployment is configured via a `manifest.json` that defines the seller, product, audience, relevance signals, and source configs. A `deploy.js` script scaffolds the entire project from templates.

---

## The Four Output Paths — THIS IS THE CORE MODEL

Every harvested item (post, article, listing) is classified into exactly ONE path. The classification logic is identical across ALL harvesters (RSS, Facebook, Reddit, and now Instagram). Do not invent new paths or skip any.

```
For each harvested item:

1. Is this about a specific person or organization?
   NO  → evaluate as FACTLET (broadly applicable intel)
   YES → continue

2. Is this person/org already in the DB?
   Call: mcp__precrime-mcp__search_clients({ search: "{name or org}" })
   YES → DOSSIER update (append to existing client's dossier)
   NO  → continue

3. Does it contain booking details? (ALL THREE required)
   - Trade: what service is needed (maps to a Leedz trade name)
   - Date: when is the event
   - Location or zip: where
   YES → LEAD CAPTURE HOT (flag with full details)
   NO  → LEAD CAPTURE THIN (flag for review)
```

### Factlet Rules
- 2-3 sentences. No opinions. No product mentions.
- Sentence 1: What happened (numbers, dates, names).
- Sentence 2: Why it matters for the target audience.
- Sentence 3 (optional): Implication for buying urgency.
- One factlet per distinct topic, not per post. Dedup against existing factlets.

### Dossier Rules
- Timestamped prose appended to existing client record.
- Format: `[{date}] Instagram @{account}: {finding}`

### Lead Capture Rules
- **Gated by `leadCaptureEnabled` in deployment config.** If false, flag in report but do NOT create records.
- THIN = new potential client, vague interest. Skill flags it. Orchestrator creates the client.
- HOT = new client WITH trade + date + location. Skill flags with full details. Orchestrator creates client + booking.
- The skill never creates clients or bookings directly. It reports. The orchestrator acts.

---

## MCP Tools Available

These are the tools your skill will use. They already exist in `server/mcp/mcp_server.js`:

| Tool | Purpose | Key Args |
|------|---------|----------|
| `mcp__precrime-mcp__create_factlet` | Save broadly applicable intel | `content`, `source` |
| `mcp__precrime-mcp__get_new_factlets` | Check existing queue (dedup) | `since` (ISO date) |
| `mcp__precrime-mcp__search_clients` | Check if person/org exists | `search` (string) |
| `mcp__precrime-mcp__update_client` | Append to dossier | `id`, `dossier` |
| `mcp__precrime-mcp__create_booking` | Create booking (hot lead path) | `clientId`, `trade`, `startDate`, `location`/`zip`, etc. |
| `mcp__precrime-mcp__get_config` | Read deployment config | (none) |

### Booking Action Criterion (auto-evaluated by create_booking)
When `create_booking` receives `trade` + `startDate` + (`location` OR `zip`), it auto-sets `status: "leed_ready"`. You don't need to set status manually.

---

## Existing Harvester Patterns — What to Match

### 1. RSS Factlet Harvester (`templates/skills/factlet-harvester.md`)
- Uses an MCP RSS scorer tool to fetch articles
- Classification then factlet creation
- Simplest pattern — no browser, no scraping script

### 2. Facebook Factlet Harvester (`templates/skills/fb-factlet-harvester/SKILL.md`)
- **Uses Chrome browser via Claude-in-Chrome MCP extension**
- Navigates to public Facebook pages, scrolls, extracts text via `get_page_text`
- Activity screen: skip pages with no posts in 60 days (STALE check)
- Source list in a separate `fb_sources.md` file
- Same four-path classification
- **Instagram will likely follow this pattern** since IG also needs browser-based scraping

### 3. Reddit Factlet Harvester (`templates/skills/reddit-factlet-harvester.md`)
- Uses a standalone Python script (`tools/reddit_harvest.py`) that fetches via public JSON endpoints
- Script outputs JSON to `./scrapes/{date}/` directory. Claude reads the JSON and classifies.
- **Zero tokens on the fetch.** Claude only processes the output.
- Config-driven: `reddit/reddit_config.json` defines subreddits, keywords, limits.

---

## Lessons Learned from Reddit Integration (READ THIS)

### API Access is Dead
Reddit killed self-service API keys in November 2025. All new apps require pre-approval via manual review. **Assume Instagram's official API is equally hostile to small-scale/personal use.** The Graph API requires Facebook App Review for any useful permissions. Do not build around official APIs.

### What Worked: Public Endpoints
Reddit's public `.json` endpoints (`reddit.com/r/{sub}/search.json?q=...`) work without auth. We built `tools/reddit_harvest.py` around these. 140 lines, just the `requests` library, 2-second delay between requests, 429 backoff built in. **If Instagram has equivalent public endpoints, use them.**

### What Failed: URS (Universal Reddit Scraper)
We tried URS, a third-party Reddit scraper. It required Rust/Maturin to compile a native module (`taisun`). Hard dependency baked into every import path, no workaround. **Avoid tools with compiled/native dependencies.** Stick to pure Python + requests/selenium/playwright.

### The Token-Zero Pattern
The harvester script does the fetch (zero Claude tokens). It dumps structured JSON to `./scrapes/{date}/`. Claude reads the JSON and does the classification. This is the right architecture for any source that produces a lot of text. **The Instagram harvester should follow this same pattern if possible** — a Python script fetches and structures the data, Claude classifies.

### Config-Driven Design
Each harvester has a config file in the deployment (`reddit/reddit_config.json`, `rss/rss_config.json`). The config defines what to scrape (accounts, keywords, limits). `deploy.js` merges a base template with manifest overrides during scaffolding. Your IG harvester needs an `ig_config.json` template.

---

## Instagram-Specific Considerations

### Scraping Approaches (in order of preference)

1. **Public profile JSON** — Instagram profiles at `instagram.com/{username}/?__a=1&__d=dis` used to return JSON. This may still work for public profiles. Test first. If it works, follow the Reddit pattern (Python script + requests).

2. **Browser-based via Chrome MCP** — Follow the Facebook pattern exactly. Navigate to public profile, scroll, `get_page_text`. This is the most reliable fallback but costs more tokens (browser text is noisy). Instagram is heavily JS-rendered so plain `requests` alone won't get post content.

3. **Instaloader** — `pip install instaloader`. Pure Python, no compiled deps. Can fetch public profiles without login. Test whether it still works without auth — Instagram has been tightening access. **If it requires login, skip it** (credential management is out of scope for the base framework).

4. **Playwright/Selenium headless** — Last resort. Heavy dependency. Only if Chrome MCP isn't available and public JSON is dead.

### What to Scrape
- **Public business profiles** — the IG equivalent of FB pages. Event venues, planners, local businesses.
- **Hashtag searches** — IG's hashtag pages show recent posts. Good for lead capture.
- **Post content:** caption text, hashtags, location tag, timestamp, like/comment counts, author handle.
- **Do NOT:** access DMs, stories (ephemeral), reels audio, private accounts, or interact (like/comment/follow).

### Output Schema
Match the Reddit harvester's output format for consistency:

```json
{
  "scrape_settings": {
    "source": "instagram",
    "account": "@accountname",
    "timestamp": "ISO-8601",
    "count": 15
  },
  "data": [
    {
      "id": "post_shortcode",
      "text": "caption text",
      "author": "username",
      "likes": 142,
      "comments": 23,
      "created_utc": 1774575614.0,
      "created_iso": "2026-03-27T01:40:14+00:00",
      "permalink": "/p/shortcode/",
      "location": "Los Angeles, CA",
      "hashtags": ["wedding", "DJ", "LAevents"],
      "is_video": false,
      "media_url": "https://..."
    }
  ]
}
```

---

## File Placement — Where Things Go

```
PRECRIME/
  templates/
    ig_config.json                          <- base config template (like reddit_config.json)
    skills/
      ig-factlet-harvester.md               <- skill playbook (or ig-factlet-harvester/SKILL.md if multi-file)
      ig-factlet-harvester/
        ig_sources.md                       <- source list (if using browser pattern like FB)
  tools/
    ig_harvest.py                           <- fetch script (if using token-zero pattern like Reddit)
  manifest.sample.json                      <- add igConfig section (see below)
  deploy.js                                 <- add ig config merge + skill copy + post-scaffold note
```

### Manifest Addition
Add to `manifest.sample.json` alongside the existing `redditConfig` and `fbSources`:

```json
"igConfig": {
  "accounts": [
    {
      "username": "account_handle",
      "category": "industry"
    }
  ],
  "hashtags": [
    "relevanthashtag",
    "anothertag"
  ],
  "additionalKeywords": [
    "keyword to add to global list"
  ]
}
```

### Deploy.js Changes
Follow the exact pattern used for Reddit config merge (search for `redditCfg` in `deploy.js` for the template):
1. Add `'ig'` to the directory creation array (line ~68, where `reddit` is listed)
2. Read base `ig_config.json` template
3. Merge manifest `igConfig` overrides (accounts, hashtags, keywords)
4. Write to `{outputDir}/ig/ig_config.json`
5. Add skill template to the copy list (search for `reddit-factlet-harvester` in deploy.js)
6. Add setup note to post-scaffold checklist (search for `5b. REDDIT HARVESTER`)

---

## Skill Playbook Structure

Follow this exact structure (matches all other harvesters):

```markdown
---
name: {{DEPLOYMENT_NAME}}-ig-factlet-harvester
description: Harvest Instagram posts and create factlets or capture leads
triggers:
  - harvest instagram factlets
  - scrape instagram
  - run the ig harvester
  - check instagram for news
  - check instagram for leads
---

# {{DEPLOYMENT_NAME}} — Instagram Factlet & Lead Harvester

[1-2 sentence description of what this skill does]

**Requires:** [dependencies]

## Tools
[table of MCP tools used]

## Configuration
[where to find config]

## Procedure
### Step 1: Fetch Posts
[how to get the data — script or Chrome]

### Step 2: Load Existing Factlets (dedup)
[get_new_factlets call]

### Step 3: Classify Each Post — Four Output Paths
[THE EXACT SAME classification logic as above — copy it verbatim]

### Step 4A: Factlet Path
### Step 4B: Dossier Path
### Step 4C: Lead Capture THIN
### Step 4D: Lead Capture HOT
[same handlers as Reddit/FB]

### Step 5: Report
[harvest summary with counts per path]

## Rules
[platform-specific constraints]

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER -->
```

---

## Entities — Database Schema

### Client (existing — do not modify)
```
id, name, email, phone, company, website, clientNotes, dossier,
targetUrls, draft, draftStatus, warmthScore, lastEnriched,
lastQueueCheck, source, createdAt, updatedAt
```

### Booking (existing — do not modify)
```
id, clientId, title, description, notes, location, startDate, endDate,
startTime, endTime, duration, hourlyRate, flatRate, totalAmount, status,
source, sourceUrl, trade, zip, shared, sharedTo, sharedAt, leedPrice,
squarePaymentUrl, leedId, createdAt, updatedAt
```

`source` field format for IG: `"instagram:@username"` or `"instagram:#hashtag"`
`sourceUrl` format: `"https://www.instagram.com/p/{shortcode}/"`

### Booking Status Values
| Status | Meaning |
|--------|---------|
| `new` | Just captured. Incomplete info. |
| `leed_ready` | Has trade + startDate + (location OR zip). Actionable. |
| `taken` | Business owner claimed it. |
| `shared` | Posted to The Leedz marketplace. |
| `expired` | Start date passed. |

---

## What NOT to Do

1. **Do not invent new classification paths.** Four paths. Always four. No "maybe" bucket.
2. **Do not create clients or bookings from the skill.** Flag and report. The orchestrator creates.
3. **Do not require API keys if avoidable.** Instagram Graph API requires Facebook App Review. Find a public path.
4. **Do not use tools with compiled/native dependencies.** Pure Python only. No Rust, no C extensions.
5. **Do not interact with Instagram** — no likes, follows, comments, DMs.
6. **Do not follow external links in posts.** Evaluate caption text + metadata only.
7. **Do not scrape private accounts, stories, or DMs.**
8. **Do not hardcode deployment-specific values.** Use `{{TEMPLATE_TOKENS}}` that deploy.js substitutes.
9. **Do not modify existing MCP tools or skills.** Your work is additive. The 15 existing MCP tools and all other skills are untouched.
10. **Do not add new database tables or columns.** Client, Booking, Factlet, Config — these four tables handle everything. Use `source` and `sourceUrl` fields to identify IG origin.

---

## Reference Files to Read

Before writing any code, read these files in the PRECRIME directory:

| File | Why |
|------|-----|
| `ONTOLOGY.md` | Full v2.0 design spec — entities, paths, funnel, design rules |
| `manifest.sample.json` | See existing config sections to match your additions |
| `deploy.js` | See Reddit/RSS merge patterns to replicate for IG |
| `templates/reddit_config.json` | Config template pattern to follow |
| `templates/skills/reddit-factlet-harvester.md` | Closest skill pattern (script-based fetch) |
| `templates/skills/fb-factlet-harvester/SKILL.md` | Closest skill pattern (browser-based fetch) |
| `tools/reddit_harvest.py` | Reference implementation for a token-zero fetch script |
| `server/mcp/mcp_server.js` | All 15 MCP tools — read the `handleToolsList` function |

---

## Checklist Before You're Done

- [ ] Scraping approach chosen and tested (public JSON, Chrome MCP, or instaloader)
- [ ] `tools/ig_harvest.py` OR browser-based skill — one approach, not both
- [ ] `templates/ig_config.json` — base config template
- [ ] `templates/skills/ig-factlet-harvester.md` (or `/SKILL.md`) — full skill playbook
- [ ] Four-way classification logic matches verbatim
- [ ] `manifest.sample.json` — `igConfig` section added
- [ ] `deploy.js` — ig config merge, skill copy, directory creation, post-scaffold note
- [ ] Output JSON schema matches the format above
- [ ] Source field format: `"instagram:@handle"` or `"instagram:#tag"`
- [ ] No compiled dependencies. No API keys required (if possible).
- [ ] Tested: script runs (at minimum `--help` or a dry run)
