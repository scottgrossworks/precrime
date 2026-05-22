---
name: url-loop
description: The recursive scrape loop. Claim source from server queue, scrape, save findings, mark scraped, repeat. Backbone called by every flow.
triggers:
  - find leedz
  - convention pipeline
  - scrape exhibitors
  - url loop
  - run pipeline
---

# URL Loop

The recursive URL processor. Every flow (marketplace, outreach, hybrid, headless) invokes this to process Tavily-friendly sources: `directory`, `blog`, and `website`.

The Source queue lives in the DB, not in markdown. Your job is to scrape one URL, extract clients/factlets/new source URLs, persist every valid finding immediately, mark the URL, then recurse to the next claim until Step 7.

Run the steps top to bottom. Branch only where stated. Do not improvise. Do not read or write `_sources.md` files -- the server owns the queue.

---

## Step 1 -- Open session

```
precrime__pipeline({ action: "start_session", workflow: "url-loop", target_count: 10 })
```

Hold the returned `session_id` (call it `sid`). Pass `sid` on every `save` and `next_source` below so the server attributes the work and the claim to this session.

---

## Step 2 -- Claim next source (Tavily-friendly channels only)

This skill scrapes generic web pages via Tavily. Other channels have dedicated harvesters and MUST NOT be claimed here:

| Channel | Owned by | Why not url-loop |
|---|---|---|
| `directory` | url-loop | Vendor/exhibitor lists. Tavily-friendly. |
| `blog` | url-loop | Generic blog page. Tavily-friendly. |
| `website` | url-loop | Generic site page. Tavily-friendly. |
| `rss` | url-loop fallback | Feed URLs can still reveal article links and facts via Tavily. |
| `reddit` | url-loop fallback | Subreddits can still reveal posts via Tavily if the dedicated harvester is not run first. |
| `fb` | `skills/fb-factlet-harvester/` | Browser-only (heavy JS). Tavily yields nothing useful. |
| `ig` | `skills/ig-factlet-harvester/` | Browser-only. Same. |
| `x`  | `skills/x-factlet-harvester/`  | Browser/Grok-only. Same. |

Iterate the five url-loop channels in priority order. The first to return `CLAIMED` is yours; on `QUEUE_EMPTY`, try the next.

**The parameter name is `channel`. Not `scope`, not `target`, not `category`.** Misspelling silently disables the filter and pops the wrong rows. The exact JSON keys are: `action`, `session_id`, `channel`. Nothing else for this call.

### Step 2a: try directory

```json
{ "action": "next_source", "session_id": "<sid>", "channel": "directory" }
```

If `status: "CLAIMED"` -> Step 3 (with the returned `url`).
If `status: "QUEUE_EMPTY"` -> Step 2b.

### Step 2b: try blog

```json
{ "action": "next_source", "session_id": "<sid>", "channel": "blog" }
```

If `status: "CLAIMED"` -> Step 3.
If `status: "QUEUE_EMPTY"` -> Step 2c.

### Step 2c: try website

```json
{ "action": "next_source", "session_id": "<sid>", "channel": "website" }
```

If `status: "CLAIMED"` -> Step 3.
If `status: "QUEUE_EMPTY"` -> Step 2d.

### Step 2d: try rss

```json
{ "action": "next_source", "session_id": "<sid>", "channel": "rss" }
```

If `status: "CLAIMED"` -> Step 3.
If `status: "QUEUE_EMPTY"` -> Step 2e.

### Step 2e: try reddit

```json
{ "action": "next_source", "session_id": "<sid>", "channel": "reddit" }
```

If `status: "CLAIMED"` -> Step 3.
If `status: "QUEUE_EMPTY"` -> Step 2f.

### Step 2f: retry preserved sources once

If all channels above returned `QUEUE_EMPTY`, retry the same five channels once with `"maxAgeDays": 0`. Preserved deployment DBs may have non-null `scrapedAt` values from a previous bad run; this forces a fresh scrape pass.

If any retry returns `CLAIMED` -> Step 3.
If every retry returns `QUEUE_EMPTY` -> Step 6.

You may also pass `"maxAgeDays": N` to control re-scrape staleness (default 30).

**Server safety net (Pass 2):** if you forget `channel` entirely, the server now defaults to excluding fb/ig/x. Always pass `channel` explicitly per Step 2a-2f. If you find yourself omitting `channel` or using `scope`/`target`, stop -- that is the old pattern.

