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

Merge, deduplicate by id. For each booking, evaluate which gates it passes (use the data already loaded -- no extra MCP calls):

- **share-ready**: `status=hot` AND `client.contactGate=true` AND `booking.zip` present AND `booking.trade` present. A missing `booking.description` is NOT a blocker — you synthesize the marketplace blurb from the client dossier at share time (Step 4 `share`).
- **outreach-ready**: (`status=hot` OR `status=brewing`) AND `client.email` present AND `booking.startDate` present

**HARD FILTER — a booking that passes NEITHER gate is NEVER presented.** No email and no
share path means there is NOTHING the user can do with it; showing it wastes their time.
Drop it from the list and count it — the missing email is the conductor's job (DRILL_DOWN),
not the user's. This rule has no exceptions: never present a card whose only annotation
would be "cannot share / cannot outreach".

Order the survivors by soonest `startDate` first. If NO survivors, complete with empty ids,
summary `"no actionable leedz (<dropped> hot/brewing lack contact info)"`, `needsJudge:false`.

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

After the cards, report the hidden ones in ONE line, never as cards:
`(<N> more brewing leedz have no contact info yet — say "workflow" to send the conductor email-hunting)`

Order: PRIVATE celebrations FIRST — a single host's own wedding, birthday, quinceañera,
bar/bat mitzvah, sweet 16, shower, graduation or similar life event (the ideal client:
a one-to-one booking, whatever the trade). Then other direct bookings (corporate parties,
galas). Then container-derived vendor leads last. Within each group, soonest `startDate` first.

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

- `outreach`: user wants the gig; email the client. **You do not WRITE this email. You REWRITE the seller's approved template. Composing from scratch is FORBIDDEN.**
  1. Fetch the template and signature (two calls, always first):
     `precrime__pipeline({ action:"get_config", key:"sampleEmail" })` and
     `precrime__pipeline({ action:"get_config", key:"signature" })`.
     These keys are ALWAYS present on this server. If you think one is missing, you did not
     actually make the call — make it now. NEVER tell the user the template is missing and
     NEVER compose without it.
  2. Rewrite the `value` of sampleEmail for THIS booking. Keep every sentence, same order,
     same length, same tone. Change ONLY: recipient first name, their company/brand, event
     name, event date in plain words, venue/city — all taken from the card you showed in
     Step 3. A fact you do not have: drop that clause, never guess. Keep the rates line,
     the no-deposit line, and the video link EXACTLY as written. The template tailors one
     product detail to its own event (pre-printed car bodies for an auto show): retarget
     that ONE detail to this event's theme, or drop it if nothing fits.
  3. End with the signature `value` VERBATIM. No em dash, en dash, or double hyphen
     anywhere in subject or body — use commas.
  4. Call `gmail__gmail_send` IMMEDIATELY with the rewritten email. Do NOT print the
     email in the terminal first and do NOT ask "shall I create the draft?" — the user
     saying draft/outreach IS the instruction, and the tool is HARD-GATED DRAFT-ONLY:
     it puts the email in the user's Gmail Drafts folder and NEVER sends it. The user
     reviews it IN GMAIL, so showing it on screen or asking permission only wastes
     their time and tokens. After the call, report exactly ONE line:
     `Draft in your Gmail Drafts folder: <client> / <event>` — never say "sent".
  **This is NOT the marketplace path. Do NOT call `share_booking` (that builds a marketplace brief, not a client email). Do NOT call any `tavily__*` tool. Do NOT call `pipeline.save` or write factlets. Do NOT research the client or event on the web — every fact you need is already loaded.** If the user supplies a template path, you MAY read it once with `developer__shell` `type` and follow its structure — that is the ONLY additional read allowed on this branch. Keep it brief when asked.
  You do NOT record the send. The gmail send tool marks the client sent and resets its bookings out of hot PROCEDURALLY — the action records itself, no save from you. This applies to BOTH a real send AND `draft:true`: a Gmail draft consumes the leed exactly like a send — the client goes cold and never returns to the hot list. Never re-present a leed after drafting for it, and never claim the client was not contacted when a draft exists. (A client already at `draftStatus:"sent"` is prior outreach: it should not be in your hot list at all; if you somehow see one, warn "already emailed" and skip.)

- `skip`: PERMANENT dismissal. The user rejected this leed; it must never be presented as hot again. Call:
  ```
  precrime__pipeline({ action: "dismiss_booking", bookingId: <id> })
  ```
  The server marks it acted-on so the classifier keeps it cold through every future rescore and the hot query excludes it. This is the ONLY way to make a hot leed stop coming back. Do not just move on without calling it -- a skip with no `dismiss_booking` call will resurface next run.

Collect acted-on `bookingIds` and `clientIds`.

- **`ignore <name>` / `blacklist <name>` — the user wants a company or person GONE FOREVER** ("ignore Rivian", "never show me X again", "no more X", "blacklist X"): call `precrime__pipeline({ action:"ignore", term:"<the name>" })` ONCE. The server dismisses every existing matching booking, cancels their open tasks, and refuses all future saves mentioning the name — permanent and immediate. Quote the response counts. This is stronger than `skip` (one booking); use it when the user names the client, not the booking. Never argue, never substitute dismiss_booking, never ask "are you sure".
- **`drill <name>` / `enrich <name>` — the user NAMES a specific client or company** ("DRILL_DOWN Rock Dimension", "dig into Acme Corp", "enqueue X", "find X's upcoming events", "research X until we can email them"): call `precrime__pipeline({ action:"enqueue", client:"<the name>" })` ONCE. This is a USER ORDER: it creates that client's task directly, at the FRONT of the queue, and arms the conductor if needed — never answer that plan_tasks can't target a client, never substitute a system-wide plan_tasks, never offer alternatives. Quote the literal response status ("ENQUEUED — front of queue"). On `AMBIGUOUS`, show the candidates, ask which one, re-call with `clientId`. Then continue presenting.
- `enrich` / `drill` / `workflow` with NO specific client named (general "run the workflow", "continue workflow", "start the workflow", "fill the queue", "keep working" — ESPECIALLY when there are zero hot leedz to present): hand it to the background conductor — call `precrime__pipeline({ action:"plan_tasks", mode:"workflow" })` ONCE. Never answer a workflow request with `claim_task`, a status report alone, or a question — the ONE correct action is that single plan_tasks call, then report "Queue seeded — conductor running." That arms the Node conductor, which runs discovery / DRILL_DOWN / ENRICH_CLIENT in its own window while you keep presenting. Tell the user it's running in the background and to re-list hot leedz later to see the enrichment. Do NOT claim or run worker skills yourself, and do NOT block waiting on it. (You do NOT need this to SHARE — the share blurb is synthesized from the dossier at share time. Enrichment deepens the dossier; it is not a share prerequisite.)

Forbidden in this worker: `pipeline.save`, `pipeline.rescore`, `pipeline.judge_affected`, `pipeline.resolve_dates`, ALL `tavily__*` tools (`tavily_search` AND `tavily_extract` — the presenter never web-searches; outreach composes inline, share research belongs to the conductor's enrichment tasks), claiming or running worker task skills yourself, external Leedz tools. You never write bookings, scores, draftStatus, or status by hand — action side effects are procedural (the send marks sent; dismiss/share mark acted-on). Allowed: `dismiss_booking` (skip), `share_booking` with a synthesized `dtDraft` (share), `gmail__gmail_send` (outreach — the send records itself), `enqueue` (user names ONE client to drill/enrich — front of queue), and a SINGLE `plan_tasks({mode:"workflow"})` to hand enrichment to the conductor when the user asks with no specific client named.

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
