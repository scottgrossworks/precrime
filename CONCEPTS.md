# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Pipeline roles

### Planner
The server-side procedural component that decides what work exists and enqueues it as Tasks; it never reasons with an LLM. It owns sequencing and suppression — which kinds of work pause while higher-priority work is pending — and does all fan-out (candidate selection) so Workers receive pre-scoped inputs.

### Conductor
The procedural loop that drives execution: it polls the Task queue, claims ready Tasks, spawns one one-shot Worker per Task, and marks each Task done or failed. Like the Planner it runs no LLM; unlike the Planner it owns dispatch and Worker process lifecycle, not the decision of what work exists.

The Conductor never reads a Worker's output directly — results reach the system only through the shared data store, so a Worker's context dies with its process and cannot accumulate. It also self-feeds: when the ready queue drains it asks the Planner to enqueue more, so a run continues without external prompting.

### Worker
A single-purpose agent skill that claims one Task, performs one bounded action, and stops. A Worker never plans, never scores, and never sets trusted outcome state; it does exactly one mutation and reports completion.

### Judge
The sole server-side authority that promotes a Booking to the actionable (hot) state, combining procedural qualification gates with an LLM product-market-fit verdict. Workers may demote a Booking but may never promote it — promotion exists only inside the Judge.

### Presenter
The role that surfaces actionable results to the user and routes an approved action — a marketplace post or an outreach email — once the user confirms.

## Work and sources

### Task
One unit of queued work carrying a type, a target, and a claim. A Task is claimed atomically by exactly one Worker, runs to a terminal state (done, failed, or cancelled), and is retained as an audit trail. A claim left stale beyond a timeout becomes reclaimable by another Worker.

### Source
A dereferenceable place to scrape for prospects — a directory, feed, page, or social account. The source list lives in per-channel markdown files under `data/sources/` (deployment data, the single source of truth); the server loads them into an in-memory index at startup and is the sole writer. A Source found by `DISCOVER_SOURCES` or while scraping another (recursion) is appended via `add_sources`, which is how discovery grows the list.

### Factlet
A reusable piece of demand evidence — an event date, buying occasion, budget clue, or market trend — captured independently of any single Client, then matched to the Clients it mentions. A Factlet is standalone: it is not owned by a Client and may inform several.

## Sales entities

### Client
A prospective buyer record, a person or an organization. Sparse company-only Clients are allowed; enrichment fills in the named person and a direct contact later.

A Client is *live* when it has a future-dated Booking and *dead* otherwise. Enrichment and source-finding only ever touch live Clients — that selective work, not deletion, is the pruning ("prune the work, not the data"), so a Client is never removed just for going dead.

### dossier
The accumulated, timestamped intelligence about one Client, written as permanent facts plus dated signals. It is the Client's memory and the raw material from which outreach is drafted.

### Booking
A specific opportunity to sell — a trade plus a date plus a location — attached to one Client. Its actionable state is owned by the Judge, and acting on a Booking returns it out of the actionable pool.

### Leed
The marketplace term for a shareable Booking opportunity posted to the external Leedz marketplace.
*Avoid:* lead (when the marketplace-post sense is meant)

### Booking status — cold / brewing / hot
The three classification states of a Booking. *cold* = missing a mandatory qualification; *brewing* = qualified but not yet judged a market fit; *hot* = the Judge confirmed it is actionable. Workers may demote a Booking to cold or brewing; only the Judge sets hot, and acting on a hot Booking returns it to cold.

### near-hot booking
A live (future-dated) Booking that is only one or two hot prerequisites short of qualifying — e.g. it has everything but a confirmed event time, or but a direct decision-maker email. Closeness is measured by how few prerequisites are still missing; the planner ranks near-hot bookings ahead of routine work and actively drills down on them.

### drill-down
The research-only act of closing a near-hot Booking: a focused task that hunts the Booking's *specific* missing fields (a direct contact, an event date/time, a venue zip, a named decision-maker) using search/extract tools, then saves them so the Judge can promote it. Drill-down never contacts anyone — outreach stays a separate, user-approved step.

### container (event class)
A Booking whose event is a public, multi-vendor, or competitive gathering — a convention, expo, trade show, festival, fair, or tournament — classified `container` rather than `direct`. A container is not itself a sellable Leed: its opportunity is the organizer, the vendors/exhibitors, and/or the crowd, never the event's subject. A container drill finds the named organizer and expands each *fitting* vendor into its own Booking that inherits the event's date and venue. A `direct` event, by contrast, is a single private host — a wedding, a company party. (An earlier three-way convention/festival/direct split was collapsed into this binary.)

### fit gate
An LLM product-market-fit check — "would this buyer plausibly hire or buy the seller's product for this event?" — run at a decision point to avoid spending effort on irrelevant prospects. It judges VALUE_PROP relevance signals (booth traffic, a crowd, an activation or entertainment need), not topic match, so an unrelated trade show can still fit while a closed B2B event does not. The fit gate is the LLM half of the Judge's promotion decision, and also runs standalone to gate expensive work — e.g. a container vendor must pass the fit gate before a Worker is spent drilling it.
