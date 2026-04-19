---
name: {{DEPLOYMENT_NAME}}-fb-factlet-harvester
description: Scrape curated Facebook pages for relevant news and create factlets
triggers:
  - harvest facebook factlets
  - scrape facebook for factlets
  - run the fb harvester
  - check facebook for news
---

# {{DEPLOYMENT_NAME}} — Facebook Factlet Harvester

You scrape curated Facebook pages for broadly applicable news relevant to selling the product (per `DOCS/VALUE_PROP.md`) and create factlets for the broadcast queue.

**Before running: read `DOCS/VALUE_PROP.md`** for product name, audience, and relevance signals.

**Detect mode before running (Step 0).** Chrome is preferred; headless (WebSearch) is the automatic fallback. Do NOT stop if Chrome is unavailable.

## Source File

`skills/fb-factlet-harvester/fb_sources.md`

Only scrape URLs listed in that file. Never add new pages mid-run.

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__Claude_in_Chrome__tabs_context_mcp` | Verify Chrome is connected (call ONCE) |
| `mcp__Claude_in_Chrome__navigate` | Navigate to each FB page |
| `mcp__Claude_in_Chrome__computer` | Wait, scroll |
| `mcp__Claude_in_Chrome__get_page_text` | Extract post text |
| `mcp__precrime-mcp__create_factlet` | Save qualifying posts |
| `mcp__precrime-mcp__get_new_factlets` | Check existing queue (dedup) |

## Procedure

### Step 0: Pre-flight

1. **Detect mode:** if `mcp__Claude_in_Chrome__tabs_context_mcp` is in your available tools, call `tabs_context_mcp({ createIfEmpty: false })`. If the tool is missing or the call fails → **HEADLESS mode** automatically. Do NOT stop. Do NOT mention Chrome to the user. Proceed.
2. Read `fb_sources.md`. Parse all URLs (skip lines starting with `#` or blank).
3. `get_new_factlets({ since: "1970-01-01T00:00:00Z" })` — load full queue for dedup.

**If HEADLESS:** skip Steps 0.5, 1, 1.5, 2 below. Go directly to Step 0H.

### Step 0H: Headless Harvesting (no Chrome)

For each URL in fb_sources.md, extract the page name from the URL (e.g. `facebook.com/SomeGroup` → "SomeGroup"). Then:

```
WebSearch("[page name] facebook recent posts 2026")
WebSearch("[page name] facebook event news 2026")
```

Evaluate any snippets returned against the same relevance criteria in Steps 3–4. Create factlets for qualifying findings. Skip Steps 0.5–2 entirely. Jump to Step 5 (report) when done.

### Step 0.5: Discover AI Assistant

Scan open tabs for `gemini.google.com` or `grok.com`. Store as `SESSION_AI = { gemini: <tabId> | null, grok: <tabId> | null }`. Chrome is already connected (required above) — this is just a tab scan, no extra overhead. If neither found, set `SESSION_AI = null`; Gemini steps below will be skipped.

### Step 1: Activity Screen (fast pass)

Before deep-scraping any page, do a quick activity check:

1. Navigate to the page
2. Wait 2 seconds
3. `get_page_text` — scan for the most recent post date
4. **If most recent post is older than 60 days:** mark as STALE, skip. Note it in the report.
5. **If the page has recent posts:** proceed to Step 2.

This prevents wasting tokens on dead pages. Move fast — ~3 seconds per page.

### Step 1.5: Bulk Relevance Pre-filter via Gemini (if SESSION_AI available)

**Skip to Step 2 if SESSION_AI is null.**

After the activity screen, you have a list of active (non-stale) pages plus a short text sample from each. Use Gemini to filter before spending Chrome cost on deep scrapes.

1. Compile a numbered list of active pages: `[N] [page URL] — [first 50 words of activity-screen text]`
2. Navigate to Gemini tab and paste:
   > "We sell [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]. From this numbered list of Facebook pages, return ONLY the numbers of pages likely to contain relevant buying signals, industry trends, or pain points for this audience. Comma-separated numbers only, no explanation."
   (Fill [PRODUCT_NAME] and [AUDIENCE_DESCRIPTION] from DOCS/VALUE_PROP.md)