Hold the returned `url` and `id` for Steps 3-5.

---

## Step 3 -- Scrape

```
tavily__tavily_extract({ url: "<url from Step 2>" })
```

The wrapper defaults to `mode: "full"` -- you receive the cleaned full page content (typically 5-25K chars), not a 5-sentence summary. Response shape:

```json
{
  "url": "...",
  "ok": true,
  "mode": "full",
  "content": "<full page text with vendor names, headers, lists>",
  "emails": ["..."],
  "phones": ["..."],
  "stats": { ... }
}
```

Read the `content` and `candidates` fields carefully in Step 4. Vendor lists, exhibitor rosters, contact directories all sit in `content` with their structure preserved. `candidates` gives procedural hints only.

- Extract succeeds (`ok: true`) -> Step 4.
- Extract fails (`ok: false`, timeout, 4xx, 5xx, empty body) -> log to `logs/ROUNDUP.md`, then go to Step 5 with `failedReason` set, then back to Step 2.

---

## Step 4 -- Extract clients, factlets, and new sources

Read the `content` and `candidates` fields returned by Step 3. The procedural `candidates` object is only evidence: emails, phones, URLs, and heading/card-like lines. It is not the final answer. Use the LLM judgment against VALUE_PROP to classify findings.

Emit this strict internal JSON shape before saving:

```json
{
  "clients": [
    {
      "company": "string required unless name is present",
      "name": "string optional",
      "email": "string optional",
      "phone": "string optional",
      "website": "string optional",
      "source": "<current url>",
      "segment": "string optional",
      "whyRelevant": "short reason tied to VALUE_PROP"
    }
  ],
  "factlets": [
    {
      "content": "short factual signal",
      "source": "<current url>",
      "signalType": "occasion|context|pain"
    }
  ],
  "sources": [
    {
      "url": "new URL or handle",
      "channel": "directory|rss|fb|ig|reddit|x|blog|website",
      "subtype": "optional",
      "label": "optional",
      "category": "optional"
    }
  ]
}
```

Rules for the JSON:
- `clients[]` may be sparse. A company-only record is allowed when it is relevant to VALUE_PROP. You cannot enrich what you never start.
- `clients[]` must not contain placeholders like `<name>`, `Unknown`, blank strings, page navigation, or generic section labels.
- `factlets[]` are broad useful signals: upcoming event, hiring/buying occasion, market trend, budget clue, venue/calendar signal, or demand signal.
- `sources[]` are relevant URLs worth following later. Do not include every link on the page; include URLs likely to reveal clients or factlets.

On a vendor directory page, clients typically appear as:

- Cards or tiles with a vendor name as the header
- Bullet/numbered lists of business names
- Table rows where the first column is a name
- Linked text where the link text is the vendor name (e.g., a hyperlink to their site)
- Title-cased phrases of 2-5 words that recur multiple times near contact info, addresses, or "Visit website" links

**Concrete examples of what counts as a client save:**
- `"Bella Eventi Catering"` -> save (real business)
- `"Dallas Wedding Planners LLC"` -> save (real business)
- `"Texas Tents & Events"` -> save (real business)
- Even a single vendor name with no other detail -> save (`patch: { company: "Name", source: "<url>", draftStatus: "brewing" }`). The enrichment phase fills in email/website/contacts later.

**What to skip:**
- Navigation chrome: "Home", "About", "Contact", "Sign In", "Search", "Vendors", "Categories", "Login"
- Section headers: "Featured", "Top Rated", "All Categories", "Filter By"
- City/state names alone: "Dallas", "Texas"
- Generic single words

**Be generous, not cautious.** A directory page typically has 10-50+ vendor names. If your extraction yields 0 or 1, you are over-filtering -- re-read the page text and pick anything that looks like a business name.

### Save clients

For EACH JSON client, issue one save immediately:

```
precrime__pipeline({
  action: "save",
  session_id: sid,
  patch: {
    name: "<name if present>",
    company: "<company if present>",
    email: "<email if present>",
    phone: "<phone if present>",
    website: "<website if present>",
    source: "<url>",
    segment: "<segment if known>",
    draftStatus: "brewing",
    clientNotes: "<whyRelevant>"
  }
})
```

One save per client, immediately, no batching. Server dedups by company.

### Save factlets

