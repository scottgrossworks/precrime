# {{DEPLOYMENT_NAME}} -- Value Proposition Reference

This document is the Composer's reference. The enrichment agent reads it before writing any outreach draft.
**Complete this document before running the pipeline.** The quality of this document directly determines the quality of every draft.

---

## THE PRODUCT

**[YOUR PRODUCT NAME]**
**Trade:** [LEEDZ TRADE CATEGORY -- must match a name returned by precrime__trades()]
**Seller:** [YOUR NAME] -- [YOUR COMPANY]
**Email:** [YOUR EMAIL]
**Website:** [YOUR WEBSITE]
**Geography:** [GEOGRAPHY SERVED]
**Pricing:** [PRICING]

---

## SIGNATURE

<!-- REQUIRED STRICT FORMAT.
     This top-level heading is the canonical signature source.
     Put only the literal email signature lines below. No sample email, no prose,
     no greeting. Everything until the next `---` is mirrored into Config and
     appended verbatim by outreach drafting. Lines still containing `[YOUR ...]`
     placeholders are treated as unset.

     Startup also accepts legacy nested headings like `### Signature`, but new
     deployments should use this exact `## SIGNATURE` block. -->

[YOUR NAME]
[YOUR COMPANY]
[YOUR EMAIL]
[YOUR PHONE]
[YOUR WEBSITE]

---

## THE PITCH (2-3 sentences)

