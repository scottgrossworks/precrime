---
name: precrime-init-wizard
description: Startup/initialization skill — conversationally configures a Pre-Crime deployment on first launch or re-initialization
triggers:
  - initialize this deployment
  - run setup
  - configure this workspace
  - first time setup
  - re-initialize
---

# Pre-Crime Initialization Wizard

You are configuring a Pre-Crime deployment for first use. Ask questions in order. One topic at a time. Don't ask everything at once. Write each answer to Config as you go — don't batch at the end.

**When to run:** First launch of a new deployment, or any time the user says the config is stale/wrong.

**Prerequisite:** MCP tools must be loaded. Start by calling `get_config()` to see what's already set. Skip questions whose answers are already in Config.

---

## Step 0: Check Existing Config

Call `get_config()`. Report what's already set and what's missing:

> "I found your config. Here's what's already set:
> - Company: {companyName or '(not set)'}
> - Email: {companyEmail or '(not set)'}
> - Business description: {businessDescription or '(not set)'}
> - Default booking action: {defaultBookingAction or '(not set)'}
> - Marketplace enabled: {marketplaceEnabled}
>
> I'll only ask about the missing or blank fields. Ready?"

If everything is set, say so and offer to review/update any field.

---

## Step 1: Who Are You?

Ask:

> "What's your name, company, and email address? (One line is fine — e.g., 'Scott Gross / That Drawing Show / scott@scottgross.works')"

Parse and call:
```
update_config({ companyName: "...", companyEmail: "..." })
```

Confirm: "Got it — {companyName} / {companyEmail}. Saved."

---

## Step 2: What Are You Selling?

Ask:

> "Describe what you're selling in 2–4 sentences. What is it, who buys it, why does it matter?"

Call:
```
update_config({ businessDescription: "..." })
```

If the user says "it's already in VALUE_PROP.md" — that's fine. The businessDescription in Config is a short summary (2–4 sentences) that gets injected into prompts. Ask them to summarize it.

Confirm: "Saved."

---

## Step 3: Value Prop File

Ask:

> "Is there a VALUE_PROP.md (or equivalent) file in this workspace? If yes — what's the path? If no — I can help you draft one after setup."

This is informational only — no Config write needed here. Note the path if given, so you can reference it when running the enrichment workflow.

If they want to draft it now: "I can help with that after we finish config. Let's keep going."

---

## Step 3.5: Deployment Mode

Ask:

> "Is this a gig or service business where you might share bookings to The Leedz marketplace? Or is this a B2B/non-gig outreach deployment? (gig / B2B)"

**If gig/Leedz (or unsure — default to gig):**

Fetch the canonical trade list:
```
WebFetch("https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/getTrades")
```

Present the list:
> "Here are valid Leedz trade categories: [list]. Does your service match one of these?"

- **Trade matches** → note as session context: `leedzMode = true`, `defaultTrade = [matched trade]`. Proceed to Step 4.
- **No match** → say: "Your trade isn't in The Leedz marketplace yet — marketplace sharing will be disabled. Bookings will be emailed to you instead." Note: `leedzMode = false`, `marketplaceEnabled = false`. Skip Step 5a. Proceed to Step 5.

**If B2B/non-gig:**

Note as session context: `leedzMode = false`. Skip Steps 4, 5, 5a, 6. Jump to Step 7.

---

## Step 4: Default Trade

**Skip if `leedzMode = false`.**

If trade was confirmed in Step 3.5: say "Got it — [trade]. Using that as your default trade." Skip the question.

If trade is still unset (user was unsure):
> "What trade category does your work fall under? (From the list above.)"

Note the answer as session context: `defaultTrade = [trade]`.

---

## Step 5: What to Do With a Hot Lead

This is the most important config question. Ask it clearly.

