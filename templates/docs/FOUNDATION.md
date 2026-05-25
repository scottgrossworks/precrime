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

## Function-to-Tool Mapping (Planner / Worker / Judge / Presenter)

| Function | Tool Call |
|----------|----------|
| Read config / stats             | `precrime__pipeline({ action: "status" })` |
| Set config field                | `precrime__pipeline({ action: "configure", patch })` |
| Planner: enqueue Task batch     | `precrime__pipeline({ action: "plan_tasks", mode: "workflow" \| "headless" \| "hot_only" })` |
| Worker: claim one Task          | `precrime__pipeline({ action: "claim_task", role, types? })` |
| Worker: complete one Task       | `precrime__pipeline({ action: "complete_task", taskId, status, output, error? })` |
| Save / update record (worker)   | `precrime__pipeline({ action: "save", id?, judge: false, patch })` |
| Judge: rescore affected records | `precrime__pipeline({ action: "judge_affected", clientIds?, bookingIds? })` |
| Presenter: build / post leed    | `precrime__pipeline({ action: "share_booking", bookingId, mode: "draft" \| "post", timezone })` |
| Structured date validator       | `precrime__pipeline({ action: "resolve_dates", start, end, timezone, ... })` |
| Recycler: stale Factlets / old Tasks | `precrime__pipeline({ action: "recycler", dryRun? })` |
| List Tasks (audit / debug)      | `precrime__pipeline({ action: "tasks", status?, type?, sessionId? })` |
| Source seed + queue growth      | `precrime__pipeline({ action: "import_sources" })` / `add_sources` |
| Search clients                  | `precrime__find({ action: "clients", filters, summary: true })` |
| Search bookings                 | `precrime__find({ action: "bookings", filters })` |
| Search factlets                 | `precrime__find({ action: "factlets", filters })` |
| Get trade list                  | `precrime__trades()` |
| Fetch RSS articles              | `precrime_rss__get_top_articles({ limit })` |
| Web search / extract            | `tavily__tavily_search({ query })` / `tavily__tavily_extract({ url })` |
| Send email                      | `gmail__gmail_send({ to, subject, body })` |
| Post marketplace leed (LEGACY)  | `leedz__createLeed` -- forbidden for normal sharing; `share_booking(mode:"post")` is the only sanctioned path. |

Workers always pass `judge: false` on `pipeline.save`. The Planner converts a completed Task's `output.clientIds` / `output.bookingIds` into a `JUDGE_AFFECTED` Task; the Judge then runs canonical scoring (`computeBookingTargetScore` over `DOCS/SCORING.json`) and writes the resulting `Booking.status`. There is no separate "rescore" call in this architecture.

See `DOCS/SCORING.json` for the algorithm and gates.

## Invariants

1. **Dedup always.** Check `precrime__find exactCompany` before every create. Server enforces as last resort.
2. **Log always.** Every action, every skip, every error goes to `logs/ROUNDUP.md`.
3. **Never stop on error.** Log it, skip the item, continue to the next one.
4. **Results at the end.** Run the full pipeline before presenting anything to the user.
5. **Never ask permission between steps.** The pipeline runs until it reaches PRESENT. A low score means keep enriching. A thin dossier means keep scraping. The only question the user hears is at the end: "Share this leed?" or "Send this draft?"
6. **VALUE_PROP is truth.** All relevance decisions flow from `DOCS/VALUE_PROP.md`. If it's incomplete, stop and fix it before proceeding.
7. **No invented facts.** Thin data produces thin output. Never fabricate intel, scores, or contacts.
8. **Client = person.** Every client record must have a real human name. No placeholder names.

## Orchestrator Procedure (Planner-driven)

The conceptual `PRECRIME(sources, clients)` pseudocode above is implemented as a server-side **Planner** that enqueues `Task` rows and a thin client-side **orchestrator** that drains them. The LLM is no longer responsible for global control flow.

The orchestrator is `skills/headless_flow.md` in headless mode, or `skills/init-wizard.md` -> `RUN_WORKFLOW` / `SHOW_HOT_LEEDZ` route in interactive mode. Both follow the same dispatch shape:

