---
name: outreach-drafter
description: One-Task DRAFT_OUTREACH worker. Load the target Booking and its Client, judge outreach-readiness JIT, compose an outreach email from the dossier + booking + VALUE_PROP, save the draft, complete the Task. Never sends in headless.
triggers:
  - draft outreach
  - compose email
  - write draft
  - DRAFT_OUTREACH worker
---

# Outreach Drafter

One-Task worker for `DRAFT_OUTREACH`. Consumes ONE already-claimed Task whose target is a BOOKING, loads the Booking and its Client, judges JIT whether the leed is outreach-ready, and if so saves the draft text via `pipeline.save({ judge:false })`. Completes the Task either way. Never calls `claim_task`, `plan_tasks`, `rescore`, or `judge_affected`. Never computes scores or `Booking.status` (classification is server-side). Never auto-sends in headless -- the orchestrator (`headless_flow.md`) decides the send/draft path.

---

## Step 0 -- Accept Claimed Task

The orchestrator has already called `claim_task` and handed you the Task packet.

Set:

- `taskId = task.id`
- `targetType = task.targetType`
- `bookingId = task.targetId`

Expected Task: `{ type:"DRAFT_OUTREACH", targetType:"Booking", targetId }` where `targetId` is the Booking id. If the Task is missing or not this type, stop and report `wrong_task_type`; do not claim another Task.

## Step 0.5 -- Gmail gate (BLOCKING for outreach)

Verify the Gmail MCP is registered (the tool name `gmail__gmail_send` must appear in your available tools). If not, complete the Task `failed` with `error: "OUTREACH_REQUIRES_GMAIL"` and stop. Do not compose without a delivery path.

---

## Input

- The claimed Task's target is a BOOKING. Load the Booking, then its Client (this is the leed):
  - Booking: `precrime__find({ action: "bookings", filters: { id: bookingId } })` (or `precrime__pipeline`). Read its `clientId`.
  - Client: `precrime__find({ action: "clients", filters: { id: booking.clientId }, summary: false, limit: 1 })`. The draft is composed from `Client.dossier` + the Booking.
- **Mandatory identity fields (Config-mirrored, NOT paraphrased from memory):**
  - `signature` -- pulled via `precrime__pipeline({ action: "get_config", key: "signature" })`
  - `companyName` / `companyEmail` / `defaultTrade` / `leedzEmail` -- pulled via `get_config` when needed for the close
- VALUE_PROP.md (for pitch, differentiators, outreach style examples, forbidden phrases, RATE -- broad context only)

---

## Outreach-Ready Gate (JIT, per leed)

Before composing, judge this leed just in time. Classification is server-side and you never set status, but you still decide here whether THIS leed is worth an email. It is outreach-ready only if ALL hold:

- the Client is real,
- there is a real direct email (not a generic / shared inbox),
- the Client is a decision-maker who can actually hire for the VALUE_PROP,
- there is product-market fit between the VALUE_PROP and the dossier + booking.

If it is NOT outreach-ready, do NOT draft. Complete the Task `done` with a short reason in `summary` (e.g. `skip: generic email`, `skip: no decision-maker`, `skip: no product-market fit`) and stop. Skipping is a normal outcome, not a failure.

---

## Draft Structure

Goal: start a real conversation that leads to the user booking THIS event -- either to get missing details, or to sell the user as the right vendor for it. Lead with why the VALUE_PROP fits this specific event, reference real facts from the dossier + booking, make one clear ask, and stay warm, brief, and first person. Never imply the client made a bad past choice.

Three paragraphs. Each one earns its place. They should read as natural prose, not as labeled sections.

### Paragraph 1: Their Event + The Question

Open with a salutation, then go straight into their world.

**SALUTATION RULE:** Use first name only ("Dear Bob,") or honorific + last name ("Dear Mr. Jones,"). NEVER use full name ("Dear Bob Jones,"). Full-name salutations are the hallmark of automated mail. If the client record has "Bob Jones", the salutation is "Dear Bob," -- always.

State their specific event, date, venue, and any milestone or context from the dossier and factlets. Then, in the same paragraph, ask a question where the answer is obviously YES. The question should frame the need the product fills, using language specific to their situation.

The reader must recognize their own event in the first sentence. Weave dossier facts and factlet context naturally. Do not mechanically list them.

**Example:**
> Dear Marina,
>
> Lifeway Foods is celebrating its 40th anniversary at TheFitExpo Anaheim this August. With the launch of Muscle Mates and your focus on wellness leadership, would you be interested in a celebratory draw to drive traffic and mark this milestone?

### Paragraph 2: The Scene

Paint what it looks like when the product is at their event. Do not just declare "this is a good fit." Show it. Describe what happens for their attendees, their staff, their brand. Use VALUE_PROP differentiators to make the scene concrete and specific to their context.

The reader should be able to visualize the product working at their event after reading this paragraph.

