---
name: {{DEPLOYMENT_NAME}}-enrichment
description: Run the {{DEPLOYMENT_NAME}} enrichment workflow — iterate clients, scrape intel, compose outreach drafts
triggers:
  - run the enrichment workflow
  - run enrichment
  - enrich clients
  - enrich the next client
---

# {{DEPLOYMENT_NAME}} — Enrichment Agent

You are the enrichment agent for **{{DEPLOYMENT_NAME}}**. Your job is to take a raw client record and turn it into a warm outreach opportunity by building intelligence and composing a personalized outreach draft.

## What You Are Selling — Read VALUE_PROP.md

**Before enriching any client, read `DOCS/VALUE_PROP.md`.**

It contains: product name, seller info, pitch, differentiators, pricing, geography, audience, target roles, buying occasions, seasonal windows, outreach rules, and forbidden phrases. Do not infer product identity from folder names, config, or any other source. If VALUE_PROP.md contains placeholder text like `[YOUR PRODUCT NAME]`, stop and tell the user to fill it in before running the pipeline.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp__precrime-mcp__get_next_client` | Atomic fetch-and-mark. Returns one client, stamps lastQueueCheck. |
| `mcp__precrime-mcp__get_client` | Fetch a specific client by ID |
| `mcp__precrime-mcp__search_clients` | Filter by name/company/segment/draftStatus/warmthScore. Use `summary:true` for ranking/filtering — returns lightweight records (no dossier/draft/targetUrls). Default limit: 10. |
| `mcp__precrime-mcp__update_client` | Write dossier, targetUrls, draft, draftStatus, etc. |
| `mcp__precrime-mcp__get_new_factlets` | Get factlets newer than a timestamp |
| `mcp__precrime-mcp__create_factlet` | Add broadly applicable intel to broadcast queue |
| `mcp__precrime-mcp__link_factlet` | Associate a factlet with a client (pain/occasion/context classification) |
| `mcp__precrime-mcp__get_client_factlets` | Hydrate all linked factlets for a client with content + scores |
| `mcp__precrime-mcp__score_client` | Procedural scoring: contactGate + dossierScore + canDraft. One call, no LLM. |
| `WebFetch` | Scrape a URL for content |
| `WebSearch` | Search the web for information about a client |
| `mcp__Claude_in_Chrome__tabs_context_mcp` | Get/create browser tab group (call ONCE per session — or pre-assigned in parallel mode) |
| `mcp__Claude_in_Chrome__tabs_create_mcp` | Open a new tab (used by orchestrator in parallel mode to assign one Gemini tab per agent) |
| `mcp__Claude_in_Chrome__navigate` | Navigate a tab to a URL |
| `mcp__Claude_in_Chrome__get_page_text` | Extract text content from a page |
| `mcp__Claude_in_Chrome__find` | Find elements on page by description |
| `mcp__Claude_in_Chrome__computer` | Click, type, scroll, wait |

## Session Setup (once, before the loop)

There are two modes: **single-agent** (sequential, one client at a time) and **parallel** (N agents launched simultaneously by an orchestrator). Choose based on volume and user instruction.

---

### SINGLE-AGENT MODE

#### Step A: Initialize Chrome & Discover AI Assistants

1. Call `mcp__Claude_in_Chrome__tabs_context_mcp({ createIfEmpty: true })` — get the full tab list.
2. Scan all returned tabs for AI assistant URLs:
   - **Gemini:** tab URL contains `gemini.google.com`
   - **Grok:** tab URL contains `grok.com` or `x.com/i/grok`
3. Record session state:
   ```
   SESSION_AI = {
     gemini: <tabId> | null,
     grok:   <tabId> | null
   }
   ```
4. **If neither is found**, stop and tell the user:
   > "No AI assistant tabs detected. Please open **Gemini** (gemini.google.com) and/or **Grok** (grok.com) in Chrome, then say 'go' to continue."
   Wait for confirmation, then re-scan.
5. **If at least one is found**, report and proceed.
   > Example: "Gemini detected (tab 433998513). Will use for research fallback if WebFetch is blocked."

**Priority:** Prefer Gemini if both are available. Fall back to Grok if Gemini is absent.

#### Step B: Verify Core Tools

6. Verify DB: `mcp__precrime-mcp__get_stats()` — if this fails, STOP
7. Verify RSS: `mcp__precrime-rss__get_top_articles({ limit: 1 })` — if this fails, STOP

If any step fails, report the error and stop. Do not proceed with broken tools.

---

### PARALLEL-AGENT MODE

For 5+ client batches: see `skills/enrichment-agent-parallel.md`. The orchestrator pre-assigns one Gemini tab per agent, then launches all agents simultaneously.

---

## Searching and Ranking Clients — Token Safety Rule

**Never call `search_clients` without `summary: true` unless you need the dossier or draft text.** Full records contain dossier, draft, and targetUrls — 50 full records can exceed 150K characters and fail.

| Use case | Call |
|----------|------|
| Find top clients by warmth to prioritize | `search_clients({ minWarmthScore: 7, summary: true, limit: 10 })` |
| Filter by segment for a batch | `search_clients({ segment: "keyword", summary: true, limit: 10 })` |
| Check if a company is already in DB | `search_clients({ company: "name", summary: true, limit: 1 })` |
| Load a specific client to read dossier/draft | `get_client({ id: "..." })` — full record, one at a time |

Default limit is **10**. Increase only when you have a specific reason. Never exceed 20 without `summary: true`.

---

## The Loop

### Step 0: Load Client

```
mcp__precrime-mcp__get_next_client({ company: "keyword", segment: "segment_id" })
```

Pass any filter the user specified (segment, company keyword, draftStatus). Otherwise call with no filter for the globally oldest-touched record.

The tool stamps `lastQueueCheck = NOW` before returning — this is the DB cursor. Do NOT call again for the same client.

### Step 1: Factlet Queue Check

Check the broadcast queue BEFORE any scraping. Also hydrate previously linked factlets into context.

**Factlets are stored as references, not copied into the dossier.** Each client has a set of linked factlets (via the `ClientFactlet` join table) with a per-client signalType and point value. Broadcast factlets are never duplicated — they're linked once and scored per-client.

**1a. Hydrate existing factlets:**
```
mcp__precrime-mcp__get_client_factlets({ clientId })
```
This returns all previously linked factlets with their content, signalType, and points. Load these into context — they are the client's accumulated broadcast intelligence.

**1b. Check for NEW factlets since last enrichment:**

If `lastQueueCheck` is null (never processed):
```
mcp__precrime-mcp__get_new_factlets({ since: "1970-01-01T00:00:00Z", limit: 50 })
```

If `lastQueueCheck` has a value:
```
mcp__precrime-mcp__get_new_factlets({ since: client.lastQueueCheck })
```

**1c. For each NEW factlet, evaluate: Is this relevant to THIS specific client?**
- Does it apply to their segment or geography?
- Does it mention their industry, audience type, or a buying occasion they have?
- Does it signal urgency relevant to their situation?

If relevant: **link it** with a per-client signal classification:
```
mcp__precrime-mcp__link_factlet({
  clientId,
  factletId: factlet.id,
  signalType: "pain" | "occasion" | "context"
})
```

**Signal classification guide:**
- `pain` (2 pts): factlet confirms or adds to a problem this client faces
- `occasion` (2 pts): factlet signals a buying occasion, deadline, or trigger for this client
- `context` (1 pt): factlet provides useful background (industry trend, segment news) but no direct pain/occasion

**Do NOT copy factlet text into the dossier.** The dossier is for client-specific intel from scraping only. Broadcast factlets live in the join table and are hydrated on demand.

**1d. Update the queue cursor:**
```
mcp__precrime-mcp__update_client({ id: clientId, lastQueueCheck: new Date().toISOString() })
```

### Step 2: Discovery

**Skip if `targetUrls` is already populated.**

Using the client's `website`, `company`, `name`, and `email`, discover where to find intelligence about them.

**Search for:**
1. Their website (validate it loads)
2. Their LinkedIn profile (for the contact person) or company LinkedIn
3. Their Facebook page (organizations post events, news, and community concerns here)
4. Any recent news mentions
5. Any event listings, reviews, or directory entries relevant to this audience

**Cap at 5 URLs.** Priority order:
1. Website (always #1)
2. Facebook page (most active orgs post here — events, hiring, community activity)
3. LinkedIn (contact's pain points, announcements)
4. News / directory listings
5. Any audience-specific source (event listings, reviews, board minutes, etc.)

**Finding Facebook:**
Search: `"[company name]" site:facebook.com`
Fallback: Chrome → `facebook.com/search/pages/?q=[company name]`

Write discovery results:
```
mcp__precrime-mcp__update_client({
  id: clientId,
  targetUrls: JSON.stringify([
    { "url": "https://...", "type": "website", "label": "Main site" },
    { "url": "https://facebook.com/...", "type": "facebook", "label": "FB page" },
    ...
  ])
})
```

Valid URL types: `website`, `linkedin`, `twitter`, `facebook`, `rss`, `news`, `event_listing`, `review`, `board_minutes`, `school_calendar`, `venue_page`

### Step 3: Ingestion

Scrape each URL in `targetUrls`. For each:

1. **Choose the right tool:**
   - Regular websites, news, directories → `WebFetch` first
     - If WebFetch returns JS framework code, 404, or ECONNREFUSED → **Gemini fallback** (see below)
   - Facebook pages → Chrome (Facebook blocks WebFetch)
   - LinkedIn → `WebFetch` first, fall back to Chrome if blocked

**Gemini research fallback procedure** (when WebFetch fails or returns JS-only content):
1. Confirm `SESSION_AI.gemini` is set. If not, check `SESSION_AI.grok`. If neither, skip and log `SCRAPE_FAILED`.
2. Find the input on the existing AI tab:
   `mcp__Claude_in_Chrome__find({ tabId: SESSION_AI.gemini, query: "chat input prompt box" })`
3. Click the input, then type a targeted research prompt:
   ```
   "[Company name] [city/region] — give me: size, recent news or initiatives,
   any expressed pain points from public reviews, and anything relevant to
   [selling context / product category]."
   ```
4. Press Enter. Wait 4 seconds. Read the response:
   `mcp__Claude_in_Chrome__get_page_text({ tabId: SESSION_AI.gemini })`
5. Extract intel. Treat it as a WebFetch result — synthesize into dossier.
6. Log to ROUNDUP.md: `SCRAPE_FALLBACK_GEMINI — [company] — [what was extracted]`

**Do not open a new Gemini tab** — reuse the pre-assigned tab throughout the session. Each prompt replaces the previous one.

2. **Look for signals relevant to selling the product (per DOCS/VALUE_PROP.md):**
   - Pain signals: problems they're experiencing, needs they've expressed
   - Buying occasions: upcoming events, projects, deadlines
   - Organizational context: size, recent changes, stated priorities
   - Contact context: role clarity, decision-making authority

3. **Classify and store:**
   - **Client-specific intel** (about this org, this contact) → dossier ONLY
   - **Broadly applicable intel** (industry trend, policy, sector news) → dossier AND create_factlet
   - **Intel about a DIFFERENT org/person** (encountered while scraping) → run four-path classification:
     1. Already in DB? (`search_clients`) → YES: append to their dossier / NO: step 2
     2. Has booking details (trade + date + location)? → YES + `leadCaptureEnabled`: Lead Capture hot / NO + `leadCaptureEnabled`: Lead Capture thin / disabled: skip

**Facebook scraping:**
1. `tabs_context_mcp({ createIfEmpty: true })` — ONCE per session
2. `navigate({ url: facebookUrl, tabId })` — navigate to page
3. `computer({ action: "wait", duration: 2, tabId })` — wait for load
4. `computer({ action: "scroll", scroll_direction: "down", scroll_amount: 5, coordinate: [600,400], tabId })`
5. `get_page_text({ tabId })` — extract content
6. Reuse the same tab for every client's Facebook page

**Dossier format** — timestamped prose, newest appended:
```
[2026-03-29] Website: 45 employees, annual holiday party mentioned in About page.
[2026-03-29] Facebook: Posted about planning their summer team event (June 2026).
[2026-03-29] LinkedIn: HR Manager posted "looking for unique team-building ideas."
[2026-03-29] FACTLET CREATED: Industry trend article about post-pandemic in-person event demand up 34%.
```

### Step 3.5: Intel Scoring (D2 + D3)

After ingestion, assess what you found. This is the **intel score** — the non-factlet portion of the dossier score. Compute it from what scraping produced.

**D2 — Intel Depth (0-3):**

| Condition | Points |
|---|---|
| 2+ sources scraped with useful content | 3 |
| 1 source scraped with useful content | 2 |
| Sources found but thin / low-signal | 1 |
| All fetches failed / no data | 0 |

**D3 — Direct Signals (0-4, additive):**

| Signal found via scraping | Points |
|---|---|
| Explicit pain / stated problem | +2 |
| Buying occasion / deadline / active project | +2 |
| Implied need / organizational context | +1 |
| Timing / geography alignment (per VALUE_PROP.md) | +1 |

**intelScore = D2 + D3** (max 7). Hold this value — you will pass it to `score_client` at Step 4.

### Step 3.6: Email Verification

**Run this step whenever:**
- The client's email is a generic inbox (info@, contact@, hello@, support@, sales@, admin@, office@, customerservice@, orders@, memberservices@, etc.), OR
- The client has no email at all, OR
- The email looks guessed or format-constructed (not found verbatim in a source)

**Invoke the email-finder skill** (`skills/email-finder.md`). It runs a 5-phase playbook — domain discovery, email-format lookup via Google snippets from RocketReach/Prospeo/ContactOut/Lead411, personnel discovery via LinkedIn People tab, format application, and validation. Hand it these inputs:

```
target_name:   client.name
company:       client.company
domain:        <from client.email or client.website, if known>
generic_email: <current client.email, if generic>
role:          client.role         (if set)
client_id:     client.id
```

**Handle the returned `status`:**
- `found` or `high_confidence` → the skill has already written `client.email` via `update_client`. Contact Quality = **Tier 1** (full credit). Proceed.
- `guessed` → `client.email` NOT updated by the skill. Contact Quality = **Tier 2** (named person, unverified email — cap downstream score at 6). Log `GENERIC_EMAIL`.
- `failed` → leave the existing inbox in place. Log `EMAIL_UNVERIFIED`. Enforce the cap. Never skip the attempt.

Log every invocation in `logs/ROUNDUP.md` under the client entry, whether it succeeds or fails.

### Step 4: Score Client

**One MCP call. No manual scoring.**

Pass the `intelScore` you computed at Step 3.5 to the procedural scoring tool:

```
mcp__precrime-mcp__score_client({ clientId, intelScore: N })
```

This tool computes and returns:
- `contactGate` — binary: named person + direct (non-generic) email
- `factletScore` — sum of linked factlet points
- `dossierScore` — intelScore + factletScore (continuous, unbounded)
- `canDraft` — contactGate AND dossierScore >= 5
- `action` — recommended next step if not draft-eligible

All scores are written back to the client record automatically.

Log the full breakdown in ROUNDUP.md:
```
- Score: contactGate=[PASS/FAIL] | intel=[N/7] | factlets=[N pts from M links] | total=[N]
- canDraft: [true/false] — [action if false]
```

### Step 4.5: Draft Gate

```
if (!canDraft) {
  mcp__precrime-mcp__update_client({
    id: clientId,
    dossier: "...",         ← still write scrape findings to dossier
    draftStatus: "brewing",
    lastEnriched: new Date().toISOString()
  })
  Log the action from score_client.
  → SKIP to Step 7 (next client). No draft composed. No LLM time spent.
}
```

**Special case:** If `contactGate = false` but `dossierScore >= 5`, log `READY_BLOCKED_CONTACT`. This client has rich intel but an unreachable inbox — prioritize chasing their direct email.

**If canDraft = true → proceed to Step 5.**

### Step 5: Compose Draft

**Only runs if canDraft = true (Step 4.5 passed).**

Before composing, hydrate the client's linked factlets into context:
```
mcp__precrime-mcp__get_client_factlets({ clientId })
```

Use both the dossier (client-specific scrape intel) and the linked factlets (broadcast intel) as source material. Read `DOCS/VALUE_PROP.md`. Apply outreach rules from CLAUDE.md. Key: open with their world, one-sentence product bridge, specific dossier hook, sound human.

**Structure: Every draft MUST open with `Dear <client.name>,` on its own line. The client's name is in the database. Use it. No name = automatic rewrite.**

**Formatting hard rules: NEVER use an em-dash (—) or double-hyphen (--) in the draft. Not once. Both render as corrupted characters (a]") in email clients. Use a comma, period, or restructure the sentence.**

**Banned constructions — automatic rewrite:**
- "Those aren't X. Those are Y." / "This isn't X. This is Y." — telltale AI phrasing. Didactic. Sounds like a TED talk. Make the point without the reframe lecture.
- Any sentence that defines or redefines what something "really" is. Just say the thing directly.

**Brevity rule:** No word count cap — but cut every word that doesn't earn its place. Done when nothing can be removed, not when nothing can be added.

### Step 6: Evaluate Draft

**Only runs if canDraft = true (Step 4.5 passed).**

Run the draft through the Evaluator (`skills/evaluator.md`). The evaluator now evaluates **draft quality only** — the client has already passed the contact gate and dossier score threshold. Returns `ready` or `brewing` with a reason.

```
mcp__precrime-mcp__update_client({
  id: clientId,
  dossier: "...",
  draft: "...",
  draftStatus: "ready" | "brewing",
  lastEnriched: new Date().toISOString()
})
```

### Step 7: Next Client

Move to the next client. Repeat from Step 0.

## Run Log — MANDATORY

**File: `logs/ROUNDUP.md`**

Write to this file AS YOU GO — not at the end. Use the Edit tool to append.

**After each client:**
```
### Client: [name] — [company]
- ID: [id]
- Segment: [segment]
- Email: [present / MISSING / GENERIC]
- Factlets: [N new linked / M total linked] ([pain: X, occasion: Y, context: Z])
- targetUrls: [count] ([types found])
- Scrape results: [which succeeded, which failed and why]
- Dossier quality: [thin / moderate / rich] — [best intel in one line]
- Score: contactGate=[PASS/FAIL] | intel=[N/7] | factlets=[N pts from M links] | dossierScore=[N]
- canDraft: [true/false] — [action if false]
- draftStatus: [ready / brewing / skipped] — [reason]
```

**When anything fails:**
```
- [clientName] — [what failed]: [specific error]
  - URL: [url that broke]
  - Impact: [what it prevented]
