# SEEDING_TODO.md — Client Seeding Skill Implementation Plan

**Date:** 2026-04-09
**Author:** Claude (session with Scott)
**Target:** `PRECRIME/templates/skills/client-seeder.md`

---

## What This Skill Does

Given a set of discovered source URLs (directories, exhibitor lists, event calendars, venue pages, association member lists) and optionally an existing database of clients, this skill scrapes those sources for contacts — names, companies, websites, emails — and creates thin client records in the database. The enrichment pipeline then fills them out.

**This is a scraping skill.** It visits web pages, finds people and organizations, extracts contact info, and writes it to the database. It digs for real contacts (not info@). It follows links to find more contacts. It does this every time it runs, building on what's already in the DB.

**Growth is intrinsic:** The database may already contain clients from previous runs. That's normal. The skill deduplicates by company name and email, never creates duplicates, and focuses on finding NEW contacts each run. It also discovers new source URLs as it scrapes (a directory page links to another directory → follow it, scrape it, add it to the source list).

---

## Context for the Coding Agent

### Project Structure

```
PRECRIME/
├── server/
│   ├── mcp/mcp_server.js             ← 19 MCP tools (SQLite via Prisma)
│   └── prisma/schema.prisma          ← Client, Booking, Factlet, ClientFactlet, Config
├── templates/
│   ├── skills/
│   │   ├── source-discovery/
│   │   │   └── discovered_directories.md  ← directory URLs found by source-discovery skill
│   │   ├── fb-factlet-harvester/
│   │   │   └── fb_sources.md          ← FB page URLs
│   │   ├── enrichment-agent.md        ← reference for four-path classifier pattern
│   │   ├── client-seeder.md           ← ** YOU ARE BUILDING THIS **
│   │   └── ...
│   ├── docs/
│   │   └── VALUE_PROP.md             ← product identity
│   ├── reddit/
│   │   └── reddit_config.json
│   └── rss/
│       └── rss-scorer-mcp/
│           └── rss_config.json
```

### Database Schema (relevant fields)

**Client:**
```
id             String    @id @default(cuid())
name           String
email          String?   @unique
phone          String?
company        String?
website        String?
clientNotes    String?
segment        String?
dossier        String?
targetUrls     String?   // JSON: [{url, type, label}]
draft          String?
draftStatus    String?   // "brewing" | "ready" | "sent"
dossierScore   Int?      // computed by score_client
contactGate    Boolean   @default(false)
intelScore     Int?
warmthScore    Float?    // deprecated
lastEnriched   DateTime?
lastQueueCheck DateTime?
source         String?   // HOW this client entered the DB
```

**Booking:**
```
id, clientId, title, description, location, startDate, endDate, startTime, endTime
trade, zip, status ("new" | "leed_ready" | ...), source, sourceUrl
```

### MCP Tools Available

| Tool | Purpose |
|------|---------|
| `mcp__leedz-mcp__search_clients` | Check if a client already exists (dedup by company/email). Use `summary: true`. |
| `mcp__leedz-mcp__create_client` | Create a new client. Requires at least name or company. Defaults draftStatus to "brewing". Set `source` field. Returns client with ID. |
| `mcp__leedz-mcp__update_client` | Update an existing client with new info found during seeding |
| `mcp__leedz-mcp__get_config` | Read defaultTrade, leadCaptureEnabled, geography |
| `mcp__leedz-mcp__get_stats` | Pipeline health check |
| `mcp__leedz-mcp__score_client` | Score a client after creating/updating |
| `mcp__leedz-mcp__link_factlet` | Link a factlet to a client |
| `mcp__leedz-mcp__create_factlet` | Save broadly applicable intel |
| `WebSearch` | Search the web |
| `WebFetch` | Scrape a URL for content |
| `Read` | Read local files |
| `Edit` | Append to local files |

**Client creation tool:** `mcp__leedz-mcp__create_client` — requires at least `name` or `company`. Defaults `draftStatus` to `"brewing"`. Always set the `source` field (e.g., `"seeder:directory"`, `"seeder:exhibitor_list"`). Returns the created client with its ID.

If Chrome MCP is available:
| `mcp__Claude_in_Chrome__*` | Browser automation for scraping pages that block WebFetch |

