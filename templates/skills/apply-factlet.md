---
name: {{DEPLOYMENT_NAME}}-apply-factlet
description: One-Task APPLY_FACTLET worker. Consume one already-claimed APPLY_FACTLET Task, compare one Factlet to plausible Clients, update dossiers with judge:false, complete the Task, stop.
triggers:
  - apply one factlet
  - run apply factlet task
  - APPLY_FACTLET worker
---

# apply-factlet -- APPLY_FACTLET Worker

Execute exactly one already-claimed `APPLY_FACTLET` Task. Do not call `claim_task`, `plan_tasks`, `next`, `rescore`, `judge_affected`, or load another Factlet.

## Step 1 -- Accept Claimed Task

The orchestrator has already called `claim_task` and handed you the Task packet.

Set:

- `taskId = task.id`
- `factletId = task.targetId`

Expected Task: `{ type:"APPLY_FACTLET", targetType:"Factlet", targetId }`. If the Task is missing or not this type, stop and report `wrong_task_type`; do not claim another Task.

## Step 2 -- Load Factlet

```
precrime__find({ action: "factlets", filters: { id: factletId }, limit: 1 })
```

Capture `content`, `source`, `createdAt`. If missing, complete as `failed`.

## Step 3 -- Candidate Clients

Load a bounded client set:

```
precrime__find({ action: "clients", filters: {}, limit: 100 })
```

Keep a Client only if at least one cheap check matches:

- Client name/company appears in Factlet `content` or `source`, or vice versa.
- Client website host appears in Factlet `content` or `source`.
- Factlet overlaps with Client `clientNotes` or `dossier`.
- A recent Booking shares trade, location, zip, date text, or a title token longer than 3 chars.
- Phone area code overlap only when the Client has a phone and the Factlet contains a formatted area code.

Drop all non-candidates before any LLM call.

## Step 4 -- Relevance Decision

For each candidate, use only this bounded context:

- Factlet `content`, `source`, `createdAt`
- Client `name`, `company`, `website`, `clientNotes`, `dossier`
- Most recent 3 Bookings: `title`, `location`, `zip`, `startDate`, `trade`

Return exactly one action:

- `no_change`: irrelevant or already covered.
- `append_dossier_entry`: append `[YYYY-MM-DD] <one-line factlet summary>`.
- `rewrite_existing_dossier_entry`: replace one existing dated line; do not also append.
- `update_permanent_profile`: update/create one `[PERMANENT] ...` line for durable facts only.

Duplicate rule: if a dossier line already covers the same fact and the new Factlet adds nothing, choose `no_change`. If it adds sharper/newer detail, rewrite that one line. Append only when no covering line exists.

## Step 5 -- Save Dossiers

For each mutated Client:

```
precrime__pipeline({
  action: "save",
  id: clientId,
  judge: false,
  patch: {
    dossier: "<new dossier text>"
  }
})
```

Dossier format:

```
[PERMANENT] stable fact about this Client
[YYYY-MM-DD] time-sensitive signal from <source>: ...
```

Use Factlet `createdAt` for new dated entries. Do not invent dates. Do not append duplicates. Do not create ClientFactlet rows.

Every `pipeline.save` call MUST pass `judge:false`. Do not call `judge_affected` or `rescore`. Do not write `Booking.status`.

Collect mutated `clientId`s.

## Step 6 -- Complete

Success:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    clientIds: [<mutated client ids>],
    bookingIds: [],
    factletIds: [factletId],
    sourceIds: [],
    summary: "Applied Factlet <factletId> to <N> clients: <K> appends, <R> rewrites, <P> permanent updates.",
    needsJudge: true
  }
})
```

If no dossier changed, use `clientIds: []`, summary `"no plausible match"` or `"no new evidence"`, and `needsJudge:false`.

Failure:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error: "<factlet_missing | scan_failed | tool_error>",
  output: {
    clientIds: [],
    bookingIds: [],
    factletIds: [factletId],
    sourceIds: [],
    summary: "APPLY_FACTLET failed for <factletId>: <reason>.",
    needsJudge: false
  }
})
```

Never leave a claimed Task open.

## Step 7 -- Stop

After `complete_task`, exit. Do not claim another Task.
