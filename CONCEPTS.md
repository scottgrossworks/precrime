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
A dereferenceable place to scrape for prospects — a directory, feed, page, or social account. Sources form a work-stealing queue and carry lineage: a Source discovered while scraping another records where it came from, which is how discovery recurses.

### Factlet
A reusable piece of demand evidence — an event date, buying occasion, budget clue, or market trend — captured independently of any single Client, then matched to the Clients it mentions. A Factlet is standalone: it is not owned by a Client and may inform several.

## Sales entities

### Client
A prospective buyer record, a person or an organization. Sparse company-only Clients are allowed; enrichment fills in the named person and a direct contact later.

### dossier
The accumulated, timestamped intelligence about one Client, written as permanent facts plus dated signals. It is the Client's memory and the raw material from which outreach is drafted.

### Booking
A specific opportunity to sell — a trade plus a date plus a location — attached to one Client. Its actionable state is owned by the Judge, and acting on a Booking returns it out of the actionable pool.

### Leed
The marketplace term for a shareable Booking opportunity posted to the external Leedz marketplace.
*Avoid:* lead (when the marketplace-post sense is meant)

### Booking status — cold / brewing / hot
The three classification states of a Booking. *cold* = missing a mandatory qualification; *brewing* = qualified but not yet judged a market fit; *hot* = the Judge confirmed it is actionable. Workers may demote a Booking to cold or brewing; only the Judge sets hot, and acting on a hot Booking returns it to cold.
