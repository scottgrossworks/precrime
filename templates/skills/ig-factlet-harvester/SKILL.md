---
name: {{DEPLOYMENT_NAME}}-ig-factlet-harvester
description: Scrape Instagram profiles and hashtags for relevant posts, create factlets.
triggers:
  - harvest instagram
  - scrape ig
  - check instagram
---

# Instagram Factlet Harvester

Scrape curated Instagram accounts and hashtags for relevant posts and create factlets.

---

## Procedure

### Step 0: Pre-flight

1. **Use latched mode.** The caller already selected interactive or headless. Do not run a separate mode probe.
   - Interactive (Chrome) -> scrape via Chrome navigate + get_page_text.
   - Headless -> skip this harvester. Log `IG_SKIPPED_HEADLESS`. Instagram requires a browser session.
2. Open a session:
   ```
   precrime__pipeline({ action: "start_session", workflow: "ig-factlet-harvester", target_count: 25 })
   ```
   Hold the returned `session_id` as `sid`.
3. Iterate IG sources from the DB via:
   ```
   precrime__pipeline({ action: "next_source", channel: "ig", maxAgeDays: 0, session_id: sid })
   ```
   Each returned row has `subtype: "account"` or `subtype: "hashtag"` -- branch on subtype for the scrape pattern. Loop until `QUEUE_EMPTY`. Pair every `next_source` with `mark_source` before the next claim. Do NOT read `ig_sources.md` -- it's a seed file, imported once at first deploy.
4. Load existing factlets for dedup.

### Step 1: Scrape

**Accounts:** Navigate to `instagram.com/[handle]`, scroll, extract recent post captions.
**Hashtags:** Navigate to `instagram.com/explore/tags/[tag]`, extract top post captions.

For each post:
- **Relevant?** Per VALUE_PROP config. Skip if not.
- **Broad or specific?** BROAD -> factlet. SPECIFIC -> `skills/shared/classify-contact.md`.
- **Duplicate?** Skip if existing factlet covers it.

### Step 2: Create Factlets

Follow `skills/shared/factlet-rules.md`.

### Step 3: Report

For every claimed IG source:

```
precrime__pipeline({
  action: "mark_source",
  url: "<ig source url>",
  clientsFound: <factlets created + leads captured>,
  failedReason: <only if browser/fetch failed or yielded nothing useful>
})
```

Then close:

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Report accounts scraped, hashtags checked, factlets created, leads captured, skipped, sources added.