### Four-Path Classifier (MUST USE)

This pattern is used by ALL harvesters and MUST be used by the seeder. When you encounter information about a person or organization:

```
1. Is it already in the DB?
   search_clients({ company: "name", summary: true, limit: 1 })
   YES → DOSSIER UPDATE: update_client(dossier += new finding)
   NO → continue to step 2

2. Does it have booking details? (trade + date + location)
   ALL THREE present → LEAD HOT:
     Create client + create_booking(status: "leed_ready")
   NOT ALL THREE → LEAD THIN:
     Create client only (draftStatus: "brewing")

3. Is leadCaptureEnabled? (from get_config)
   YES → execute the create from step 2
   NO → log it but don't create records
```

---

## Implementation Plan

### Step 0: Read Context

1. Read `DOCS/VALUE_PROP.md` — target audience, geography, trade, pain points
2. Call `get_config()` — defaultTrade, leadCaptureEnabled, companyName
3. Call `get_stats()` — how many clients exist? Cold start or expansion?
4. Read `skills/source-discovery/discovered_directories.md` — directory URLs to scrape
5. Read all source config files — for additional URLs to scan
6. If interactive mode: ask user "Do you have a list of potential clients or URLs to scrape?" Accept CSV, text list, or URLs.

### Step 1: Build Scrape Queue

Compile a prioritized list of URLs to scrape for contacts:

**Priority order:**
1. User-provided URLs (if interactive mode and user gave some)
2. `discovered_directories.md` entries not yet scraped (check against a scraped marker — see Step 7)
3. High-value source URLs from configs: convention/event listing sites, trade association pages
4. WebSearch for new directory-type sources: `"[trade] vendors" "[geography]" directory OR list`

**Each entry in the queue:**
```
{ url, type, priority, estimated_clients, last_scraped }
```

### Step 2: Scrape Each Source for Contacts

For each URL in the scrape queue:

**2a. Fetch the page:**
- `WebFetch(url)` first
- If WebFetch fails (JS-heavy, 403, timeout) and Chrome is available → use Chrome MCP
- If both fail → log `SCRAPE_FAILED`, skip to next URL

**2b. Extract contacts from the page content:**

Look for:
- **Names** — person names (not company names alone)
- **Companies/organizations** — the entity the person belongs to
- **Emails** — REAL emails, not info@/contact@/admin@ generic inboxes
- **Websites** — company or personal websites
- **Phone numbers** — if visible
- **Roles/titles** — decision-maker indicators (owner, manager, director, coordinator)

**What counts as a valid contact:**
- Has at least a name OR a company name
- Bonus: has a non-generic email (dramatically increases value — see scoring system)
- Bonus: has a website (enables enrichment pipeline to discover more)

**What to SKIP:**
- Entries with only a generic inbox and no name (info@ with no person = useless)
- Entries clearly outside the target geography (per VALUE_PROP.md)
- Entries in an unrelated trade/industry

**2c. For each extracted contact, run the four-path classifier:**

```
search_clients({ company: "[company]", summary: true, limit: 1 })
  OR
search_clients({ email: "[email]", summary: true, limit: 1 })
```

- **Already exists** → update their dossier with any new info found. Update website/email/phone if we found better data.
- **New client, has booking details** → LEAD HOT. Create client + booking.
- **New client, no booking details** → LEAD THIN. Create client with:
  ```
  name, company, email (if found), website (if found), phone (if found)
  draftStatus: "brewing"
  source: "seeder:[source_url_type]"  (e.g., "seeder:directory", "seeder:exhibitor_list")
  segment: [derive from VALUE_PROP target audience]
  ```

**2d. Score the client immediately after creation:**
```
mcp__leedz-mcp__score_client({ clientId, intelScore: 0 })
```
intelScore is 0 because the seeder hasn't scraped the client's OWN sources yet — that's the enrichment pipeline's job. But score_client will compute contactGate (does this client have a real email?) which is immediately useful.

### Step 3: Deep Contact Extraction (Dig for Emails)

For high-value contacts (has a name + company but no direct email), make ONE attempt to find the email before moving on:

