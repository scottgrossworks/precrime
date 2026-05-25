---
name: {{DEPLOYMENT_NAME}}-enrichment
description: One-Task ENRICH_CLIENT worker. Claim one ENRICH_CLIENT Task, enrich exactly one Client, save with judge:false, complete the Task, stop. Does not decide global workflow, does not iterate clients.
triggers:
  - enrich one client
  - run enrich client task
  - ENRICH_CLIENT worker
---

# enrichment-agent -- One-Task ENRICH_CLIENT Worker

This skill is a worker. It executes exactly one `ENRICH_CLIENT` Task and stops.

The Planner (`pipeline.plan_tasks`) decides which Clients are stale and need enrichment. The Judge (`pipeline.judge_affected`) decides scoring and status promotion. This skill does neither. It enriches one Client, writes facts, and completes its Task.

Do not iterate to the next Client. Do not call `pipeline.next`. Do not run a queue. Do not call `pipeline.rescore`. The legacy multi-client loop is preserved at `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\enrichment-agent.legacy.md` for reference only.

---

## Step 1 -- Claim one Task

Call:

```
precrime__pipeline({
  action: "claim_task",
  role:   "enrichment-agent",
  types:  ["ENRICH_CLIENT"]
})
```

Response shape:

```json
{
  "status": "CLAIMED",
  "task": {
    "id": "task_...",
    "type": "ENRICH_CLIENT",
    "status": "claimed",
    "targetType": "Client",
    "targetId": "cli_...",
    "input": null
  }
}
```

Branching:

- `status === "NO_TASK"` -> STOP. Do not look for another Client. Exit the skill.
- `status === "CLAIMED"` -> hold `taskId = task.id`, `clientId = task.targetId`. Proceed to Step 2.
- Any other status (`CONTENTION`, error) -> STOP. Exit the skill.

---

## Step 2 -- Load the one Client

```
precrime__find({ action: "clients", filters: { id: clientId }, limit: 1 })
```

Capture existing `name`, `company`, `email`, `phone`, `website`, `targetUrls`, `dossier`, `clientNotes`, and recent linked factlets. This is the only Client this worker touches.

If the Client cannot be loaded, go to Step 5 (failure path).

---

## Step 3 -- Enrich exactly this Client

Do the enrichment work for this single Client only:

1. If `targetUrls` is empty or stale, find up to 5 high-signal URLs (website, LinkedIn, Facebook, news, directory). Scrape them via `tavily__tavily_extract`.
2. Extract direct contact info, current event signals, pain signals, buying-occasion signals, and org context relevant to the deployment VALUE_PROP.
3. For contacts found about OTHER people/orgs while reading this Client's pages, follow `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\shared\classify-contact.md` and save them as their own Clients via `pipeline.save({ judge:false, patch: ... })` (the Planner will enrich them later in their own Tasks).
4. For broadly reusable signals, follow `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\shared\factlet-rules.md` and save them as factlets attached to this Client where applicable.
5. Verify direct email if needed via `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\client-finder.md`.

You may make multiple read/scrape calls in this step. You may NOT claim another Task. You may NOT enrich another Client.

---

## Step 4 -- Save changes with judge:false

Save the accumulated enrichment for THIS Client in one call:

```
precrime__pipeline({
  action: "save",
  id:     clientId,
  judge:  false,
  patch: {
    name:        "<corrected if needed>",
    email:       "<verified direct email if found>",
    phone:       "<if found>",
    website:     "<if found>",
    targetUrls:  "<JSON.stringify of resolved URL list>",
    dossier:     "<appended dated findings>",
    clientNotes: "<short operational note if needed>",
    factlets:    [
      { content: "...", source: "...", signalType: "occasion|context|pain" }
    ],
    lastEnriched: "<ISO timestamp now>"
  }
})
```

CRITICAL: this `pipeline.save` call MUST pass `judge: false`. Scoring is owned by the Judge via the JUDGE_AFFECTED Task the Planner will create from this Task's output. Do not call `pipeline.judge_affected` here. Do not call `pipeline.rescore` here. Do not write `Booking.status` directly. Do not compose marketplace leeds.

Collect `affectedClientIds`, `affectedBookingIds`, and any factlet ids returned. If you saved sibling Clients (Step 3.3) via additional `pipeline.save({ judge:false })` calls, collect their `clientId` too.

---

## Step 5 -- Complete the Task

On success:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds:   [clientId, <any sibling clients you created/touched>],
    bookingIds:  [<affected booking ids>],
    factletIds:  [<saved factlet ids>],
    sourceIds:   [],
    summary:     "Enriched <clientId>: <short result, e.g. email verified, 2 factlets, 1 booking>.",
    needsJudge:  true
  }
})
```

`needsJudge: true` whenever any client/booking/factlet id was produced. If absolutely nothing changed, set `needsJudge: false` and the summary should say "no enrichable signal".

On failure (Client unloadable, all scrapes failed, no usable signal anywhere, or any tool error you cannot work around):

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error:  "<short reason: client_missing | scrape_failed | no_signal | tool_error>",
  output: {
    clientIds:  [clientId],
    bookingIds: [],
    summary:    "Enrichment failed for <clientId>: <reason>.",
    needsJudge: false
  }
})
```

Never leave a claimed Task uncompleted. If anything goes wrong, complete the Task as `failed` with a short `error`. Do not hide tool failures in prose; record them in `error`.

---

## Step 6 -- Stop

After `complete_task` returns, exit the skill. Do not claim another Task. Do not load another Client. Do not call `report_session`. Do not call `plan_tasks`. The Planner decides what is next; the worker is done.
