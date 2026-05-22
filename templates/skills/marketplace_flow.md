---
name: marketplace-flow
description: Full workflow -- discover sources, harvest intel, enrich clients, share ready leedz.
triggers:
  - run marketplace
  - run workflow
  - share leedz
  - marketplace mode
---

# Marketplace Flow

Run the full Pre-Crime pipeline. See `DOCS/FOUNDATION.md` for the conceptual model: DISCOVER -> ENRICH -> PRESENT.

The spine is recursion: every source you scrape can produce clients, factlets, and more sources. Save the clients/factlets immediately. Add every relevant new URL to the Source table immediately. Then keep following the queue with the source-specific skill that owns that channel. The workflow is not "one pass then stop"; it is "process everything newly discovered until the queues stop producing useful work."

## Triage before harvest

First, inventory existing share-ready work:
```
precrime__find({"action":"bookings","filters":{"status":"leed_ready"}})
```
If any leed_ready bookings exist, jump to Step 8 PRESENT and post them. If the result is `[]`, immediately continue to Step 1. Empty ready queue is not a stop condition.

Otherwise run Steps 1-8 in order. Non-interactive rail per GOOSE.md: no menus, no "should I continue?" between steps. Only valid stop is Step 8 PRESENT or unrecoverable error.

---

## Pipeline

1. **Work status.** Call:
   ```
   precrime__pipeline({ action: "work_status" })
   ```
   If `recommendation = "present"` go to Step 8. If `recommendation = "process_sources"` go to Step 3. If `recommendation = "enrich"` go to Step 6. If `recommendation = "discover_sources"` or `"done"`, go to Step 2. Never stop here.

2. **Source discovery.** Read and follow `skills/source-discovery.md`. It calls `pipeline.add_sources` per channel based on VALUE_PROP config; the Source table grows. When complete, proceed immediately.

3. **URL loop.** Read and follow `skills/url-loop.md`. It claims source rows via `pipeline.next_source` for Tavily-friendly URLs (`directory`, `rss`, `reddit`, `blog`, `website`). If the queue says empty, retry once with `maxAgeDays: 0` before moving on; old preserved source rows may have stale `scrapedAt` values but still need a fresh run in this deployment. Scrape full content, extract clients/factlets/sources, save each finding immediately, mark via `pipeline.mark_source`, and repeat. Any new URLs discovered here feed back into the same Source table.

4. **Channel harvesters -- run every one, in order, no stopping:**
   - `skills/rss-factlet-harvester/SKILL.md`
   - `skills/fb-factlet-harvester/SKILL.md`
   - `skills/reddit-factlet-harvester/SKILL.md`
   - `skills/x-factlet-harvester/SKILL.md`
   - `skills/ig-factlet-harvester/SKILL.md`
   - Each harvester owns its channel: claim source -> extract -> save clients/factlets -> add newly discovered sources -> mark source -> claim the next source for that channel. Skip a harvester only when both its seed import and Source channel are empty. When all complete, proceed.

5. **Client seeding.** Read and follow `skills/client-seeder.md`. Find named contacts for clients missing them. When complete, proceed.

6. **Enrichment.** Read and follow `skills/enrichment-agent.md`. Link factlets, scrape client URLs, score, compose drafts for qualifying clients.

7. **Health check -- rescore the leed_ready queue** before presenting anything:
   ```
   precrime__pipeline({ action: "rescore", scope: "leed_ready" })
   ```
   This demotes any bookings that no longer pass `DOCS/SCORING.json` (e.g., after policy was tightened). Only bookings that CURRENTLY qualify survive.

8. **PRESENT -- fetch all actionable results:**
   ```
   precrime__find({ action: "bookings", filters: { status: "leed_ready" }, limit: 50 })
   ```
   For each leed_ready booking:
   - Read and follow `skills/leed-drafter.md` to build the addLeed JSON.
   - Read and follow `skills/draft-checker.md` with `mode: marketplace` to quality check.
   - If verdict = `brewing` -> log reason, mark `status: "needs_enrichment"`, next booking.
   - If verdict = `ready` -> show full JSON to user. Ask: `yes / no / edit`.
     - `yes` -> follow `skills/share-skill.md` to POST.
     - `no` -> `skills/share-skill.md` skip path (demotes to `needs_enrichment`).
     - `edit` -> loop.

9. **RECURSE if work remains.** This is the heartbeat. Sum the deltas across this iteration:
   - Step 2 source-discovery added 0 entries, AND
   - Step 3 url-loop produced 0 client saves, 0 factlets, and 0 new sources, AND
   - Step 4 harvesters created 0 clients, 0 factlets, and 0 new sources, AND
   - Step 5 seeding created 0 clients, AND
   - Step 6 enrichment promoted 0 bookings, AND
   - Step 8 PRESENT yielded 0 leed_ready
   - -> **terminal.** All queues empty. Stop.

   Otherwise -> **GOTO Step 2.** Each iteration discovers more: a new factlet can re-qualify a brewing client; a new sparse client can become a real prospect during enrichment; a new directory/RSS/profile URL found mid-scrape feeds the next channel worker. The pipeline is built to recurse, not to be re-launched manually.

10. **On share error: STOP.** Log full payload to `logs/ROUNDUP.md`. Do not retry. Do not skip to next booking.

---

## Rules

1. Sources come from seed files. Never ask the user where to look.
2. Scoring is handled by `pipeline.save` automatically. Do not re-implement.
3. `share-skill.md` is the only path to the Leedz API. No direct curl.
4. On share error, STOP. Diagnose first.
