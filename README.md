# Pre-Crime

Manifest-driven agentic enrichment and lead generation engine built on Claude Code. Scrapes public sources for booking intelligence, enriches contacts, scores warmth, composes outreach drafts, and posts ready leads to The Leedz marketplace — automatically.

---

## What It Does

Pre-Crime runs a six-stage pipeline:

1. **Harvest** — RSS feeds and Facebook pages are scraped for public posts. Each post is classified: broad industry news becomes a *factlet*; org-specific intelligence goes into the client's *dossier*; booking requests (trade + date + location) become *bookings*.

2. **Enrich** — The client queue is worked one at a time. Each client gets web research, dossier updates, and a warmth score (0–10 across 7 criteria).

3. **Draft** — Clients scoring ≥ 5 get a personalized outreach email composed, injecting relevant factlets and dossier material.

4. **Evaluate** — A 5-criteria evaluator scores each draft. Low-scoring drafts are revised. Passing drafts are marked `ready`.

5. **Book** — When a harvested post contains a trade, date, and location, a Booking is created and marked `leed_ready`.

6. **Share** — `leed_ready` bookings are posted to The Leedz marketplace, emailed to the share inbox, or emailed to you — based on your configured default action.

### Three Modes

| Mode | What runs |
|------|-----------|
| Outreach only | Enrich → Draft → Evaluate |
| Full pipeline | Harvest → Enrich → Draft → Evaluate → Share |
| Marketplace seeder | Full pipeline + auto-post to theleedz.com |

---

## Before You Start

The startup wizard asks these questions in order. Have answers ready.

### Required

- **Your name, company, and email** — injected into drafts and used for notifications
- **What you're selling** — 2–4 sentences: what it is, who buys it, why it matters
- **Your geography** — not a config field, but drives harvester relevance judgments. Know what city/region you serve.

### If You're Posting to The Leedz Marketplace

- **A Leedz account** — sign up at theleedz.com
- **Your trade category** — must match a valid Leedz trade. The wizard fetches the list and helps you match.

### Optional but Valuable

- **VALUE_PROP.md** — longer-form document: pitch, differentiators, ideal client, objections, real examples. Put it anywhere in the workspace and tell the wizard the path. This is what drives draft quality — the better it is, the better every email will be.
- **An existing client list** — contacts already in a SQLite database can be loaded before the first run.
- **Facebook groups or pages** — public communities where your buyers post. Give the wizard the URLs; they go into the harvester source list.
- **Chrome open with the Claude-in-Chrome extension** — required for Facebook harvesting. Without it, the Facebook harvester is skipped; RSS and enrichment still run.

---

## Running Pre-Crime (End Users)

```
1. Unzip the package → you get a precrime\ folder
2. cd precrime
3. precrime
```

That's it. The launcher handles everything:
- Installs Node dependencies (first run only — fast on subsequent runs)
- Generates the Prisma client
- Starts Claude with all required flags and permissions
- Triggers the startup wizard automatically

The wizard reads any existing config, skips what's already set, and only asks about missing fields. On second and subsequent runs it goes straight to launch.

**Watch `logs/ROUNDUP.md`** for live progress after launch.

---

## Config Reference

These fields are set during the startup wizard and stored in the local SQLite database. Pre-Crime reads them on every startup.

| Field | What it is | Required |
|-------|-----------|---------|
| `companyName` | Your company name | Yes |
| `companyEmail` | Your email address | Yes |
| `businessDescription` | 2–4 sentences: what you sell, who buys it | Yes |
| `defaultBookingAction` | What to do when a booking hits `leed_ready` | Yes |
| `marketplaceEnabled` | Whether to post to The Leedz marketplace | Auto-set |
| `leedzEmail` | Your Leedz account email | If using marketplace |
| `leedzSession` | JWT session token (auto-generated, 1-year TTL) | If using marketplace |
| `leadCaptureEnabled` | Always true — auto-set, never asked | Auto |

### Booking Actions

| Value | What happens |
|-------|-------------|
| `leedz_api` | Booking is posted to theleedz.com automatically |
| `email_share` | Booking details emailed to share@theleedz.com for manual review |
| `email_user` | Booking details emailed to your address |

---

## How the Pipeline Works

### Warmth Scoring

Each client is scored 0–10 across 7 criteria. Score ≥ 5 triggers draft composition.

