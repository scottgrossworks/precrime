---
name: {{DEPLOYMENT_NAME}}-apply-factlet
description: One-shot APPLY_FACTLET worker. Reads task ID from env, loads VALUE_PROP, judges factlet relevance, appends to client dossier (+ verified structured fields) if relevant, completes task, stops.
version: 3.0
replaces: apply-factlet v2 (verbose; trimmed to procedural minimum)
triggers:
  - apply one factlet
  - run apply factlet task
  - APPLY_FACTLET worker
---

# apply-factlet — one-shot APPLY_FACTLET worker

Process ONE task, then stop. Never call `claim_task`, `plan_tasks`, `next`, `rescore`,
or `judge_affected`. Never load extra clients or factlets.

**Substitute real values.** Code blocks are templates. `taskId`, `factletId`, `clientId`,
`dossier` are variables you captured — replace them with real values. `patch`/`filters`/`output`
are JSON objects, not strings. Never send a value containing `{ } < >` or a bare variable name.
`patch: "{dossier}"` saves nothing.

## Step 0 — Task ID + VALUE_PROP
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- `precrime__pipeline({ action: "get_config" })` → hold: `trade`, `geography`, `serviceZips`,
  `buyerRoles`, `audienceSegments`, `notBuyer`, `relevanceSignals`.

## Step 1 — Load task
`precrime__pipeline({ action: "get_task", taskId })`
- `factletId = task.targetId`; `clientId = task.input.clientId`
- Not `{ type:"APPLY_FACTLET", targetType:"Factlet" }` → complete `failed` `wrong_task_type`, stop.
- `clientId` null/absent = **SWEEP** (no existing client matched). Don't just drop it:
  if the factlet clearly names a REAL prospective client (an in-trade org/person) AND a
  future bookable event (a date + a place), set `newClient = true` and CREATE it — Step 5
  saves WITHOUT an id (name/company + the new booking). This is how a factlet found in the
  wild becomes a row. If it's just noise (no real client or no dated event), complete and stop:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[], bookingIds:[], factletIds:[factletId], sourceIds:[],
    summary:"sweep -- no bookable client", needsJudge:false }})
```

## Step 2 — Load context (one batch; no further data calls)
```
precrime__find({ action:"factlets", filters:{ id: factletId }, limit:1 })
precrime__find({ action:"clients",  filters:{ id: clientId },  limit:1 })   // SKIP if newClient
```
Capture — Factlet: `content`, `source`, `createdAt`. Client (when not newClient): `name`,
`company`, `website`, `clientNotes`, `dossier`, last 3 bookings (`id`, `title`, `location`,
`zip`, `startDate`, `trade`).
Factlet missing → `failed` `factlet_missing`. Client missing (and NOT newClient) → `failed` `client_missing`.

## Step 3 — Relevance (qualitative; you are the filter)
Does this factlet have sales-intelligence value for selling `[trade]` — to this client or
clients like them? **Lean RELEVANT; a false negative costs more than a false positive.**

RELEVANT if it provides ANY of:
- **Event/occasion** matching `audienceSegments` (need not name this client; market-level counts).
- **Demand** for `[trade]` or adjacent (RFP, "seeking vendors", inquiry) — implied is fine.
- **Contact**: a named person + role + affiliation with THIS client who could book/authorize.
  Role-without-name, or a person at another org, does NOT count.
- **Geography**: places this client inside (or outside) `geography`/`serviceZips`.
- **Trade/buyer profile**: industry, scale, event cadence, org type mapping to `buyerRoles`/
  `audienceSegments`; includes `notBuyer` negatives.

`no_change` ONLY if clearly unrelated AND no contact AND no geography/buyer AND no event signal —
or name-collision (different org sharing a name token; check `company`/`website`/bookings) —
or verbatim duplicate already in dossier. Do NOT exclude for: not naming the client, implied
demand, a competitor (still intel), or a weak signal.

## Step 4 — Dossier entry (if relevant)
Pick one action: `append_dossier_entry` (new info) | `rewrite_existing_dossier_entry` (cite the
line it supersedes) | `update_permanent_profile` (structural: contact/org/venue/ownership) |
`no_change` (duplicate). Use factlet `createdAt`; never invent dates. Format:
```
[YYYY-MM-DD] [event|demand|contact|geography|background] one concise sentence. Source: [factlet source]
[PERMANENT] stable structural fact (contacts, org, geography)
```

## Step 5 — Save (skip if no_change)
ALWAYS pass `factletId`. The server verifies each structured value verbatim against the factlet
text and DROPS anything not present — so include `email`/`phone`/`zip`/date ONLY if you can read
it in the factlet. This is your safety net against a false hot leed.

- **Existing client** → pass `id: clientId`.
- **New client** (sweep-create, `newClient`) → OMIT `id`; pass `name`/`company` + `source`. The server dedups-or-creates.

**Bookings — this is how a factlet becomes a leed:**
- Factlet describes a future event NOT already among the client's bookings → add a `bookings[]`
  entry **WITHOUT `id`** → the server CREATES the booking, linked to this client.
- It updates an existing booking → use that booking's `id` from Step 2.
Give the event's verified `title`, `startDateParts`, `zip`, `location`, `trade`.
```
precrime__pipeline({ action:"save", id: clientId /* OMIT when newClient */, factletId, judge:false,
  patch:{
    name:"<org/person>",        // ONLY when creating a new client (no id)
    company:"<org>",            // ONLY when creating a new client
    source:"<factlet source>",  // ONLY when creating a new client
    dossier:"<full updated dossier text>",   // existing client: full text, not just the new line
    email:"<decision-maker DIRECT email>",   // optional — verified, only if stated for THIS client
    phone:"<direct phone>",                  // optional — verified
    bookings:[{
      // id:"<existing bookingId>"  ← include to UPDATE; OMIT to CREATE a new future booking
      title:"<event name>", trade:"<trade>", location:"<venue/city>", zip:"<5-digit venue zip>",
      startDateParts:{ year:2026, month:6, day:26, hour:7, minute:0, ampm:"pm" }
    }]
  }})
```
A booking turns HOT only with a direct email (not info@/expo@) + venue zip + future date + start
time — supply these whenever the factlet gives them. Do NOT set `Booking.status` (the judge
promotes). Always `judge:false`. The save response returns the created/affected client and booking
ids — use them in Step 6.

## Step 6 — Complete
Saved (enriched a client, and/or created a client/booking) — use the ids the save returned:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[<savedClientId>], bookingIds:[<createdBookingId if any>], factletIds:[factletId], sourceIds:[],
    summary:"Applied <factletId>: <action> (e.g. enriched <clientId> | created client+booking).", needsJudge:true }})
```
No change:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[], bookingIds:[], factletIds:[factletId], sourceIds:[],
    summary:"<not relevant | already covered>", needsJudge:false }})
```
Failure:
```
precrime__pipeline({ action:"complete_task", taskId, status:"failed",
  error:"<factlet_missing|client_missing|tool_error|wrong_task_type>",
  output:{ clientIds:[], bookingIds:[], factletIds:[factletId], sourceIds:[], summary:"<reason>", needsJudge:false }})
```
Never leave a claimed task open. Then STOP — do not claim another task.
