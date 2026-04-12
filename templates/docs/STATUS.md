# {{DEPLOYMENT_NAME}} — Session Bootstrap

**Generated:** {{TODAY}}
**Read this entire file before touching anything.**

---

## MANDATORY FIRST READS

1. `DOCS/CLAUDE.md` — Binding rules.
2. `DOCS/VALUE_PROP.md` — Product pitch and audience. Read before composing any draft.
3. This file — finish it.

---

## PROJECT OVERVIEW

**{{DEPLOYMENT_NAME}}** — contextual outreach engine.

**Product identity, seller info, audience, and geography are defined in `DOCS/VALUE_PROP.md`. Read that file — do not infer product identity from folder names, manifest tokens, or any other source.**

---

## RUNNING THE WORKFLOW

**First time:** say **"initialize this deployment"** — the init wizard will confirm config, generate your Leedz session JWT, discover harvest sources, then launch harvesters automatically.

**Subsequent runs:** say **"run the enrichment workflow"** in any Claude session.

| Playbook | Purpose |
|----------|---------|
| `skills/enrichment-agent.md` | Full enrichment loop (load → factlets → discovery → ingest → compose → evaluate) |
| `skills/evaluator.md` | Draft evaluation: 5 pass/fail criteria |
| `skills/factlet-harvester.md` | RSS → factlet pipeline |
| `skills/fb-factlet-harvester/SKILL.md` | Facebook → factlet pipeline (requires Chrome desktop app) |

---

## DATABASE

**Read `server/mcp/mcp_server_config.json` → `database.path` for the active DB path.** That is the single place the DB is configured.

DO NOT use any other .sqlite file.

---

## SCHEMA

```prisma
model Client {
  id             String    @id @default(cuid())
  name           String
  email          String?   @unique
  phone          String?
  company        String?
  website        String?
  clientNotes    String?
  segment        String?   // audience segment: defined per deployment
  dossier        String?   // accumulated intelligence — timestamped prose
  targetUrls     String?   // JSON: [{url, type, label}]
  draft          String?   // current best outreach draft
  draftStatus    String?   // "brewing" | "ready" | "sent"
  warmthScore    Float?    // 0–10
  lastEnriched   DateTime?
  lastQueueCheck DateTime? // DB cursor + factlet watermark
  source         String?   // how this client entered the DB
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  bookings       Booking[]
}

model Booking {
  id               String    @id @default(cuid())
  clientId         String
  title            String?
  description      String?
  notes            String?
  location         String?
  startDate        DateTime?
  endDate          DateTime?
  startTime        String?
  endTime          String?
  duration         Float?
  hourlyRate       Float?
  flatRate         Float?
  totalAmount      Float?
  status           String    @default("new")   // new | leed_ready | shared | booked | cancelled
  source           String?
  sourceUrl        String?
  trade            String?
  zip              String?
  shared           Boolean   @default(false)
  sharedTo         String?   // "leedz_api" | "email_share" | "email_user"
  sharedAt         BigInt?
  leedPrice        Int?
  leedId           String?   // returned by createLeed MCP tool
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  client           Client    @relation(fields: [clientId], references: [id])
}

model Factlet {
  id        String   @id @default(cuid())
  content   String
  source    String
  createdAt DateTime @default(now())
}

model Config {
  id                  String   @id @default(cuid())
  companyName         String?
  companyEmail        String?
  businessDescription String?
  activeEntities      String?  // JSON: ["client"] or ["client","booking"]
  defaultTrade        String?  // e.g., "Caricature Artist"
  defaultBookingAction String? // "leedz_api" | "email_share" | "email_user"
  marketplaceEnabled  Boolean  @default(false)
  leadCaptureEnabled  Boolean  @default(false)
  leedzEmail          String?
  leedzSession        String?  // session JWT for createLeed MCP calls
  llmApiKey           String?
  llmProvider         String?
  llmBaseUrl          String?
  llmAnthropicVersion String?
  llmMaxTokens        Int?     @default(1024)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}
```

---

## MCP CONFIGURATION

**`.mcp.json`** — defines MCP servers. Claude reads this from the working directory.

| Tool prefix | Server | Entry point |
|-------------|--------|-------------|
| `mcp__precrime-mcp__*` | precrime-mcp | `server/mcp/mcp_server.js` |
| `mcp__precrime-rss__*` | precrime-rss | `rss/rss-scorer-mcp/index.js` |
| `mcp__gmail-sender__*` | gmail-sender | optional — requires separate MCP setup |

---

## FILE MAP

| File | Purpose |
|------|---------|
| `DOCS/CLAUDE.md` | Binding rules |
| `DOCS/STATUS.md` | This file |
| `DOCS/VALUE_PROP.md` | Full product pitch + differentiators |
| `skills/enrichment-agent.md` | Enrichment loop playbook |
| `skills/evaluator.md` | Draft evaluation logic |
| `skills/relevance-judge.md` | Relevance filter |
| `skills/factlet-harvester.md` | RSS factlet harvester |
| `skills/fb-factlet-harvester/SKILL.md` | FB factlet harvester |
| `skills/fb-factlet-harvester/fb_sources.md` | Curated FB page list |
| `skills/init-wizard.md` | First-run setup wizard |
| `server/mcp/mcp_server.js` | MCP server |
| `server/mcp/mcp_server_config.json` | DB path config |
| `rss/rss-scorer-mcp/index.js` | RSS scorer MCP |
| `rss/rss-scorer-mcp/rss_config.json` | Feed URLs + keywords |
| `logs/ROUNDUP.md` | Per-run enrichment log |

---

## DESIGN DECISIONS — SETTLED

1. **Factlets are GLOBAL** — no clientId. Client-specific intel → dossier only.
2. **`lastQueueCheck` dual role** — DB cursor + factlet watermark.
3. **`targetUrls` is JSON** — `[{url, type, label}]`
4. **`dossier` is timestamped prose** — `[date] Source: finding.`
5. **No HTTP server** — MCP calls Prisma directly.
6. **No local LLM** — Claude does everything.
7. **`segment` field** — audience segment label for multi-segment deployments.

---

## CURRENT STATE

### Done (scaffold)
- Deployment generated by Pre-Crime deploy.js
- Empty DB initialized with full schema
- All 5 skill playbooks generated from templates
- RSS config generated ({{TODAY}})
- MCP server config pointing at correct DB

### TODO (manual steps required before first run)
- [ ] Fill in `DOCS/VALUE_PROP.md` with the real product pitch
- [ ] Run init wizard: say "initialize this deployment" — it handles Config setup, JWT generation, and harvest source discovery
- [ ] Load client records into the database (if outreach mode)

### Segments and seasonal windows

See `DOCS/VALUE_PROP.md`.

---

## KNOWN LIMITATIONS

- **`claude -p` does not attach MCP servers.** The headless flag runs without `.mcp.json`. Use the interactive Claude Code session.
- **Chrome integration:** Use `claude --chrome` to start with Chrome connected. The Chrome MCP extension must be installed in your browser.
