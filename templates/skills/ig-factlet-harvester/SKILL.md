---
name: {{DEPLOYMENT_NAME}}-ig-factlet-harvester
description: Harvest Instagram posts from curated accounts and hashtags, then create factlets or capture leads
triggers:
  - harvest instagram factlets
  - scrape instagram
  - run the ig harvester
  - check instagram for news
  - check instagram for leads
---

# {{DEPLOYMENT_NAME}} — Instagram Factlet & Lead Harvester

You harvest Instagram posts from curated business accounts and hashtags using `tools/ig_harvest.py` (Instaloader, no auth required for public profiles) and classify each post into one of four output paths. The script handles the fetch (zero Claude tokens). You handle the judgment.

**Requires:** `pip install instaloader`

**No API keys required.** Public profiles only. No login. No DMs, stories, or private accounts.

## Tools

| Tool | Purpose |
|------|---------|
| `Bash` | Run ig_harvest.py to fetch posts → JSON files |
| `Read` | Read the output JSON files |
| `mcp__leedz-mcp__create_factlet` | Save broadly applicable intel |
| `mcp__leedz-mcp__get_new_factlets` | Check existing queue (dedup) |
| `mcp__leedz-mcp__search_clients` | Check if a person/org is already a client |
| `mcp__leedz-mcp__update_client` | Append to existing client's dossier |
| `mcp__leedz-mcp__create_booking` | Create a booking for Lead Capture hot path |

## Configuration

Read `ig/ig_config.json` for the account list, hashtags, and limits.

Source accounts and hashtags are also listed in `skills/ig-factlet-harvester/ig_sources.md` for human review.

## Procedure

### Step 1: Fetch Posts

**Option A — Config-driven (preferred):**

```bash
python tools/ig_harvest.py --config ig/ig_config.json
```

Runs all accounts and hashtags in one pass. Output lands in `./scrapes/{YYYY-MM-DD}/`.

- Account files: `ig_account_{username}.json`
- Hashtag files: `ig_hashtag_{tag}.json`

**Option B — Single target:**

```bash
python tools/ig_harvest.py --account {username} --limit 20
python tools/ig_harvest.py --hashtag {tag} --limit 25
```

Each JSON file contains `scrape_settings` (source, timestamp, count) and a `data` array.
Each post in `data` has: `id`, `text`, `author`, `likes`, `comments`, `created_utc`, `created_iso`, `permalink`, `location`, `hashtags`, `is_video`.

**If ig_harvest.py fails entirely** (instaloader broken, Instagram blocking):
Use Chrome MCP as fallback. Navigate to `https://www.instagram.com/{username}/`, wait 3 seconds, scroll down twice, `get_page_text`. Extract post captions and timestamps from the page text. Log as `SCRAPE_FALLBACK_CHROME — @{username}` in the report.

### Step 2: Load Existing Factlets (dedup)

```
mcp__leedz-mcp__get_new_factlets({ since: "30 days ago ISO" })
```

Build a list of existing factlet topics. Any post covering the same ground gets skipped.

### Step 3: Classify Each Post — Four Output Paths

For every post in every JSON file, answer the classification questions IN ORDER.

**Skip the post entirely if:**
- `created_iso` is older than `recencyDays` in config (default: 30 days)
- `text` is empty and no location or hashtags to evaluate
- `scrape_settings.error` is set (file represents a failed scrape)

**For each remaining post:**

**1. Is this about a specific person or organization?**

- **NO** → evaluate as **Factlet** candidate (Step 4A)
- **YES** → continue to question 2

**2. Is this person/org already in the DB?**

```
mcp__leedz-mcp__search_clients({ search: "{name or org}", limit: 1 })
```

- **YES (match found)** → **Dossier** update (Step 4B)
- **NO** → continue to question 3

**3. Does this post contain booking details?**

Check for ALL THREE:
- **Trade** — what service is needed? (maps to a Leedz trade name)
- **Date** — when is the event?
- **Location or zip** — where?

- **YES (all three present)** → **Lead Capture HOT** (Step 4D)
- **NO (missing any)** → **Lead Capture THIN** (Step 4C)

### Step 4A: Factlet Path

Apply the three-question relevance filter:

**Q1: Relevant to selling [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]?**
(Use product name and audience from DOCS/VALUE_PROP.md)

RELEVANT topics:
(See "Relevance Signals — Relevant" section in DOCS/VALUE_PROP.md)

NOT RELEVANT:
(See "Relevance Signals — Not Relevant" section in DOCS/VALUE_PROP.md)

**Q2: Broadly applicable to multiple clients?**

Industry-wide trends, policy changes, market shifts, sector news → YES.
One account's self-promotion, one org's internal event → NO.

