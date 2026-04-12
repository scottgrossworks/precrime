---
name: precrime-deployment-wizard
description: Interactive wizard — gather business details, build a manifest, scaffold a new Pre-Crime deployment end to end
triggers:
  - deploy a new project
  - run the deployment wizard
  - set up a new deployment
  - new pre-crime deployment
  - scaffold a new workspace
---

# Pre-Crime Deployment Wizard

You are running an interactive deployment wizard for the Pre-Crime agentic outreach framework.

Your job is to interview the user, build a complete manifest, run `deploy.js`, then walk them through every remaining manual step. Do not skip phases. Do not ask all questions at once — move through the phases in order, wait for responses, then continue.

**Run this from:** The PRECRIME root directory (where `deploy.js` lives)

---

## Phase 0: Grounding Check

Before asking anything, verify the environment:

1. Confirm `deploy.js` exists at the PRECRIME root
2. Confirm `data/template.sqlite` exists
3. Confirm `manifest.sample.json` exists

If any are missing, stop and report. The framework is not intact.

If all present, greet the user:

> "Pre-Crime deployment wizard ready. I'll ask you a few questions, build your manifest, scaffold the workspace, then walk you through the remaining setup steps. Takes about 10 minutes."
>
> "Let's start."

---

## Phase 1: Name and Workspace (3 questions, get them all at once)

Ask:

> 1. **What is the project name?** (short slug, no spaces — e.g., `DrawingShow`, `NorthStar`, `EventPro`) — this becomes the workspace folder name and MCP server name
> 2. **Where should the workspace be created?** Full absolute path — e.g., `C:\Users\YourName\Projects\DRAWINGSHOW`
> 3. **What should the database file be named?** — e.g., `data/drawingshow.sqlite` (or leave blank to use `data/{name}.sqlite`)

Wait for answers. Confirm before continuing:

> "Got it: **{name}** → `{rootDir}`. I'll name the DB `{dbFile}`. Moving on."

---

## Phase 2: Seller Identity (1 question)

Ask:

> "Who is doing the outreach? Give me: name, company, email, website, and phone (optional)."
>
> Example: "Jane Smith / Acme Events / jane@acmeevents.com / https://acmeevents.com"

Accept free-form input. Parse it into:
```json
"seller": {
  "name": "...",
  "company": "...",
  "email": "...",
  "website": "...",
  "phone": ""
}
```

---

## Phase 3: Product Description — The Generative Seed

This is the most important question. Claude uses this answer to generate the rest of the manifest.

Ask:

> "Describe what you're selling in 3–5 sentences. Cover:
> - What it is and what it does
> - Who buys it (job titles, organization types)
> - Where you operate (geography)
> - What makes you different from alternatives
> - How you price it
>
> The more specific you are here, the better the entire deployment will be. Don't worry about format — just tell me about the business."

Wait for the answer. Read it carefully. You are about to generate the entire manifest from this.

---

## Phase 4: Claude Builds the Full Draft Manifest

Using the product description from Phase 3, generate a complete manifest JSON — every section, every field.

Do the following work BEFORE showing anything to the user:

### 4a. Derive Product Fields

From the description, extract or infer:
- `product.name` — the product or service name
- `product.description` — clean 2–3 sentence version
- `product.differentiators` — 3–5 bullet points; be specific, not generic ("Former Warner Bros. artist" not "experienced professional")
- `product.geography` — cities/regions served
- `product.pricing` — extract from description or note "(set in VALUE_PROP.md)"

### 4b. Define Audience Segments

From the buyer description, identify 1–4 distinct audience segments. For each:
- `id` — short slug (`schools`, `corporate`, `community`)
- `label` — human-readable name
- `targetRoles` — specific job titles for that segment; be concrete (`ASB Advisor` not `school staff`)
- `events` — occasions that trigger a purchase decision for this buyer
- `seasonalWindows` — when is this segment in buying mode?
  - `name` — season name
  - `months` — months when outreach should happen (the lead-up, not the event)
  - `event_months` — when the event actually occurs
  - `lead_weeks` — how many weeks before the event to book

**Seasonal window guidance:**
- Events/entertainment: 4–8 week lead (book before dates fill)
- B2B SaaS: no seasonal windows unless tied to budget cycles (Jan, Sep)
- Professional services: align to decision cycles (budget review, new year, new school year)
- If the buyer has no clear season, leave `seasonalWindows: []`

### 4c. Define Relevance Signals

From the buyer's world:
- `high` — phrases that signal urgent, imminent buying intent ("prom", "holiday party", "looking for entertainment")
- `medium` — phrases that signal relevance but not urgency ("event planning", "team building")
- `timing` — phrases that signal planning is underway ("save the date", "mark your calendars", "annual")
- `not` — topics explicitly not relevant (block out noise)

### 4d. Define Factlet Topics

