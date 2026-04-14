---
name: {{DEPLOYMENT_NAME}}-ig-factlet-harvester
description: Scrape curated Instagram profiles and hashtags for relevant posts and create factlets
triggers:
  - harvest instagram factlets
  - scrape instagram
  - run the ig harvester
  - check instagram for news
  - check instagram for leads
---

# {{DEPLOYMENT_NAME}} — Instagram Factlet & Lead Harvester

You scrape curated Instagram profiles and hashtag pages for broadly applicable news relevant to selling the product (per `DOCS/VALUE_PROP.md`) and create factlets for the broadcast queue.

**Before running: read `DOCS/VALUE_PROP.md`** for product name, audience, and relevance signals.

**This skill REQUIRES Chrome.** If Chrome is not connected, STOP immediately and tell the user.

## Source File

`skills/ig-factlet-harvester/ig_sources.md`

Only scrape accounts and hashtags listed in that file. Never add new sources mid-run.

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__Claude_in_Chrome__tabs_context_mcp` | Verify Chrome is connected (call ONCE) |
| `mcp__Claude_in_Chrome__navigate` | Navigate to each IG profile/hashtag page |
| `mcp__Claude_in_Chrome__computer` | Wait, scroll |
| `mcp__Claude_in_Chrome__get_page_text` | Extract post captions and metadata |
| `mcp__precrime-mcp__create_factlet` | Save qualifying posts as factlets |
| `mcp__precrime-mcp__get_new_factlets` | Check existing queue (dedup) |
| `mcp__precrime-mcp__search_clients` | Check if person/org is already a client |
| `mcp__precrime-mcp__update_client` | Append to existing client's dossier |
| `mcp__precrime-mcp__create_client` | Create new client (lead capture paths) |
| `mcp__precrime-mcp__create_booking` | Create booking (hot lead path) |
| `mcp__precrime-mcp__get_config` | Read config (check leadCaptureEnabled) |

## Procedure

### Step 0: Pre-flight

1. `tabs_context_mcp({ createIfEmpty: true })` — if this fails, wait 3 seconds and retry once. If still failing, STOP.
2. Read `skills/ig-factlet-harvester/ig_sources.md`. Parse all sources (skip lines starting with `#` or blank). Separate into ACCOUNTS (`@handle` lines) and HASHTAGS (`#tag` lines).
3. `get_new_factlets({ since: "1970-01-01T00:00:00Z" })` — load full queue for dedup.
4. `get_config()` — check `leadCaptureEnabled`.

### Step 0.5: Discover AI Assistant

Scan open tabs for `gemini.google.com` or `grok.com`. Store as `SESSION_AI = { gemini: <tabId> | null, grok: <tabId> | null }`. If neither found, set `SESSION_AI = null`; Gemini steps below will be skipped.

### Step 1: Activity Screen (fast pass)

Before deep-scraping any account, do a quick activity check:

For each @account in ig_sources.md:

1. Navigate to `https://www.instagram.com/{handle}/`
2. Wait 3 seconds (IG is heavily JS-rendered)
3. `get_page_text` — scan for the most recent post date
4. **If the page shows "login required" or redirects to login:** mark as BLOCKED, skip. Note in report.
5. **If the profile is private or doesn't exist:** mark as PRIVATE/404, skip. Note in report.
6. **If most recent post is older than 60 days:** mark as STALE, skip. Note in report.
7. **If the profile has recent posts:** add to active list with a text sample. Proceed to Step 1.5.

This prevents wasting tokens on dead or blocked profiles. Move fast, ~5 seconds per account.

### Step 1.5: Bulk Relevance Pre-filter via Gemini (if SESSION_AI available)

**Skip to Step 2 if SESSION_AI is null.**

After the activity screen, you have a list of active accounts plus a short text sample from each.

