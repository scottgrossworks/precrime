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

- **share-ready**: `status=hot` AND `client.contactGate=true` AND `booking.zip` present AND `booking.trade` present. A missing `booking.description` is NOT a blocker — you synthesize the marketplace blurb from the client dossier at share time (Step 4 `share`).
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
A missing `description` is NOT a share blocker and must NOT be flagged — it is synthesized from the dossier at share time.

Order: soonest `startDate` first.

## Step 4 -- User Action

Ask once per Booking:

```
<title> [<gate label>] -- share / outreach / skip ?
```

- `share`: user does not want the gig; post to the Leedz marketplace.
  Only a MISSING `zip` or `contactGate` truly blocks a share — warn "cannot share: <reason>, choose outreach or skip" and don't call `share_booking`. A missing `description` does NOT block: you SYNTHESIZE the blurb.
  Load the dossier (read-only): `precrime__find({ action:"clients", filters:{ id:<clientId> }, summary:false, limit:1 })`. From `dossier` + the booking facts, write `dtDraft` = 2–3 plain sentences selling THIS event as a caricatures gig (the crowd, the fit, why it's a strong booth draw). No emails, phones, or epoch numbers in it. If the booking already has a good `description`, reuse or sharpen it.
  ```
  precrime__pipeline({ action: "share_booking", bookingId: <id>, mode: "draft", dtDraft: "<synthesized blurb>" })
  ```
  Server derives timezone from Booking zip; do not pass `timezone`. Show `payload` and `humanReadable`. Ask `Post this leed?`; on explicit `yes` (pass the SAME dtDraft):
  ```
  precrime__pipeline({ action: "share_booking", bookingId: <id>, mode: "post", dtDraft: "<same blurb>" })
  ```
  Quote the response. Do not write shared fields by hand.

- `outreach`: user wants the gig; email the client. Compose per `skills/outreach-drafter.md` style (real dossier facts, RATE, verbatim signature from `get_config`, NO em/en dashes). Show the draft; on the user's approval SEND via `gmail__gmail_send`.
  **This is NOT the marketplace path. Compose the email INLINE from data already in your context: the Client record, the booking card you already showed in Step 3, the VALUE_PROP, and the `get_config` signature. Do NOT call `share_booking` (that builds a marketplace brief, not a client email). Do NOT call any `tavily__*` tool. Do NOT call `pipeline.save` or write factlets. Do NOT research the client or event on the web — an outreach email needs none of that; every fact you need is already loaded.** If the user supplies a template path, you MAY read it once with `developer__shell` `type` and follow its structure — that is the ONLY additional read allowed on this branch. Keep it brief when asked.
  You do NOT record the send. The gmail send tool marks the client sent and resets its bookings out of hot PROCEDURALLY — the action records itself, no save from you. (A client already at `draftStatus:"sent"` is a prior send: it should not be in your hot list at all; if you somehow see one, warn "already emailed" and skip.)

- `skip`: PERMANENT dismissal. The user rejected this leed; it must never be presented as hot again. Call:
  ```
  precrime__pipeline({ action: "dismiss_booking", bookingId: <id> })
  ```
  The server marks it acted-on so the classifier keeps it cold through every future rescore and the hot query excludes it. This is the ONLY way to make a hot leed stop coming back. Do not just move on without calling it -- a skip with no `dismiss_booking` call will resurface next run.

Collect acted-on `bookingIds` and `clientIds`.

- `enrich` / `drill` (user asks to enrich or drill leedz deeper): hand it to the background conductor — call `precrime__pipeline({ action:"plan_tasks", mode:"workflow" })` ONCE. That arms the Node conductor, which runs discovery / DRILL_DOWN / ENRICH_CLIENT in its own window while you keep presenting. Tell the user it's running in the background and to re-list hot leedz later to see the enrichment. Do NOT claim or run worker skills yourself, and do NOT block waiting on it. (You do NOT need this to SHARE — the share blurb is synthesized from the dossier at share time. Enrichment deepens the dossier; it is not a share prerequisite.)

Forbidden in this worker: `pipeline.save`, `pipeline.rescore`, `pipeline.judge_affected`, `pipeline.resolve_dates`, ALL `tavily__*` tools (`tavily_search` AND `tavily_extract` — the presenter never web-searches; outreach composes inline, share research belongs to the conductor's enrichment tasks), claiming or running worker task skills yourself, external Leedz tools. You never write bookings, scores, draftStatus, or status by hand — action side effects are procedural (the send marks sent; dismiss/share mark acted-on). Allowed: `dismiss_booking` (skip), `share_booking` with a synthesized `dtDraft` (share), `gmail__gmail_send` (outreach — the send records itself), and a SINGLE `plan_tasks({mode:"workflow"})` to hand enrichment to the conductor when the user asks.

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