**Q3: Recent enough to matter?**

- Posted within 7 days: strong candidate
- 7–30 days: include if major trend
- 30+ days: skip

If all three pass:

```
mcp__leedz-mcp__create_factlet({
  content: "[2-3 sentences. What. Why it matters for the target decision-makers. Implication.]",
  source: "https://www.instagram.com/p/{post.id}/"
})
```

Rules: 2-3 sentences. No opinions. No mention of the product.
One factlet per distinct topic — not one per post. If two posts cover the same news, write one factlet.

### Step 4B: Dossier Path

This post is about an existing client. Append to their dossier:

```
mcp__leedz-mcp__update_client({
  id: "{clientId}",
  dossier: "{existing dossier}\n[{today}] Instagram @{post.author}: {finding}"
})
```

### Step 4C: Lead Capture THIN

New potential client, vague — no concrete booking details.

**Only if `leadCaptureEnabled` is true in config.** Skip otherwise.

Note in the report: "Thin lead: @{author} — {summary}. Flagged for review."

When lead capture is active, the orchestrator creates the client. This skill flags only.

### Step 4D: Lead Capture HOT

New client WITH booking details — trade + date + location all present.

**Only if `leadCaptureEnabled` is true in config.** Skip otherwise.

Note in the report with full details:
- **Who:** {author or org name}
- **Trade:** {what service they need}
- **Date:** {when}
- **Location:** {where}
- **Source:** `https://www.instagram.com/p/{post.id}/`
- **Snippet:** {relevant quote from caption}

Source field format: `"instagram:@{username}"` or `"instagram:#{hashtag}"`
SourceUrl format: `"https://www.instagram.com/p/{shortcode}/"`

When lead capture is active, the orchestrator creates client + booking. Skill flags and reports.

## Step 5: Report

After processing all files:

```
Instagram Harvest Report — {date}
====================================
Accounts harvested: N
Hashtags harvested: N
Posts fetched: N
Posts evaluated: N (after recency filter)

Scrape errors:
  @{account}: {error} (if any)
  #{hashtag}: {error} (if any)

Output path breakdown:
  Factlets created:     N (with summaries)
  Dossier updates:      N (client name + finding)
  Lead Capture thin:    N (flagged for review)
  Lead Capture hot:     N (flagged with full details)
  Duplicates skipped:   N
  Irrelevant skipped:   N
  Too old skipped:      N
  Empty/error skipped:  N
```

## Rules

- ig_harvest.py does the fetch. Claude does the judgment. Never use WebFetch for Instagram.
- Only scrape accounts and hashtags listed in `ig/ig_config.json`.
- One factlet per distinct topic — not one per post.
- Do NOT interact with Instagram (no likes, follows, comments, DMs).
- Do NOT follow external links in captions. Evaluate caption text + metadata only.
- Do NOT scrape private accounts, stories, or reels audio.
- Lead Capture is opt-in. If `leadCaptureEnabled` is false, flag but do not create records.
- If a scrape returns `LOGIN_REQUIRED`, log it and skip — do not attempt to authenticate.
- Dossier entries are timestamped prose. Include the account handle.

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER
     ================================
     1. Edit ig/ig_config.json to add accounts and hashtags for your audience.
        - accounts: public business Instagram pages in your industry
          (associations, publications, competitor pages, community hubs)
        - hashtags: tags your buyers use when discussing their events/needs
          e.g. "#corporateevent", "#hiringSEL", "#teambuilding"

     2. The four-way classification (factlet / dossier / lead thin / lead hot)
        is identical across all harvesters. The relevance criteria (Q1) come
        from your manifest.

     3. Rate limits: Instagram allows ~100-200 public profile fetches per
        session without login. The script adds 3s between accounts and 30s
        between hashtags. For large account lists (20+), consider splitting
        across multiple days or using --account in separate runs.

     4. Hashtag scraping is more heavily throttled than profile scraping.
        Start with 3-5 hashtags. If you hit RATE_LIMITED errors consistently,
        remove hashtags and rely on account-based scraping instead.

     5. Chrome MCP fallback: if instaloader is blocked for a session, you can
        manually navigate to instagram.com/{username} in Chrome, scroll, and
        use get_page_text to extract posts. Log as SCRAPE_FALLBACK_CHROME.
        This is a last resort — it costs more tokens and is less structured.

     6. Lead capture use case: hashtag scraping is most useful for lead capture
        (e.g., "#needaDJ", "#eventvendorneeded"). Account scraping is most
        useful for factlets (industry associations, news accounts, trade bodies).
        Adjust your config accordingly.
-->