1. `WebSearch("[firstname] [lastname] [company] email")`
2. `WebSearch("[firstname.lastname]@[domain]")` (if website domain is known)
3. `WebFetch("[company website]/about")` or `/team` or `/staff` or `/contact`

If found → update the client record with the email. If not → leave it for the enrichment pipeline's Step 3.5 (Email Verification) to handle later.

**Do NOT spend more than 30 seconds per contact on email hunting.** The enrichment pipeline does this more thoroughly. The seeder's job is volume.

### Step 4: Follow Links (Source Growth)

While scraping any page, watch for links to OTHER relevant sources:
- A trade association page linking to member organizations → each member is a potential client AND the member list URL is a new source
- A convention page linking to partner events → more convention pages to scrape
- A directory linking to category sub-pages → scrape those too
- An exhibitor linking to their own vendor page → follow it for contact details

**For new source URLs:**
1. Classify: is this a directory/listing (add to `discovered_directories.md`) or a single-entity page (scrape it now for the one contact)?
2. If directory: append to `discovered_directories.md` for the next run
3. If single entity: scrape it now, extract contact, run four-path classifier

**For new FB pages discovered:** Append to `fb_sources.md` (so the FB harvester picks them up)
**For new subreddits discovered:** Append to `reddit_config.json`

### Step 5: Create Factlets from Seeding

While scraping, the skill will encounter broadly applicable intelligence:
- Industry statistics mentioned on directory pages
- Trends mentioned in trade association content
- Policy changes, new regulations, market data

Capture these as factlets:
```
mcp__leedz-mcp__create_factlet({ content: "...", source: "URL" })
```

Then link relevant factlets to the clients being created:
```
mcp__leedz-mcp__link_factlet({ clientId, factletId, signalType: "context" })
```

### Step 6: Booking Detection

If any scraped content contains clear booking details — someone requesting a specific service at a specific time and place:

**Check for all three:** trade (matches defaultTrade or a known Leedz trade), date/time, location/zip.

If all three present:
```
Create client (if new) + create booking:
  trade: [detected or defaultTrade]
  startDate: [extracted date]
  location: [extracted location]
  zip: [extracted or geocoded zip]
  source: "seeder:[source_type]"
  sourceUrl: "[URL where found]"
  status: "leed_ready"  (auto-set by create_booking if trade+date+location present)
```

This is a HOT LEAD. It goes straight to the share pipeline.

### Step 7: Mark Scraped Sources

After scraping a directory URL from `discovered_directories.md`, mark it as scraped so subsequent runs don't re-scrape the same page unnecessarily:

Edit the entry in `discovered_directories.md`:
```
# BEFORE:
https://example.com/vendors | trade_directory | ~50 | 2026-04-09

# AFTER:
https://example.com/vendors | trade_directory | ~50 | 2026-04-09 | scraped:2026-04-10 | clients:12
```

**BUT:** Some sources should be RE-SCRAPED periodically (convention exhibitor lists change yearly, directories add new members). The skill should re-scrape any source older than 30 days since last scrape.

### Step 8: Run Log

Write a summary to `logs/SEEDING_LOG.md`:
```
## Client Seeding Run — [date]

### Context
- Mode: interactive | headless
- Existing clients: [N]
- Sources in queue: [N]
- leadCaptureEnabled: true | false

### Results
- Sources scraped: [N] of [M] in queue
- New clients created: [N]
- Existing clients updated: [N]
- Hot leads (with bookings): [N]
- Emails found: [N direct] / [M generic] / [K none]
- New source URLs discovered: [N] (added to discovered_directories.md)
- Factlets created: [N]

### Clients Created
| Name | Company | Email | Source | contactGate |
|------|---------|-------|--------|-------------|
| ... | ... | ... | ... | PASS/FAIL |

### Sources Scraped
| URL | Type | Contacts Found | New Clients | Status |
|-----|------|---------------|-------------|--------|
| ... | ... | N | M | success/partial/failed |

### Sources Added to Pool
[list new URLs discovered during scraping]
```

---

## Parameterization — The -p Prompt

**Headless:**
```
claude -p --dangerously-skip-permissions "run client seeding"
```
- No user interaction. Read discovered_directories.md + config. Scrape. Create clients. Log.
- Growth: follow links, discover new sources, scrape new contacts.