What industry news would make the seller say "I should mention this in my outreach"?
- `factletTopics` — 3–5 broad topic areas worth monitoring in RSS feeds
- `factletNotTopics` — 2–3 topic areas that might appear in those feeds but are irrelevant

### 4e. Define Warmth Scoring

Generate 6–7 scoring categories (total 10 points) appropriate for this business type.

**Universal categories (always include):**
- Contact Quality (max 2): 0=no email, 1=generic inbox, 2=named decision-maker with direct email
- Intel Depth (max 1): 0=no usable web presence, 1=scraped something useful

**Business-type categories:**

For **event/booking** businesses:
- Timing Signal (max 2): 0=off-season, 1=planning season active, 2=specific upcoming event identified
- Event Signal (max 2): 0=no evidence they run events, 1=historical evidence, 2=active planning signal
- Facebook/Social (max 1): 0=not found, 1=found with recent activity
- Org-Specific Fact (max 1): 0=only generic info, 1=at least one specific fact
- Draft Hook Available (max 1): 0=nothing specific enough to open with, 1=clear event-specific opener

For **B2B SaaS** businesses:
- Buying Signal (max 2): 0=no evidence of need, 1=historical pattern, 2=active signal (job posting, RFP, stated need)
- Pain Signal (max 2): 0=no pain found, 1=inferred/indirect, 2=direct/observed (stated problem, visible gap)
- Additional Source (max 1): 0=only one source, 1=two or more independent sources
- Specificity (max 1): 0=generic info only, 1=at least one unique fact
- Draft Hook Available (max 1): 0=nothing specific, 1=clear hook

For **professional services**:
- Project/Need Signal (max 2): 0=no signal, 1=general need evidence, 2=active project or stated need
- Budget/Timeline Signal (max 2): 0=no signal, 1=indirect evidence, 2=direct (RFP, budget cycle, deadline)
- Referral/Relationship (max 1): 0=cold, 1=shared connection or prior contact
- Specificity (max 1): 0=generic only, 1=unique fact
- Draft Hook Available (max 1): 0=nothing specific, 1=clear hook

Hard gates (always include all three):
```
"hardGates": [
  "No email at all → warmthScore = 0, draftStatus = brewing, do not compose",
  "Client outside service geography → warmthScore = 0, mark brewing, note as OUT_OF_GEOGRAPHY",
  "Score < 5 → draftStatus = brewing always"
]
```

### 4f. Define Evaluator Criteria

Generate 5 pass/fail criteria tailored to this buyer type.

**Universal criteria (always include, tune the wording):**
1. **Specificity** — does the draft reference THIS client specifically, not a type?
2. **Timing or Recency** — is there a timely hook? (events: is there an active booking window? B2B: is there a recent signal?)
3. **Pain-to-Product Bridge** — one sentence connecting their situation to what you sell
4. **Brevity** — under the word limit; no forbidden phrases
5. **Reply Test** — would a busy [target role] reply, forward, or at least not delete?

For each criterion provide:
- `name`
- `description` — one sentence
- `passExample` — concrete, vivid
- `failExample` — concrete, vivid

### 4g. Define Outreach Rules

From the product type and audience:
- `maxWords` — 100 for event/booking (busy planners, fast decisions), 150 for B2B SaaS, 120 for professional services
- `tone` — match the buyer (event planners: warm and direct; school admin: respectful and practical; enterprise HR: professional and peer-to-peer)
- `openWith` — instruction for the first sentence; always lead with THEIR world
- `closeWith` — instruction for the closing; command, not a hope
- `forbidden` — always include the universal six; add any context-specific ones

Universal forbidden phrases (always include):
```
"I hope this finds you well"
"I'm reaching out because"
"I would love the opportunity"
"Please don't hesitate"
"At your earliest convenience"
"My name is [as opening sentence]"
```

---

## Phase 5: Present and Review the Draft Manifest

Show the complete manifest JSON to the user. Walk through each section briefly:

> "Here's the draft manifest based on what you told me. I'll walk through the key sections — tell me anything that's wrong or should be different."
>
> **Segments:** [list the segments and their seasonal windows in plain English]
>
> **Warmth scoring:** [describe the categories in one line each]
>
> **Word limit:** [N] words. Tone: [description]
>
> **Factlet topics:** [list in plain English]
>
> "Any corrections? Or should I proceed?"

Wait for corrections. Apply any changes. If they say "proceed" or "looks good", move to Phase 6.

---

## Phase 6: Feeds and Facebook

Two targeted questions:

**RSS Feeds:**
> "Do you have specific news sites, industry blogs, or trade publications you want to monitor? (I'll add them to the RSS config alongside the base feeds.) List any URLs you know — or say 'none' to skip."

