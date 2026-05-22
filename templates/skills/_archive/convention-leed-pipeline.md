---
name: convention-leed-pipeline
description: Find conventions/expos, scrape exhibitor lists, create exhibitor clients, build marketplace leedz.
triggers:
  - find convention leedz
  - convention pipeline
  - scrape exhibitors
  - find leedz
---

# Convention Leed Pipeline

Search for upcoming conventions, expos, and tournaments at major venues in the seller's geography. Scrape exhibitor lists. Create client records for exhibitors. Detect bookings.

---

## Setup

1. **Mode detection.** Read `skills/shared/mode-detect.md`.
2. **Hold VALUE_PROP config** -- geography determines which venues to search.
3. **Start session:** `precrime__pipeline({ action: "start_session", workflow: "convention-leeds" })`

---

## Step 1: Find Conventions

Search for upcoming events at major convention centers and venues in the configured geography.

Use Tavily for all searches. Do NOT ask the user for venue names or keywords.

Query pattern: `"[venue name] upcoming events [year]"` or `"[venue name] event calendar"`.

For each convention found, extract: event name, dates, venue, expected attendance, organizer, website.

---

## Step 2: Scrape Exhibitor Lists

For each convention with an exhibitor list URL:

1. Fetch the page (Chrome or Tavily).
2. Extract exhibitor entries: company name, booth number, contact person, email, website, trade/category.

---

## Step 3: Create Exhibitor Clients

For each exhibitor, run `skills/shared/classify-contact.md`:
- Dedup by `exactCompany` FIRST (mandatory).
- If new: create with `source: "convention:[event_name]"`, `segment: "[convention_type]"`.
- If exists: append convention participation to dossier.

---

## Step 4: Detect Bookings

Each convention IS a booking signal. The exhibitor has trade (their business) + date (convention dates) + location (venue).

Run `skills/shared/booking-detect.md` for each exhibitor where the trade matches a known Leedz trade.

---

## Step 5: Session Report

```
precrime__pipeline({ action: "report_session", session_id })
```

Echo the server's response verbatim. This is the ONLY sanctioned summary. Do not write your own counts.

---

## Rules

1. Dedup is mandatory before every create. Server also enforces as last resort.
2. Never invent exhibitor data. If the list doesn't have names, save company-only records.
3. Do not scrape exhibitor websites during this skill. That's the enrichment agent's job.
