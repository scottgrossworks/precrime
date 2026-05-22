---
name: outreach-flow
description: Outreach pipeline -- compose emails to high-probability clients.
triggers:
  - run outreach
  - outreach mode
---

# Outreach Flow

Run the outreach pipeline. Same DISCOVER -> ENRICH -> PRESENT pattern as marketplace flow, but the output is outreach emails instead of marketplace leedz.

**Do not stop between steps.** Keep going until PRESENT.

---

## Pipeline

1. **Use latched mode.** Init-wizard/GOOSE already selected the rail. Do not run a separate mode probe.
2. **Source discovery.** `skills/source-discovery.md`
3. **Harvesters.** All enabled harvesters in order (RSS, FB, Reddit, X, IG). Skip empty sources.
4. **Client seeding.** `skills/client-seeder.md`
5. **Enrichment.** `skills/enrichment-agent.md` -- includes draft composition for qualifying clients.
6. **PRESENT -- fetch ready drafts:**
   ```
   precrime__find({ action: "clients", filters: { draftStatus: "ready" }, summary: false, limit: 20 })
   ```
   For each client with a ready draft:
   - Show the draft to the user.
   - `skills/draft-checker.md` with `mode: outreach`.
   - If `ready` -> ask: `Send this email? (yes / edit / skip)`
     - `yes` -> send via `gmail__gmail_send`, then mark `draftStatus: "sent"`, `sentAt: now`.
     - `edit` -> loop.
     - `skip` -> leave as `ready`.
   - If `brewing` -> log reasons, leave as `brewing`.

7. **RECURSE if work remains.** Sum the deltas across this iteration:
   - Step 2 source-discovery added 0 entries, AND
   - Step 3 harvesters created 0 factlets, AND
   - Step 4 seeding created 0 clients, AND
   - Step 5 enrichment composed 0 new drafts, AND
   - Step 6 PRESENT yielded 0 ready drafts
   - -> **terminal.** All queues empty. Stop.

   Otherwise -> **GOTO Step 2.** Each iteration uncovers more: a new factlet can re-qualify a brewing client; a freshly-found email can lift a thin contact past `contactGate`; a new directory feeds the next seed pass. The pipeline is built to recurse, not to be re-launched manually.

---

## Rules

1. Never auto-send. Every email requires user `yes`.
2. `gmail__gmail_send` then `pipeline.save draftStatus: "sent"` are atomic. Never mark sent without sending.
3. If send fails, leave as `ready` and log the error.
