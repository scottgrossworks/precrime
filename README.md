# Pre-Crime — Agentic Sales Enrichment Engine

**Version:** 2.0
**Built by:** Scott Gross
**Reference deployment:** BloomLeedz (K-12 student wellbeing outreach, Los Angeles)

---

## What Is Pre-Crime?

Pre-Crime is a deployment framework for agentic, contextual sales outreach. You give it a database of contacts. It enriches every record — scraping the web, Facebook, and RSS feeds for intelligence — then composes personalized outreach drafts tailored to each person based on what it finds.

It is not a mass-emailer. It is not a template engine. It is an intelligence-first pipeline where every draft is earned by the data in the dossier.

**The pipeline:**
```
Contact list (SQLite) → Enrich → Score warmth → Compose draft → Evaluate → ready | brewing
```

**Broadcast intelligence runs in parallel:**
```
RSS feeds + Facebook pages → Factlet Harvester → Global broadcast queue → Injected per-client at enrichment time
```

**Claude is the orchestrator.** No local LLM. No code execution. Claude reads skill playbooks (markdown files) and executes the workflow using MCP tools.

---

## Core Concepts

### Clients
A `Client` is one contact record in the database. At minimum: a name and a company. Ideally: email, website, and any initial notes. Pre-Crime enriches everything else.

### Dossier
The dossier is where all scraped intelligence lives. It is timestamped prose — not structured data. Every fact gets a datestamp and a source:
```
[2026-03-29] Website: 45 employees, annual holiday party mentioned in About page.
[2026-03-29] Facebook: Posted "planning our best holiday party yet" (Nov 2025).
[2026-03-29] LinkedIn: HR Manager posted "looking for unique team-building ideas."
```
The Composer reads the dossier to write the draft.

### Factlets
A factlet is a piece of broadly applicable intelligence — an industry trend, a policy change, a competitor move — that is relevant to multiple clients. Factlets go into a global broadcast queue and are injected into each client's dossier at enrichment time.

Client-specific intel (about one specific org) goes only in the dossier.

### Warmth Score
0–10. Earned by finding real signals: a named decision-maker, a recent event announcement, an expressed pain point, a Facebook post showing active planning. A score below 5 means the draft stays in `brewing` no matter how clever the writing.

### draftStatus
- `brewing` — needs more intel or a better draft
- `ready` — passed all 5 evaluator criteria, awaiting human review
- `sent` — human has sent it

**Drafts are never auto-sent.** Everything goes to `ready` for the human to review.

---

## Repository Structure

```
PRECRIME/
├── README.md                    ← This file
├── DOCS/DEPLOYMENT.md           ← Full deployment reference
├── deploy.js                    ← Manifest → workspace generator
├── build.bat                    ← Packages distributable zip (see "Building a zip" below)
├── manifest.sample.json         ← Full blank manifest with all fields documented
│
├── skills/
│   └── deployment-wizard.md    ← Interactive wizard: interview → manifest → scaffold → walkthrough
│
├── server/
│   ├── mcp/mcp_server.js       ← MCP server (15 tools) — auto-copied to each deployment
│   ├── package.json            ← Node deps (Prisma + dotenv) — npm install runs automatically
│   └── prisma/schema.prisma    ← SQLite schema — prisma generate runs automatically
│
├── scripts/
│   └── migrate-db.js           ← Lossless DB migration: any SQLite → Pre-Crime schema (Node 22.5+, no deps)
│
├── data/
│   └── template.sqlite          ← Empty DB with correct schema (source of truth)
│
├── templates/                   ← Source files for deploy.js — DO NOT edit deployed workspaces' templates
│   ├── mcp.json                 ← .mcp.json template
│   ├── rss_config.json          ← Base RSS config (minimal — feeds injected from manifest)
│   ├── docs/
│   │   ├── CLAUDE.md            ← Claude Code binding rules (deployment-specific)
│   │   ├── STATUS.md            ← Session bootstrap file
│   │   └── VALUE_PROP.md        ← Product pitch stub
│   └── skills/
│       ├── enrichment-agent.md  ← Full enrichment loop
│       ├── evaluator.md         ← 5-criteria draft evaluator
│       ├── relevance-judge.md   ← Relevance filter (called by all other skills)
│       ├── factlet-harvester.md ← RSS → factlet pipeline
│       └── fb-factlet-harvester/
│           ├── SKILL.md         ← Facebook → factlet pipeline
│           └── fb_sources.md    ← Facebook page list (blank, populate per deployment)
│
└── sample-manifests/
    ├── drawingshow.json          ← Complete worked example: caricature artist
    └── (add your own here)
```

