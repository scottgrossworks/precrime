---
name: {{DEPLOYMENT_NAME}}-drill-container
description: One-Task DRILL_CONTAINER worker. For ONE multi-vendor event (convention / expo / festival / fair / tournament), find the real NAMED organizer, expand any vendor/exhibitor list into fitting leedz (each born with an inherited booking), and prep a marketplace listing. Gated on whether VALUE_PROP could plausibly sell to the vendors or crowd. Research only — never contacts anyone, never shares.
triggers:
  - drill down container
  - run drill container task
  - DRILL_CONTAINER worker
  - work a multi-vendor event
---

# drill-container — DRILL_CONTAINER worker (work a multi-vendor event)

Process ONE already-claimed DRILL_CONTAINER task. A convention, expo, festival, fair, or
tournament is NOT a single prospect — it is a CONTAINER. The opportunity is the **organizer**,
the **vendors/exhibitors**, and/or the **crowd**, never the event's subject (we don't care about
taekwondo any more than nursing at an AMA expo). Your job, in order: confirm there's a VALUE_PROP
angle at all, find the real organizer, expand any vendor list into fitting leedz, and prep the
event as a marketplace listing. You fill DATA with research tools and synthesize listing prose.
You do NOT contact anyone and you do NOT share. Never call `gmail__gmail_send`, `share_booking`,
`claim_task`, `plan_tasks`, `judge_affected`, `next_source`, or `mark_source`.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- `precrime__pipeline({ action:"get_task", taskId })`. Not `{ type:"DRILL_CONTAINER" }` → complete `failed` `wrong_task_type`, stop.
- `containerBookingId = task.targetId`; `clientId = task.input?.clientId`;
  `ctx = task.input?.containerContext` — `{ title, location, zip, startDate, startTime }` (the event's
  own date/venue; every vendor leed INHERITS these). Read the event title/description yourself to judge
  whether it is exhibitor-heavy (trade show / expo → vendor list likely) or a single public event
  (festival / tournament → organizer + crowd) and weight your effort accordingly.

## Step 1 — Load context
`precrime__find({ action:"clients", filters:{ id: clientId }, limit:1, summary:false })` and
`precrime__find({ action:"bookings", filters:{ search: containerBookingId } })` → event name, venue,
date, website, current description. **Read `DOCS/VALUE_PROP.md` in full — especially `## RELEVANCE
SIGNALS` and its `### Not Relevant Signals` — you need it for the fit gate below.**

## Step 2 — FIT GATE (do this first; bail cheaply on no-fit)
Judge product-market fit between VALUE_PROP and THIS event **using VALUE_PROP's `## RELEVANCE SIGNALS`
as the criteria** — that section is the authoritative fit test. The question is NOT "does the event's
subject match our trade"; it is whether the event shows any RELEVANCE SIGNAL — needs live
entertainment / guest activities / booth traffic / a guest takeaway; has a crowd, booths, sponsor
activations, a family or student audience; vendors/exhibitors who'd want booth-draw. (That is why a
service like ours fits a roofing expo — booth traffic for any exhibitor — AND a tournament with a
crowd, but NOT a closed B2B event hitting the `### Not Relevant Signals`: pure catering/AV/security,
no public audience, no entertainment/activation need.)
- **No RELEVANCE SIGNAL / hits a Not-Relevant signal** → complete `done`, summary `"no VALUE_PROP fit for this event"`, `needsJudge:false`, stop. Do not research further.
- **One or more RELEVANCE SIGNALS present** → continue.

## Step 3 — Research (bounded; 1–4 searches total)
Tavily unavailable → complete `cancelled` `tavily_unavailable`, stop.
Find the event's OWN site/listing, then gather BOTH:
- **A NAMED organizer** — a real person (event/vendor/market coordinator) with a DIRECT email. A
  generic inbox (`info@`, `vendors@`, `events@`) is NOT acceptable; keep digging (about/team/LinkedIn).
- **A vendor / exhibitor list** — the event's `exhibitors` / `vendors` / `directory` / `floor plan`
  page, if one exists. Also capture any **vendor-application** link/PDF + requirements (fee, booth,
  deadline, accepted categories) — these often carry the full schema.
- **Confirm the trade** (canonical `precrime__trades()` name) for marketplace listing.
- Capture the page URL(s) proving these.

## Step 4 — Write results (judge:false)

**4a. Vendor expansion (if a vendor/exhibitor list exists).** Apply the RELEVANCE SIGNALS test again
per vendor: mint only vendors our service could plausibly draw/serve (their booth would benefit from a
traffic-draw, or their audience fits) — skip the rest; do NOT mint everyone. ONE `save` per kept
vendor with **no `id`** (server creates/dedups by company), each booking INHERITING `ctx`:
```
precrime__pipeline({ action:"save", judge:false,
  patch:{ company:"<vendor>", name:"<contact if found, else company>",
    email:"<direct, non-generic only; else OMIT>", website:"<if found>",
    segment:"<vendor category>", source:"container:<containerBookingId>",
    bookings:[{ title:"<ctx.title>", trade:"<canonical if the vendor's business fits, else OMIT>",
      location:"<ctx.location>", zip:"<ctx.zip>", startDate:"<ctx.startDate>", startTime:"<ctx.startTime>",
      source:"container:<containerBookingId>", sourceUrl:"<vendor-list page URL>" }] }})
```
Process up to ~12 vendors this run; no second pass is scheduled, so prioritize the best-fit vendors.

**4b. Organizer + marketplace prep (always, on the container's OWN booking).** ONE `save` updating the
existing client + booking (`id: clientId`, booking by its id):
```
precrime__pipeline({ action:"save", judge:false, id: clientId,
  patch:{ name:"<real organizer person>", email:"<direct, non-generic>", phone:"<if found>",
    bookings:[{ id:"<containerBookingId>", trade:"<canonical>",
      description:"<2-4 sentence selling point: why this event is a strong gig for the trade — crowd, fit, demand>",
      notes:"Vendor application: <url/pdf>. Requirements: <fee / booth / deadline / accepted categories>.",
      location:"<ctx.location>", zip:"<ctx.zip>", startDate:"<ctx.startDate>", startTime:"<ctx.startTime>",
      sourceUrl:"<page proving organizer + vendor form>" }] }})
```
Rules:
- Booking `description` → marketplace `dt`; `notes` → marketplace `rq`. Keep emails/phones, epochs, and
  any date/time other than the booking's own OUT of `description` (the share path validates this).
- Never write `Booking.status`; never `judge:true`; never `share_booking`. The server Judge re-scores;
  a present demand signal (the trade has appeared at this event before) tips it toward marketplace-eligible.
- No named organizer found → still save whatever you got (progress); omit fields you did not find.

## Step 5 — Complete
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[<organizer clientId + every vendor clientId saved>], bookingIds:[containerBookingId],
    factletIds:[], sourceIds:[],
    summary:"Container <containerBookingId>: <N> vendor leed(s) + organizer/marketplace <staged|partial>.", needsJudge:true }})
```
No fit: `status:"done"`, summary `"no VALUE_PROP fit for this event"`, `needsJudge:false`.
Nothing usable: `status:"done"`, summary `"no organizer / vendor list found"`, `needsJudge:false`.
Tavily down / error: `status:"cancelled"|"failed"`, `error:"<tavily_unavailable|tool_error>"`.
Never contact anyone. Never share. Never leave a claimed task open. Then STOP.
