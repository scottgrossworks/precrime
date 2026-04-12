---
title: Instagram Harvester — Integration Spec
tags: [instagram, harvester, scraping, ig, token-zero, browser, instaloader]
source_docs: [DOCS/IG_NOTES.md, DOCS/STATUS.md]
last_updated: 2026-04-04
staleness: none
---

The Instagram harvester is a planned harvester plugin for Pre-Crime. It follows the same four-path classification model as all other harvesters (RSS, Facebook, Reddit). This article captures the full integration spec from `IG_NOTES.md`.

---

## Scraping Approaches (Priority Order)

1. **Public profile JSON** — `instagram.com/{username}/?__a=1&__d=dis`. Used to return JSON for public profiles. Test first. If it works → follow the Reddit token-zero pattern (Python script + requests). Preferred.

2. **Browser-based via Chrome MCP** — Navigate to public profile, scroll, `get_page_text`. Most reliable fallback. More tokens (browser text is noisy). IG is heavily JS-rendered so plain `requests` alone won't get post content.

3. **Instaloader** — `pip install instaloader`. Pure Python, no compiled deps. Can fetch public profiles without login. **If it requires login, skip it** — credential management is out of scope.

4. **Playwright/Selenium headless** — Last resort. Heavy dependency. Only if Chrome MCP isn't available and public JSON is dead.

**Do NOT use the Instagram Graph API.** Requires Facebook App Review for any useful permissions. Same problem as Reddit official API.

---

## What to Scrape

- Public business profiles (event venues, planners, local businesses)
- Hashtag search pages (good for lead capture)
- Post content: caption text, hashtags, location tag, timestamp, like/comment counts, author handle

**Do NOT:** access DMs, stories (ephemeral), reels audio, private accounts, or interact (like/comment/follow/DM).

---

## Output JSON Schema

Match this format (consistent with Reddit harvester output):

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

Script dumps to `./scrapes/{date}/`.

---

## DB Source Field Format

- `source` field on Booking: `"instagram:@username"` or `"instagram:#hashtag"`
- `sourceUrl` field on Booking: `"https://www.instagram.com/p/{shortcode}/"`

---

## File Placement

```
PRECRIME\
  templates\
    ig_config.json                    <- base config template
    skills\
      ig-factlet-harvester.md         <- skill playbook
      ig-factlet-harvester\           <- or multi-file dir if complex
        ig_sources.md                 <- source list (if browser pattern)
  tools\
    ig_harvest.py                     <- fetch script (if token-zero pattern)
  manifest.sample.json                <- add igConfig section
  deploy.js                           <- add ig config merge + skill copy
```

---

## Manifest Config Section

Add to `manifest.sample.json` alongside existing `redditConfig` and `fbSources`:

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

---

## deploy.js Changes Required

Follow the exact pattern used for Reddit config merge (search for `redditCfg` in `deploy.js`):

1. Add `'ig'` to directory creation array (line ~68, where `reddit` is listed)
2. Read base `ig_config.json` template
3. Merge manifest `igConfig` overrides (accounts, hashtags, keywords)
4. Write to `{outputDir}/ig/ig_config.json`
5. Add skill template to copy list (search for `reddit-factlet-harvester`)
6. Add setup note to post-scaffold checklist (search for `5b. REDDIT HARVESTER`)

---

## Skill Playbook Structure

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

## Tools
[table of MCP tools used]

## Configuration
## Procedure
  ### Step 1: Fetch Posts
  ### Step 2: Load Existing Factlets (dedup)
  ### Step 3: Classify Each Post — Four Output Paths
  ### Step 4A: Factlet Path
  ### Step 4B: Dossier Path
  ### Step 4C: Lead Capture THIN
  ### Step 4D: Lead Capture HOT
  ### Step 5: Report

## Rules
```

The four-path classification logic (Step 3) must match verbatim across ALL harvesters. Do not invent new paths.

---

## MCP Tools Used by This Skill

| Tool | Purpose |
|------|---------|
| `mcp__precrime-mcp__create_factlet` | Save broadly applicable intel |
| `mcp__precrime-mcp__get_new_factlets` | Check existing queue (dedup) |
| `mcp__precrime-mcp__search_clients` | Check if person/org exists |
| `mcp__precrime-mcp__update_client` | Append to dossier |
| `mcp__precrime-mcp__create_booking` | Create booking (hot lead path) |
| `mcp__precrime-mcp__get_config` | Read deployment config (check leadCaptureEnabled) |

`create_booking` auto-evaluates Booking Action Criterion — no manual status setting needed.

---

## Constraints

1. Do not invent new classification paths. Four paths. Always four.
2. Do not create clients or bookings from the skill. Flag and report. Orchestrator creates.
3. Do not require API keys if avoidable.
4. Do not use tools with compiled/native dependencies. Pure Python only.
5. Do not interact with Instagram (no likes, follows, comments, DMs).
6. Do not follow external links in posts. Caption text + metadata only.
7. Do not scrape private accounts, stories, or DMs.
8. Do not hardcode deployment-specific values. Use `{{TEMPLATE_TOKENS}}`.
9. Do not modify existing MCP tools or skills. Work is additive only.
10. Do not add new DB tables or columns. Use `source` and `sourceUrl` for IG origin.

---

## Implementation Checklist

- [ ] Scraping approach chosen and tested (public JSON, Chrome MCP, or instaloader)
- [ ] `tools/ig_harvest.py` OR browser-based skill (one approach, not both)
- [ ] `templates/ig_config.json` — base config template
- [ ] `templates/skills/ig-factlet-harvester.md` — full skill playbook
- [ ] Four-way classification logic matches verbatim
- [ ] `manifest.sample.json` — `igConfig` section added
- [ ] `deploy.js` — ig config merge, skill copy, directory creation, post-scaffold note
- [ ] Output JSON schema matches format above
- [ ] Source field format: `"instagram:@handle"` or `"instagram:#tag"`
- [ ] No compiled dependencies. No API keys required (if possible).
- [ ] Tested: script runs (at minimum `--help` or dry run)

---

## Related
- [[ontology]] — four output paths, Booking status values, DB field formats
- [[architecture]] — token-zero pattern, browser-based scraping pattern
- [[reddit]] — Reddit harvester (closest implementation reference)
- [[mcp]] — MCP tools available to skills
