---
name: {{DEPLOYMENT_NAME}}-last-30-days
description: One-Task LAST_30_DAYS worker. Run the last30days research CLI on VALUE_PROP buyer-occasion topics, read its ranked_candidates JSON, and turn HIGH-SCORE dated-event candidates into Clients + Factlets + Bookings + Sources. last30days finds recent vendor-call posts for UPCOMING events (a dated event + venue + organizer on one already-fetched record) — exactly the event+contact pairing the scrape loop rarely gets. Research-only; never contacts anyone.
triggers:
  - last 30 days
  - seed demand
  - scan last 30 days
  - LAST_30_DAYS worker
---

<!-- DEPRECATED (2026-07-01): LAST_30_DAYS now runs IN-PROCESS as a procedural (zero-model)
     worker — server/mcp/workers/Last30DaysWorker.js — dispatched via the conductor's
     runInProcess hook, NOT as a spawned goose worker. This skill is retained for reference
     only and is no longer in WORKER_SKILL_MAP, so nothing dispatches it. Do not delete. -->

# last-30-days — LAST_30_DAYS worker (last30days seeder)

Process ONE already-claimed LAST_30_DAYS task: sense fresh demand with the external
`last30days` CLI and feed it into the pipeline as Clients / Factlets / Bookings / Sources.
You add DATA only — never contact anyone. Never call `claim_task`, `plan_tasks`,
`judge_affected`, `share_booking`, `gmail__gmail_send`, `next_source`, or `mark_source`.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- `precrime__pipeline({ action:"get_task", taskId })`. Not `{ type:"LAST_30_DAYS" }` → complete `failed` `wrong_task_type`, stop.

## Step 1 — Build 2–3 buyer-occasion topics from VALUE_PROP
`developer__shell(command="type \"DOCS\\VALUE_PROP.md\"")` (or `precrime__pipeline({action:"get_config"})`).
Build topics from trade + buyer/segment + geography + the year. Shape them as BUYING
OCCASIONS (events that hire the trade), not your own service name:
- `"wedding expo <city> 2026"` · `"<city> festival vendors 2026"` · `"corporate event entertainment <region> 2026"` · `"comic con <city> 2026"`
Pick 2–3 best-fit topics. You are sensing demand, not searching yourself.

## Step 2 — Run last30days per topic (research-only, no LLM key needed)
For each topic, run the CLI (keyless sources run free; IG/TikTok/X need keys from `precrime_config.json`):
```
developer__shell(command="python \"last30days/skills/last30days/scripts/last30days.py\" \"<topic>\" --emit=json > \"data/dr-<slug>.json\"")
```
If python/the script is missing or errors (non-zero, "No such file") → complete `cancelled`
`error:"LAST_30_DAYS_UNAVAILABLE: install last30days at last30days/skills/last30days/scripts/"`, stop.
Read the file: `developer__shell(command="type \"data\\dr-<slug>.json\"")` → parse JSON.

## Step 3 — Keep only HIGH-SCORE dated candidates
From `ranked_candidates` (each has `final_score`, `explanation`, `snippet`, `candidate_id`(url), and the source item's `author`):
- **KEEP** a candidate when `final_score >= 40` AND its `explanation`/`snippet` names a SPECIFIC future date (and ideally a venue). The tool's own `explanation` tells you ("date X and venue Y" = keep; "lacks a specific date" / "off-topic" = drop).
- **DROP** low-score (< 40) and anything the explanation flags as off-topic or undated.
Trust the score + explanation — do not re-rank by hand. Typically only a few of ~35 survive.

## Step 4 — Ingest each kept candidate (ONE save per candidate, judge:false)
The candidate body is ALREADY fetched (no re-scrape). Map it:
- **Organizer** = the post `author`/named org → the **Client**.
- **Dated event + venue** (from `snippet`/`explanation`) → a **Booking** (`dateText` verbatim, `location`, `sourceUrl`=the candidate url). The server resolves the date; if it rejects an unverifiable social URL, the **Factlet** below still carries the date for APPLY_FACTLET.
- **The post itself** → a demand **Factlet** (content = the snippet incl. date+venue+"seeking vendors", source = url).
```
precrime__pipeline({ action:"save", judge:false,
  patch:{ company:"<organizer/author>", website:"<if any>", source:"<candidate url>", draftStatus:"brewing",
    clientNotes:"last-30-days: <topic>",
    bookings:[{ dateText:"<verbatim date text>",
      location:"<venue>", zip:"<if present>", title:"<event name>", sourceUrl:"<candidate url>" }],
    factlets:[{ content:"<snippet: event, date, venue, 'seeking vendors'>", source:"<candidate url>" }] }})
```
Omit `bookings` if no date is present; omit `zip` if unknown. Also enqueue the candidate url as a Source for deeper recursion:
```
precrime__pipeline({ action:"add_sources", entries:[{ url:"<candidate url>", channel:"ig|reddit|x|website", discoveredFrom:"last-30-days:<topic>" }]})
```
Never invent a date or URL — copy verbatim from the candidate. Never write `Booking.status`.

## Step 5 — Complete
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[...affected], bookingIds:[...affected], factletIds:[], sourceIds:[],
    summary:"last-30-days: <topics> -> <K> kept of <N>, <clients> clients, <bookings> bookings, <factlets> factlets.", needsJudge:true }})
```
Nothing kept: `status:"done"`, summary `"last-30-days: no high-score dated candidates"`, `needsJudge:false`.
last30days unavailable/error: `status:"cancelled"`, `error:"LAST_30_DAYS_UNAVAILABLE: <reason>"`.
Never contact anyone. Never leave a claimed task open. Then STOP.