### Deployed Workspace Structure

When you run `deploy.js`, it creates this workspace:

```
{rootDir}/
├── .mcp.json                    ← MCP server connections (generated)
├── CLAUDE.md → DOCS/CLAUDE.md  ← Binding rules for this deployment
├── DOCS/
│   ├── CLAUDE.md                ← Binding rules (generated, customize)
│   ├── STATUS.md                ← Session bootstrap (generated, keep updated)
│   └── VALUE_PROP.md            ← Product pitch (STUB — you must fill this in)
├── skills/
│   ├── enrichment-agent.md      ← Enrichment loop (generated, tune for audience)
│   ├── evaluator.md             ← 5-criteria evaluator (generated, tune criteria)
│   ├── relevance-judge.md       ← Relevance filter (generated, tune signals)
│   ├── factlet-harvester.md     ← RSS harvester (generated, tune topic filter)
│   └── fb-factlet-harvester/
│       ├── SKILL.md             ← FB harvester (generated, structure unchanged)
│       └── fb_sources.md        ← FB page list (generated with manifest sources)
├── data/
│   └── {name}.sqlite            ← Your deployment's database (copy of template.sqlite)
├── server/
│   └── mcp/
│       ├── mcp_server.js        ← Copied from PRECRIME source by deploy.js
│       └── mcp_server_config.json ← DB path (generated)
├── rss/
│   └── rss-scorer-mcp/
│       ├── index.js             ← Copy from your BLOOMLEEDZ/rss installation
│       └── rss_config.json      ← Feed list (generated from manifest)
└── logs/
    └── ROUNDUP.md               ← Per-run enrichment log (written by Claude)
```

---

## Database Schema

The `template.sqlite` has four tables:

### Client
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | CUID primary key |
| `name` | TEXT | Contact's full name |
| `email` | TEXT | Contact's email (unique) |
| `phone` | TEXT | Phone number (optional) |
| `company` | TEXT | Organization name |
| `website` | TEXT | Organization website URL |
| `clientNotes` | TEXT | Raw import notes (title, address, source) |
| `segment` | TEXT | Audience segment (defined per deployment) |
| `dossier` | TEXT | Accumulated intelligence — timestamped prose |
| `targetUrls` | TEXT | JSON array: `[{url, type, label}]` |
| `draft` | TEXT | Current best outreach draft |
| `draftStatus` | TEXT | `brewing` \| `ready` \| `sent` |
| `warmthScore` | REAL | 0–10 warmth score |
| `lastEnriched` | DATETIME | Timestamp of last enrichment run |
| `lastQueueCheck` | DATETIME | DB cursor + factlet watermark |
| `createdAt` | DATETIME | Record creation time |
| `updatedAt` | DATETIME | Record last update time |

### Booking
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | CUID primary key |
| `clientId` | TEXT | FK → Client.id |
| `title` | TEXT | Booking title / event name |
| `description` | TEXT | Event details |
| `notes` | TEXT | Internal notes |
| `location` | TEXT | Event location |
| `startDate` / `endDate` | DATETIME | Event dates |
| `startTime` / `endTime` | TEXT | Time strings |
| `duration` | REAL | Duration in hours |
| `hourlyRate` / `flatRate` | REAL | Pricing |
| `totalAmount` | REAL | Computed total |
| `status` | TEXT | `new` \| `leed_ready` \| `shared` \| `booked` \| `cancelled` |
| `source` / `sourceUrl` | TEXT | Where the lead came from |
| `trade` | TEXT | Trade/service type |
| `zip` | TEXT | Event zip code |
| `shared` | BOOLEAN | Whether shared to marketplace |
| `sharedTo` | TEXT | `leedz_api` \| `email_share` \| `email_user` |
| `sharedAt` | INTEGER | Unix timestamp of share |
| `leedPrice` | INTEGER | Price set for marketplace listing |
| `leedId` | TEXT | ID returned by createLeed API |
| `createdAt` / `updatedAt` | DATETIME | Timestamps |

### Factlet
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | CUID primary key |
| `content` | TEXT | 2–3 sentence intelligence summary |
| `source` | TEXT | URL of source article or page |
| `createdAt` | DATETIME | When factlet was created |

