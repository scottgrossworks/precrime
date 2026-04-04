# Pre-Crime v2.0 — Deployment Reference

Full reference for deploying and distributing Pre-Crime workspaces.

---

## What deploy.js Does Automatically

When you run `node deploy.js --manifest <file>`, these steps happen without any manual work:

1. Creates full directory tree in the target workspace
2. Copies `server/mcp/mcp_server.js` from the PRECRIME source
3. Copies `server/package.json` from the PRECRIME source
4. Copies `server/prisma/schema.prisma` from the PRECRIME source
5. Runs `npm install` in the generated `server/` directory
6. Runs `npx prisma generate` in the generated `server/` directory
7. Copies `data/template.sqlite` as your deployment DB
8. Generates `server/.env` with `DATABASE_URL` pointing at the DB
9. Generates `server/mcp/mcp_server_config.json` with DB path
10. Generates `.mcp.json` (MCP server connections)
11. Generates `rss/rss-scorer-mcp/rss_config.json` (feeds + keywords from manifest)
12. Generates `reddit/reddit_config.json` (subreddits + keywords from manifest)
13. Generates `ig/ig_config.json` (accounts + hashtags from manifest)
14. Copies and token-substitutes all 11 skill playbooks
15. Copies and token-substitutes all 3 DOCS stubs
16. Creates `logs/ROUNDUP.md`

---

## Manual Steps After deploy.js

These cannot be automated — they require your input:

### 1. Fill in DOCS/VALUE_PROP.md

The stub was generated. The Composer reads this file to write every outreach draft. A thin VALUE_PROP = thin drafts.

Fill in:
- Full product pitch (what, who, why)
- Differentiators — specific, not generic
- Pain points you address
- Real case studies or proof points
- Objection handling
- Examples of past outreach that worked

### 2. Verify the RSS scorer

The RSS scorer (`rss/rss-scorer-mcp/index.js`) is included in the distributable zip. Verify it exists at `{rootDir}/rss/rss-scorer-mcp/index.js`. The `rss_config.json` is generated and wired automatically — no manual step needed for the scorer itself.

### 3. Load client records

The DB is empty — schema only. Options:

**Migrate from an existing SQLite:**
```
node scripts/migrate-db.js --source "C:\path\to\source.sqlite" --dry-run
node scripts/migrate-db.js --source "C:\path\to\source.sqlite" --target "{rootDir}\data\{name}.sqlite"
```

**Insert manually:** Use DB Browser for SQLite. Required: `id` (CUID), `name`, `company`. Everything else can be null.

### 4. Initialize

```
cd "{rootDir}"
claude
```

Then say: **initialize this deployment**

The init wizard (in `skills/init-wizard.md`) will:
- Confirm Config (companyName, companyEmail, businessDescription)
- Generate the Leedz marketplace session JWT
- Discover and configure harvest sources
- Auto-launch harvesters

---

## Distributing a Zip

### Building

From the PRECRIME root, run:

```bat
build.bat
```

Output: `dist\precrime-deploy-YYYYMMDD.zip`

If there's already a zip for today's date, it is deleted and rebuilt.

### What's included

```
precrime/
├── deploy.js
├── build.bat
├── README.md
├── data/
│   └── template.sqlite
├── server/
│   ├── mcp/
│   │   └── mcp_server.js
│   ├── package.json
│   └── prisma/
│       └── schema.prisma
├── templates/
│   ├── mcp.json
│   ├── rss_config.json
│   ├── reddit_config.json
│   ├── ig_config.json
│   ├── docs/
│   │   ├── CLAUDE.md
│   │   ├── STATUS.md
│   │   └── VALUE_PROP.md
│   └── skills/
│       ├── enrichment-agent.md
│       ├── evaluator.md
│       ├── relevance-judge.md
│       ├── factlet-harvester.md
│       ├── init-wizard.md
│       ├── share-skill.md
│       ├── fb-factlet-harvester/
│       ├── reddit-factlet-harvester.md
│       └── ig-factlet-harvester/
└── scripts/
    └── migrate-db.js
```

### What's NOT included

- `node_modules/` — `npm install` runs automatically during `deploy.js`
- `manifests/` — your manifest files are specific to you; don't distribute them
- `DOCS/` — master PRECRIME docs (recipient gets their own generated in the workspace)
- `TMP/` — working scratch space, not for distribution
- Any generated workspaces

### Deploying from the zip (recipient instructions)

1. Unzip anywhere — you get a `precrime/` folder
2. Create your manifest JSON (see README.md for format, or copy an example)
3. Run:
   ```
   node deploy.js --manifest your-manifest.json
   ```
4. `npm install` + `npx prisma generate` run automatically
5. Verify `{rootDir}/rss/rss-scorer-mcp/index.js` exists (included in zip)
6. Fill in `{rootDir}/DOCS/VALUE_PROP.md`
7. Load client records into the DB
8. `cd "{rootDir}" && claude`
9. Say: **initialize this deployment**

---

## MCP Server Reference

The MCP server runs as a stdio subprocess. Claude Code connects via `.mcp.json`.

**Entry point:** `server/mcp/mcp_server.js`
**DB config:** `server/mcp/mcp_server_config.json`
**Prisma env:** `server/.env` (contains `DATABASE_URL`)

### 15 Tools

| Tool | Args | Purpose |
|------|------|---------|
| `get_next_client` | `criteria?` | Atomic cursor fetch — stamps lastQueueCheck |
| `get_client` | `id` | Fetch one client by ID |
| `search_clients` | `query` | Filter by name/company/segment/draftStatus |
| `update_client` | `id, fields` | Write any Client columns |
| `get_ready_drafts` | — | All draftStatus=ready, sorted by warmthScore |
| `get_stats` | — | Counts by draftStatus + factlet count |
| `create_factlet` | `content, source` | Add to broadcast queue |
| `get_new_factlets` | `since` | Factlets after a timestamp |
| `delete_factlet` | `id` | Remove from broadcast queue |
| `get_config` | — | Read Config table |
| `update_config` | `fields` | Write Config columns |
| `create_booking` | `clientId, fields` | Create Booking record |
| `get_bookings` | `filters?` | List bookings |
| `get_client_bookings` | `clientId` | All bookings for one client |
| `update_booking` | `id, fields` | Update booking status/leedId/etc. |

---

## Troubleshooting

**npm install failed during deploy.js:**
```
cd "{rootDir}\server"
npm install
npx prisma generate
```

**MCP tools not available in Claude:**
- Claude Code must be launched from `{rootDir}` (where `.mcp.json` lives)
- `claude -p` (headless) does NOT load `.mcp.json` — use interactive mode

**`get_stats()` fails / DB errors:**
- Check `server/mcp/mcp_server_config.json` — verify DB path is correct
- Check `server/.env` — verify `DATABASE_URL` points to the right file
- Run `npx prisma generate` in `server/` if Prisma client is missing

**RSS scorer returns nothing:**
- Verify `rss/rss-scorer-mcp/index.js` exists (not auto-copied)
- Check `rss/rss-scorer-mcp/rss_config.json` — are feeds defined?

**All drafts stay brewing:**
- Check warmthScores — below 5 = always brewing
- Check ROUNDUP.md for THIN_DOSSIER entries
- Check that `targetUrls` are being populated after discovery

**Facebook scraping not working:**
- Requires Claude Code desktop app (not standalone CLI)
- Chrome MCP extension must be installed and connected