3. Wait 5 seconds. Read response via `get_page_text`.
4. Parse the comma-separated list. Only run Step 2 deep scrape on those pages. Mark the rest as `GEMINI_FILTERED` in the report.
5. Log: `Gemini pre-filter: [N active pages] → [M selected for deep scrape]`

### Step 2: Deep Scrape (Gemini-selected pages only)

1. Scroll down twice: `scroll down 5 ticks` → wait 1s → `scroll down 5 ticks`
2. `get_page_text` — capture full visible post feed

### Step 3: Evaluate Posts

For each post, apply the same three questions as the RSS harvester:

**Q1: Is this relevant to selling [PRODUCT_NAME] to [AUDIENCE_DESCRIPTION]?**
(Use product name and audience from DOCS/VALUE_PROP.md)

RELEVANT:
(See "Relevance Signals — Relevant" section in DOCS/VALUE_PROP.md)

NOT RELEVANT:
(See "Relevance Signals — Not Relevant" section in DOCS/VALUE_PROP.md)

**Q2: Is this broadly applicable — or specific to one org/person?**

BROAD → create factlet. Affects multiple orgs in the audience. Proceed to Q3.

SPECIFIC to one org/person → four-path classification:
- Already in DB? `search_clients({ company: "[name]", limit: 1 })` → YES: append to dossier, no factlet. NO: continue.
- Has trade + date + location/zip AND `leadCaptureEnabled`? → Lead HOT: `create_client` + `create_booking(status:"leed_ready")`, run Booking Completeness Check.
- Missing booking details AND `leadCaptureEnabled`? → Lead THIN: `create_client` only, dossier note.
- `leadCaptureEnabled = false`? → skip. Log: `LEAD_CAPTURE_OFF — [name/org]`

**Q3: Is this post-2023?**

Recency is a bonus, not a gate. Only skip if pre-2023 AND superseded by newer data.

### Step 4: Create Factlets

```
mcp__precrime-mcp__create_factlet({
  content: "[2-3 sentences. What. Why it matters for the target decision-makers. Implication.]",
  source: "[Facebook page URL]"
})
```

Rules: same as RSS harvester. 2-3 sentences. No opinions. No mention of the product.
One factlet per distinct news item — not one per post.

### Step 5: Report

- Total pages in source file
- Pages screened as STALE (with URLs — recommend removal from fb_sources.md)
- Pages active (passed activity screen)
- Gemini pre-filter: N active → M selected (or "Gemini not available — all active pages deep-scraped")
- Pages deep-scraped
- Posts evaluated
- Factlets created (with summaries)
- Duplicates skipped
- Gemini-filtered skipped: N

## Performance Targets

- Activity screen: ~3 seconds/page
- Deep scrape: ~8 seconds/page
- Expected factlet yield: 2–5 per full run

## Rules

- Reuse the same Chrome tab for every page — do NOT create new tabs
- Do NOT scrape pages not in fb_sources.md
- Do NOT create factlets for single-org events (dossier material)
- In headless mode use WebSearch only — do NOT attempt Chrome tools
- Do NOT interact with the page (no likes, comments, shares)
- Do NOT follow links to external articles — evaluate post text only

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER
     ================================
     This skill is identical in structure across all deployments.
     The only thing that changes is:

     1. fb_sources.md — the list of Facebook pages to scrape.
        Populate this with:
        - Industry association pages
        - News organization pages
        - Competitor pages (for market intelligence)
        - Community pages where your buyers congregate
        - Any public page that frequently posts content relevant to your audience

     2. The relevance criteria above (Q1) — already substituted from your manifest.
        Make sure they match your relevance-judge.md criteria.

     3. The STALE threshold (60 days) — adjust if your audience posts less frequently.
        Religious orgs and small associations may post monthly; raise to 90 days.
        News organizations post daily; could tighten to 30 days.

     CHROME REQUIREMENT: This skill requires the Claude-in-Chrome MCP extension.
     The extension connects automatically if it is running in the browser.
     No special claude launch flags are needed.
-->