### Config
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | CUID primary key |
| `companyName` | TEXT | Seller's company name |
| `companyEmail` | TEXT | Seller's email |
| `businessDescription` | TEXT | Product/business description |
| `activeEntities` | TEXT | JSON: `["client"]` or `["client","booking"]` |
| `defaultTrade` | TEXT | e.g. "Caricature Artist" |
| `defaultBookingAction` | TEXT | `leedz_api` \| `email_share` \| `email_user` |
| `marketplaceEnabled` | BOOLEAN | Enable Leedz marketplace posting |
| `leadCaptureEnabled` | BOOLEAN | Enable lead capture mode |
| `leedzEmail` | TEXT | Leedz marketplace account email |
| `leedzSession` | TEXT | Session JWT for createLeed API calls |
| `llmApiKey` | TEXT | (Reserved) |
| `llmProvider` | TEXT | (Reserved) |
| `llmMaxTokens` | INTEGER | (Reserved, default 1024) |

---

## Step-by-Step: Deploy a New Project

> **Faster path:** Run `skills/deployment-wizard.md` from this directory. The wizard interviews you, generates the manifest, runs deploy.js, and walks you through every manual step interactively.
>
> **Manual path:** Follow the steps below.
>
> **Quick reference:** After running `deploy.js`, see [DEPLOYMENT.md](DEPLOYMENT.md) for the exact post-scaffold checklist.

### Prerequisites

1. **Claude Code desktop app** — for the enrichment workflow and Chrome bridge (for Facebook scraping).
2. **Node.js ≥ 18** — for running deploy.js and the MCP server.
3. **A contact database** — a SQLite file with the correct schema (or use `template.sqlite` as the base).

### Step 1: Create Your Manifest

Copy `manifest.sample.json` and fill it in:
```
cp manifest.sample.json my-project.json
```

Fill in every field. The manifest drives everything:
- `deployment.rootDir` — where the workspace will be created
- `seller` — who is doing the outreach
- `product` — what is being sold
- `audience.segments` — who you're selling to, and when (seasonal windows)
- `relevanceSignals` — what counts as a buying signal for this audience
- `warmthScoring` — what earns points in this context
- `evaluatorCriteria` — the 5 pass/fail criteria for a `ready` draft
- `outreachRules` — word limit, tone, open/close rules, forbidden phrases
- `rssConfig.feeds` — news feeds to monitor
- `fbSources` — Facebook pages to monitor

See `sample-manifests/drawingshow.json` for a complete worked example.

### Step 2: Run the Generator

```
cd C:\path\to\PRECRIME
node deploy.js --manifest my-project.json
```

The generator will:
- Create the workspace directory tree
- Copy `template.sqlite` as your project database
- Copy `server/mcp/mcp_server.js`, `server/package.json`, `server/prisma/schema.prisma`
- Run `npm install` + `npx prisma generate` in the generated `server/` automatically
- Generate `mcp_server_config.json` and `server/.env` (DB path for Prisma)
- Generate `.mcp.json` (MCP server connections)
- Generate `rss_config.json` (your feeds + keywords)
- Copy and substitute all skill playbooks
- Generate all DOCS stubs
- Print a checklist of remaining manual steps

### Step 3: Fill In VALUE_PROP.md

