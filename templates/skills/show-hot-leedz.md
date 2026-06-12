---
name: {{DEPLOYMENT_NAME}}-show-hot-leedz
description: One-Task SHOW_HOT_LEEDZ presenter. Consume one already-claimed Task, show judged hot Bookings, route sharing through share_booking, complete, stop.
triggers:
  - show hot leedz
  - show ready leedz
  - SHOW_HOT_LEEDZ worker
---

# show-hot-leedz -- SHOW_HOT_LEEDZ Presenter

Read judged state only. Do not scrape, enrich, rescore, resolve dates, save, plan, or call external Leedz tools. Sharing goes through `share_booking`.

## Step 1 -- Accept Claimed Task

The orchestrator has already called `claim_task` and handed you the Task packet.

Set `taskId = task.id`.

Expected Task: `{ type:"SHOW_HOT_LEEDZ", targetType:"none" }`. If the Task is missing or not this type, stop and report `wrong_task_type`; do not claim another Task.

## Step 2 -- Read Hot Bookings

```
precrime__find({ action: "bookings", filters: { status: "hot", shared: false, future: true }, limit: 50 })
```

Order by soonest `startDate` first. If empty, complete with empty ids, summary `"no hot leedz to present"`, `needsJudge:false`.

## Step 3 -- Present

Show one compact block per Booking:

```
[hot] <title>
Client: <client.name/company> | <client.email> | <client.phone>
Where : <location> | zip <zip>
When  : <startDate> -> <endDate>
Trade : <trade>
Notes : <one line>
bookingId: <id>
```

Order: soonest `startDate` first.

## Step 4 -- User Action

Ask once per Booking:

```
<title> [hot] -- share / outreach / skip ?
```

- `share`: user does not want the gig; post it to the Leedz marketplace. `share_booking` requires status `hot`.
  ```
  precrime__pipeline({ action: "share_booking", bookingId: <id>, mode: "draft" })
  ```
  Server derives timezone from Booking zip/location; do not pass `timezone`. Show `payload` and `humanReadable`. Ask `Post this leed?`; on explicit `yes`:
  ```
  precrime__pipeline({ action: "share_booking", bookingId: <id>, mode: "post" })
  ```
  Quote the response. Do not write shared fields by hand.

- `outreach`: user wants the gig; email the client. Use `skills/outreach-drafter.md` for outreach draft/send.

- `skip`: no DB write.

Collect acted-on `bookingIds` and `clientIds`.

Forbidden in this worker: `pipeline.save`, `pipeline.rescore`, `pipeline.judge_affected`, `pipeline.resolve_dates`, `pipeline.plan_tasks`, `tavily__tavily_extract`, scrape/enrich tools, external Leedz tools.

## Step 5 -- Complete

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "done",
  output: {
    bookingIds: [<acted-on booking ids>],
    clientIds: [<their client ids>],
    factletIds: [],
    sourceIds: [],
    summary: "Presented <N> hot bookings; <S> shared, <E> outreach, <K> skipped.",
    needsJudge: false
  }
})
```

On failure:

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error: "<short reason>",
  output: { bookingIds: [], clientIds: [], factletIds: [], sourceIds: [], summary: "presenter failed: <reason>", needsJudge: false }
})
```

## Step 6 -- Stop

After `complete_task`, exit.