1. Compile a numbered list: `[N] @{handle} -- [{first 50 words of activity-screen text}]`
2. Navigate to Gemini tab and paste:
   > "We sell [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]. From this numbered list of Instagram accounts, return ONLY the numbers of accounts likely to contain relevant buying signals, industry trends, or pain points for this audience. Comma-separated numbers only, no explanation."
   (Fill [PRODUCT_NAME] and [AUDIENCE_DESCRIPTION] from DOCS/VALUE_PROP.md)
3. Wait 5 seconds. Read response via `get_page_text`.
4. Parse the comma-separated list. Only run Step 2 deep scrape on those accounts. Mark the rest as `GEMINI_FILTERED` in the report.
5. Log: `Gemini pre-filter: [N active accounts] -> [M selected for deep scrape]`

### Step 2: Deep Scrape Accounts (Gemini-selected only)

For each selected account:

1. Navigate to `https://www.instagram.com/{handle}/` (may already be there from activity screen)
2. Scroll down twice: `scroll down 5 ticks` -> wait 1s -> `scroll down 5 ticks`
3. `get_page_text` — capture full visible post feed
4. Extract from each visible post: caption text, hashtags in caption, location tag (if any), approximate date, author handle

### Step 3: Scrape Hashtag Pages

For each #hashtag in ig_sources.md:

1. Navigate to `https://www.instagram.com/explore/tags/{hashtag}/`
2. Wait 3 seconds
3. `get_page_text` — extract visible post previews
4. **If the page shows "login required" or redirects:** mark as BLOCKED, skip. Note in report.
5. Scroll down once: `scroll down 5 ticks` -> wait 1s
6. `get_page_text` — capture additional posts
7. Extract: caption text, author handle, location (if visible), approximate date, hashtags

**Note:** Hashtag pages show top + recent posts. Focus on recent posts.

### Step 4: Classify Each Post — Four Output Paths

For every extracted post (from both accounts and hashtags), answer the classification questions IN ORDER.

**Skip the post entirely if:**
- Post date is older than 30 days
- Caption text is empty with no useful metadata
- Post is clearly self-promotional spam (pure ad copy with no intel value)

**For each remaining post:**

**Q1: Is this about a specific person or organization?**

- **NO** -> evaluate as **Factlet** candidate (Step 5A)
- **YES** -> continue to Q2

**Q2: Is this person/org already in the DB?**

```
mcp__precrime-mcp__search_clients({ search: "{name or org}", limit: 1 })
```

- **YES (match found)** -> **Dossier** update (Step 5B)
- **NO** -> continue to Q3

**Q3: Does this post contain booking details AND is `leadCaptureEnabled` true?**

Check `leadCaptureEnabled` from config (Step 0). If false -> skip. Log: `LEAD_CAPTURE_OFF -- [name/org]`

If enabled, check for ALL THREE:
- **Trade** — what service is needed? (maps to a Leedz trade name)
- **Date** — when is the event?
- **Location or zip** — where?

- **YES (all three present)** -> **Lead Capture HOT** (Step 5D)
- **NO (missing any)** -> **Lead Capture THIN** (Step 5C)

### Step 5A: Factlet Path

Apply the three-question relevance filter:

**Q1: Relevant to selling [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]?**
(Use product name and audience from DOCS/VALUE_PROP.md)

RELEVANT: (See "Relevance Signals -- Relevant" section in DOCS/VALUE_PROP.md)
NOT RELEVANT: (See "Relevance Signals -- Not Relevant" section in DOCS/VALUE_PROP.md)

**Q2: Broadly applicable to multiple clients?**

Industry-wide trends, policy changes, market shifts, sector news -> YES.
One account's self-promotion, one org's internal event -> NO.

**Q3: Recent enough to matter?**

- Posted within 7 days: strong candidate
- 7-30 days: include if major trend
- 30+ days: skip

If all three pass:

```
mcp__precrime-mcp__create_factlet({
  content: "[2-3 sentences. What. Why it matters for the target decision-makers. Implication.]",
  source: "instagram:@{account_handle}"
})
```

Rules: 2-3 sentences. No opinions. No mention of the product.
One factlet per distinct topic, not one per post. If two posts cover the same news, write one factlet.

