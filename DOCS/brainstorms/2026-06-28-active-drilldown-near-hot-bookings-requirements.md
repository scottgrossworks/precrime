---
date: 2026-06-28
topic: active-drilldown-near-hot-bookings
focus: active drill-down on near-hot bookings instead of passive round-robin enrichment
mode: repo-grounded
---

# Active Drill-Down on Near-Hot Bookings

## Problem
PreCrime enriches live clients round-robin (stalest-first) and abandons them after a flat 3 find-passes. Brewing bookings that are **one field from hot** — a missing decision-maker email, an unconfirmed date, a missing venue zip, an org name instead of a person — sit in that pool and age out. Yet `classification.js` `classify()` already computes each booking's `missing[]` (the exact unmet hot prerequisites) and the planner discards it. The system never focuses effort on its closest leedz; it waits for the next generic pass to maybe fill a gap. Result: many brewing, ~0 hot.

## Core Outcome
When a booking is close to hot, the system **actively and preferentially drills down** to find its specific missing fields, escalating tools, and does **not** give up on near-hot bookings — turning "almost" into hot. Passive solitaire → active closing.

## Actors
- **Planner** (server, `plan_tasks`) — ranks live bookings by closeness, schedules drill-down ahead of routine enrichment.
- **DRILL_DOWN worker** (new skill) — given a booking + its missing fields, hunts only those, escalating tools.
- **Judge** (`judge_affected`) — unchanged; promotes to hot once prerequisites are met.
- **Seller / user** — approves any outreach. Drill-down itself never contacts anyone.

## Requirements
- **R1 — Use `missing[]`.** The planner reads each live booking's unmet hot prerequisites from `classify()` instead of discarding them.
- **R2 — Closeness-first scheduling.** Live bookings are worked in order of fewest missing fields (near-hot first), ahead of routine round-robin enrichment. A reserved slice still advances new/cold work so it isn't fully starved.
- **R3 — Field-targeted `DRILL_DOWN` task.** A task that receives a booking + its specific missing fields and searches **only** for those, escalating tools per gap: web search → the org's contact/about/staff page → LinkedIn/social → the event's own listing → (stop; hand to outreach for a human-approved ask).
- **R4 — Per-field playbooks.** Codified search recipes per missing field — decision-maker email, event-date confirmation, venue zip, person-not-org name — that the worker follows.
- **R5 — Tiered effort by closeness.** Replace the flat `MAX_FIND_PASSES` cap: ≤1-missing bookings get more passes + full tool escalation before giving up; far/cold ones keep a hard cap. Effort scales with how close to hot. (Supersedes the current blunt "abandon every live client at 3 passes".)
- **R6 — Urgency × closeness priority.** Drill-down priority weights both fields-missing AND time-to-event; a near-hot booking with a sooner event outranks a distant one.
- **R7 — Finish-one-leed mode.** An optional mode that concentrates the session's drill-down budget on the single highest-probability near-hot booking until it is hot or proven-dead.
- **R8 — No auto-outreach.** Drill-down fills data via research tools only; it never emails or contacts an organizer. Reaching a real contact for a pitch stays the existing, user-approved `DRAFT_OUTREACH` arm.
- **R9 — Persist progress.** A booking's missing fields + drill-down attempts persist across runs so effort compounds (don't re-derive each session) and confirmed dead-ends are remembered.

## Success Criteria
- A near-hot booking (≤1 missing field) gets a focused `DRILL_DOWN` within the same session it's detected — not a generic enrichment pass.
- Hot leedz > 0 from previously-brewing bookings whose only gap was a findable field.
- A near-hot booking with a future event is not silently abandoned while still findable.
- Drill-down never sends outreach.

## Scope Boundaries
- **In:** planner closeness scheduling; the new `DRILL_DOWN` worker + per-field playbooks; tiered effort; urgency×closeness; finish-one-leed mode; persistence of missing/attempts.
- **Deferred for later:** cross-source date/budget verification beyond the source page; a human-in-the-loop "ask the organizer to confirm" automation.
- **Outside this product's identity:** auto-sending outreach; scraping behind logins; buying contact data.

## Key Decisions
- The **booking** (not the client) is the unit of closeness ranking; the drill-down still saves results to the client.
- `classify().missing[]` is the single source of truth for "what to chase."
- Drill-down is **research-only**; outreach stays a separate, approval-gated arm (R8).
- **Tiered effort replaces the flat cap** — this supersedes the recent blunt 3-pass abandonment of all live clients.

## Open Questions (for planning)
- Exact closeness/urgency scoring formula and the reserved-slice ratio that keeps cold/new work from being fully starved.
- Whether `DRILL_DOWN` is a distinct task type or a parameterized variant of `FIND_CLIENT_SOURCES`/`ENRICH_CLIENT`.
- Per-field tool availability (is LinkedIn reachable? which MCP/tools the worker may escalate through).
