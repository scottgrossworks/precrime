# Pre-Crime -- Conceptual Foundation

Pre-Crime is a recursive intelligence-gathering system. It discovers people and organizations who are likely to buy what you sell, learns about them, and produces actionable sales opportunities.

## The Goal

Every object in the system is moving toward one of two end states:

1. **Leed shared to marketplace** -- a booking that passes `DOCS/SCORING.json` `leed_ready` gates, posted via the Leedz API.
2. **Outreach email sent** -- a draft composed from a rich dossier, approved by the user, delivered via Gmail.

Everything else is **brewing**. A client at score 0 is brewing. A factlet not yet linked is brewing. A booking missing a zip code is brewing. A source not yet scraped is brewing. The system's job is to move every object from brewing toward an end state. A low score is not a problem to report -- it is the fuel that keeps the pipeline running.

## The Core: Demand Signal

A woman's hair catches fire at her desk. We email her a bucket of water at that moment, we make the sale. Five minutes early, next day, or the coworker next to her with fine hair: no sale. Cold outreach without a demand signal is selling buckets to people whose hair is not on fire. PRECRIME's job is to predict combustion, or detect it the instant it happens, and arrive with VALUE_PROP framed as the bucket.

A booking is `leed_ready` only when a demand signal is present. Demand signal is never stored (fires start and go out); it is recomputed at enrichment from current evidence. Two sources: **explicit** (source literally states the need: "looking for X", RFP, inbound inquiry) or **inferred** (factlets stack into an argument the agent can state out loud). Without one, a complete booking is `outreach_ready`, not `leed_ready`.

Inferred archetype (the Prom Pattern). Five slots, all required: (1) named decision-maker for VALUE_PROP's category, (2) concrete event with a date inside the conversion window, (3) public precedent of buying this category before, (4) pattern of publicly crediting vendors, (5) thematic fit for this specific instance. Canonical case: activity director, prom in 60 days, past gallery shows caricature booth, school posts thank-yous to prior vendors, this year's theme matches the pitch. Transpose the nouns for other verticals (corporate planner + holiday party, brewery + tap takeover, etc.). Fewer than 5/5 slots filled = `outreach_ready`. Empty slots are the next enrichment target.

## The Process

The process is recursive: every step can discover inputs for itself or any other step. Scraping a directory finds clients AND links to more directories. Processing an RSS article finds intel AND links to new RSS feeds. Enriching a client finds booking signals AND references to other potential clients. When you discover new inputs, add them to the queue and keep going.

**Sources vs Clients.** A convention organizer, a venue, a vendor directory, an event calendar -- these are SOURCES, not Clients. Their value is the list of buyers they reveal: a convention's exhibitor list, a venue's preferred-vendor page, a calendar's event organizers. Scrape the source, harvest the exhibitors/organizers/planners, THOSE become Clients (a brand exhibiting at a convention is a real buyer for booth-enhancement VALUE_PROP). Then enrich those clients until a demand signal appears. The recursive loop is: source -> clients -> enrich -> demand signal -> end state. Keep digging. Zero saves from one URL is not a failure; it is a signal to discover more sources.

```
PRECRIME(sources, clients):

  DISCOVER(sources):
    for each source:
      content     = SCRAPE(source)
      new_sources = find links to more sources in content   -> append to sources
      new_clients = extract contacts from content           -> DEDUP, then save
      intel       = extract broadly useful facts             -> attach to relevant clients
      bookings    = extract events with trade + date + place -> attach to client, score

  ENRICH(clients):
    for each client not yet at an end state:
      urls    = find their website, social, news
      dossier = scrape those urls for signals
      score   = rate contact quality + intel depth + buying signals
      if score passes gate -> compose draft or flag booking as ready
      if score is low -> keep going. Low score = more enrichment needed, not a stop.

  PRESENT():                           <- the ONLY place the user is consulted
    show results that reached an end state -- ready bookings, ready drafts
    user decides what to share or send
```

Every skill file is an implementation of one of these functions.

## Function-to-Tool Mapping

| Function | Tool Call |
|----------|----------|
| Read config / stats | `precrime__pipeline({ action: "status" })` |
| Save / update client | `precrime__pipeline({ action: "save", id?, patch })` |
| Get next client | `precrime__pipeline({ action: "next", criteria })` |
| Search clients | `precrime__find({ action: "clients", filters, summary: true })` |
| Search bookings | `precrime__find({ action: "bookings", filters })` |
| Search factlets | `precrime__find({ action: "factlets", filters })` |
| Get trade list | `precrime__trades()` |
| Fetch RSS articles | `precrime-rss__get_top_articles({ limit })` |
| Web search (headless) | `tavily__tavily_search({ query })` |
| Delete record | `precrime__pipeline({ action: "delete", target, id })` |
| Re-score bookings | `precrime__pipeline({ action: "rescore", scope })` |
| Start workflow session | `precrime__pipeline({ action: "start_session", workflow })` |
| Close session + report | `precrime__pipeline({ action: "report_session", session_id })` |
| Audit session (no close) | `precrime__pipeline({ action: "audit_session" })` |
| Scrape URL (headless) | `tavily__tavily_extract({ url })` |
| Send email | `gmail__gmail_send({ to, subject, body })` |
| Post marketplace leed | `leedz__createLeed({ ...payload })` |