### Step 5B: Dossier Path

This post is about an existing client. Append to their dossier:

```
mcp__precrime-mcp__update_client({
  id: "{clientId}",
  dossier: "{existing dossier}\n[{today}] Instagram @{post.author}: {finding}"
})
```

### Step 5C: Lead Capture THIN

New potential client, no concrete booking details.

```
mcp__precrime-mcp__create_client({
  company: "{name or org}",
  dossier: "[{today}] Discovered via Instagram @{source_account}: {summary}",
  segment: "ig_lead"
})
```

### Step 5D: Lead Capture HOT

New client WITH booking details: trade + date + location all present.

```
mcp__precrime-mcp__create_client({
  company: "{name or org}",
  dossier: "[{today}] Discovered via Instagram @{source_account}: {summary}",
  segment: "ig_lead"
})
```

Then immediately:

```
mcp__precrime-mcp__create_booking({
  clientId: "{new client id}",
  trade: "{matched trade}",
  startDate: "{ISO date}",
  location: "{location}",
  zip: "{zip if known}",
  source: "instagram:@{source_account}",
  sourceUrl: "https://www.instagram.com/p/{shortcode}/",
  status: "leed_ready",
  notes: "{relevant quote from caption}"
})
```

Run Booking Completeness Check after creation.

### Step 6: Report

After processing all accounts and hashtags:

```
Instagram Harvest Report -- {date}
====================================
Accounts in source file:  N
Hashtags in source file:  N

Activity screen:
  Active accounts:        N
  Stale (60+ days):       N (list handles)
  Private/404:            N (list handles)
  Blocked (login req):    N (list handles/tags)

Gemini pre-filter: N active -> M selected (or "Gemini not available -- all active accounts evaluated")

Posts evaluated:          N

Output path breakdown:
  Factlets created:       N (with summaries)
  Dossier updates:        N (client name + finding)
  Lead Capture thin:      N (name + summary)
  Lead Capture hot:       N (with booking details)
  Duplicates skipped:     N
  Irrelevant skipped:     N
  Too old skipped:        N
  Empty/spam skipped:     N
```

## Performance Targets

- Activity screen: ~5 seconds/account (IG renders slower than FB)
- Deep scrape: ~10 seconds/account
- Hashtag page: ~8 seconds/tag
- Expected factlet yield: 2-5 per full run

## Rules

- Reuse the same Chrome tab for every page, do NOT create new tabs
- Do NOT scrape accounts or hashtags not in ig_sources.md
- Do NOT create factlets for single-org events (dossier material)
- Do NOT run without Chrome connected
- Do NOT interact with Instagram (no likes, follows, comments, DMs)
- Do NOT follow external links in captions, evaluate caption text + metadata only
- Do NOT scrape private accounts, stories, or reels audio
- If a page shows "login required", skip it. Never attempt to authenticate.
- Source field format: `"instagram:@{handle}"` or `"instagram:#{hashtag}"`

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER
     ================================
     This skill is identical in structure across all deployments.
     The only thing that changes is:

     1. ig_sources.md -- the list of Instagram accounts and hashtags to scrape.
        Populate this with:
        - Industry association accounts
        - Trade publication accounts
        - Competitor accounts (market intelligence)
        - Community hub accounts where your buyers congregate
        - Hashtags your buyers use for events/buying signals

     2. The relevance criteria (Q1) -- already substituted from your manifest.
        Make sure they match your relevance-judge.md criteria.

     3. The STALE threshold (60 days) -- adjust if your audience posts less frequently.

     CHROME REQUIREMENT: This skill requires the Claude-in-Chrome MCP extension.
     The extension connects automatically if it is running in the browser.
     No special claude launch flags are needed.

     INSTAGRAM RATE LIMITS: Instagram may throttle or block repeated scraping.
     Space runs 6+ hours apart. If you consistently get blocked, reduce the number
     of hashtags (they trigger blocks more than profile pages).
-->
