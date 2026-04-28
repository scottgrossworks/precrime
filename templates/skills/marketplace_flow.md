---
name: marketplace-flow
description: Marketplace mode pipeline. Generate leedz with high probability of conversion and share to The Leedz marketplace via the addLeed API.
triggers:
  - run marketplace
  - share leedz
  - marketplace mode
  - run precrime marketplace
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# Marketplace Flow

## Goal

Generate leedz with **HIGH PROBABILITY OF CONVERSION** and share them to The Leedz marketplace. A leed is "high probability" when `score_target` says `shareReady: true` — driven by data completeness AND by relevant, fresh factlets connecting the client to `DOCS/VALUE_PROP.md`.

**Out of scope (do not do here):**
- Drafting outreach emails — see `skills/outreach_flow.md`
- Tuning scoring weights — see `DOCS/SCORING.md`
- Asking the user where to find sources — use seed files only

---

## Hard Gates (every leed)

| Gate | Rule |
|------|------|
| Trade | Must match `precrime__trades()` (lowercase). Determined from `DOCS/VALUE_PROP.md` by `init-wizard.md`. |
| `pr` | Always `0` (free) |
| `email` | Always literal string `"false"` (broadcast suppressed) |
| Share path | Only via `skills/share-skill.md`. No raw curl in this skill. |
| Booking shareReady | Comes from `precrime__pipeline({ action: "next" })` scoring only. Do not invent gates. |

---

## Pipeline

Run sequentially. On step error, log to `logs/ROUNDUP.md` and continue. Per-step cap: 20 min. Per-URL cap: 30 sec.

1. **`skills/source-discovery.md`** — expand source lists from VALUE_PROP.md + `*_sources.md` seeds.
2. **`skills/convention-leed-pipeline.md`** — search local conventions, harvest convention factlets, create exhibitor clients.
3. **All enabled `skills/*-factlet-harvester/SKILL.md`** per Config (`rss` / `fb` / `ig` / `reddit` / `x`). Each harvester calls `relevance-judge.md` per factlet.
4. **`skills/client-seeder.md`** — for clients without contacts, find named contact (name + email + phone).
5. **`skills/enrichment-agent.md`** — link relevant factlets to clients, extract Bookings (trade + date + location + contact).
6. **For each Booking with `status = "new"`:**
   ```
   precrime__pipeline({ action: "next", id: bookingId })
   ```
   Read `shareReady` from response.
7. **If `shareReady = true`:**
   1. `skills/leed-drafter.md` — build addLeed JSON payload.
   2. `skills/draft-checker.md` with `mode: marketplace` — quality check the payload.
   3. If verdict = `brewing` → log reason, mark `Booking.status = "needs_enrichment"`, continue to next booking.
   4. If verdict = `ready` → proceed to step 8.
8. **Mode branch:**
   - **Interactive:** print full JSON (every field, no truncation per `share-skill.md` Rule 8). Ask `yes / no / edit`. On `no` → mark `status: "hold"`, log `USER_DECLINED_SHARE`. On `edit` → loop. On `yes` → step 9.
   - **Headless:** skip preview, proceed to step 9.
9. **`skills/share-skill.md`** Step 2a — POST to Leedz `addLeed`.
10. **On success:**
    ```
    precrime__pipeline({ action: "save", id, patch: { leedId, status: "shared", sharedTo: "leedz_api", sharedAt: Date.now() } })
    ```
11. **On share error: STOP the entire workflow.** Save full payload to `logs/ROUNDUP.md`, log error with HTTP code/message, exit. Do not retry. Do not skip to next booking — the system may be misconfigured.

---

## Logging — `logs/ROUNDUP.md`

```
SHARED: {trade} / {startDate} / {location} → leedId {id}
NEEDS_ENRICHMENT: {trade} / {client.name} → {draft-checker reason}
DECLINED: {trade} / {startDate} → user said no
ERROR: {step} → {message}
```

---

## Rules

1. **Sources come from seed files.** Never ask the user where to look.
2. **`pipeline.next` shareReady is the only share gate.** Do not invent gates.
3. **`share-skill.md` is the only path to Leedz.** No curl here.
4. **On share error, STOP.** Do not chain retries. Diagnose first.
5. **Scoring is opaque to this skill.** Do not re-implement or duplicate `DOCS/SCORING.md`.