**Facebook Sources:**
> "Are there any Facebook pages you want to monitor for leads? (Industry groups, associations, community pages — places your buyers post about upcoming events or needs.) List URLs — or say 'none' to skip."

For each URL provided:
- If it looks like a Facebook page URL → add to `fbSources`
- If it looks like a website/blog → add to `rssConfig.feeds` (Claude will suggest likely RSS URL based on CMS type)
- If the user says "research it" → do a quick web search for relevant feeds and pages for this industry/geography

Update the manifest with any additions before writing to disk.

---

## Phase 7: Write the Manifest File

Determine the output path:
- Default: `sample-manifests/{name}.json` (relative to PRECRIME root)
- Ask: "Where should I save the manifest? Default is `sample-manifests/{name}.json`. Hit enter to accept or give a different path."

Write the final manifest JSON to that path.

Confirm:
> "Manifest written to `{path}`. Running deploy.js now."

---

## Phase 8: Run deploy.js

Execute:
```
node deploy.js --manifest {manifestPath}
```

Read the output. Report what was generated. Note any warnings (⚠ lines).

If deploy.js errors:
- JSON parse error → open the manifest, find the syntax problem, fix it, re-run
- rootDir is invalid → ask the user to confirm the path and re-run
- Any other error → show the error to the user

If successful, show the checklist output to the user and say:
> "Scaffold is complete. Now let's walk through the remaining manual steps."

---

## Phase 9: Post-Scaffold Walkthrough

Work through each step interactively. Don't dump the whole list — do one at a time, confirm completion before moving to the next.

### Step 9a: Verify Server Infrastructure

The server files are included in the zip and were copied by `deploy.js`. Verify:

```
dir "{rootDir}\server\mcp\mcp_server.js"
dir "{rootDir}\rss\rss-scorer-mcp\index.js"
```

> "If those files are missing, run `setup.bat` again from `{rootDir}`. If they still don't appear, re-unzip from the original archive."

Wait for confirmation. Then proceed.

### Step 9b: Client Database

Ask:
> "Do you have an existing SQLite database with client records? Or are you starting from scratch?"

**If existing DB — run the migration tool:**

> "I'll migrate it to the Pre-Crime schema now. Run this from the PRECRIME root:"
>
> ```
> node scripts/migrate-db.js --source "C:\path\to\your.sqlite" --dry-run
> ```
>
> "That shows you exactly what will happen — which columns get added, which rows get carried over — without touching anything. Review the output, then run it without `--dry-run` to execute."
>
> ```
> node scripts/migrate-db.js --source "C:\path\to\your.sqlite" --target "{rootDir}\{dbFile}"
> ```
>
> "The migrated file goes directly into your deployment as the live database. Tell me when it's done."

What the migration tool does:
- Source columns that exist in Pre-Crime schema → copied directly
- Source columns NOT in Pre-Crime schema → added to target, data preserved (nothing is dropped)
- Pre-Crime columns not in source (dossier, draft, warmthScore, etc.) → start as NULL, filled by enrichment
- Extra source tables with no Pre-Crime equivalent → copied with `_src_` prefix (e.g., `_src_Booking`)
- Uses `INSERT OR IGNORE` — never overwrites existing rows in target

**If schema is already correct (no migration needed):**
> "Copy it directly to `{rootDir}\{dbFile}`. If the `segment` column is missing, the migration tool handles that automatically."

**If starting from empty template:**
> "The empty template is already at `{rootDir}\{dbFile}`. You can add clients using a SQLite editor (DB Browser for SQLite is free), or load them later. Required fields: `id` (CUID or UUID), `name`, `company`. Everything else can be null — Pre-Crime fills it in."
> "Want to add a test client now so we can verify the pipeline?"

### Step 9c: VALUE_PROP.md

Tell the user:
> "Open `{rootDir}\DOCS\VALUE_PROP.md`. It has stubs. Fill in the sections — especially the pitch, differentiators, and outreach examples. This is what the Composer reads to write every email. The better it is, the better the drafts."
>
> "Do it now if you have 10 minutes, or come back to it before running the enrichment loop."

If they want to do it now: "I can help draft it. Tell me your best 3–4 sentences about why someone should buy, and your top 2–3 case studies or proof points."

### Step 9d: Set Config Table

Tell the user:
> "Now we need to set the Config table so the MCP server knows who is doing the outreach."
>
> "Open a new terminal, navigate to `{rootDir}`, and run `claude`. Once Claude loads with the MCP tools, call:"
>
> ```
> update_config({ companyName: "{company}", companyEmail: "{email}", businessDescription: "{short description}" })
> ```

Or offer to do it directly if the tools are already available in the current session:
> "I can set this now if the MCP tools are loaded. Want me to try?"
> (If `mcp__precrime-mcp__update_config` is available: call it directly.)

### Step 9e: Test Launch

