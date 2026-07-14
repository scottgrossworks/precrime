---
name: {{DEPLOYMENT_NAME}}-find-client-sources
description: One-Task FIND_CLIENT_SOURCES worker. For one Client, run a bounded Tavily search and store the top hits as { url, summary, consumed:false } on Client.targetUrls for ENRICH_CLIENT. Snippet-first — NEVER extract. Complete, stop.
triggers:
  - find client sources
  - run find client sources task
  - FIND_CLIENT_SOURCES worker
---

# find-client-sources — FIND_CLIENT_SOURCES worker (producer)

Process ONE already-claimed FIND_CLIENT_SOURCES task. Find and summarize URLs ABOUT
one Client; store them for the ENRICH_CLIENT worker to fold into the dossier. You do
NOT write the dossier. Mechanical: search, store the search snippets, done. Only the
tools advertised to you exist.

## HARD RULE: SEARCH ONLY, NEVER EXTRACT

This worker is **snippet-first**. `tavily_search` already returns a relevance-scored
snippet for every hit — that snippet IS the source summary. Do NOT call `tavily_extract`
here. Per-URL extract is the single largest Tavily credit sink, and the ENRICH_CLIENT
worker folds these snippets into the dossier without needing full page text. The wrapper
enforces this (an extract call from a FIND worker is refused for 0 credits), so extracting
only wastes a turn. If a snippet is thin, store it anyway or skip that URL — do not extract
to "improve" it.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- Read the **ASSIGNED TASK** JSON block in these instructions as `task` (do NOT call get_task) → `clientId = task.targetId`.
- Not `{ type:"FIND_CLIENT_SOURCES", targetType:"Client" }` → complete `failed` `wrong_task_type`, stop.

## Step 1 — Load client
`precrime__find({ action:"clients", filters:{ id: clientId }, limit:1, summary:false })`
Capture `name`, `company`, `website`, `segment`, existing `targetUrls`. Missing → complete `failed`.

## Step 2 — Search (bounded, 1–3 queries, basic depth)
You are the cheap WIDE NET, not the email hunter. The decision-maker email hunt belongs
to the DRILL_DOWN worker (it has the extract budget for that mission); do not chase
addresses here. Build general queries from client identity + VALUE_PROP trade/segment
language:
- `"<company/name>" <city/segment>` (who they are)
- `"<company/name>" event OR booking OR festival OR fundraiser` (buying occasions)
- `"<company/name>" contact OR director OR coordinator` (decision-maker)

Run `tavily__tavily_search` per query (basic depth; the wrapper clamps to basic anyway).
Tavily unavailable → complete `cancelled` `tavily_unavailable`, stop. From the combined
results pick the top 3–5 on-topic hits (prefer official site, event pages, news,
directories; skip social login walls).

## Step 3 — Take each hit's snippet as its summary
Each search hit already carries a short relevance-scored snippet (and any extracted
emails/phones). Use that snippet verbatim, lightly trimmed, as the source summary — raw
material for the ENRICH worker. Do NOT extract, do NOT interpret or score. If a hit has no
usable snippet, drop it rather than extracting.

## Step 4 — Store on targetUrls AND complete, in ONE call (judge:false)
Append `{ url, summary, consumed:false }` per hit (summary = the search snippet from Step 3).
DEDUP on `url` (skip URLs already present, consumed or not). Preserve existing entries. Fold
the completion into this SAME save via `completeTask` — do NOT make a separate `complete_task`
call on the success path; that wastes a whole turn. When the save succeeds the server marks
the task done.
```
precrime__pipeline({ action:"save", id: clientId, judge:false,
  patch:{ targetUrls:"<JSON.stringify of existing + new { url, summary, consumed:false } entries>" },
  completeTask:{ taskId, status:"done",
    output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[],
      summary:"Found <N> source snippets for <clientId>.", needsJudge:false } }})
```
Never write `dossier`, `Booking.status`, factlets, or bookings. After this call succeeds you are DONE — STOP.

## Step 5 — Completion for the no-save paths only
Only when there is no save to fold into:
- **Nothing usable** (no hits found): `precrime__pipeline({ action:"complete_task", taskId, status:"done", output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[], summary:"no sources found", needsJudge:false }})`
- **Failure / no Tavily**: `precrime__pipeline({ action:"complete_task", taskId, status:"failed"|"cancelled", error:"<tavily_unavailable|client_missing|tool_error>", output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[], summary:"FIND_CLIENT_SOURCES failed for <clientId>: <reason>.", needsJudge:false }})`
Never leave a claimed task open. Then STOP.