Scoring runs automatically on every `pipeline.save`. No separate score call needed.
See `DOCS/SCORING.json` for the full algorithm and gates.
See `DOCS/SUMMARY.md` for session accountability (start_session / report_session / audit_session).

## Invariants

1. **Dedup always.** Check `precrime__find exactCompany` before every create. Server enforces as last resort.
2. **Log always.** Every action, every skip, every error goes to `logs/ROUNDUP.md`.
3. **Never stop on error.** Log it, skip the item, continue to the next one.
4. **Results at the end.** Run the full pipeline before presenting anything to the user.
5. **Never ask permission between steps.** The pipeline runs until it reaches PRESENT. A low score means keep enriching. A thin dossier means keep scraping. The only question the user hears is at the end: "Share this leed?" or "Send this draft?"
6. **VALUE_PROP is truth.** All relevance decisions flow from `DOCS/VALUE_PROP.md`. If it's incomplete, stop and fix it before proceeding.
7. **No invented facts.** Thin data produces thin output. Never fabricate intel, scores, or contacts.
8. **Client = person.** Every client record must have a real human name. No placeholder names.

## Numbered Orchestrator Procedure

The pseudocode above is the conceptual model. Below is the literal procedure any orchestrator (goose, hermes, claude code, or any tool-calling LLM with a large enough context window) follows. Each step is one tool call. Branch only where stated. The agent's job is judgment at branches; the control flow is fixed.

1. **Open session.** `precrime__pipeline({ action: "start_session", workflow: "<name>", target_count: N })`. Hold the returned `session_id`.
2. **Pop work.**
   - URL queue: `precrime__pipeline({ action: "next_source", session_id, channel?: "<filter>" })`. Returns `CLAIMED` (with the source row) or `QUEUE_EMPTY`.
   - Client queue: `precrime__pipeline({ action: "next", criteria: { lastEnrichedBefore: "<30d ago ISO>" } })`.
3. **Branch on empty.** Got `QUEUE_EMPTY` (or null) -> Step 7 (grow). Else -> Step 4.
4. **Scrape / process.** `tavily__tavily_extract` for URLs, or scrape the client's `targetUrls`. Extract findings.
5. **Save every finding, one tool call each.** `precrime__pipeline({ action: "save", session_id, patch })`. The server dedups, scores, and auto-promotes any booking that hits `leed_ready`. Repeat for every distinct company / contact / factlet on the page. Any new source URLs found mid-scrape -> `precrime__pipeline({ action: "add_sources", entries: [...] })`.
6. **Mark item processed.** URL queue: `precrime__pipeline({ action: "mark_source", url, clientsFound, failedReason? })` -- releases the 10-min claim, stamps `scrapedAt`. Client queue: set `lastEnriched` via `pipeline.save`. If `saved_this_session >= target_count` -> Step 8.
7. **Grow queue.** Run `skills/source-discovery.md` ONCE. It calls `pipeline.add_sources` per channel. New entries added -> Step 2. Nothing added -> Step 8.
8. **Close session.** `precrime__pipeline({ action: "report_session", session_id })`. Echo the result verbatim.
9. **Recurse upward.** If an outer flow (marketplace / outreach / hybrid / headless) called this loop, return control. The flow runs its own PRESENT step and decides whether to re-enter Step 1 based on its own delta-zero check.

### Recursion arms

The procedure recurses on three planes. Each arm is what makes a re-run discover more than the last:

- **Source recursion.** Every Step 5 scrape can pick up new source URLs from page text -> `pipeline.add_sources` writes them to the Source table -> a future Step 2 `next_source` pops them. (Implemented in `client-seeder.md` "Follow Links" and every harvester's "Source Growth" step. The `_sources.md` files are SEED-ONLY; read once at first deploy by `pipeline.import_sources`, never written to at runtime.)
- **Client recursion.** Every Step 5 save can spawn a thin client -> later picked up by Step 4 enrichment when its `lastEnrichedBefore` cursor catches up.
- **Booking recursion.** Every save auto-rescores attached bookings; a new factlet linked to an existing client can promote a previously-brewing booking to `leed_ready` on the next iteration.

### Termination

The whole system terminates ONLY when:
1. The URL queue is empty (every entry has a fresh `scraped:` stamp), AND
2. The client-needing-enrichment queue is empty (`pipeline.next` returns null), AND
3. The leed_ready queue is empty (or every entry was just posted/rejected), AND
4. ONE pass of `source-discovery.md` added zero new entries.

Until all four conditions hold, the agent stays in the loop. Empty page extracts, dedup hits, and low scores are NOT termination signals -- they are normal loop output.

### What is server-enforced vs agent-judged

| Concern | Owner | How |
|---|---|---|
| Empty patch rejection | Server | `pipeline.save` returns -32602 |
| Dedup by company | Server | `pipeline.save` merges by company name |
| Scoring + leed_ready promotion | Server | `score_target` runs on every save |
| Session truth (counts, failures) | Server | `report_session` event log |
| 3-min save-or-terminate watchdog | Server | applied to read actions |
| 60s cooldown on workflow re-open | Server | `start_session` |
| Loop continuation between steps | Agent | follow the numbered procedure |
| Relevance / classification / extraction | Agent | judgment per `shared/*` rules |
| Termination decision | Agent | the four conditions above |

The agent's intelligence is spent on judgment (is this contact a competitor? is this factlet a buying signal? is this dossier rich enough for a draft?). The control flow is a state machine -- not improvisation.
