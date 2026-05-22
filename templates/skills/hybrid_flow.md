---
name: hybrid-flow
description: Interactive exploration -- present each lead, user decides share/draft/skip per lead.
triggers:
  - hybrid mode
  - explore leads
---

# Hybrid Flow

Conversational mode. Run discovery and enrichment, then present each actionable lead to the user. User decides per-lead what to do.

---

## Pipeline (same as marketplace, no stopping between steps)

1. **Use latched mode.** Init-wizard/GOOSE already selected hybrid/interactive. Do not run a separate mode probe.
2. **Triage existing queue first.** Check `precrime__find({ action: "bookings", filters: { status: "leed_ready" } })` AND `precrime__find({ action: "bookings", filters: { status: "outreach_ready" } })`. If any exist, go straight to PRESENT (Step 8) before harvesting.
3. **Source discovery.** `skills/source-discovery.md`
4. **URL loop.** `skills/url-loop.md`
5. **Harvesters** (all, in order, skip empty sources): RSS, FB, Reddit, X, IG.
6. **Client seeding.** `skills/client-seeder.md`
7. **Enrichment.** `skills/enrichment-agent.md`

---

## Step 8: PRESENT

Fetch:
```
precrime__find({ action: "bookings", filters: { status: "leed_ready" }, limit: 20 })
precrime__find({ action: "bookings", filters: { status: "outreach_ready" }, limit: 20 })
precrime__find({ action: "clients", filters: { draftStatus: "ready" }, limit: 20 })
```

For each lead, show status + summary:

```
[Client Name] -- [event] -- status: leed_ready | outreach_ready -- score: X
  (s) Share on marketplace   [only if leed_ready]
  (d) Draft outreach email
  (k) Skip
```

`outreach_ready` bookings cannot be shared (no demand signal). Hide the `(s)` option and tell the user: `no demand signal yet — draft only`. Wait for answer.

- `s` -> follow `skills/share-skill.md` (marketplace rail)
- `d` -> follow `skills/outreach-drafter.md` then show draft, ask `send to gmail drafts? (yes/edit/skip)`
  - yes -> `gmail__gmail_send` with `draft: true`, mark `draftStatus: "sent"`
  - edit -> loop
  - skip -> leave as ready
- `k` -> next lead

After all leads presented, say: `Done. X shared, Y drafted, Z skipped.`

---

## Rules

- This is the only mode with per-lead dialog. Marketplace and outreach are hard rails.
- Never batch decisions. One lead at a time.
- Never auto-send. Every action requires user confirmation.