| Criterion | Points |
|-----------|--------|
| Dossier depth (recent intel) | 0–2 |
| Factlet relevance match | 0–2 |
| Org size / event volume signals | 0–2 |
| Prior relationship indicators | 0–1 |
| Budget / spend signals | 0–1 |
| Contact quality (named person found) | 0–1 |
| Recency of intel | 0–1 |

### Booking Completeness

A booking reaches `leed_ready` when it has all three:
- **Trade** — matches a valid Leedz trade category
- **Start date** — explicit date or date range
- **Location** — city/venue name OR zip code

### Factlets

Factlets are 2–3 sentence summaries of broadly applicable news — industry trends, market signals, policy changes — that get injected into outreach drafts to make them timely and relevant. They are not org-specific. One factlet per distinct news item, global to all clients.

### Second-Run Behavior

Pre-Crime reads existing config on every startup. Fields already set are displayed but not re-asked. Only blank or missing fields trigger questions. After config is confirmed, harvesters and enrichment launch automatically.

---

## Building a Distributable Zip (Developers)

### 1. Edit the manifest

```
manifest.json
```

Set your deployment name, product name, audience description, relevance signals, and target roles. See `manifest.sample.json` for all fields with inline comments.

### 2. Build the zip

```bat
build.bat
```

Output: `dist\precrime-deploy-YYYYMMDD.zip`

### 3. Send the zip to the end user

Three instructions: unzip → cd precrime → precrime.

### What's in the zip

The zip contains a self-contained `precrime\` folder:

```
precrime\
├── precrime.bat              ← THE ONLY THING THE USER RUNS
├── setup.bat                 ← Called automatically. Never run manually.
├── .mcp.json                 ← MCP server config (Pre-Crime + Leedz)
├── CLAUDE.md                 ← Claude's operating instructions
├── data\
│   └── myproject.sqlite      ← Pre-built database (schema already applied)
├── server\
│   ├── mcp\mcp_server.js     ← Pre-Crime MCP server (15 tools)
│   ├── prisma\schema.prisma  ← DB schema
│   └── package.json          ← Node deps (@prisma/client 5.22.0)
├── skills\
│   ├── init-wizard.md        ← Startup config + launch sequence
│   ├── enrichment-agent.md   ← Full enrichment loop
│   ├── evaluator.md          ← Draft evaluator + booking completeness gate
│   ├── share-skill.md        ← leed_ready → marketplace action
│   ├── factlet-harvester.md  ← RSS → factlet pipeline
│   └── fb-factlet-harvester\
│       ├── SKILL.md          ← Facebook → factlet pipeline
│       └── fb_sources.md     ← List of Facebook pages to scrape
├── logs\
│   └── ROUNDUP.md            ← Live run progress (watch this)
└── DOCS\
    └── VALUE_PROP.md         ← Your value proposition (fill before first run)
