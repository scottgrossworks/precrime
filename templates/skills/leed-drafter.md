---
name: leed-drafter
description: Build addLeed JSON payload from booking + client + factlets. Procedural.
triggers:
  - draft leed
  - build leed
  - compose leed payload
  - show me the leed
  - show the leed
  - show me the json
  - show me the payload
  - show me what you'd share
  - show me what you would share
  - preview the leed
  - preview leed
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# Leed Drafter

Procedure. Run each step in order. Do not skip. Do not deliberate.

## RULE 0 — WHAT THE USER MEANS

In marketplace mode, when the user says any of: "show me the leed", "show me the json", "show me the payload", "show me what you'd share", "draft the leed", "preview the leed" — they mean ONE thing:

> Take the booking + linked factlets + client. Build the full addLeed JSON payload (Step 4 schema, every field, no ellipsis). Print only that JSON. Nothing else.

Do not show the booking row, the client row, the factlet list, the config, the status, or any narrative. Do not ask "do you want me to draft it" — yes, that is what they asked. Do not preface with "here is" or follow with commentary. The deliverable is the JSON payload.

If a required input is missing (session, trade, startDate, client.name), STOP with the structured error from Steps 1–3 in one line. Do not invent values.

## Step 1: Get session token

Call `precrime__pipeline({"action": "status"})`. From the response, read `config.leedzSession`.

If `config.leedzSession` is empty or null → STOP. Return `{"error": "NO_SESSION"}`.

## Step 2: Get valid trades

Call `precrime__trades()`. You receive an array of trade name strings.

If `booking.trade` (lowercased) is not in that array → STOP. Return `{"error": "INVALID_TRADE", "trade": booking.trade}`.

## Step 3: Validate inputs

Check the booking and client values you already have in context:

- `booking.startDate` not blank → continue. If blank → STOP `{"error": "NO_DATE"}`.
- `client.name` not blank → continue. If blank → STOP `{"error": "NO_CONTACT_NAME"}`.

## Step 4: Build the JSON

Substitute every placeholder in the template below with real values. Every field must be present.

```json
{
  "session": "<config.leedzSession from Step 1>",
  "tn":      "<booking.trade lowercased>",
  "ti":      "<short event-focused title, e.g. 'Mother's Day Brunch at Hotel Bel-Air, May 12'>",
  "zp":      "<booking.zip>",
  "st":      <booking.startDate as epoch ms (number)>,
  "et":      <booking.endDate as epoch ms or null>,
  "lc":      "<booking.location with zip appended if missing>",
  "dt":      "<event description, see Step 5>",
  "rq":      "<logistics, see Step 5>",
  "pr":      0,
  "cn":      "<client.name>",
  "em":      "<client.email>",
  "ph":      "<client.phone or null>",
  "sh":      "*",
  "email":   "false"
}
```

`cn`, `em`, `ph` come from the **client record**. NEVER from Config.companyName, Config.companyEmail, or any user identity. If you put the user as the contact, the proxy validator rejects the leed.

## Step 5: Write dt and rq

`dt` is the event description, third-person:

- BAD: `"Hi Ashley, I noticed your venue. I bring a 360 booth from $599."`
- GOOD: `"Mother's Day brunch at Hotel Bel-Air. ~150 guests, 11am-3pm, indoor ballroom."`

Do NOT include: greetings (Hi/Hello/Dear), first-person (I/we/our), pricing ($/from/packages/deposit), questions to a reader, vendor company names.

`rq` is logistics, third-person:

- BAD: `"Custom branding, instant prints, digital gallery."`
- GOOD: `"Indoor, 110V outlet within 20ft, 10x10 footprint, COI required, setup 9-10:30am."`

Do NOT include: deliverables ("instant prints"), seller features, sales language.

## Step 6: Return the JSON

Return the JSON object. Do NOT post it. Posting is `share-skill.md`'s job. The caller (`marketplace_flow.md` or `convention-leed-pipeline.md`) takes your output and decides next steps.

## Step 7: If you call createLeed yourself

If your task includes posting (not just drafting), then after building the JSON you call `leedz__createLeed(<json>)`. The proxy will:

- Hard-code `email="false"` and `pr=0` regardless of what you sent.
- Validate the rest. If it rejects with `-32000`, the response lists exactly what to fix. Fix and retry.
- Forward to the marketplace if validation passes.

You MUST quote the literal `result` from the proxy response when reporting success. If you cannot quote a real result, the call did not happen.