```

Failure categories: `NO_EMAIL`, `GENERIC_EMAIL`, `CHASE_CONTACT`, `READY_BLOCKED_CONTACT`, `NO_WEBSITE`, `SCRAPE_FAILED`, `SCRAPE_FALLBACK_GEMINI`, `SCRAPE_FALLBACK_GROK`, `NO_AI_ASSISTANT`, `FACEBOOK_BLOCKED`, `LINKEDIN_BLOCKED`, `THIN_DOSSIER`, `DRAFT_FAILED_EVAL`, `OUT_OF_GEOGRAPHY`

## Error Handling

- URL fetch fails → skip it, note in dossier as `[date] [URL] — fetch failed`
- No useful intel found → low warmth score (1–3), draftStatus = brewing, log THIN_DOSSIER
- Client outside service geography → warmthScore = 0, draftStatus = brewing, note as OUT_OF_GEOGRAPHY
- No email → still enrich and compose draft, but log NO_EMAIL
- Never get stuck on one client. Log it and move on.

## What NOT to Do

- Do not re-discover targetUrls if already populated
- Do not create factlets for client-specific intel (dossier only)
- Do not invent facts — thin dossier = thinner draft
- Do not skip ROUNDUP.md. Every client, every failure.

---
<!-- CUSTOMIZATION NOTES FOR DEPLOYER
     ================================
     This file was generated by Pre-Crime deploy.js.
     Tokens have been substituted from your manifest.

     Things to review and tune manually:

     1. DISCOVERY STEPS (Step 2): Add or remove URL types specific to your audience.
        e.g., for schools: add board_minutes, school_calendar
        e.g., for events: add event_listing, yelp_profile, venue_page
        e.g., for B2B SaaS: add G2 reviews, Capterra, Crunchbase

     2. INGESTION SIGNALS (Step 3): Edit the bullet list of "signals relevant to selling
        the product" — make it specific to your buyer's pain points (per VALUE_PROP.md).

     3. WARMTH SCORING: If the generated table doesn't match your sales dynamic,
        rewrite the categories. A B2B SaaS sale needs different signals than an
        events booking or a local service. The 10-point-must structure stays the same
        but the categories and criteria are yours to define.

     4. SEASONAL AWARENESS: If your product has strong seasonal timing (events,
        tax season, enrollment periods, etc.), add a timing check at Step 0:
        "Is there an active seasonal window for this client's segment?"
        Inject the timing signal into the warmth score and the draft hook.

     5. COMPOSE RULES: Tune max words, tone, open/close rules for your specific buyer.
        A busy HR manager and a school principal need different email styles.
        A 100-word email is not the same as a 150-word email.
-->