**Interactive:**
```
User types: "seed clients" or "find new clients"
```
- At Step 0, ask: "Do you have a list of potential clients or URLs to scrape?" Accept whatever format they give.
- During scraping, if a page requires login or has CAPTCHA → tell the user, ask them to handle it, continue with the result.
- Otherwise, run autonomously.

**With specific targets:**
```
claude -p "seed clients from https://example.com/exhibitors"
```
- Parse the URL from the prompt, add it to the scrape queue as priority 1, run normally.

---

## Skill File Structure

Create: `templates/skills/client-seeder.md`

Follow existing skill format:
```
---
name: {{DEPLOYMENT_NAME}}-client-seeder
description: Scrape source URLs for contacts, create thin client records, follow links for more sources
triggers:
  - run client seeding
  - seed clients
  - find new clients
  - scrape for clients
---
```

---

## Files to Create

1. `templates/skills/client-seeder.md` — the skill itself

## Files to Edit (append only)

1. `skills/source-discovery/discovered_directories.md` — mark scraped, add newly discovered directories
2. `skills/fb-factlet-harvester/fb_sources.md` — append FB pages discovered during scraping
3. `reddit/reddit_config.json` — append subreddits discovered during scraping
4. `rss/rss-scorer-mcp/rss_config.json` — append feeds discovered during scraping
5. `logs/SEEDING_LOG.md` — run log (create if not exists, append each run)

## Files to Read (not edit)

1. `templates/docs/VALUE_PROP.md`
2. `templates/docs/CLAUDE.md`
3. All source config files
4. `server/mcp/mcp_server.js` — MUST read to find correct client creation pattern

---

## Testing Checklist

- [ ] Cold start: empty DB, discovered_directories.md has 5 URLs → skill scrapes all 5, creates clients
- [ ] Expansion: DB has 40 clients, directories have 10 URLs → skill creates only NEW clients, updates existing
- [ ] Dedup: same URL scraped twice → no duplicate clients created (check by company + email)
- [ ] Hot lead: scrape finds booking with trade+date+location → client + booking created, status = leed_ready
- [ ] Email digging: contact has name+company but no email → skill attempts 2-3 searches before giving up
- [ ] Source growth: scraping a directory finds links to 3 more directories → added to discovered_directories.md
- [ ] FB source growth: scraping finds relevant FB page → appended to fb_sources.md
- [ ] Factlet creation: broadly applicable intel found → factlet created and linked
- [ ] Scraped marking: directory marked as scraped in discovered_directories.md with date + client count
- [ ] Re-scrape: directory scraped 31+ days ago → re-scraped
- [ ] Headless: runs with -p flag, no user interaction
- [ ] Interactive: asks for starter URLs, accepts input, proceeds
- [ ] Score: every created client gets score_client called with intelScore=0
- [ ] Log: SEEDING_LOG.md written with full run summary

---

## Critical Rules

1. **Read VALUE_PROP.md FIRST.** Know your audience before scraping.
2. **Dedup by company AND email.** `search_clients({ company: "..." })` before every create.
3. **Use the four-path classifier.** Every contact goes through: exists? → booking details? → leadCaptureEnabled? Same pattern as all other harvesters.
4. **Don't spend too long per contact.** 30 seconds max on email hunting. Volume over depth. Enrichment does depth.
5. **Follow links.** Every page scraped is an opportunity to discover more sources. Watch for directory links, member lists, related organizations.
6. **Append, never overwrite.** Source config files grow. They never shrink.
7. **No architectural changes.** Do not modify the MCP server, schema, or existing skills. You are creating ONE new skill file.
8. **Use `create_client` to create new clients.** Tool: `mcp__leedz-mcp__create_client({ name, company, email, website, source, segment, draftStatus })`. Requires at least name or company.
9. **Set `source` field on every client.** Format: `seeder:[type]` (e.g., `seeder:directory`, `seeder:exhibitor_list`, `seeder:association`). This lets us track where clients came from.
10. **Score immediately.** Call `score_client` right after creating a client. Even with intelScore=0, it computes contactGate which tells us if we got a real email.
