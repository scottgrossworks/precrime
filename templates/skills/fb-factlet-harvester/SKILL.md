---
name: {{DEPLOYMENT_NAME}}-fb-factlet-harvester
description: Scrape Facebook pages for relevant posts, create factlets.
triggers:
  - harvest facebook
  - scrape fb
  - check facebook
---

# Facebook Factlet Harvester

Scrape curated Facebook pages/groups for relevant posts and create factlets.

---

## Procedure

### Step 0: Pre-flight

1. **Use latched mode.** The caller already selected interactive or headless. Do not run a separate mode probe.
   - Interactive (Chrome available) -> scrape via Chrome navigate + get_page_text.
   - Headless -> skip this harvester. Log `FB_SKIPPED_HEADLESS`. Facebook requires a browser session.
2. Open a session:
   ```
   precrime__pipeline({ action: "start_session", workflow: "fb-factlet-harvester", target_count: 25 })
   ```
   Hold the returned `session_id` as `sid`.
3. Iterate FB sources from the DB via:
   ```
   precrime__pipeline({ action: "next_source", channel: "fb", maxAgeDays: 0, session_id: sid })
   ```
   `maxAgeDays: 0` makes every previously-scraped source eligible too -- harvesters revisit feeds for fresh content. Loop until `QUEUE_EMPTY`. Pair every `next_source` with `mark_source` (clientsFound: <factlets created from this page>) before the next claim. Do NOT read `fb_sources.md` -- it's a seed file, imported once at first deploy.
4. Load existing factlets for dedup: `precrime__find({ action: "factlets", filters: { sinceTimestamp: "<ISO timestamp for 30 days ago>" }, limit: 100 })`

### Step 1: Scrape Each Page

For each FB URL:
1. `navigate({ url, tabId })` -> wait 2s -> scroll down -> `get_page_text({ tabId })`
2. Extract recent posts (within 30 days).
3. For each post with substantive content (not just a photo or share with no text):
   - **Relevant** to VALUE_PROP config? If not: skip.
   - **Broadly applicable or specific?**
     - BROAD -> factlet candidate.
     - SPECIFIC -> run `skills/shared/classify-contact.md`.
   - **Duplicate?** Same topic as existing factlet -> skip.

### Step 2: Create Factlets

Follow `skills/shared/factlet-rules.md`.

### Step 3: Source Growth

If a scraped page links to other relevant FB pages/groups, add them to the Source table:

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "https://facebook.com/<page>", channel: "fb", subtype: "page", discoveredFrom: "<current page url>" },
    { url: "https://facebook.com/groups/<id>", channel: "fb", subtype: "group", discoveredFrom: "<current page url>" }
  ]
})
```

Server dedups on URL; do NOT touch `fb_sources.md`.

### Step 4: Report

For every claimed FB source:

```
precrime__pipeline({
  action: "mark_source",
  url: "<fb source url>",
  clientsFound: <factlets created + leads captured>,
  failedReason: <only if browser/fetch failed or yielded nothing useful>
})
```

Then close:

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Report pages scraped, posts processed, factlets created, leads captured, duplicates skipped, sources added.