*[Describe the product in 2-3 sentences. What it is, what problem it solves, who it's for.]*

---

## WHY US -- DIFFERENTIATORS

*[List 3-5 specific differentiators. Not "professional" or "experienced" -- name facts.]*

---

## WHO BUYS THIS

**Primary buyers:** [TARGET ROLES -- e.g., "HR Managers, Event Coordinators"]
**Segments:** [AUDIENCE SEGMENTS -- e.g., "Corporate events, Weddings, Private parties"]
**Buying occasions:** [TRIGGER EVENTS -- what makes someone need this now?]

---

## THE SALE -- HOW TO MAKE IT

<!-- FILL IN THIS SECTION MANUALLY
     ==============================
     Describe the sales motion:
     - What makes a prospect warm vs cold?
     - What's the typical objection and how do you answer it?
     - What's the ideal first conversation ask? (demo, call, trial, quote)
     - What urgency levers exist? (seasonal, compliance, competitor moves)
     - What does a "yes" look like? (booking, signed contract, meeting scheduled)
-->

*[Complete this section with the actual sales motion for your product]*

---

## PAIN POINTS WE ADDRESS

<!-- FILL IN THIS SECTION MANUALLY
     ==============================
     For each pain point:
     - Name the pain clearly
     - Describe the emotional weight of it (what does it feel like to have this problem?)
     - Explain how your product addresses it specifically
     - If you have metrics, case studies, or testimonials -- add them here
     Example:

     ### Pain: [Name the pain]
     [What does this feel like from the buyer's perspective?]
     **How the product helps:** [specific capability or outcome]
     **Evidence:** [metric, testimonial, case study -- no invented stats]
-->

### Pain 1: [Name it]
*[Complete manually]*

### Pain 2: [Name it]
*[Complete manually]*

### Pain 3: [Name it]
*[Complete manually]*

---

## OBJECTIONS AND RESPONSES

<!-- FILL IN THIS SECTION MANUALLY
     ==============================
     Common objections you hear and your best answers.
     The Composer uses this to preemptively address concerns in the draft.

     ### "We already have [X]"
     [Your response]

     ### "We don't have budget right now"
     [Your response]

     ### "Send me more information"
     [Your response -- usually: ask for a 15-minute call instead]
-->

*[Complete manually]*

---

## PROOF POINTS

<!-- FILL IN THIS SECTION MANUALLY
     ==============================
     Real evidence. No invented facts, metrics, or unnamed customers.
     - Named client results (if you have permission to share)
     - Before/after stories
     - Testimonial quotes
     - Industry recognition, certifications, awards
     - Years in business, volume served
-->

*[Complete manually -- only use facts you can verify]*

---

## COMPETITIVE LANDSCAPE

<!-- FILL IN THIS SECTION MANUALLY
     ==============================
     Who else does the buyer consider?
     How are you different from them?
     When should you mention competitors vs. not?
-->

*[Complete manually]*

---

## OUTREACH EXAMPLES (GOOD DRAFTS)

<!-- FILL IN THIS SECTION MANUALLY
     ==============================
     Add 2-3 real examples of outreach drafts that worked (got replies).
     The Composer will use these as style reference.
     Format: [Client type] -> [Draft text]
-->

*[Add working examples here -- these are the single highest-value content in this document]*

---

## RELEVANCE SIGNALS

The enrichment agent and harvesters use these to filter articles, posts, and scraped content. Fill in after you know your audience.

### Relevant -- High Signal (strong buying intent)

*[List phrases or topics that indicate someone needs your product RIGHT NOW.
Example: "looking for [your service]", "need [your product type]", "[specific buying phrase for your audience"]*

### Relevant -- Medium Signal (context, not urgent)

*[Topics that are relevant background but not an active buying signal.
Example: "planning a corporate event", "event entertainment ideas"]*

### Relevant -- Timing Signals

*[Words that suggest a deadline or booking window is open.
Example: "save the date", "planning for", "event is in [month]"]*

### Not Relevant -- Skip These

*[Topics that look adjacent but aren't. Keeps the relevance filter tight.
Example: "digital art commission", "graphic design job posting"]*

### Banned Terms

<!-- HARD blocklist, enforced PROCEDURALLY by the server at save time (saveClient.js) --
     this is not advisory prose. Any NEW client or booking whose name, company, segment,
     title, description, or location contains one of these terms (case-insensitive
     substring) is refused and never enters the database. Use it for categories you have
     permanently rejected (e.g. after deleting them: they stay deleted). One term per
     bullet; keep terms specific -- every save is substring-matched against them. -->

*[List permanently banned terms, one per bullet, e.g.:]*
*[- comic con]*

---

## SOURCE DISCOVERY

Everything an agent needs to CONSTRUCT a source-finding prompt should be above —
Trade, Geography, Buyer Roles, Audience Segments, Relevance Signals. Fill those in well
and an agent can discover real sources, validate them, and add them to the per-channel
seed files; the harvesters scrape them and the wizard's `import_sources` loads new entries.

**Channels to mine** (each has a seed file under `skills/`):
- RSS / blogs — `skills/rss-factlet-harvester/rss_sources.md`
- Facebook pages / groups — `skills/fb-factlet-harvester/fb_sources.md`
- Instagram handles / hashtags — `skills/ig-factlet-harvester/ig_sources.md`
- Reddit subreddits — `skills/reddit-factlet-harvester/reddit_sources.md`
- X / Twitter accounts — `skills/x-factlet-harvester/x_sources.md`
- Directories / listings — `skills/source-discovery/discovered_directories.md`

**What a good source looks like:** a place where your Buyer Roles announce or plan your
Audience Segment events within your Geography — where FUTURE events surface *with a date and
an organizer contact*. Prefer sources that pair an event with who to contact.

**Query patterns to construct** (fill from Trade + Geography + Audience Segments):
- `<audience segment> <city/zip> <year>`
- `<buyer role> <city> seeking <trade> / vendors`
- `<city> festivals fairs <year> vendor application` / `<venue> event calendar`
- `"<audience segment>" site:eventbrite.com OR site:facebook.com/events <city>`

**Rule:** validate before adding — the handle / feed / subreddit must exist, be active, and
match the Trade + Geography. A hallucinated source is worse than none.

---

<!-- INSTRUCTIONS FOR COMPLETING THIS DOCUMENT
     ==========================================
     Priority order for completion:

     1. OUTREACH EXAMPLES -- fill these in first if you have any
        Real working drafts are better than any instruction.

     2. DIFFERENTIATORS -- what makes you different?
        Be specific. "Professional" is not a differentiator. "Warner Bros. veteran,
        12-15 faces/hour" is a differentiator.

     3. PAIN POINTS -- what problems do you solve?
        Name the emotional experience of the problem, not just the functional one.

     4. THE SALE -- what happens after the first email?
        If you don't know the sales motion, the Composer can't close.

     5. PROOF POINTS -- evidence only, no invented stats.
        One real testimonial is worth 10 marketing bullets.

     The enrichment agent reads this file at Step 5 (Compose).
     The more specific and honest this document is, the better the drafts.
-->