For EACH JSON factlet that is relevant to VALUE_PROP, follow `skills/shared/factlet-rules.md`. Attach to a client when obvious. If no client is obvious, log it to `logs/UNLINKED_INTEL.md` exactly as that shared rule says. Do not invent a client just to hold a generic factlet.

### Add new sources

If `sources[]` has entries, issue ONE `add_sources` call:

```
precrime__pipeline({
  action: "add_sources",
  entries: [
    { url: "<url1>", channel: "directory", discoveredFrom: "<current url>" },
    { url: "<url2>", channel: "rss", label: "Some Blog", discoveredFrom: "<current url>" }
  ]
})
```

The server dedups on URL. Do NOT echo to `_sources.md` files -- the queue is in the DB.

### IF you found ZERO clients and ZERO factlets and ZERO sources

This is normal for some pages: login wall, JS-only render, irrelevant page, scraper failure, or a category page with no useful rows.

- DO NOT call `pipeline.save` with an empty patch. The server now soft-skips empty saves but it logs each one as a no-op event -- noisy and unhelpful.
- Set `emptyReason` to one of: `no_candidates`, `irrelevant`, `login_wall`, `js_only`, `extract_failed`, `ambiguous`.
- Skip directly to Step 5 and pass `clientsFound: 0` plus `failedReason: "empty:<emptyReason>"`. Move to next URL.

Before declaring zero, double-check by re-reading the Step 3 result. Did you miss obvious vendor cards? Common mistake: agent over-filters because the names lack the word "Inc" or "LLC" -- but most small event vendors don't use suffixes. Server:
- rejects empty patches (-32602),
- dedups by company,
- auto-scores and auto-promotes any booking that hits `leed_ready`.

If a row carries name + email + phone + role together, follow `__PROJECT_ROOT__/skills/client-seeder.md` for THAT page (it adds classify-contact, booking-detect, factlet capture) -- then return here.

Track:
- `saved_this_iteration` = count of client save attempts
- `factlets_this_iteration` = count of factlets saved/logged
- `sources_added_this_iteration` = `added` count returned by `add_sources`

---

## Step 5 -- Mark source scraped, check budget

```
precrime__pipeline({
  action: "mark_source",
  url: "<url from Step 2>",
  clientsFound: <saved_this_iteration count>,
  failedReason: <set ONLY if Step 3 failed or Step 4 found nothing useful; omit on useful success>
})
```

This releases the claim and stamps `scrapedAt`. If you don't call this within 10 minutes of Step 2, the row becomes claimable again by another agent.

Budget check:
- `total_client_saves_this_session >= target_count` -> Step 7.
- Otherwise -> Step 2.

---

## Step 6 -- Queue empty, grow it

Read and follow `__PROJECT_ROOT__/skills/source-discovery.md`. It searches Tavily / SESSION_AI for new directories and feeds them into the Source table via `add_sources` calls.

When source-discovery returns:
- It reports `total_added > 0` -> Step 2.
- It reports `total_added == 0` (channels exhausted) -> Step 7.

ONE pass of source-discovery per url-loop invocation. Do not re-enter source-discovery in a tight loop.

---

## Step 7 -- Close session

```
precrime__pipeline({ action: "report_session", session_id: sid })
```

Echo the returned JSON verbatim. The server's report is the truth -- do not paraphrase, do not write your own count, do not summarize. Then exit this skill.

---

## Termination contract

Exit url-loop ONLY at Step 7. Until then, you are in the loop.

You do NOT exit when:
- A scrape returns nothing.
- A save returns "duplicate company" (it counted as an attempt).
- The current URL had zero extractable companies.
- You feel uncertain. (Loop back to Step 2.)

You DO exit at Step 7 when:
- `target_count` was hit (success).
- `next_source` returned `QUEUE_EMPTY` AND source-discovery added zero entries (genuine exhaustion).
- An unrecoverable tool error -- log it, attempt Step 7 anyway so the server closes the session cleanly.

Server-side guards already in your favor (do not replicate in markdown):
- 3-min save-or-terminate watchdog on read actions.
- 60s cooldown on re-opening the same `workflow` string.
- 10-min claim timeout on `next_source` (work-stealing -- dead agents release their claims automatically).
- Empty-patch rejection.
- Dedup by company on save, dedup by URL on add_sources.
- Auto-score and auto-promote on every save.