The generated `DOCS/VALUE_PROP.md` has stubs. Fill in:
- The full pitch (what you're selling, to whom, why)
- Differentiators — specific, not generic
- Pain points you address
- Case studies or proof points (real ones only)
- Objections and responses
- Example outreach drafts that have worked in the past

**This document directly determines draft quality.** The better it is, the better every outreach email will be.

### Step 4: Load Your Contact Database

The deployment starts with `template.sqlite` — empty schema, no clients. You have two options:

**Option A: Migrate an existing database (recommended)**

Use the lossless migration tool to bring any SQLite into the Pre-Crime schema:
```
# Inspect first — nothing written
node scripts/migrate-db.js --source "C:\path\to\your.sqlite" --dry-run

# Execute — write migrated DB directly to your deployment
node scripts/migrate-db.js --source "C:\path\to\your.sqlite" --target "C:\path\to\{rootDir}\data\{name}.sqlite"
```

The tool preserves all source data: source columns not in Pre-Crime schema are added to the target; Pre-Crime enrichment columns (dossier, draft, warmthScore, etc.) start NULL and get filled by the pipeline. Extra source tables are copied with a `_src_` prefix.

Requires Node.js ≥ 22.5. No additional npm packages.

**Option B: Insert records manually**
Use any SQLite editor (DB Browser for SQLite, DBeaver, etc.) to insert client rows directly into the template. Required columns: `id` (CUID or UUID), `name`, `company`. Everything else can be null — Pre-Crime will fill it in.

### Step 5: Launch

```
cd "{rootDir}"
claude
```

Then say: **initialize this deployment**

The init wizard handles Config setup, Leedz JWT generation, and harvest source discovery. After that, say: **run the enrichment workflow**

---

## Building a Distributable Zip

To package everything needed for a blank new deployment into a single zip:

```bat
build.bat
```

Run from `C:\path\to\PRECRIME`. Output goes to `dist\precrime-deploy-YYYYMMDD.zip`.

### What's in the zip

The zip contains a top-level `precrime/` folder:

```
precrime/
├── deploy.js
├── build.bat
├── README.md
├── data/
│   └── template.sqlite       ← blank schema DB
├── server/
│   ├── mcp/mcp_server.js     ← MCP server (15 tools)
│   ├── package.json          ← node_modules NOT included — npm install runs on deploy
│   └── prisma/schema.prisma
├── templates/                ← all skill + doc templates
└── scripts/
    └── migrate-db.js
```

`node_modules` is NOT included in the zip. When the recipient runs `deploy.js`, it runs `npm install` + `npx prisma generate` automatically in the generated workspace.

### Using the zip on another machine

1. Unzip anywhere — you get a `precrime/` folder
2. `cd precrime`
3. Create or copy a manifest JSON
4. `node deploy.js --manifest your-manifest.json`
5. `cd` into the generated workspace and run `claude`
6. Say: **initialize this deployment**

---

## Customizing Skill Files

The generated skills work out of the box for most deployments. These notes explain when and how to tune each one.

### enrichment-agent.md

**What it controls:** The full enrichment loop — how clients are loaded, how intel is discovered and scraped, how warmth is scored, how drafts are composed.

**Tune when:**
- Your audience requires discovery sources beyond website + LinkedIn + Facebook (e.g., event listings, Yelp reviews, Eventbrite organizer history, board minutes, government directories)
- Your product has a strong seasonal component that should influence warmth scoring (add a timing check at Step 0 that detects active seasonal windows and adds urgency to the hook)
- The warmth scoring categories don't match the signals that actually predict a reply in your domain

**How to edit:**
- Step 2 (Discovery): add/remove URL types. Add specific search queries for your audience.
- Step 4 (Warmth Scoring): rewrite the scoring table. Keep the 10-point structure.
- Step 5 (Compose): tighten or loosen the word limit and tone rules for your buyer.

### evaluator.md

**What it controls:** The 5 pass/fail criteria that determine whether a draft is `ready` or `brewing`.

**Tune when:**
- Your manifest defined evaluatorCriteria but the descriptions or examples need refinement after seeing real drafts
- One criterion is too easily gamed (e.g., Specificity passes with very weak specifics — tighten the bar)
- Your buyer type is very different from a typical B2B buyer (e.g., event planners need a timing signal in Criterion 2, not just a recency signal)

**How to edit:** Rewrite the 5 criteria sections. Keep the PASS/FAIL example format — it makes the evaluator more consistent.

### relevance-judge.md

**What it controls:** Whether a piece of scraped content is worth synthesizing into the dossier or creating a factlet from.

**Tune when:**
- After 10–20 enrichment runs, you notice the dossier filling with noise (irrelevant facts that don't help the Composer)
- Factlet yield is too high (relevance filter too loose) or zero (too tight)
- New topics emerge in your industry that should always be captured

**How to edit:** Add to the RELEVANT list. Add to the NOT RELEVANT list. Expand the gray zone section with judgment notes from real runs.

### factlet-harvester.md

**What it controls:** Which RSS articles become factlets in the broadcast queue.

**Tune when:**
- Topic filter (Q1) is producing factlets that never get used in drafts (check ROUNDUP.md)
- New RSS feeds have been added to rss_config.json that cover topics not mentioned in the filter
- Recency threshold (Q3) needs adjustment for your industry's pace

**How to edit:** Update the RELEVANT topics list. Adjust the recency threshold in Q3. Keep in sync with relevance-judge.md.

### fb-factlet-harvester/SKILL.md

**What it controls:** Which Facebook posts become factlets from the curated source list.

**Tune when:**
- The STALE threshold (60 days) needs adjustment for your audience's posting frequency
- You need to add audience-specific relevance checks beyond the substituted signals

**fb_sources.md:** Add/remove Facebook page URLs. The activity screen will flag stale pages.

### rss_config.json

**What it controls:** Which feeds are fetched and how articles are scored.

**Tune when:**
- You find a new high-value feed not in the manifest (add directly to this file)
- Feed keywords are too broad (producing too many low-relevance articles)
- `relevanceThreshold` needs adjustment (raise to reduce noise, lower to catch more)

**Key settings:**
- `relevanceThreshold`: minimum score for an article to be returned (default: 15)
- `maxArticlesPerFeed`: max articles per feed per run (default: 2) — raise for high-volume feeds
- `feedKeywordWeight`: per-feed keyword matches score higher than global keyword matches (default: 3)

---

## MCP Tools Reference

15 tools available in every enrichment session:

| Tool | Purpose |
|------|---------|
| `get_next_client(criteria)` | Atomic fetch: returns one client, stamps lastQueueCheck. This is the DB cursor. |
| `get_client(id)` | Fetch a specific client by ID |
| `search_clients(query)` | Filter clients by name, company, segment, or draftStatus |
| `update_client(id, fields)` | Write any Client fields (dossier, draft, warmthScore, etc.) |
| `get_ready_drafts()` | Get all clients with draftStatus = ready, sorted by warmthScore desc |
| `get_stats()` | Counts by draftStatus + total factlets |
| `create_factlet(content, source)` | Add a broadly applicable intel item to the broadcast queue |
| `get_new_factlets(since)` | Get factlets created after a timestamp |
| `delete_factlet(id)` | Remove a factlet from the queue |
| `get_config()` | Read the Config table |
| `update_config(fields)` | Write any Config fields |
| `create_booking(clientId, fields)` | Create a Booking record linked to a client |
| `get_bookings(filters)` | List bookings with optional filters |
| `get_client_bookings(clientId)` | Get all bookings for a specific client |
| `update_booking(id, fields)` | Update a booking (status, leedId, sharedAt, etc.) |
| `get_top_articles(limit)` | RSS scorer: return top-scored articles from configured feeds |

---

## Parallel Agent Architecture

**Status: Proven. Active feature. Do not remove or simplify.**

### What It Is

Instead of processing clients one at a time (sequential), the orchestrator launches N enrichment agents simultaneously. Each agent claims a different client via the atomic `get_next_client` cursor, does the full enrichment loop independently, and saves results. Wall-clock time: N clients in the time of 1.

### Architecture

```
Orchestrator (main Claude session)
│
├── tabs_context_mcp()              ← confirm Chrome is live
├── tabs_create_mcp() × N           ← open N Gemini tabs, one per agent
├── navigate each to gemini.google.com
├── record AI_TABS = [tabId_1..tabId_N]
│
└── ONE message → N parallel Agent tool calls
    ├── Agent 1  ← tabId_1, get_next_client(), full loop
    ├── Agent 2  ← tabId_2, get_next_client(), full loop
    ├── ...
    └── Agent N  ← tabId_N, get_next_client(), full loop
```

### Why It Works Without Contention

- **DB cursor:** `get_next_client` atomically stamps `lastQueueCheck=NOW` before returning. Each agent gets a different record. Guaranteed by SQLite write serialization.
- **Chrome tabs:** Each agent has a dedicated Gemini tab opened by the orchestrator. No two agents share a tab. No race conditions.
- **ROUNDUP.md:** Each agent appends its own named block. Never overwrites another agent's work.

### How to Launch a Parallel Batch

```
1. tabs_context_mcp()                          — confirm Chrome
2. tabs_create_mcp() × N                       — open N Gemini tabs
3. navigate each to gemini.google.com           — load AI assistant
4. record AI_TABS = [id_1, id_2, ..., id_N]
5. Single message → N parallel Agent calls      — each gets one tabId
6. Wait for all N to complete. Collect summaries.
7. Immediately launch next batch of N.
```

### Scaling

| N agents | Use case | Notes |
|----------|----------|-------|
| 1 | Debug / single client | Sequential mode |
| 5 | Standard batch | Default. ~4-5 min wall clock. |
| 10 | Max batch | Chrome slows above this. Test first. |

### Gemini Tab Role

Each agent uses WebSearch/WebFetch as its primary research tools. The pre-assigned Gemini tab is the **fallback** when WebFetch returns JS-only content or is blocked. With N dedicated tabs, fallback is available to every agent simultaneously — no queueing.

Full session setup protocol is in `templates/skills/enrichment-agent.md` under **PARALLEL-AGENT MODE** and **SINGLE-AGENT MODE**.

---

## Key Design Decisions (Do Not Change Without Reason)

1. **Factlets are GLOBAL** — no clientId. Every factlet is broadcast to every client at enrichment time. Client-specific intel always goes into the dossier, never a factlet.

2. **`lastQueueCheck` serves two roles** — it is both the DB cursor (what has been processed) and the factlet watermark (what factlets this client has seen). Never skip updating it.

3. **`dossier` is timestamped prose** — not structured JSON. This is intentional. Prose dossiers are richer and more flexible for the Composer. Add entries as `[date] Source: finding.` Never replace the dossier — always append.

4. **`targetUrls` is a JSON string** — `[{url, type, label}]`. Once populated, it is not rediscovered. To reset discovery, clear targetUrls to null.

5. **No HTTP server** — the MCP server uses Prisma directly via stdin/stdout JSON-RPC. No Express, no ports.

6. **No local LLM** — Claude does everything. The skill markdown files are Claude's instructions, not code.

7. **Drafts never auto-send** — `ready` means "passed the evaluator, ready for human review." The human decides to send.

8. **Score < 5 = always brewing** — the evaluator cannot override a low warmth score. Intelligence quality gates draft quality.

---

## Adding a New Deployment

1. Create a new manifest JSON file (copy `manifest.sample.json`)
2. Run `node deploy.js --manifest new-manifest.json`
3. Copy server infrastructure (or symlink from BloomLeedz)
4. Fill in `DOCS/VALUE_PROP.md`
5. Load client database
6. Tune skill files for the new audience
7. Launch from the new workspace root

Each deployment is fully self-contained. Multiple deployments can run simultaneously from different workspace directories.

---

## Troubleshooting

**MCP tools not loading:**
- Make sure Claude Code is launched from the workspace root directory (where `.mcp.json` lives)
- The `-p` headless flag does not load `.mcp.json` — use interactive mode
- Run `get_stats()` to verify DB connection. If it fails, check `mcp_server_config.json` DB path.

**RSS scorer returning nothing:**
- Run `get_top_articles({ limit: 1 })` to verify connection
- Check `rss/rss-scorer-mcp/rss_config.json` — are feeds defined?
- Check the log at `logs/rss_server.log`

**Facebook scraping not working:**
- Chrome bridge requires the Claude Code desktop app — not the standalone CLI
- The Chrome MCP extension must be installed and connected
- See DOCS/STATUS.md for the Chrome bridge limitation note

**All drafts stay in `brewing`:**
- Check warmthScores — if everything is below 5, discovery is finding nothing useful
- Check ROUNDUP.md for THIN_DOSSIER failures
- Verify targetUrls are being populated — if not, discovery step is failing silently

**deploy.js exits without output:**
- Run with `node deploy.js --manifest path/to/manifest.json` — `--manifest` flag is required
- Check that the manifest JSON is valid (paste into a JSON validator)
- Check that `rootDir` in the manifest is an absolute path

---

## Architecture Notes for Developers

The Pre-Crime framework has three layers:

**Layer 1 — Infrastructure (zero changes per deployment)**
- `mcp_server.js` — JSON-RPC server, Prisma + SQLite, 15 tools
- `rss-scorer-mcp/index.js` — RSS feed runner with keyword scoring
- Prisma schema — Client, Booking, Factlet, Config (generic)
- `template.sqlite` — empty schema file

**Layer 2 — Configuration (structured, changes per deployment)**
- `rss_config.json` — feeds, keywords, scoring weights
- `mcp_server_config.json` — DB path
- `.mcp.json` — server connections

**Layer 3 — Intelligence (prose, changes per deployment)**
- `DOCS/VALUE_PROP.md` — product pitch
- `skills/*.md` — enrichment playbooks
- `fb_sources.md` — Facebook page list

The token system in deploy.js uses `{{TOKEN}}` placeholders in template files. Tokens are defined in `buildTokens()` and derived from the manifest. To add a new token: add to the manifest schema, add to `buildTokens()`, add `{{NEW_TOKEN}}` wherever it's needed in a template file.

---

## Reference Deployment: BloomLeedz

The canonical example deployment is BloomLeedz at `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ`.

- **Product:** Bloomsights (K-12 student wellbeing platform)
- **Audience:** 351 school principals/admins in Los Angeles
- **DB:** `data/ca_schools.sqlite`
- **Feeds:** 28 RSS feeds (education, SEL, Catholic, Jewish sector)
- **Factlets:** global broadcast queue, 10 active

BloomLeedz was built before Pre-Crime was formalized. It runs the same pipeline with hand-crafted skill files. Refer to it when the behavior of a generated skill file is unclear.
