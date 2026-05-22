---
name: outreach-drafter
description: Compose outreach email from client + dossier + factlets + VALUE_PROP config.
triggers:
  - draft outreach
  - compose email
  - write draft
---

# Outreach Drafter

Compose a cold outreach email for a specific client.

---

## Input

- Client record (name, company, email, dossier, linked factlets)
- VALUE_PROP config: PRODUCT, RATE, SIGNATURE, differentiators, outreach examples, forbidden phrases

---

## Draft Structure

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

Then the signature block:
> [SIGNATURE from VALUE_PROP]

**RATE is mandatory.** Comes from VALUE_PROP config. Anchor with "Rates start at [RATE]" plus any notes (deposits, payment methods). If VALUE_PROP has no rate, do not compose. Log `MISSING_RATE`.

**SIGNATURE is mandatory.** Comes from VALUE_PROP config. If missing, do not compose. Log `MISSING_SIGNATURE`.

---

## Banned Patterns

- Auto-mail tells: "I'm writing to...", "I'm reaching out because...", "I hope this finds you well"
- Soft closes: "Would you be open to...", "Let me know if you're interested", "Feel free to reach out". Close with an imperative.
- Full-name salutations ("Dear Bob Jones,"). Use first name only or honorific.
- Em-dashes, en-dashes, double hyphens (corrupt in email clients).
- Any phrase in VALUE_PROP config `forbidden` list.

---

## Procedure

1. Read the client's dossier. Identify the strongest hook (most specific, most recent).
2. Read linked factlets. If any add urgency or milestone context, weave into paragraph 1.
3. Read VALUE_PROP config outreach examples. Match their style, tone, and structure.
4. Compose the three paragraphs. Read the draft aloud in your head. Does it flow?
5. Self-check: banned patterns? Rate included? Signature? Close is client-specific?
6. Save:
   ```
   precrime__pipeline({ action: "save", id: clientId, patch: {
     draft: "[the email text]",
     draftStatus: "ready"
   }})
   ```

---

## Rules

1. Never invent facts. If the dossier is thin, the draft is thin.
2. Never reference facts not in the dossier or factlets.
3. Drafts land at `draftStatus: "ready"` for human review. Never auto-send.
4. If RATE or SIGNATURE is missing from VALUE_PROP config, do not compose.
