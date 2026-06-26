# Pre-Crime — Conceptual Foundation

Pre-Crime is a recursive intelligence-gathering system. It discovers people and organizations who are likely to buy what you sell, learns about them, and produces actionable sales opportunities.

## The Goal

Every object in the system is moving toward one of two end states:

1. **Leed shared to marketplace** — a booking that passes share-ready gates (hot status, verified contact, zip, description), posted via the Leedz API.
2. **Outreach email sent** — a draft composed from a rich dossier, approved by the user, delivered via Gmail.

Everything else is **brewing**. A client at score 0 is brewing. A factlet not yet linked is brewing. A booking missing a zip code is brewing. A source not yet scraped is brewing. The system's job is to move every object from brewing toward an end state. A low score is not a problem to report — it is the fuel that keeps the pipeline running.

## The Core: Demand Signal

A woman's hair catches fire at her desk. We email her a bucket of water at that moment, we make the sale. Five minutes early, next day, or the coworker next to her with fine hair: no sale. Cold outreach without a demand signal is selling buckets to people whose hair is not on fire. PRECRIME's job is to predict combustion, or detect it the instant it happens, and arrive with VALUE_PROP framed as the bucket.

A booking is **share-ready** only when a demand signal is present. Demand signal is assessed by the LLM Judge and stored as `Booking.status = hot`. The verdict persists — it is not recomputed on every enrichment. Call `judge_affected` (or let the conductor schedule a `JUDGE_AFFECTED` task) to re-evaluate. Two sources: **explicit** (source literally states the need: "looking for X", RFP, inbound inquiry) or **inferred** (factlets stack into an argument the agent can state out loud). Without one, a complete booking is **outreach-ready**, not share-ready.

Inferred archetype (the Prom Pattern). Five slots, all required: (1) named decision-maker for VALUE_PROP's category, (2) concrete event with a date inside the conversion window, (3) public precedent of buying this category before, (4) pattern of publicly crediting vendors, (5) thematic fit for this specific instance. Canonical case: activity director, prom in 60 days, past gallery shows caricature booth, school posts thank-yous to prior vendors, this year's theme matches the pitch. Transpose the nouns for other verticals (corporate planner + holiday party, brewery + tap takeover, etc.). Fewer than 5/5 slots filled = `outreach_ready`. Empty slots are the next enrichment target.

## The Process

The process is recursive: every step can discover inputs for itself or any other step. Scraping a directory finds clients AND links to more directories. Processing an RSS article finds intel AND links to new RSS feeds. Enriching a client finds booking signals AND references to other potential clients. When you discover new inputs, add them to the queue and keep going.

**Sources vs Clients.** A convention organizer, a venue, a vendor directory, an event calendar — these are SOURCES, not Clients. Their value is the list of buyers they reveal: a convention's exhibitor list, a venue's preferred-vendor page, a calendar's event organizers. Scrape the source, harvest the exhibitors/organizers/planners, THOSE become Clients (a brand exhibiting at a convention is a real buyer for booth-enhancement VALUE_PROP). Then enrich those clients until a demand signal appears. The recursive loop is: source → clients → enrich → demand signal → end state. Keep digging. Zero saves from one URL is not a failure; it is a signal to discover more sources.

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
    show results that reached an end state — ready bookings, ready drafts
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
| Post marketplace leed | `precrime__pipeline({ action: "share_booking", bookingId, mode })` -- the server builds the payload and computes `st`/`et`; external Leedz tools are not exposed to the agent |

Judging runs via explicit `JUDGE_AFFECTED` tasks dispatched by the conductor, or by calling `pipeline.judge_affected` directly. It does not run on every save.
See `DOCS/SCORING.json` for tuning knobs (factlet thresholds, generic email prefixes, etc.).
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
