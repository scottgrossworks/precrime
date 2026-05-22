---
name: {{DEPLOYMENT_NAME}}-x-factlet-harvester
description: Harvest X/Twitter posts via Grok for relevant intel, create factlets.
triggers:
  - harvest x
  - harvest twitter
  - check x
---

# X/Twitter Factlet Harvester

Harvest posts from curated X accounts, hashtags, and keywords. Uses Grok (via Chrome) as the primary search tool.

---

## Procedure

### Step 0: Pre-flight

1. **Use latched mode.** The caller already selected interactive or headless. Do not run a separate mode probe.
   - Interactive with Grok tab -> use Grok for searches, Chrome for X pages.
   - Headless -> use Tavily with `site:x.com` queries. Limited results but functional.
2. Open a session:
   ```
   precrime__pipeline({ action: "start_session", workflow: "x-factlet-harvester", target_count: 25 })
   ```
   Hold the returned `session_id` as `sid`.
3. Iterate X sources from the DB via:
   ```
   precrime__pipeline({ action: "next_source", channel: "x", maxAgeDays: 0, session_id: sid })
   ```
   Each row has `subtype: "account" | "hashtag" | "keyword"` -- branch on subtype. Loop until `QUEUE_EMPTY`. Pair every `next_source` with `mark_source` before the next claim. Do NOT read `x_sources.md` -- it's a seed file, imported once at first deploy.
4. Load existing factlets for dedup.

### Step 1: Search

**Accounts:** Ask Grok or search Tavily: `"from:[account] [VALUE_PROP keywords]"`.
**Hashtags:** Search `#[tag]` via Grok or Tavily.
**Keywords:** Search each keyword phrase.

### Step 2: Evaluate

For each post with substantive content:
- **Relevant?** Per VALUE_PROP config. Skip if not.
- **Broad or specific?** BROAD -> factlet. SPECIFIC -> `skills/shared/classify-contact.md`.
- **Booking signal?** Trade + date + location -> `skills/shared/booking-detect.md`.
- **Duplicate?** Skip.

### Step 3: Create Factlets

Follow `skills/shared/factlet-rules.md`.

### Step 4: Report

For every claimed X source:

```
precrime__pipeline({
  action: "mark_source",
  url: "<x source url>",
  clientsFound: <factlets created + leads captured>,
  failedReason: <only if search/fetch failed or yielded nothing useful>
})
```

Then close:

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Report accounts checked, hashtags searched, factlets created, leads captured, skipped, sources added.
