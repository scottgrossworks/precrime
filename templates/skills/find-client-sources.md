---
name: {{DEPLOYMENT_NAME}}-find-client-sources
description: One-Task FIND_CLIENT_SOURCES worker. For one Client, run a bounded Tavily search, summarize the top results, store them as { url, summary, consumed:false } on Client.targetUrls for ENRICH_CLIENT. Complete, stop.
triggers:
  - find client sources
  - run find client sources task
  - FIND_CLIENT_SOURCES worker
---

# find-client-sources — FIND_CLIENT_SOURCES worker (producer)

Process ONE already-claimed FIND_CLIENT_SOURCES task. Find and summarize URLs ABOUT
one Client; store them for the ENRICH_CLIENT worker to fold into the dossier. You do
NOT write the dossier. Mechanical: search, extract, store. Never call `claim_task`,
`plan_tasks`, `next`, `rescore`, or `judge_affected`.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- Read the **ASSIGNED TASK** JSON block in these instructions as `task` (do NOT call get_task) → `clientId = task.targetId`; `focus = task.input?.focus`.
- Not `{ type:"FIND_CLIENT_SOURCES", targetType:"Client" }` → complete `failed` `wrong_task_type`, stop.

## Step 1 — Load client
`precrime__find({ action:"clients", filters:{ id: clientId }, limit:1, summary:false })`
Capture `name`, `company`, `website`, `segment`, existing `targetUrls`. Missing → complete `failed`.

## Step 2 — Search (bounded, 1–3 queries)
**If `focus === "contact_email"`** (this client's booking is one field from HOT — it only
lacks the decision-maker's direct email), make EVERY query hunt that email. Use the
client's `name`/`company` and any contact name in the dossier:
- `"<person name or company>" email` and `"<company>" "@"` (direct address)
- `"<company>" events director OR booking manager OR coordinator email contact`
- `"<company>" staff OR team OR about contact` (find a named person + their address)
Prefer the official site's contact/about/staff/team pages and LinkedIn. The goal is a
real personal/role address (e.g. `jane@company.com`), NOT `info@`/`events@`.

**Otherwise** build from client identity + VALUE_PROP trade/segment language:
- `"<company/name>" <city/segment>` (who they are)
- `"<company/name>" event OR booking OR festival OR fundraiser` (buying occasions)
- `"<company/name>" contact OR director OR coordinator` (decision-maker)

Run `tavily__tavily_search` per query (default depth, small count). Tavily unavailable →
complete `cancelled` `tavily_unavailable`, stop. Pick the top 3–5 on-topic URLs (prefer
official site, event pages, news, directories; skip social login walls).

## Step 3 — Summarize each
`tavily__tavily_extract` per chosen URL. Keep each summary short and factual — raw material
for the ENRICH worker. Don't interpret or score.

## Step 4 — Store on targetUrls AND complete, in ONE call (judge:false)
Append `{ url, summary, consumed:false }` per source. DEDUP on `url` (skip URLs already present,
consumed or not). Preserve existing entries. Fold the completion into this SAME save via
`completeTask` — do NOT make a separate `complete_task` call on the success path; that wastes a
whole turn. When the save succeeds the server marks the task done.
```
precrime__pipeline({ action:"save", id: clientId, judge:false,
  patch:{ targetUrls:"<JSON.stringify of existing + new { url, summary, consumed:false } entries>" },
  completeTask:{ taskId, status:"done",
    output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[],
      summary:"Found <N> source summaries for <clientId>.", needsJudge:false } }})
```
Never write `dossier`, `Booking.status`, factlets, or bookings. Never call `judge_affected`/`rescore`. After this call succeeds you are DONE — STOP.

## Step 5 — Completion for the no-save paths only
Only when there is no save to fold into:
- **Nothing usable** (no sources found): `precrime__pipeline({ action:"complete_task", taskId, status:"done", output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[], summary:"no sources found", needsJudge:false }})`
- **Failure / no Tavily**: `precrime__pipeline({ action:"complete_task", taskId, status:"failed"|"cancelled", error:"<tavily_unavailable|client_missing|tool_error>", output:{ clientIds:[clientId], bookingIds:[], factletIds:[], sourceIds:[], summary:"FIND_CLIENT_SOURCES failed for <clientId>: <reason>.", needsJudge:false }})`
Never leave a claimed task open. Then STOP.