Final step:
> "Let's verify the deployment is live. Open a terminal, navigate to `{rootDir}`, run `claude`."
>
> "Once it loads, run: `get_stats()`"
>
> "You should see: `{ brewing: N, ready: 0, sent: 0, factlets: 0 }` where N is your total client count."
>
> "If that works: you're ready to run `Read DOCS/STATUS.md then run the enrichment workflow`."

---

## Phase 10: Deployment Summary

When all steps are complete, print a one-page summary:

```
=================================================================
Pre-Crime Deployment: {name}
=================================================================
Workspace:     {rootDir}
Database:      {dbFile}
Manifest:      {manifestPath}
Seller:        {seller.name} / {seller.company}
Product:       {product.name}
Segments:      {N} — {segment labels}
Feeds:         {N} RSS feeds configured
FB sources:    {N} Facebook pages
Max words:     {outreachRules.maxWords}

STATUS.md      — keep this updated after every session
VALUE_PROP.md  — fill in before first enrichment run
ROUNDUP.md     — enrichment run log; Claude writes to this

To enrich:     cd "{rootDir}" && claude
               > Read DOCS/STATUS.md then run the enrichment workflow
=================================================================
```

---

## Wizard Behavior Rules

- **One phase at a time.** Don't ask Phase 4 questions until Phase 3 is answered.
- **Propose, don't interrogate.** In Phase 4, Claude builds the manifest — the user reviews and corrects. Don't ask the user to define warmth scoring categories from scratch.
- **Be concrete.** When showing the manifest, translate JSON into plain English. "You have 3 segments: schools (prom/Halloween/spring), corporate (holiday), and community (summer). Each has a seasonal booking window." Don't just show raw JSON and ask "does this look right?"
- **Apply corrections immediately.** If the user says "the word limit should be 80, not 100", update the manifest JSON in your working context before proceeding.
- **Don't stall.** If a section doesn't apply (no seasonal windows, no FB sources), move on without dwelling.
- **If something fails in Phase 8:** Diagnose and fix before reporting back. Try to solve the error, not just describe it.
- **Keep the whole session in memory.** The manifest you build in Phase 4 must be exactly what you write to disk in Phase 7. No silent resets.

---

## Manifest Section Reference

For reference when generating the manifest (all field names and types):

```json
{
  "deployment": {
    "name": "string (slug)",
    "version": "1.0",
    "rootDir": "absolute path",
    "dbFile": "relative path from rootDir — e.g. data/project.sqlite"
  },
  "seller": {
    "name": "string", "company": "string", "email": "string",
    "website": "string", "phone": "string (optional)"
  },
  "product": {
    "name": "string",
    "description": "2–3 sentence string",
    "differentiators": ["array of strings"],
    "geography": "string",
    "pricing": "string"
  },
  "audience": {
    "segments": [{
      "id": "slug",
      "label": "Human name",
      "targetRoles": ["Job Title"],
      "events": ["trigger occasion"],
      "seasonalWindows": [{
        "name": "Season Name",
        "months": [1,2,3],
        "event_months": [4,5],
        "lead_weeks": 8
      }]
    }]
  },
  "relevanceSignals": {
    "high": ["string"],
    "medium": ["string"],
    "timing": ["string"],
    "not": ["string"]
  },
  "factletTopics": ["string"],
  "factletNotTopics": ["string"],
  "warmthScoring": {
    "categories": [{
      "name": "string",
      "max": 1 or 2,
      "criteria": { "0": "string", "1": "string", "2": "string (if max=2)" }
    }],
    "hardGates": ["string"]
  },
  "evaluatorCriteria": [{
    "name": "string",
    "description": "string",
    "passExample": "string",
    "failExample": "string"
  }],
  "outreachRules": {
    "maxWords": 100,
    "tone": "string",
    "openWith": "string",
    "closeWith": "string",
    "forbidden": ["string"]
  },
  "rssConfig": {
    "additionalKeywords": ["string"],
    "feeds": [{
      "url": "string",
      "name": "string",
      "category": "string",
      "keywords": ["string"]
    }]
  },
  "fbSources": ["https://www.facebook.com/..."]
}
```

---

## Error Reference

| Error | What to do |
|-------|-----------|
| `deploy.js not found` | Check that you're in the PRECRIME root (`C:\Users\...\PRECRIME`) |
| `template.sqlite not found` | Re-unzip the distribution archive — `data/template.sqlite` should be included |
| `JSON parse error` in manifest | Open the written manifest, find the syntax error, fix it, re-run deploy.js |
| `rootDir not found` after scaffold | The directory was created — verify with `ls {rootDir}` |
| MCP tools not loading after deploy | Launch Claude Code from {rootDir}, not a subdirectory; check `.mcp.json` exists at root |
| `mcp_server_config.json DB path wrong` | Check the path relative from `server/mcp/` to `data/{name}.sqlite` — fix and restart MCP |
