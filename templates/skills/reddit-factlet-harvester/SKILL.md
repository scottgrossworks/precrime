---
name: {{DEPLOYMENT_NAME}}-reddit-factlet-harvester
description: Harvest Reddit posts via public JSON API and create factlets or capture leads
triggers:
  - harvest reddit factlets
  - scrape reddit
  - run the reddit harvester
  - check reddit for news
  - check reddit for leads
---

# {{DEPLOYMENT_NAME}} — Reddit Factlet & Lead Harvester

You harvest Reddit posts using `tools/reddit_harvest.py` (public JSON endpoints, no auth) and classify each post into one of four output paths. The script handles the fetch (zero Claude tokens). You handle the judgment.

**Requires:** `pip install requests` (usually already installed). No API keys needed.

## Tools

| Tool | Purpose |
|------|---------|
| `Bash` | Run reddit_harvest.py to fetch posts → JSON files |
| `Read` | Read the output JSON files |
| `mcp__precrime-mcp__create_factlet` | Save broadly applicable intel |
| `mcp__precrime-mcp__get_new_factlets` | Check existing queue (dedup) |
| `mcp__precrime-mcp__search_clients` | Check if a person/org is already a client |
| `mcp__precrime-mcp__update_client` | Append to existing client's dossier |
| `mcp__precrime-mcp__create_booking` | Create a booking for Lead Capture hot path |

## Source File

`skills/reddit-factlet-harvester/reddit_sources.md`

This is the human-readable subreddit list. Source-discovery and init-wizard populate it.

The operational config (keywords, limits, scoring thresholds) lives in `reddit/reddit_config.json`.

## Procedure

### Step 1: Fetch Posts

Use the **terminal tool** (not execute_code) to run the harvest script. Always use absolute paths:

**Option A — Config-driven (preferred):**

Use the terminal tool to run: `python /precrime/tools/reddit_harvest.py --config /precrime/reddit/reddit_config.json`

Runs all subreddit/keyword combos defined in the config in one pass.

**Option B — Headless fallback (if script fails or tools/reddit_harvest.py is missing):**

Use `WebFetch` directly on Reddit's public JSON API — no script, no auth needed:

`WebFetch("https://www.reddit.com/r/{subreddit}/new.json?limit=25")` for each subreddit in reddit_sources.md.

Parse the returned JSON for `data.children[].data` — each item has `title`, `selftext`, `permalink`, `created_utc`, `author`, `score`.

**Option C — Single subreddit (terminal tool):**

Use the terminal tool to run: `python /precrime/tools/reddit_harvest.py --subreddit {subreddit} --keywords "{keywords}" --limit {maxPosts}`

Additional flags: `--sort {relevance|hot|top|new|comments}`, `--time {day|week|month|year|all}`.

Output lands in `/precrime/scrapes/{YYYY-MM-DD}/{subreddit}_search_{keywords}.json`.

Each file contains `scrape_settings` (metadata) and a `data` array of posts with: `id`, `title`, `selftext`, `score`, `upvote_ratio`, `num_comments`, `created_utc`, `created_iso`, `author`, `permalink`, `url`, `subreddit`, `link_flair_text`, `is_self`, `over_18`.

### Step 2: Load Existing Factlets (dedup)

```
mcp__precrime-mcp__get_new_factlets({ since: "30 days ago ISO" })
```

Build a list of existing factlet topics. Any post covering the same ground gets skipped.

### Step 3: Classify Each Post — Four Output Paths

For every post, answer the classification questions IN ORDER:

**1. Is this about a specific person or organization?**

- **NO** → evaluate as **Factlet** candidate (Step 4A)
- **YES** → continue to question 2

**2. Is this person/org already in the DB?**

