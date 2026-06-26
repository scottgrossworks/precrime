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

## Step 2 -- Read Bookings

Fetch both hot (share-ready AND outreach-ready) and brewing (outreach-ready only, relaxed gate):

```
precrime__find({ action: "bookings", filters: { status: "hot", shared: false, future: true }, limit: 50 })
precrime__find({ action: "bookings", filters: { status: "brewing", shared: false, future: true }, limit: 25 })
```

Merge, deduplicate by id. Order by soonest `startDate` first. If empty, complete with empty ids, summary `"no ready leedz to present"`, `needsJudge:false`.

For each booking, evaluate which gates it passes (use the data already loaded -- no extra MCP calls):

- **share-ready**: `status=hot` AND `client.contactGate=true` AND `booking.zip` present AND `booking.description` present
- **outreach-ready**: (`status=hot` OR `status=brewing`) AND `client.email` present AND `booking.startDate` present

## Step 3 -- Present

Show one compact block per Booking. Include gate labels so the user knows what actions are available:

```
[SHARE+OUTREACH] <title>          ← passes both gates
[OUTREACH ONLY]  <title>          ← brewing, or missing zip/contactGate
[SHARE ONLY]     <title>          ← hot + contactGate + zip, but no direct email (rare)
Client: <client.name/company> | <client.email> | <client.phone>
Where : <location> | zip <zip>
When  : <startDate> -> <endDate>
Trade : <trade>
Notes : <one line>
bookingId: <id>
```

If a booking is OUTREACH ONLY because it lacks `zip` or `contactGate`, note it inline:
`⚠ Cannot share: missing zip` or `⚠ Cannot share: no verified contact email`

Order: soonest `startDate` first.

## Step 4 -- User Action

Ask once per Booking:

```
<title> [<gate label>] -- share / outreach / skip ?
```

- `share`: user does not want the gig; post to the Leedz marketplace.
  If this booking is OUTREACH ONLY (fails share-ready gate), warn the user BEFORE calling: "This booking cannot be shared: <reason>. Choose outreach or skip." Do not call `share_booking` if the gate obviously fails.
  Otherwise:
  ```
  precrime__pipeline({ action: "share_booking", bookingId: <id>, mode: "draft" })
  ```
  Server derives timezone from Booking zip; do not pass `timezone`. Show `payload` and `humanReadable`. Ask `Post this leed?`; on explicit `yes`:
  ```
  precrime__pipeline({ action: "share_booking", bookingId: <id>, mode: "post" })
  ```
  Quote the response. Do not write shared fields by hand.

- `outreach`: user wants the gig; email the client. Use `skills/outreach-drafter.md` for outreach draft/send.

- `skip`: PERMANENT dismissal. The user rejected this leed; it must never be presented as hot again. Call:
  ```
  precrime__pipeline({ action: "dismiss_booking", bookingId: <id> })
  ```
  The server marks it acted-on so the classifier keeps it cold through every future rescore and the hot query excludes it. This is the ONLY way to make a hot leed stop coming back. Do not just move on without calling it -- a skip with no `dismiss_booking` call will resurface next run.

Collect acted-on `bookingIds` and `clientIds`.

Forbidden in this worker: `pipeline.save`, `pipeline.rescore`, `pipeline.judge_affected`, `pipeline.resolve_dates`, `pipeline.plan_tasks`, `tavily__tavily_extract`, scrape/enrich tools, external Leedz tools. (`dismiss_booking` is allowed -- it is the skip action.)

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