> "When the lead harvester finds a booking that hits `leed_ready` — meaning it has a trade, a date, and a location — what should I do with it by default?
>
> **Option 1 — Post to The Leedz marketplace (leedz_api)**
> I call the createLeed API automatically. The booking goes live on theleedz.com. Fully hands-off.
> *Requires: your Leedz account email and a session token (I'll ask for those next if you choose this).*
>
> **Option 2 — Email to share@theleedz.com (email_share)**
> I send the booking details to The Leedz share inbox for manual review and posting.
> *Requires: Gmail sender MCP connected.*
>
> **Option 3 — Email to you (email_user)**
> I send the booking details to your email ({companyEmail}). You decide what to do.
> *Requires: Gmail sender MCP connected.*
>
> Which default? (1 / 2 / 3)"

Note the answer. Use it as context for the rest of the session — the evaluator will use it when a booking hits `leed_ready`.

If they chose option 1 (leedz_api) → proceed to Step 5a. Otherwise skip to Step 6.

---

## Step 5a: Leedz Marketplace Credentials (only if leedz_api chosen)

Ask:
> "Your Leedz account email?"

Save the email and generate a session JWT immediately using Bash:

```bash
python -c "
import jwt, time
payload = {
    'email': 'LEEDZ_EMAIL',
    'type': 'session',
    'exp': int(time.time()) + 31536000
}
secret = '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c'
print(jwt.encode(payload, secret, algorithm='HS256'))
"
```

Substitute `LEEDZ_EMAIL` with the email they provided. Capture the printed token.

Then write both to Config in one call:
```
mcp__leedz-mcp__update_config({ leedzEmail: "[email]", leedzSession: "[token]", marketplaceEnabled: true })
```

Confirm:
> "Done — marketplace credentials saved. Session token is valid for 1 year."

**If PyJWT is not installed:** run `pip install PyJWT` first, then retry. If Python is unavailable, tell the user:
> "I can't generate the token automatically. Run this in a terminal and paste the result:
> `python -c \"import jwt, time; print(jwt.encode({'email':'YOUR_EMAIL','type':'session','exp':int(time.time())+31536000}, '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c', algorithm='HS256'))\"`"

---

## Step 6: Enable Lead Capture?

> "Should the lead harvester create Client and Booking records automatically when it finds someone posting about needing a {trade} in your area? Yes / No"

Note the answer. Use it as context for the session.

---

## Step 7: Confirm and Summary

Call `get_config()` one more time. Print a clean summary:

```
=================================================================
Configuration Set — {{DEPLOYMENT_NAME}}
=================================================================
Company:          {companyName}
Email:            {companyEmail}
Mode:             {leedzMode ? 'gig/Leedz' : 'B2B/outreach'}
Trade:            {defaultTrade or '(not set)'}
Booking action:   {defaultBookingAction or '(not set)'}
Marketplace:      {marketplaceEnabled}
Lead capture:     {leadCaptureEnabled}
Leedz account:    {leedzEmail or '(not configured)'}
=================================================================
```

If VALUE_PROP.md still needs to be written: remind them once — "Fill in DOCS/VALUE_PROP.md before the first run — that document drives draft quality."

---

## Step 7.5: Where to Harvest

**Skip if `leedzMode = false` AND `leadCaptureEnabled = false`.**

Ask:

> "Where should the harvesters look for leads? I can monitor Facebook groups/pages, subreddits, or any public community.
>
> Examples: 'LA Wedding Planning' Facebook group, r/weddingplanning, r/LAevents, a local events news feed.
>
> List what you know — or say 'skip' and I'll start with a broad keyword search."

For each source mentioned:
- Facebook page or group URL → append to `skills/fb-factlet-harvester/fb_sources.md` (create if missing)
- Subreddit name → note as session context (reddit harvest list)
- RSS URL → note as session context (add to RSS config)

If user says 'skip':
> "No problem — I'll do a broad search first and build the source list as I go."

After collecting:
> "Got it. Starting with [N source(s)]."

---

## Step 8: Launch

Say:

> "Config is set. Launching now — factlet harvesters first, then enrichment.
> Watch `logs/ROUNDUP.md` for live progress."

**If `leedzMode = true` OR `leadCaptureEnabled = true`:**
1. Run `skills/fb-factlet-harvester/SKILL.md`
2. Run `skills/factlet-harvester.md`
3. Run `skills/enrichment-agent.md`

**If outreach-only (`leedzMode = false`, `leadCaptureEnabled = false`):**
1. Run `skills/factlet-harvester.md`
2. Run `skills/enrichment-agent.md`

Harvesters run first — their factlets enrich the first wave of clients.

---

## Wizard Rules

- **One question at a time.** Don't stack questions.
- **Write to Config immediately** after each answer. Don't batch.
- **Skip what's already set.** Check Step 0 before asking anything.
- **Don't invent values.** If the user doesn't know — leave it unset and move on.
- **No sales pitch.** Don't explain Pre-Crime. They already deployed it.