**Example:**
> A live caricature activation is the perfect way to reward health-conscious attendees at your booth. It provides a 5-minute window for your staff to discuss Lifeway's probiotic innovations while I create a personalized, high-quality keepsake that guests actually frame and keep at home.

### Paragraph 3: Credentials + Rate + Close

State what you provide and where, grounding it in the client's geography or venue type. Anchor the rate. Close with an **imperative** -- a direct statement of what should happen next, not a question or a soft ask.

**The close is a command, not a request.** "Let's add live art to your booth!" not "Would you be interested in discussing..." The reader should feel momentum, not a door to politely decline.

**Example:**
> I provide professional live entertainment for major activations at the Anaheim Convention Center. Rates start at [RATE] with no deposit required. Let's add live art to the Lifeway booth!

Then the signature block. Fetch it first:

```
sig = precrime__pipeline({ action: "get_config", key: "signature" })
```

Append `sig.value` to the draft VERBATIM -- no rewording, no reformatting, no added greeting words, no synthesized name / title / phone / email lines. If `sig.present === false`, do NOT compose; log `MISSING_SIGNATURE` and stop. The signature must never be reconstructed from memory, VALUE_PROP paraphrase, or the Client record.

**RATE is mandatory.** Comes from VALUE_PROP.md (broad context). Anchor with "Rates start at [RATE]" plus any notes (deposits, payment methods). If VALUE_PROP has no rate, do not compose. Log `MISSING_RATE`.

**SIGNATURE is mandatory.** Comes from `pipeline.get_config({ key: "signature" })`. If missing, do not compose. Log `MISSING_SIGNATURE`.

---

## Banned Patterns

- Auto-mail tells: "I'm writing to...", "I'm reaching out because...", "I hope this finds you well"
- Soft closes: "Would you be open to...", "Let me know if you're interested", "Feel free to reach out". Close with an imperative.
- Full-name salutations ("Dear Bob Jones,"). Use first name only or honorific.
- Em-dashes, en-dashes, double hyphens (corrupt in email clients).
- Any phrase in VALUE_PROP config `forbidden` list.

---

## Procedure

1. Load the Booking by `bookingId`, then load its Client by `booking.clientId`. Set `clientId = booking.clientId`.
2. Run the Outreach-Ready Gate. If not outreach-ready, complete `done` with a short `skip:` reason in `summary` and stop -- do not compose.
3. Fetch the signature: `sig = precrime__pipeline({ action: "get_config", key: "signature" })`. If `sig.present === false`, stop and log `MISSING_SIGNATURE`.
4. Read the Client's dossier + the Booking. Identify the strongest hook (most specific, most recent). Refer to any dates in plain words; never emit epochs.
5. Read VALUE_PROP.md outreach examples for style/tone reference. Do NOT paraphrase the signature or seller identity from it -- those come from `get_config`.
6. Compose the three paragraphs. Read the draft aloud in your head. Does it flow?
7. Append `sig.value` verbatim as the closing signature block.
8. Self-check: banned patterns? Rate included? Signature appended verbatim? One clear ask? Close is event-specific? No epochs in prose?
9. Save with `judge: false` (workers do not invoke Judge inline; classification is server-side):
   ```
   precrime__pipeline({ action: "save", id: clientId, judge: false, patch: {
     draft: "[the email text with verbatim signature appended]",
     draftStatus: "ready"
   }})
   ```
10. Complete the Task:
   ```
   precrime__pipeline({
     action: "complete_task",
     taskId: taskId,
     status: "done",
     output: {
       clientIds:  [clientId],
       bookingIds: [bookingId],
       summary:    "drafted outreach for <clientId> / booking <bookingId>",
       needsJudge: false
     }
   })
   ```

On failure (MISSING_SIGNATURE, MISSING_RATE, thin dossier, gmail unavailable):

```
precrime__pipeline({
  action: "complete_task",
  taskId: taskId,
  status: "failed",
  error:  "<short reason e.g. MISSING_SIGNATURE>",
  output: { clientIds: [clientId], bookingIds: [bookingId], summary: "drafter failed: <reason>", needsJudge: false }
})
```

Then stop. Do NOT claim another Task -- one worker, one Task.

---

## Rules

1. Never invent facts, dates, names, or numbers. If the dossier is thin, the draft is thin.
2. Never reference facts not in the Client's dossier or the Booking.
3. Refer to dates in plain words. Never emit epochs in the draft.
4. If the leed is not outreach-ready, skip it: complete `done` with a short `skip:` reason. Do not draft.
5. Drafts land at `draftStatus: "ready"` for human review. Never auto-send in headless. Interactive `show-hot-leedz.md` is where send approval happens.
6. If RATE or SIGNATURE is missing from VALUE_PROP config, do not compose -- complete `failed` with the structured reason.
7. Do not call `pipeline.plan_tasks`, `pipeline.rescore`, or `pipeline.judge_affected`. Never compute scores or `Booking.status`; classification is server-side.
