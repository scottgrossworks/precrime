---
name: {{DEPLOYMENT_NAME}}-enrichment
description: One-Task ENRICH_CLIENT worker. Fold ONE pre-fetched source summary into one Client's dossier with judge:false, mark the summary consumed, complete, stop.
triggers:
  - enrich one client
  - run enrich client task
  - ENRICH_CLIENT worker
---

# enrichment-agent — ENRICH_CLIENT worker (synthesis only)

Process ONE already-claimed ENRICH_CLIENT task. It names one Client and carries one
pre-fetched source summary (`input.url` + `input.summary`, from find-client-sources).
Fold that summary into the dossier — nothing else. Never search, scrape, pick URLs,
create clients/bookings, or call `claim_task`, `plan_tasks`, `next`, `rescore`,
`judge_affected`, or Tavily.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- `precrime__pipeline({ action:"get_task", taskId })` → `clientId = task.targetId`,
  `url = task.input.url`, `summary = task.input.summary`.
- Not `{ type:"ENRICH_CLIENT", targetType:"Client" }` → complete `failed` `wrong_task_type`, stop.
- `summary` empty → complete `done` `needsJudge:false`, but still mark the entry consumed
  (Step 2) so it isn't retried.

## Step 1 — Load client
`precrime__find({ action:"clients", filters:{ id: clientId }, limit:1, summary:false })`
Capture `name`, `company`, `website`, `dossier`, `targetUrls`. Missing → complete `failed`.

## Step 2 — Synthesize (one LLM step)
Fold only facts about THIS client into the dossier; invent nothing. Format:
```
[PERMANENT] stable fact (role, venue type, recurring event, service area)
[YYYY-MM-DD] time-sensitive signal from <url>: buying occasion / event date / budget / trend
```
- Dedup: don't append a fact already covered; rewrite a line only if the summary is sharper/newer.
- Use today's date for new dated lines unless the summary states an explicit date.
- Set `email`/`phone` ONLY if the summary states a direct, non-generic one. No factlets/bookings here.
- **SYNERGY (container vendors only — `client.source` starts with `container:`):** this client
  arrived from a container drill-down (convention/expo/festival/fair/tournament) already carrying a thin
  inherited booking. Scan the summary for
  evidence of a fit between THIS exhibitor and the seller's service (read VALUE_PROP's RELEVANCE SIGNALS):
  have they used a service like ours before — e.g. a photo booth / caricaturist / entertainer at a prior
  booth or event? Do they draw the kind of crowd our service serves? If so, record it as a prominent
  `[PERMANENT] synergy: <specific evidence>` line — this is the strongest warm signal the Judge reads,
  so make it concrete and verifiable from the summary. Invent NOTHING; no evidence → add no synergy line.
- Mark the source consumed: in `targetUrls` (JSON array) set the entry whose `url` matches to
  `consumed:true`, leave all others unchanged (no match → leave as-is).

## Step 3 — Save (judge:false)
```
precrime__pipeline({ action:"save", id: clientId, judge:false,
  patch:{ dossier:"<updated dossier>",
    targetUrls:"<JSON.stringify with this url's entry consumed:true>",
    email:"<only if summary gave a direct email>", phone:"<only if summary gave a phone>" }})
```
Always `judge:false`. Never write `Booking.status` or call `judge_affected`/`rescore`.

## Step 4 — Complete
Synthesized:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[],
    summary:"Enriched <clientId> from <url>: <one-line result>.", needsJudge:true }})
```
Nothing usable (or empty summary): same shape, `clientIds:[]`, summary `"no enrichable signal"`,
`needsJudge:false` (still mark the entry consumed in Step 2).
Failure:
```
precrime__pipeline({ action:"complete_task", taskId, status:"failed",
  error:"<client_missing|tool_error>",
  output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[],
    summary:"Enrichment failed for <clientId>: <reason>.", needsJudge:false }})
```
Never leave a claimed task open. Then STOP.