```

`node_modules` is not included. `setup.bat` runs `npm install` + `npx prisma generate` on first launch. The SQLite database ships pre-built with schema applied — no `prisma db push` at runtime.

---

## Architecture

### Two MCP Servers

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| **Purpose** | Enrichment pipeline DB | Marketplace CRUD |
| **File** | `server/mcp/mcp_server.js` | Remote Lambda |
| **Transport** | Local stdin/stdout | Remote `POST /mcp` on API Gateway |
| **Backend** | Prisma 5 → SQLite | DynamoDB |
| **Tools** | 15 tools | createLeed + reads |

### Why `precrime.bat` Must Run Before Claude

Claude Code reads `.mcp.json` at startup and connects MCP servers immediately. On first run, `node_modules/` doesn't exist — MCP connection fails silently. There is no mid-session reconnect. `precrime.bat` runs `setup.bat` before launching Claude. By the time Claude reads `.mcp.json`, deps exist and MCP connects on the first try.

---

## MCP Tools Reference

15 tools available in every enrichment session:

| Tool | Purpose |
|------|---------|
| `get_config` | Read all config fields |
| `update_config` | Write one or more config fields |
| `get_next_client` | Pull next client from enrichment queue (atomic cursor) |
| `get_client` | Fetch a client by ID |
| `search_clients` | Search clients by name or company |
| `update_client` | Update client fields (dossier, warmth, draftStatus, etc.) |
| `create_client` | Create a new client record |
| `get_ready_drafts` | Fetch clients with draftStatus = ready |
| `get_stats` | DB summary: client count, booking count, factlet count |
| `create_booking` | Create a booking record linked to a client |
| `get_bookings` | List bookings with optional status filter |
| `get_client_bookings` | Fetch all bookings for a specific client |
| `update_booking` | Update booking fields (status, leedId, etc.) |
| `create_factlet` | Add a factlet to the broadcast queue |
| `get_new_factlets` | Fetch recent factlets (with optional since filter) |
| `delete_factlet` | Remove a factlet from the queue |

The Leedz MCP (remote Lambda) provides: `getTrades`, `getStats`, `getLeedz`, `getUser`, `createLeed`.

---

## Database Schema

Four tables in the SQLite database:

### Client
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | CUID primary key |
| `name` | TEXT | Contact's full name |
| `email` | TEXT | Contact's email (unique) |
| `company` | TEXT | Organization name |
| `website` | TEXT | Organization website URL |
| `dossier` | TEXT | Accumulated intelligence — timestamped prose |
| `draft` | TEXT | Current best outreach draft |
| `draftStatus` | TEXT | `brewing` \| `ready` \| `sent` |
| `warmthScore` | REAL | 0–10 warmth score |
| `lastEnriched` | DATETIME | Timestamp of last enrichment run |

### Booking
| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT | CUID primary key |
| `clientId` | TEXT | FK → Client.id |
| `trade` | TEXT | Trade/service type |
| `startDate` | DATETIME | Event date |
| `location` | TEXT | Event location |
| `zip` | TEXT | Event zip code |
| `status` | TEXT | `new` \| `leed_ready` \| `shared` \| `booked` \| `cancelled` |
| `source` | TEXT | Where the lead came from |
| `leedId` | TEXT | ID returned by createLeed API |

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
| `companyName` | TEXT | Seller's company name |
| `companyEmail` | TEXT | Seller's email |
| `businessDescription` | TEXT | Product/business description |
| `defaultBookingAction` | TEXT | `leedz_api` \| `email_share` \| `email_user` |
| `marketplaceEnabled` | BOOLEAN | Enable Leedz marketplace posting |
| `leadCaptureEnabled` | BOOLEAN | Always true |
| `leedzEmail` | TEXT | Leedz marketplace account email |
| `leedzSession` | TEXT | Session JWT for createLeed API calls |

---

## Troubleshooting

**Claude starts but MCP tools aren't available**
Close and run `precrime` again. MCP connects at startup — if something was wrong on the first launch, the second launch will have it fixed.

**"Something's not right" message**
The MCP connection failed. Close and run `precrime` again. If it fails twice, check that Node.js 18+ is installed (`node --version`).

**Facebook harvester skipped — Chrome not connected**
Open Chrome, make sure the Claude-in-Chrome extension is running, then restart.

**RSS returns zero articles — pipeline stopped asking what to do**
This is a bug. Zero results from RSS is not a failure. The pipeline should continue automatically. Restart — this was fixed in build 2026-04-03.

**JWT token expired**
Session tokens are valid for 1 year. Re-run the startup wizard, choose marketplace posting again, and a new token will be generated automatically.

**All drafts stay in `brewing`**
Check warmth scores. If everything is below 5, the harvester isn't finding useful intelligence. Add more Facebook sources or RSS feeds. Verify Chrome is connected for Facebook scraping.

---

## Key Design Decisions

1. **Blank DB ships in zip.** No `prisma db push` at runtime. The DB exists from the moment of unzip. Eliminates "table does not exist" errors entirely.

2. **`precrime.bat` runs setup BEFORE Claude.** MCP connects at Claude startup. If deps don't exist, MCP fails silently with no mid-session recovery. Setup must happen before Claude launches. Hard constraint.

3. **`precrime.bat` runs setup unconditionally.** No `if not exist node_modules` check. Setup is idempotent. Conditional checks add failure modes for zero benefit.

4. **Init wizard Step -1 does NOT diagnose.** If `get_config()` fails for any reason, one sentence: "run precrime again." No reading files, no checking paths, no running npm.

5. **Factlets are global.** No clientId. Every factlet is broadcast to every client at enrichment time. Client-specific intel always goes into the dossier, never a factlet.

6. **Drafts never auto-send.** `ready` means "passed the evaluator, ready for human review." The human decides to send.
