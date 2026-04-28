---
name: convention-leed-pipeline
description: Find conventions/expos/tournaments at major venues, scrape exhibitor lists, create exhibitor clients, build and share marketplace leedz
triggers:
  - find convention leedz
  - scrape exhibitors
  - convention pipeline
  - find exhibitors
  - expo pipeline
  - run convention pipeline
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->


*** FIXME FIMXE FIXME
*** determine location from VALUE_PROP.md
*** DO NOT hard-code convention centers
*** FIND the convention centers LOCAL to the user's service area
*** if location cannot be determined from VALUE_PROP, STOP and report an error


# Convention Leed Pipeline

You find upcoming events at major SoCal venues, scrape their exhibitor lists for real companies, create client records from those exhibitors, and build marketplace leedz. This is the primary leed generation workflow.

**The exhibitors are the clients. Not the event organizer.**

A company exhibiting at Anime Expo with a 20x20 booth has budget for a photo booth activation. The event organizer is secondary. The exhibitor is the customer.

---

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__claude-in-chrome__*` | Chrome browser tools for Gemini/Grok searches |
| `tavily__tavily_extract` | Scrape exhibitor list pages (headless) |
| `tavily__tavily_search` | Web search (headless) |
| `precrime__find` | action=clients to dedup, action=bookings to check existing |
| `precrime__pipeline` action=save (no id) | Create exhibitor client records |
| `precrime__pipeline` action=save (with id) | Update existing client, add bookings, add factlets, append dossier. Auto-scores on every save. |
| `precrime__trades` | Canonical Leedz marketplace trade names (cached 10 min) |
| `leedz__createLeed` | Post leed to marketplace |

---

## Mode Detection

Chrome MCP is a plugin, NOT part of the standard goose ship. On AWS / headless / standard installs the tool is not registered, and any call to `mcp__claude-in-chrome__*` returns -32002 not-found.

Detect mode by attempting the Chrome tool:

```
mcp__claude-in-chrome__tabs_context_mcp({ createIfEmpty: false })
```

- **If the tool is missing (-32002) or any call fails for any reason** -> **HEADLESS mode** automatically. Set `SESSION_AI = { gemini: null, grok: null }` and `HEADLESS = true`. Do NOT stop. Do NOT mention Chrome to the user. Do NOT attempt to install anything. Use `tavily__tavily_search` and `tavily__tavily_extract` for all web work.
- **If the call succeeds AND a tab with `gemini.google.com` is returned** -> **INTERACTIVE mode**. Use Gemini for searches. Record `SESSION_AI = { gemini: <tabId>, grok: <tabId> }`.
- **If the call succeeds but no Gemini tab is found** -> still HEADLESS. Tavily-only.

Wherever a step says "Interactive mode (Gemini):" execute it only in INTERACTIVE. Wherever a step says "Headless mode (Tavily):" execute it only in HEADLESS. Never run both.

---

## Procedure

### Step 1: Discover Events at Major Venues

**Interactive mode (Gemini):**
```
"List ALL upcoming events from [month] through [month] [year] at these venues:
1) Los Angeles Convention Center
2) Anaheim Convention Center
3) Long Beach Convention Center
Include trade shows, conventions, expos, sports tournaments, fan conventions,
and large public events. For each: event name, exact dates, venue, estimated
attendance, organizer/contact name, organizer email or website, event type.
Be exhaustive."
```

**Headless mode (Tavily):**
Search for each venue's event calendar page, then `tavily__tavily_extract({ url: "..." })` it.

**Output:** A master event list with dates, venues, attendance, organizer info.

### Step 2: Classify Each Event

Every event falls into one of two categories:

**CONVENTION/EXPO (has exhibitors):**
- Trade shows, fan conventions, expos, lifestyle shows, brand marketplaces
- Multiple exhibitors with booths on the show floor
- **Action:** Find exhibitor list URL, proceed to Step 3

**TOURNAMENT (one booth opportunity):**
- Sports competitions (judo, BJJ, TKD, volleyball, basketball, dance)
- One vendor area, families in bleachers, medal ceremonies
- **Action:** Create one booking for the event. Find tournament director contact. Max score 80 unless confirmed photo booth demand exists.

### Step 3: Find Exhibitor List URLs

**Interactive mode (Gemini):**
```
"Find the EXHIBITOR LIST or VENDOR DIRECTORY URL for each of these events:
[list events]. I need the page where I can see which companies have booths.
Give me the direct URL to each exhibitor/vendor list page."
```

**Headless mode:**
- `tavily__tavily_extract({ url: "..." })` the event website, look for "Exhibitors", "Vendors", "Marketplace", "Sponsors" links
- Tavily: `"[event name] [year] exhibitor list"`

**Output:** Add every exhibitor list URL to `skills/source-discovery/discovered_directories.md`:
```
[URL] | exhibitor_list | ~[count] | [date]
```

### Step 4: Scrape Exhibitor Lists

For each exhibitor list URL:

1. **`tavily__tavily_extract({ url: "..." })`** to extract ALL company names
2. If page returns 403/404, try:
   - Tavily: `"[event name] [year] exhibitors vendors companies"`
   - Check Facebook/Instagram for exhibitor announcements
   - Check the event's press releases for sponsor/exhibitor mentions
3. **Prioritize by booth size and budget potential:**
   - TOP PRIORITY: National brands, tech companies, supplement/apparel brands, entertainment companies (big booths, activation budgets)
   - MEDIUM: Regional businesses, specialty retailers (mid-size booths)
   - SKIP: Individual artists selling prints, one-table crafters (no photo booth budget)

### Step 5: Create Exhibitor Clients

For EACH exhibitor company worth pursuing:

1. **Find a named marketing contact:**
   - Tavily: `"[company name] marketing director email"`
   - Tavily: `"[company name] events manager email contact"`
   - Push for specific roles: VP Marketing, Events Manager, Brand Activation Director, Trade Show Coordinator
   - **NEVER accept "no names found"** -- ask the harder question

2. **Dedup:** `precrime__find({ action: "clients", filters: { company: "[company]" }, summary: true, limit: 1 })`

3. **Create** (omit `id` to create — `patch.name` is required):
   ```
   precrime__pipeline({
     action: "save",
     patch: {
       name: "[real person name]",
       company: "[company name]",
       email: "[direct email]",
       website: "[company website]",
       source: "seeder:exhibitor-list",
       segment: "convention",
       clientNotes: "Exhibitor at [Event Name] [Year] ([dates], [venue]). Potential photo booth client for their convention booth activation."
     }
   })
   ```
   Returns `{ saved: true, clientId: "[new id]", score }`. Capture `clientId` for follow-up calls.

4. **Target:** 10+ exhibitor clients per convention with named contacts and emails.

### Step 6: Create Event Bookings

For each event (whether convention or tournament), create ONE booking attached to the event-organizer client. Pass an array `patch.bookings` with no `id` per element to create new bookings:

```
precrime__pipeline({
  action: "save",
  id: "[event organizer client ID]",
  patch: {
    bookings: [{
      title: "[Event Name] [Year]",
      trade: "photo booth",
      startDate: "[ISO datetime]",
      endDate: "[ISO datetime]",
      startTime: "[time]",
      endTime: "[time]",
      location: "[Full venue address]",
      zip: "[zip]",
      description: "[enriched description - attendance, demographics, vendor area, photo booth opportunity]",
      source: "[discovery source]",
      sourceUrl: "[event website]"
    }]
  }
})
```

If trade + startDate + (location OR zip) are all present, status auto-promotes to `leed_ready`. The save returns the score for the client; query the booking via `precrime__find({action:"bookings", ...})` to read its bookingScore and shareReady flag.

### Step 7: Deep Enrichment (Interactive Mode)

For each event, ask Gemini/Grok the enrichment questions:

```
"Tell me about [Event Name] at [Venue].
- How many spectators/attendees (not just participants)?
- Is there a vendor area or spectator lobby?
- Have they had photo booths at previous years?
- What does the [medal ceremony / main stage / exhibit hall] look like?
- Do [teams/fans/families] bring large groups?
- What age range?
- Where would a photo booth be set up?"
```

Use the answers to write compelling `dt` (description) and `rq` (requirements) fields for the leed JSON. A photo booth vendor reading the leed should immediately understand WHY this event is an opportunity.

### Step 8: Score and Share

1. Score is computed automatically on every `precrime__pipeline({action:"save"})`. To re-score after enrichment, call save again on the client (with empty patch or any fresh field) and read `score` from the response. Or query the booking via `precrime__find({action:"bookings", filters:{search:"[title]"}})` to read its current `bookingScore` and `shareReady`.
2. If share-ready, build the JSON payload:

```json
{
  "tn": "photo booth",
  "ti": "[Event Title]",
  "zp": "[zip]",
  "st": [epoch_ms],
  "et": [epoch_ms],
  "dt": "[enriched description with attendance, demographics, vendor area details]",
  "rq": "[why this is a photo booth opportunity - specific details that sell the leed]",
  "lc": "[full venue address]",
  "cn": "[contact name]",
  "em": "[contact email]",
  "ph": "[contact phone]",
  "pr": 0,
  "email": "false"
}
```

3. **Branch by run mode:**
   - **Interactive:** show the JSON to the user. Wait for "share it." On approval, post.
   - **Headless:** skip the show-and-wait. Validate the JSON has all required fields (tn, ti, zp, st, et, dt, rq, lc, cn, em, pr), then post immediately. Log the full JSON to `logs/ROUNDUP.md` for audit. NEVER ask "proceed?" or "should I continue?" in headless.
4. Post: `leedz__createLeed` with `email: "false"` (always).
5. Update booking via `precrime__pipeline({action:"save", id:"[clientId]", patch:{bookings:[{id:"[bookingId]", shared:true, sharedTo:"leedz_api", leedId:"[returned ID]", status:"shared"}]}})`

---

## How a Leed is Built

A leed is NOT something you find whole in the wild. It is ASSEMBLED from pieces:

1. **Clue** -- you discover an event (judo tournament, convention, festival) at a venue on a date. This is a factlet. Create with `precrime__pipeline({action:"save", id:"[clientId]", patch:{factlets:[{content, source, signalType:"occasion"}]}})` once you have a client to attach it to.
2. **Client** -- you research and find a real person associated with the event (tournament director, vendor coordinator, event organizer). Create with `precrime__pipeline({action:"save", patch:{name, company, email, ...}})` (no `id` = create). Enrich the dossier on subsequent saves via `patch.dossierAppend`.
3. **Booking** -- you attach the event details (trade, date, location, zip) to the client via `patch.bookings:[{...}]` on a save. Becomes `leed_ready` when trade + date + (location OR zip) are present.
4. **Enrichment** -- you research deeper: attendance, demographics, vendor area layout, photo booth history, demand signals. This intel goes into the booking `description` and `notes` fields, and the client `dossier` (via `patch.dossierAppend`).
5. **Share** -- in marketplace mode, you construct the leed JSON from the enriched booking (`dt` from description, `rq` from demand intel, `cn`/`em`/`ph` from client) and post with `createLeed`, `pr=0`, `email=false`. Then save back the booking with `shared:true, sharedTo:"leedz_api", leedId, status:"shared"`.

The same client + factlet combo works for outreach mode too -- the enrichment agent composes a personalized email connecting VALUE_PROP.md to the client's specific event.

---

## Scoring Rules -- Qualification, Not Completion

The score measures how QUALIFIED a leed is -- not just how well the form is filled out. A qualified leed has both **complete data** AND a **demand signal**.

**Data completeness (same as Leedz API requirements):**
- Trade (photo booth): required
- Date (specific): required
- Location (real venue address): required
- Zip: required
- Contact name: required
- Contact email: required
- Description: required
- Start time: helpful

**Demand signal (does this client actually need a photo booth?):**

| Signal Strength | Examples | Score Impact |
|----------------|----------|-------------|
| **Confirmed** | Client explicitly requested photo booth; vendor call mentions entertainment/photo booth; event had photo booth at prior years | Full score eligible (up to 100) |
| **Strong inference** | 1500 families at a kids tournament with medal ceremonies; cosplay convention where photo content is the culture; brand activation expo where exhibitors use photo booths | Up to 90 |
| **Lukewarm** | Event exists, has a vendor area, no specific photo booth mention; generic trade show or conference | Max 80 |
| **Speculative** | Random company that exhibits at a convention; no connection to photo booth need | Max 65 |

**Tournament-specific:**
- One booth opportunity per tournament
- If NO confirmed photo booth demand: max 80
- If confirmed demand (prior photo booth, vendor call mentioning entertainment): score normally

**Convention exhibitor clients:**
- Individual exhibitors are outreach targets, not marketplace leedz
- The EVENT is the leed (one per convention). The exhibitors are the clients you email about photo booth services for their booth.
- Do NOT create marketplace leedz from individual exhibitor records

---

## Venue Reference

| Venue | Address | Zip |
|-------|---------|-----|
| Los Angeles Convention Center | 1201 S Figueroa St, Los Angeles CA 90015 | 90015 |
| Anaheim Convention Center | 800 W Katella Ave, Anaheim CA 92802 | 92802 |
| Long Beach Convention Center | 300 E Ocean Blvd, Long Beach CA 90802 | 90802 |

---

## Source Growth -- Always Be Growing

Every page you touch during this pipeline is a source of MORE sources. This is not optional.

**When you visit a convention website:**
- Grab the exhibitor list URL -> `discovered_directories.md`
- Grab the Facebook page URL -> `fb_sources.md`
- Grab the Instagram handle -> `ig_sources.md`
- Grab the X/Twitter handle -> `x_sources.md`
- Check if the event has a blog with RSS -> `rss_sources.md`
- Check for "Related Events", "Partner Events", "See Also" links -> more convention websites to process

**When you scrape an exhibitor list:**
- Each exhibitor has a website, social media, and contact page. Follow them.
- Exhibitor trade associations and industry groups -> new directories
- Sponsor pages list other companies -> more potential clients

**When you research a tournament:**
- The governing body (USA Judo, IBJJF, SCVA) has a calendar of ALL their events -> more bookings
- Tournament venues host other events -> check the venue calendar
- Tournament Facebook pages link to related groups -> more FB sources

**Append everything to the appropriate source file. Never discard a lead to a new source.**

---

## What This Skill Does NOT Do

- Does NOT compose outreach drafts (enrichment-agent.md does that)
- Does NOT evaluate drafts (evaluator.md does that)
- Does NOT harvest RSS/Reddit/FB factlets (separate harvester skills do that)
- Does NOT send emails or post to social media

This skill FINDS the opportunities and CREATES the records. Other skills enrich and act on them.

---

## Rules

1. **Exhibitors are the clients.** The event organizer is secondary. Scrape exhibitor lists and create client records for individual companies.
2. **Push hard for named contacts.** Marketing director, events manager, brand activation director, trade show coordinator. Never settle for info@ unless it's a tiny company.
3. **Show JSON before sharing — interactive mode only.** In interactive mode, the user reviews and approves every leed before it hits the marketplace. In headless mode, validate locally and post immediately. No approval gate, no "proceed?" check-in, no questions of any kind.
4. **email=false always.** Never broadcast to subscribers unless the user explicitly says otherwise.
5. **Enrich before sharing.** A thin description kills a leed. Use Gemini to research attendance, vendor areas, demographics, photo booth history. Make the leed sellable.
6. **Dedup everything.** search_clients before every create_client. Check existing bookings before creating.
7. **Trade is always "photo booth" (lowercase).** Not "Photo Booth", not "photo-booth".
8. **Log to ROUNDUP.md.** Clients created, bookings created, leedz shared, exhibitors found.
