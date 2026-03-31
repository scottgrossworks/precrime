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

You scrape curated Facebook pages for broadly applicable news relevant to selling **{{PRODUCT_NAME}}** and create factlets for the broadcast queue.

**This skill REQUIRES Chrome.** If Chrome is not connected, STOP immediately and tell the user.

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
| `mcp__leedz-mcp__create_factlet` | Save qualifying posts |
| `mcp__leedz-mcp__get_new_factlets` | Check existing queue (dedup) |

## Procedure

### Step 0: Pre-flight

1. `tabs_context_mcp({ createIfEmpty: true })` — if this fails, STOP.
2. Read `fb_sources.md`. Parse all URLs (skip lines starting with `#` or blank).
3. `get_new_factlets({ since: "1970-01-01T00:00:00Z" })` — load full queue for dedup.

### Step 1: Activity Screen (fast pass)

Before deep-scraping any page, do a quick activity check:

1. Navigate to the page
2. Wait 2 seconds
3. `get_page_text` — scan for the most recent post date
4. **If most recent post is older than 60 days:** mark as STALE, skip. Note it in the report.
5. **If the page has recent posts:** proceed to Step 2.

This prevents wasting tokens on dead pages. Move fast — ~3 seconds per page.

### Step 2: Deep Scrape (active pages only)

1. Scroll down twice: `scroll down 5 ticks` → wait 1s → `scroll down 5 ticks`
2. `get_page_text` — capture full visible post feed

### Step 3: Evaluate Posts

For each post, apply the same three questions as the RSS harvester:

**Q1: Is this relevant to selling {{PRODUCT_NAME}} to {{AUDIENCE_DESCRIPTION}}?**

RELEVANT:
{{RELEVANT_SIGNALS_HIGH}}
{{RELEVANT_SIGNALS_MEDIUM}}

NOT RELEVANT:
{{NOT_RELEVANT_TOPICS}}

**Q2: Is this broadly applicable (factlet) or specific to one client (dossier)?**

BROAD → create factlet. Affects multiple orgs in the audience.
SPECIFIC → skip here. Belongs in that org's dossier during enrichment.

**Q3: Is this post-2023?**

Recency is a bonus, not a gate. Only skip if pre-2023 AND superseded by newer data.

### Step 4: Create Factlets

```
mcp__leedz-mcp__create_factlet({
  content: "[2-3 sentences. What. Why it matters for {{TARGET_ROLES}}. Implication.]",
  source: "[Facebook page URL]"
})
```

Rules: same as RSS harvester. 2-3 sentences. No opinions. No mention of {{PRODUCT_NAME}}.
One factlet per distinct news item — not one per post.

### Step 5: Report

- Total pages in source file
- Pages screened as STALE (with URLs — recommend removal from fb_sources.md)
- Pages scraped (active)
- Posts evaluated
- Factlets created (with summaries)
- Duplicates skipped

## Performance Targets

- Activity screen: ~3 seconds/page
- Deep scrape: ~8 seconds/page
- Expected factlet yield: 2–5 per full run

## Rules

- Reuse the same Chrome tab for every page — do NOT create new tabs
- Do NOT scrape pages not in fb_sources.md
- Do NOT create factlets for single-org events (dossier material)
- Do NOT run without Chrome connected
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

     CHROME REQUIREMENT: This skill requires the Claude Code desktop app with the
     Claude-in-Chrome MCP extension. It will not work from the standalone CLI.
     See DOCS/STATUS.md for the Chrome bridge limitation note.
-->
