---
name: {{DEPLOYMENT_NAME}}-enrichment
description: One-Task ENRICH_CLIENT worker. Consume one already-claimed Client Task, enrich it, save with judge:false, complete, stop.
triggers:
  - enrich one client
  - run enrich client task
  - ENRICH_CLIENT worker
---

# enrichment-agent -- ENRICH_CLIENT Worker

Execute exactly one already-claimed `ENRICH_CLIENT` Task. Do not call `claim_task`, `plan_tasks`, `next`, `rescore`, `judge_affected`, or load another Client.

## Step 1 -- Accept Claimed Task

The orchestrator has already called `claim_task` and handed you the Task packet.

Set:

- `taskId = task.id`
- `clientId = task.targetId`

Expected Task: `{ type:"ENRICH_CLIENT", targetType:"Client", targetId }`. If the Task is missing or not this type, stop and report `wrong_task_type`; do not claim another Task.

## Step 2 -- Load Client

```
precrime__find({ action: "clients", filters: { id: clientId }, limit: 1 })
```

Capture `name`, `company`, `email`, `phone`, `website`, `targetUrls`, `dossier`, `clientNotes`, recent Bookings/Factlets. If missing, complete as `failed`.

## Step 3 -- Enrich This Client Only

Allowed work:

- Find/scrape up to 5 high-signal URLs for this Client: official site, event page, LinkedIn, Facebook, news, directory.
- Extract direct contact info, event signals, pain/occasion/context signals, useful website URLs, and potential Bookings.
- For other people/orgs discovered on this Client's pages, use `skills/shared/classify-contact.md`; save true sibling Clients with `pipeline.save({ judge:false, patch: ... })`.
- For reusable signals, use `skills/shared/factlet-rules.md`; save as Factlets on this Client where applicable.
- Verify or improve email using `skills/client-finder.md` when needed.

Do not enrich sibling Clients here. Create them and let Planner schedule their own Tasks.

## Step 4 -- Save

Prefer one accumulated save for this Client:

```
precrime__pipeline({
  action: "save",
  id: clientId,
  judge: false,
  patch: {
    name: "<corrected if needed>",
    email: "<verified direct email if found>",
    phone: "<if found>",
    website: "<if found>",
    targetUrls: "<JSON.stringify URL list>",
    dossier: "<updated dossier>",
    clientNotes: "<short operational note>",
    factlets: [{ content: "...", source: "...", signalType: "occasion|context|pain" }],
    bookings: [/* if discovered */],
    lastEnriched: "<ISO timestamp now>"
  }
})
```

Every `pipeline.save` call MUST pass `judge:false`. Do not call `judge_affected` or `rescore`. Do not write `Booking.status`.

Collect `affectedClientIds`, `affectedBookingIds`, saved `factletIds`, and any sibling Client ids created.

## Step 5 -- Complete

Success:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds: [clientId, <sibling clients touched>],
    bookingIds: [<affected booking ids>],
    factletIds: [<saved factlet ids>],
    sourceIds: [],
    summary: "Enriched <clientId>: <short result>.",
    needsJudge: true
  }
})
```

If nothing changed, use `needsJudge:false` and summary `"no enrichable signal"`.

Failure:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error: "<client_missing | scrape_failed | no_signal | tool_error>",
  output: {
    clientIds: [clientId],
    bookingIds: [],
    summary: "Enrichment failed for <clientId>: <reason>.",
    needsJudge: false
  }
})
```

Never leave a claimed Task open.

## Step 6 -- Stop

After `complete_task`, exit. Do not claim another Task.
