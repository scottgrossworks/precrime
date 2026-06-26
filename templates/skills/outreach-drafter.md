---
name: outreach-drafter
description: One-Task DRAFT_OUTREACH worker. Load the target Booking and its Client, judge outreach-readiness JIT, compose an email from dossier + booking + VALUE_PROP, save the draft, complete. Never auto-sends.
triggers:
  - draft outreach
  - compose email
  - write draft
  - DRAFT_OUTREACH worker
---

# outreach-drafter — DRAFT_OUTREACH worker

Process ONE already-claimed task whose target is a BOOKING. Load the Booking + its
Client, judge JIT whether the leed is outreach-ready, and if so save the draft via
`save({ judge:false })`. Complete either way. Never call `claim_task`, `plan_tasks`,
`rescore`, or `judge_affected`. Never compute scores or `Booking.status` (server-side).
Never auto-send — the orchestrator decides send vs draft.

## Step 0 — Load task + Gmail gate
- `taskId = env.PRECRIME_TASK_ID`. Missing → complete `failed` `missing_task_id`, stop.
- `precrime__pipeline({ action:"get_task", taskId })` → `bookingId = task.targetId`.
  Not `{ type:"DRAFT_OUTREACH", targetType:"Booking" }` → complete `failed` `wrong_task_type`, stop.
- Gmail gate (BLOCKING): if `gmail__gmail_send` is not in your tools → complete `failed`
  `OUTREACH_REQUIRES_GMAIL`, stop. Never compose without a delivery path.

## Step 1 — Load leed
- Booking: `precrime__find({ action:"bookings", filters:{ id: bookingId } })` → read `clientId`.
- Client: `precrime__find({ action:"clients", filters:{ id: booking.clientId }, summary:false, limit:1 })`.
- Identity (pull verbatim via get_config, NEVER from memory / VALUE_PROP paraphrase):
  `signature` via `get_config({ key:"signature" })`; `companyName`/`companyEmail`/`defaultTrade`/
  `leedzEmail` via `get_config` as needed. VALUE_PROP.md supplies pitch, differentiators, RATE, style.

## Step 2 — Outreach-ready gate (JIT)
Draft ONLY if ALL hold: client is real; a real direct email (not generic/shared inbox); the
contact is a decision-maker who can hire for the VALUE_PROP; product-market fit between
VALUE_PROP and dossier + booking. If not → complete `done` with a `skip:` reason
(`skip: generic email` / `skip: no decision-maker` / `skip: no product-market fit`), stop.
Skipping is normal, not a failure.

## Step 3 — Compose (three paragraphs, natural prose, first person)
Goal: start a real conversation to book THIS event. Use real dossier + booking facts; invent
nothing; refer to dates in plain words (never epochs).
1. **Their event + the question.** Salutation, then straight into their world. **SALUTATION:
   first name only ("Dear Bob,") or honorific + last name ("Dear Mr. Jones,") — NEVER full name.**
   State their specific event/date/venue/milestone, then ask a question whose answer is obviously yes.
2. **The scene.** Show what it looks like when the product is at their event — attendees, staff,
   brand — using VALUE_PROP differentiators. Concrete, not "this is a good fit."
3. **Credentials + rate + close.** What you provide and where (ground in their geography/venue).
   Anchor the rate ("Rates start at [RATE]"). Close with an **imperative** ("Let's add live art
   to your booth!"), never a soft ask.

Append the signature: `sig = precrime__pipeline({ action:"get_config", key:"signature" })`.
Append `sig.value` VERBATIM (no rewording/reformatting/added lines). `sig.present === false` →
do not compose, log `MISSING_SIGNATURE`, fail. RATE mandatory — missing in VALUE_PROP → do not
compose, log `MISSING_RATE`, fail.

**Banned:** auto-mail tells ("I'm writing to…", "I'm reaching out…", "I hope this finds you well");
soft closes ("Would you be open to…", "Let me know if…"); full-name salutations; em/en dashes and
double hyphens (corrupt in email clients); any phrase in VALUE_PROP `forbidden`.

## Step 4 — Save (judge:false)
```
precrime__pipeline({ action:"save", id: clientId, judge:false,
  patch:{ draft:"[email text with verbatim signature]", draftStatus:"ready" }})
```

## Step 5 — Complete
Drafted:
```
precrime__pipeline({ action:"complete_task", taskId, status:"done",
  output:{ clientIds:[clientId], bookingIds:[bookingId],
    summary:"drafted outreach for <clientId> / booking <bookingId>", needsJudge:false }})
```
Skipped (not outreach-ready): `status:"done"`, summary `"skip: <reason>"`, `needsJudge:false`.
Failure (MISSING_SIGNATURE / MISSING_RATE / thin dossier / gmail unavailable):
```
precrime__pipeline({ action:"complete_task", taskId, status:"failed",
  error:"<reason>",
  output:{ clientIds:[clientId], bookingIds:[bookingId], summary:"drafter failed: <reason>", needsJudge:false }})
```
Never leave a claimed task open. Then STOP — one worker, one task.
