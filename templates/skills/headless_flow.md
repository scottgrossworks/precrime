---
name: headless-flow
description: Headless marketplace pipeline. Zero questions, auto-post leedz, recurse until queues exhausted.
triggers:
  - run headless
  - headless mode
  - autonomous run
---

# Headless Flow

The non-interactive pipeline. The user is not at the keyboard. Run start to finish, post leedz automatically as they qualify, recurse until every queue is exhausted, then exit.

This is the marketplace pipeline minus every approval gate. If you find yourself wanting to ask the user a question, the answer is "decide deterministically and continue."

---

## Hard rules (override anything in upstream skills)

- **Zero questions, of any kind.** No setup, no confirmations, no per-leed approval. Skip every "show to user / wait for approval / user confirms" line in every sub-skill. Replace each with "post immediately" or "log and continue."
- **Auto-post.** When `skills/share-skill.md` says "ask `Post this leed?`" -> post it. Use `leedz__createLeed` directly with the validated payload.
- **No conversational filler.** No "Got it." No "Here's what I found." Tool calls and final report only.
- **Final report only.** All progress goes to `logs/ROUNDUP.md`. ONE terminal report at the end.
- **STOP only on:** missing required config field, OR unrecoverable tool error. STOP names the field/error and exits.
- **Per-step cap 20 min, per-URL cap 30 sec.** On cap, log and continue.

---

## Pipeline

1. **Mode latch.** Set `HEADLESS = true`, `SESSION_AI = { gemini: null, grok: null }`. Skip the browser probe in `skills/shared/mode-detect.md`.

2. **Triage existing queue first.**
   ```
   precrime__find({ action: "bookings", filters: { status: "leed_ready" }, limit: 50 })
   ```
   Any leed_ready -> jump to Step 8. Posting an existing leed costs almost nothing; harvesting is expensive.

3. **Source discovery.** Follow `skills/source-discovery.md`. It calls `pipeline.add_sources` per channel; the Source table grows.

4. **URL loop.** Follow `skills/url-loop.md`. Pop / scrape / save / mark / repeat to Step 7 of that skill. url-loop scrapes ONLY `directory` / `blog` / `website` channels (Tavily-friendly). It NEVER claims fb/ig/x rows -- those are owned by Step 5 harvesters (which themselves skip in headless because Tavily cannot render them).

5. **Harvesters, in order, no stopping.**
   - `skills/rss-factlet-harvester/SKILL.md`
   - `skills/reddit-factlet-harvester/SKILL.md`
   - `skills/x-factlet-harvester/SKILL.md` (Tavily fallback path only -- no Grok in headless)
   - **SKIP** `skills/fb-factlet-harvester/SKILL.md` -- log `FB_SKIPPED_HEADLESS`. Browser only.
   - **SKIP** `skills/ig-factlet-harvester/SKILL.md` -- log `IG_SKIPPED_HEADLESS`. Browser only.
   - Skip any harvester whose channel has zero rows in the Source table (a `next_source({channel:"<x>", maxAgeDays:0})` call returning `QUEUE_EMPTY` immediately).

6. **Client seeding.** Follow `skills/client-seeder.md`. Use `tavily__tavily_extract` for every scrape (no Chrome).

7. **Enrichment.** Follow `skills/enrichment-agent.md`. Skip its `SESSION_AI` branches; use Tavily for every URL.

8. **Health check + auto-post.**
   ```
   precrime__pipeline({ action: "rescore", scope: "leed_ready" })
   precrime__find({ action: "bookings", filters: { status: "leed_ready" }, limit: 50 })
   ```
   For each leed_ready booking:
   - Build the addLeed payload via `skills/leed-drafter.md`.
   - Quality check via `skills/draft-checker.md` with `mode: marketplace`.
   - `verdict = brewing` -> save with `status: "needs_enrichment"`, log reason, next booking.
   - `verdict = ready` -> `leedz__createLeed(payload)`. Quote the literal response payload. Then save with `status: "shared"`, `leedId`, `sharedAt`.

9. **RECURSE if work remains.** Sum the deltas across this iteration:
   - Step 3 source-discovery added 0 entries, AND
   - Step 4 url-loop produced 0 saves, AND
   - Step 5 harvesters created 0 factlets, AND
   - Step 6 seeding created 0 clients, AND
   - Step 7 enrichment promoted 0 bookings, AND
   - Step 8 posted 0 leedz
   - -> **terminal.** Write the final report to `logs/ROUNDUP.md`. Exit.

   Otherwise -> **GOTO Step 2.** The system is built to run continuously across iterations: each scrape feeds new sources, each save can promote a booking, each new factlet can re-qualify a previously brewing client.

10. **On share error: STOP.** Log full payload + error response to `logs/ROUNDUP.md`. Do not retry. Do not skip to the next booking. Exit.

---

## Override map -- interactive vs headless

| Sub-skill / step | Interactive | Headless |
|---|---|---|
| `init-wizard.md` Step 3 mode menu | ask user (1/2/3) | latch marketplace, no menu |
| Separate mode probe | skip | skip, set HEADLESS=true |
| FB / IG harvesters | scrape via Chrome | skip, log `*_SKIPPED_HEADLESS` |
| `share-skill.md` approval gate | ask `yes/no/edit` | post immediately |
| `outreach-drafter.md` | compose for human review | not invoked in headless |
| Per-step "should I continue?" | rail (never asked) | rail (never asked) |

---

## Tool-call honesty

When you claim `leedz__createLeed` succeeded, quote the literal `result` payload from the response. CloudWatch and DynamoDB are audited. Faking a success is the worst possible failure mode in headless because no human is watching to catch it. If you cannot quote a real response, the call did not happen -- re-issue it.