1. **Plan.** `precrime__pipeline({ action: "plan_tasks", mode })`. Server enqueues `Task` rows up to per-type limits from `precrime_config.json` (`tasks.limits`). Hot `SHARE_BOOKING` Tasks come first in `mode:"headless"`; `SHOW_HOT_LEEDZ` comes first in `mode:"hot_only"`.
2. **Drain.** Loop: `precrime__pipeline({ action: "claim_task", role })` -> dispatch by `task.type` -> `precrime__pipeline({ action: "complete_task", taskId, status, output })`.
3. **Replan.** When `claim_task` returns `NO_TASK`, call `plan_tasks` again. The Planner converts completed worker Tasks into `JUDGE_AFFECTED` Tasks via `extractAffectedIds(output)`, schedules `APPLY_FACTLET` Tasks for live unassimilated Factlets, and re-enqueues stale `ENRICH_CLIENT` candidates.
4. **Exit.** When `plan_tasks` creates `0` Tasks in every type AND `claim_task` returns `NO_TASK`, the queue is permanently empty for this run.

### Dispatch table

| `task.type`        | Handler |
|--------------------|---------|
| `SCRAPE_SOURCE`    | `skills/url-loop.md` (worker self-claims in interactive; orchestrator pre-claims in headless and hands off at Step 2). |
| `ENRICH_CLIENT`    | `skills/enrichment-agent.md` (same handoff convention). |
| `APPLY_FACTLET`    | `skills/apply-factlet.md`. |
| `SHOW_HOT_LEEDZ`   | `skills/show-hot-leedz.md` (interactive only; cancelled in headless). |
| `SHARE_BOOKING`    | Orchestrator calls `share_booking(mode:"post")` and completes the Task. Never `leedz__createLeed`. |
| `JUDGE_AFFECTED`   | Orchestrator calls `judge_affected(clientIds, bookingIds)` from `task.input` and completes. |
| `DISCOVER_SOURCES` | Orchestrator runs one bounded `tavily_search` keyed by `defaultTrade` + geography, feeds results to `add_sources`, completes. |

### Recursion arms (Task-based)

The system still recurses on three planes; the implementation is now expressed in Task transitions rather than agent loops:

- **Source recursion.** A `SCRAPE_SOURCE` worker may save new source URLs via `add_sources`. The next `plan_tasks` pass enqueues fresh `SCRAPE_SOURCE` Tasks for them.
- **Client recursion.** A `SCRAPE_SOURCE` or `ENRICH_CLIENT` worker may create thin Clients via `pipeline.save({ judge:false })`. The next `plan_tasks` pass picks them up as `ENRICH_CLIENT` candidates.
- **Booking recursion.** Every completed worker Task with affected `clientIds` / `bookingIds` becomes a `JUDGE_AFFECTED` Task on the next planner pass. Judge re-evaluates `Booking.status` via `computeBookingTargetScore` against `DOCS/SCORING.json` -- a newly-assimilated Factlet on the client dossier can promote a previously-brewing Booking to `leed_ready`.

### Termination

The orchestrator terminates ONLY when, in the same iteration:
1. `claim_task` returns `NO_TASK` for every type, AND
2. The subsequent `plan_tasks` call enqueues `0` new ready Tasks in every type.

Until both conditions hold, the orchestrator stays in Step 2 -> Step 3. Empty page extracts, dedup hits, and low scores are NOT termination signals -- they are normal worker output.

The Recycler (`pipeline.recycler`) runs at startup to delete stale Factlets, purge old finished Tasks, and re-queue timed-out claimed Tasks per `precrime_config.json` (`recycler.factletStaleDays`, `taskRetentionDays`, `claimTimeoutMinutes`).

### What is server-enforced vs agent-judged

| Concern | Owner | How |
|---|---|---|
| Per-type Task limits          | Server (Planner) | `plan_tasks` reads `precrime_config.json` `tasks.limits`. |
| Atomic Task claim             | Server | `claim_task` flips `ready` -> `claimed` in one transaction. |
| Reclaim stuck claims          | Server | `plan_tasks` and `recycler` requeue Tasks past `claimTimeoutMinutes`. |
| Empty patch rejection         | Server | `pipeline.save` returns -32602. |
| Dedup by company              | Server | `pipeline.save` merges by company name. |
| Scoring + status promotion    | Server (Judge) | `judge_affected` -> `computeBookingTargetScore` -> `Booking.status`. |
| `share_booking` date math     | Server | `resolve_dates` from structured Booking fields + IANA timezone. Rejects LLM-supplied `st`/`et`. |
| Worker control flow           | Agent  | follow the one-Task skill file top-to-bottom. |
| Relevance / classification    | Agent  | judgment per `skills/shared/*` rules. |
| Dispatch on Task type         | Agent  | one switch on `task.type` in the orchestrator. |
| Termination decision          | Agent  | the two conditions above. |

The agent's intelligence is spent on judgment within a single Task (is this contact a competitor? is this factlet a buying signal? is this dossier rich enough?). The control flow is a state machine -- not improvisation.
