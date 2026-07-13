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
the **vendors/exhibitors**, and/or the **crowd**, never the event's subject. Your job, in
order: confirm there's a VALUE_PROP angle at all, find the real organizer, expand any vendor
list into fitting leedz, and prep the event as a marketplace listing. RESEARCH ONLY — you
never contact anyone and never share. Only the tools advertised to you exist.

## Step 0 — Load task
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- Your task packet is the **ASSIGNED TASK** JSON block in these instructions; set `task` = that packet (do NOT call get_task). Not `{ type:"DRILL_CONTAINER" }` → complete `failed` `wrong_type`, stop.
- `containerBookingId = task.targetId`; `clientId = task.input?.clientId`;
  `ctx = task.input?.containerContext` — `{ title, location, zip, startDate, startTime }` (the event's
  own date/venue; every vendor leed INHERITS these). Read the event title/description yourself to judge
  whether it is exhibitor-heavy (trade show / expo → vendor list likely) or a single public event
  (festival / tournament → organizer + crowd) and weight your effort accordingly.

## Step 1 — Load context
`precrime__find({ action:"clients", filters:{ id: clientId }, limit:1, summary:false })` and
`precrime__find({ action:"bookings", filters:{ search: containerBookingId } })` → event name, venue,
date, website, current description. Your fit criteria are in the packet: `task.vp.relevanceSignals`
and `task.vp.notRelevantSignals` (do NOT read VALUE_PROP.md or call get_config).

## Step 2 — FIT GATE (do this first; bail cheaply on no-fit)
Judge fit between VALUE_PROP and THIS event using `task.vp.relevanceSignals` as the authoritative
criteria. The question is NOT "does the event's subject match our trade" — it is whether the event
shows any relevance signal (a crowd, booths, sponsor activations, entertainment/activation need,
vendors who'd want booth-draw). A niche expo with booth traffic fits; a closed B2B event matching
`task.vp.notRelevantSignals` does not.
- **No relevance signal / hits a not-relevant signal** → complete `done`, summary `"no VALUE_PROP fit for this event"`, `needsJudge:false`, stop. Do not research further.
- **One or more relevance signals present** → continue.

## Step 3 — Research (bounded; 1–4 searches total)
Tavily unavailable → complete `cancelled` `tavily_unavailable`, stop.
Find the event's OWN site/listing, then gather BOTH:
- **A NAMED organizer** — a real person (event/vendor/market coordinator) with a DIRECT email. A
  generic inbox (`info@`, `vendors@`, `events@`) is NOT acceptable; keep digging (about/team/LinkedIn).
- **A vendor / exhibitor list** — the event's `exhibitors` / `vendors` / `directory` / `floor plan`
  page, if one exists. Also capture any **vendor-application** link/PDF + requirements (fee, booth,
  deadline, accepted categories) — these often carry the full schema.
- Capture the page URL(s) proving these. (Do NOT determine a trade — this is a single-trade
  business; the server stamps every booking with the VALUE_PROP trade automatically.)

## Step 4 — Write results (judge:false)

**4a. Vendor expansion (if a vendor/exhibitor list exists).** LIGHT harvest only — do NOT spend extra
searches judging each vendor, and do NOT do a deep per-vendor fit analysis here. Skip only the OBVIOUS
non-fits (the `### Not Relevant Signals`); mint the rest as-is from the list. A cheap server-side gate
(`judgeContainerFit`) runs BEFORE any vendor is enriched, so borderline vendors cost nothing until they
pass it — your job is a fast, cheap harvest, not the fit decision. ONE `save` per minted vendor with
**no `id`** (server creates/dedups by company), each booking INHERITING `ctx`:
```
precrime__pipeline({ action:"save", judge:false,
  patch:{ company:"<vendor>", name:"<contact if found, else company>",
    email:"<direct, non-generic only; else OMIT>", website:"<if found>",
    segment:"<vendor category>", source:"container:<containerBookingId>",
    bookings:[{ title:"<ctx.title>",
      location:"<ctx.location>", zip:"<ctx.zip>", startDate:"<ctx.startDate>", startTime:"<ctx.startTime>",
      source:"container:<containerBookingId>", sourceUrl:"<vendor-list page URL>" }] }})
```
Process up to ~12 vendors this run; no second pass is scheduled, so prioritize the best-fit vendors.

**4b. Organizer + marketplace prep + COMPLETE (always, on the container's OWN booking).** This is your
FINAL save (it runs after all 4a vendor saves), so fold the task completion into it via `completeTask`
— do NOT make a separate `complete_task` call on the success path. ONE `save` updating the existing
client + booking (`id: clientId`, booking by its id):
```
precrime__pipeline({ action:"save", judge:false, id: clientId,
  patch:{ name:"<real organizer person>", email:"<direct, non-generic>", phone:"<if found>",
    bookings:[{ id:"<containerBookingId>",
      description:"<2-4 sentence selling point: why this event is a strong gig for the trade, crowd, fit, demand>",
      notes:"Vendor application: <url/pdf>. Requirements: <fee / booth / deadline / accepted categories>.",
      location:"<ctx.location>", zip:"<ctx.zip>", startDate:"<ctx.startDate>", startTime:"<ctx.startTime>",
      sourceUrl:"<page proving organizer + vendor form>" }] },
  completeTask:{ taskId, status:"done",
    output:{ clientIds:[<organizer clientId PLUS every vendor clientId you minted in 4a>], bookingIds:[containerBookingId],
      factletIds:[], sourceIds:[],
      summary:"Container <containerBookingId>: <N> vendor leed(s) + organizer/marketplace <staged|partial>.",
      needsJudge:true } }})
```
Rules:
- **`completeTask.output.clientIds` MUST list the organizer client PLUS every vendor client minted in 4a** — the JUDGE_AFFECTED sweep needs all of them. After this call you are DONE — STOP.
- Booking `description` → marketplace `dt`; `notes` → marketplace `rq`. Keep emails/phones, epochs, and
  any date/time other than the booking's own OUT of `description` (the share path validates this). No em dashes.
- Never write `Booking.status`; never `judge:true`; never `share_booking`. The server Judge re-scores;
  a present demand signal (the trade has appeared at this event before) tips it toward marketplace-eligible.
- No named organizer found → still save whatever you got (progress) with `needsJudge:false`; omit fields you did not find.

## Step 5 — Completion for the no-save paths only
Only when 4b did NOT run (you bailed before any save):
- **No VALUE_PROP fit** (bailed at the Step 2 fit gate): `precrime__pipeline({ action:"complete_task", taskId, status:"done", output:{ clientIds:[], bookingIds:[containerBookingId], factletIds:[], sourceIds:[], summary:"no VALUE_PROP fit for this event", needsJudge:false }})`
- **Tavily down / error** (bailed at Step 3): `precrime__pipeline({ action:"complete_task", taskId, status:"cancelled"|"failed", error:"<tavily_unavailable|tool_error>", output:{ clientIds:[], bookingIds:[containerBookingId], factletIds:[], sourceIds:[], summary:"container drill failed: <reason>", needsJudge:false }})`
Never contact anyone. Never share. Never leave a claimed task open. Then STOP.