```
mcp__precrime-mcp__search_clients({ search: "{name or org}", limit: 1 })
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

Industry-wide trends, policy changes, market shifts → YES.
One person's question or one org's internal matter → NO.

**Q3: Recent enough to matter?**

- Posted within 7 days: strong candidate
- 7–30 days: include if major trend
- 30+ days: skip

If all three pass:

```
mcp__precrime-mcp__create_factlet({
  content: "[2-3 sentences. What. Why it matters for the target decision-makers. Implication.]",
  source: "https://reddit.com{permalink}"
})
```

Rules: 2-3 sentences. No opinions. No mention of the product.
One factlet per distinct topic — not one per post. Two posts about the same news = one factlet.

### Step 4B: Dossier Path

This post is about an existing client. Append to their dossier:

```
mcp__precrime-mcp__update_client({
  id: "{clientId}",
  dossier: "{existing dossier}\n[{today}] Reddit r/{subreddit}: {finding}"
})
```

### Step 4C: Lead Capture THIN

New potential client, but vague — no concrete booking details.

**Only if `leadCaptureEnabled` is true in config.** Skip otherwise.

Note in the report: "Thin lead detected: {author} in r/{subreddit} — {summary}. No action taken (requires manual review or leadCaptureEnabled)."

When lead capture is active, the orchestrator creates the client. This skill just flags it.

### Step 4D: Lead Capture HOT

New client WITH booking details — trade + date + location all present.

**Only if `leadCaptureEnabled` is true in config.** Skip otherwise.

Note in the report with full details:
- **Who:** {author or org name}
- **Trade:** {what service they need}
- **Date:** {when}
- **Location:** {where}
- **Source:** https://reddit.com{permalink}
- **Snippet:** {relevant quote from post}

When lead capture is active, the orchestrator creates the client + booking. This skill flags and reports.

## Step 5: Report

After processing all files:

```
Reddit Harvest Report — {date}
================================
Subreddits searched: N
Posts fetched: N
Posts evaluated: N

Output path breakdown:
  Factlets created:     N (with summaries)
  Dossier updates:      N (client name + finding)
  Lead Capture thin:    N (flagged for review)
  Lead Capture hot:     N (flagged with full details)
  Duplicates skipped:   N
  Irrelevant skipped:   N
  Too old skipped:      N
```

## Rules

- Prefer the terminal tool + reddit_harvest.py. If the script fails, fall back to WebFetch on Reddit JSON API. Do NOT stop.
- One factlet per distinct topic — not one per post. Two posts about the same news = one factlet.
- Dossier entries are timestamped prose. Include the subreddit and date.
- Lead Capture is opt-in. If `leadCaptureEnabled` is false, flag but do not create records.
- Do NOT interact with Reddit (no posting, no commenting, no voting).
- Do NOT follow external links in posts. Evaluate the post text only.

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER
     ================================
     1. Edit skills/reddit-factlet-harvester/reddit_sources.md to add subreddits
        for your audience. Start with 3-5 subreddits where your buyers congregate.
        Source-discovery will also populate this file automatically.

     2. Edit reddit/reddit_config.json for operational settings (keywords, limits,
        scoring thresholds). The JSON config drives the Python script; the
        reddit_sources.md file is the human-readable source list.

     3. The four-way classification (factlet / dossier / lead thin / lead hot)
        is the same across all harvesters. The relevance criteria (Q1) come
        from your manifest.

     4. No API keys needed. The script uses Reddit's public .json endpoints.
        Rate limit: ~2 seconds between requests (built in). A harvest of
        5 subreddits runs in ~15 seconds. Safe to run multiple times per hour.

     6. Use --sort relevance (default) for factlet harvesting. Use --sort hot
        or --sort top for initial exploration of a new subreddit to gauge
        relevance before adding it to the config.

     LEAD CAPTURE NOTE: Steps 4C and 4D are gated by leadCaptureEnabled
     in your deployment config. If you're running outreach-only (no bookings),
     leave it false — the skill will still flag potential leads in the report
     but won't create database records.
-->
