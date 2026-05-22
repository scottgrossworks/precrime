---
name: {{DEPLOYMENT_NAME}}-client-seeder
description: Scrape sources for contacts, create thin client records. Volume over depth.
triggers:
  - run client seeding
  - seed clients
  - find new clients
  - scrape for clients
---

# Client Seeder

You are the DISCOVER function from `DOCS/FOUNDATION.md`. Visit source URLs, extract contacts, create thin client records. The enrichment pipeline fills them out later.

**Volume over depth.** Find contacts and create records. Do NOT write dossiers, compose drafts, or do deep research.

**Growth is recursive.** A directory page linking to another directory is a new source. Follow it, record it, scrape it.

---

## Setup

1. **Use latched mode.** The caller already selected interactive or headless. If unset, default to interactive and do not run tree/session scans.
2. **Hold VALUE_PROP config** from the validated config object. Do not re-read VALUE_PROP.md.
3. **Read pipeline status.** `precrime__pipeline({ action: "status" })` -- check leadCaptureEnabled, defaultTrade, client count.
4. **Open a session.**
   ```
   precrime__pipeline({ action: "start_session", workflow: "client-seeder", target_count: 25 })
   ```
   Hold the returned `session_id` as `sid`. Pass it to every `next_source`, `save`, `mark_source`, and final `report_session`.
5. **Pop the next directory source from the DB** with:
   ```
   precrime__pipeline({ action: "next_source", channel: "directory", session_id: sid })
   ```
   - `CLAIMED` -> proceed to scrape.
   - `QUEUE_EMPTY` -> grow the queue: search Tavily for `"[defaultTrade] directory [geography]"` and `"[defaultTrade] vendors [geography]"`, then `precrime__pipeline({ action: "add_sources", entries: [...] })`. Re-call `next_source`. Do NOT ask the user. Do NOT stop.
   - In hybrid mode only, user-provided URLs are added via `add_sources` first (if any), then the loop runs normally.

---

## For Each Source URL

### Scrape

Interactive: Chrome `navigate` + `get_page_text`. Headless: `tavily__tavily_extract`.

### Extract Contacts

Look for: names, companies, emails, websites, phone numbers, roles/titles. Sparse records are allowed when relevant to VALUE_PROP: a company-only client is a valid seed if enrichment can later find the person/email. Do not save placeholders or navigation labels.

### Classify Each Contact

Read and follow `skills/shared/classify-contact.md` for every extracted contact. No exceptions.

Set `source: "seeder:[type]"` on every created client. Types: `directory`, `exhibitor_list`, `association`, `event_listing`, `venue_directory`, `user_provided`.

### Follow Links (Recursive Growth)

While scraping, watch for links to OTHER relevant sources:
- Directory -> member list -> each member is a client AND the list URL is a new source
- Convention -> partner events -> more pages to scrape
- Vendor profile -> their FB page / website / RSS feed -> a new source

Collect new sources into a list as you scrape, then issue ONE call per page:

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "<new directory url>", channel: "directory", category: "exhibitor_list", discoveredFrom: "<current url>" },
    { url: "https://facebook.com/<page>", channel: "fb", subtype: "page", discoveredFrom: "<current url>" },
    { url: "<blog url>", channel: "blog", discoveredFrom: "<current url>" }
  ]
})
```

Server dedups on URL and normalizes channel-specific shorthand. Do NOT echo to `_sources.md` files -- the queue lives in the Source table.

### Detect Bookings

If content contains trade + date + location -> read `skills/shared/booking-detect.md`.

### Capture Factlets

If content contains broadly applicable intel -> read `skills/shared/factlet-rules.md`.

---

## Email Hunting (30 seconds max per contact)

For high-value contacts missing a direct email, make ONE attempt:
- Search: `"[name] [company] email"` via SESSION_AI or Tavily
- Fetch `/about` or `/team` page on their website
- If found -> save. If not -> leave for enrichment pipeline.

---

## Mark Scraped Sources

After scraping a directory, release the claim and persist the result:
```
precrime__pipeline({
  action: "mark_source",
  url: "<the directory URL>",
  clientsFound: <count of contacts saved>,
  failedReason: <set ONLY if scrape failed; omit on success>
})
```

The server stamps `scrapedAt` and clears the claim. If you don't call this within 10 minutes of `next_source`, the row becomes claimable again -- another agent will re-scrape. Always pair every `next_source` with a `mark_source`.

## Close Session

When the seeder has no more directory source to process, or when the parent flow tells you to return:

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Echo the server report if running standalone. If called by `marketplace_flow.md`, return the counts to the parent flow.

---

## Run Log

Append to `logs/SEEDING_LOG.md`: sources scraped, clients created, emails found, sources discovered, failures.
