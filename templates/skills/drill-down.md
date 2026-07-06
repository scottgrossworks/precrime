---
name: {{DEPLOYMENT_NAME}}-drill-down
description: One-Task DRILL_DOWN worker. For ONE near-hot booking, find the SPECIFIC fields it is missing to become hot (a real decision-maker email, an event date/time, a venue zip, a person's name) using research tools only, save them, complete, stop. RESEARCH ONLY — never contacts anyone.
triggers:
  - drill down booking
  - run drill down task
  - DRILL_DOWN worker
---

# drill-down — DRILL_DOWN worker (close the near-hot booking)

Process ONE already-claimed DRILL_DOWN task: a booking that is one or two fields short
of HOT. Find ONLY those missing fields and save them. You fill DATA with research tools.
You do NOT contact anyone. Never call `gmail__gmail_send`, `share_booking`, `claim_task`,
`plan_tasks`, `judge_affected`, `next_source`, or `mark_source`.

## Step 0 — Load task (already provided — do NOT call get_task)
- Your task packet is the **ASSIGNED TASK** JSON block in these instructions. Set `task` = that packet, `taskId = task.id`. Do NOT call `precrime__pipeline({ action:"get_task" })` — it is already here.
- If `task.type` ≠ `"DRILL_DOWN"` → complete `failed` `wrong_task_type`, stop.
- `targetType = task.targetType` — either **`Booking`** (close a near-hot booking by filling its missing fields) or **`Client`** (a bare discovered company with NO contact and NO booking — find a decision-maker contact AND an upcoming event that needs the trade, minting a NEW booking).
- `clientId = task.input?.clientId`; `missing = task.input?.missing` (array of gap codes). For a `Booking` target, `bookingId = task.targetId`; for a `Client` target there is no booking yet (`bookingId = null`).

## Step 1 — Load context
`precrime__find({ action:"clients", filters:{ id: clientId }, limit:1, summary:false })` → name, company, website, email, dossier.
`precrime__find({ action:"bookings", filters:{ search: clientId } })` or read `task.input` for the booking's title/location/startDate. You need enough to search precisely.

## Step 2 — Resolve EACH missing field (playbooks; escalate tools)
Work only the codes in `missing`. Per code:

- **`client_email_generic` / `client_email`** (need a direct, non-role address): search the org's official site → its `contact` / `about` / `team` / `staff` page (`tavily__tavily_extract`) → LinkedIn / socials for the named decision-maker (events director, booking manager, coordinator). Goal: a real personal/role address like `jane@company.com`, NOT `info@`/`events@`.
- **`client_name` / `client_name_not_person`** (need a real PERSON, not an org/team): find the named decision-maker on the org's staff/about page or LinkedIn; capture their name (and email if it appears).
- **`start_date` / `start_time` / `start_date_not_future_enough`** (need the event date): find the event's OWN listing/registration page and copy the **verbatim** date/time text. Do not invent dates.
- **`location_with_zip`** (need venue + zip): find the venue on the event page or the venue's own site; capture the address incl. 5-digit zip (or the city to geocode).
- **`trade`** (rare): confirm the service fits a canonical `precrime__trades()` name; if not, leave it.
- **`title`**: capture the event/opportunity name from the page.
- **`booking`** (CLIENT target only — there is no event yet): research the org (its site, events/calendar page, or an event listing/registration page) for ONE UPCOMING public event it is hosting or attending that fits the trade. Capture the event's **verbatim** date/time text, venue + 5-digit zip, and title. Pair it with the contact from `client_email` above. No qualifying FUTURE event found → leave it (do NOT invent one); saving just the contact is still progress.

Use 1–4 bounded searches total. Tavily unavailable → complete `cancelled` `tavily_unavailable`, stop.

## Step 3 — Save what you found AND complete, in ONE call (judge:false)
ONE save. Client-level fields (email/phone/name/website) on the patch; booking-level fields
(date/time/zip/title) inside `bookings[]` with the proving `sourceUrl`. The server resolves
`dateText` and re-classifies the booking (it may go HOT). **Fold the task completion into this
SAME call via `completeTask` — do NOT make a separate `complete_task` call on the happy path;
that wastes a whole turn. When the save succeeds the server marks the task done.**
```
precrime__pipeline({ action:"save", judge:false, id: clientId,
  patch:{ name:"<if found>", email:"<direct address if found>", phone:"<if found>",
    bookings:[{ trade:"<canonical>", dateText:"<verbatim date text if found>",
      location:"<venue text>", zip:"<5-digit if found>", title:"<event name>",
      sourceUrl:"<live page proving these>" }] },
  completeTask:{ taskId, status:"done",
    output:{ clientIds:[clientId], bookingIds: bookingId ? [bookingId] : [], factletIds:[], sourceIds:[],
      summary:"Drill-down <bookingId or clientId>: filled <fields-found>.", needsJudge:true } }})
```
Omit any field you did not find. Never write `Booking.status`, never `judge:true`. After this call succeeds you are DONE — STOP.

## Step 4 — Completion for the NO-SAVE paths only
Only when there is no save to fold into:
- **Found nothing to save** (no missing field resolved): `precrime__pipeline({ action:"complete_task", taskId, status:"done", output:{ clientIds:[clientId], bookingIds: bookingId ? [bookingId] : [], factletIds:[], sourceIds:[], summary:"no missing fields resolved", needsJudge:false }})`
- **Tavily down / error**: `precrime__pipeline({ action:"complete_task", taskId, status:"cancelled"|"failed", error:"<tavily_unavailable|tool_error>" })`

Never contact anyone. Never leave a claimed task open. Then STOP.
