# Pre-Crime Ontology v2.0

**Date:** 2026-04-01
**Status:** Design spec — not yet implemented

---

## Why v2.0

Pre-Crime v1.0 was a client enrichment engine: take a database of contacts, enrich them, draft personalized outreach. One entity (Client), one output path (outreach draft), one goal (get a reply).

v2.0 recognizes that the same scraping infrastructure that finds factlets also finds **gig opportunities**. A Reddit post saying "Looking for a DJ in LA next Saturday" isn't a factlet — it's a leed. Pre-Crime isn't just an outreach engine. For The Leedz, it's a **marketplace supply engine**.

---

## Entities

### Client

Same as v1.0, with expanded `draftStatus` to support the full conversion funnel.

```
Client {
  id            String    @id @default(cuid())
  name          String
  email         String?   @unique
  phone         String?
  company       String?
  website       String?
  clientNotes   String?
  dossier       String?         // timestamped prose: "[date] Source: finding."
  targetUrls    String?         // JSON: [{url, type, label}]
  draft         String?
  draftStatus   String    @default("brewing")
  warmthScore   Int?
  lastEnriched  DateTime?
  lastQueueCheck DateTime?
  source        String?         // how this client entered the DB
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  bookings      Booking[]
}
```

**`draftStatus` values (expanded):**

| Value | Meaning |
|-------|---------|
| `brewing` | Not enough intel yet. Needs more enrichment. |
| `ready` | Draft passes evaluator. Ready for human review or send. |
| `sent` | Outreach email sent. |
| `responded` | Client replied. Conversation active. |
| `booked` | Booking created. Action phase. |

### Booking

Mirrors the Invoicer's `schema.prisma` exactly — same field names, same types — with Pre-Crime intelligence fields added. **A Booking is what crystallizes when a Client has a specific gig opportunity.**

```
Booking {
  id              String    @id @default(cuid())
  clientId        String
  title           String?
  description     String?
  notes           String?
  location        String?
  startDate       DateTime?
  endDate         DateTime?
  startTime       String?
  endTime         String?
  duration        Float?
  hourlyRate      Float?
  flatRate        Float?
  totalAmount     Float?
  status          String    @default("new")
  source          String?         // "reddit:r/weddingplanning", "facebook:LAEvents", etc.
  sourceUrl       String?         // direct link to the post/listing that spawned this
  trade           String?         // mapped to Leedz trade name (e.g., "DJ", "Caterer")
  zip             String?         // for Leedz marketplace posting
  shared          Boolean   @default(false)
  sharedTo        String?
  sharedAt        BigInt?
  leedPrice       Int?            // price in cents for marketplace listing
  squarePaymentUrl String?
  leedId          String?         // The Leedz marketplace ID after posting
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  client          Client    @relation(fields: [clientId], references: [id])
}
```

**`status` values:**

| Value | Meaning |
|-------|---------|
| `new` | Just captured. Incomplete info. |
| `leed_ready` | Has trade + startDate + (location OR zip). Can be actioned. |
| `taken` | Business owner claimed it. |
| `shared` | Posted to The Leedz marketplace via share@theleedz.com or MCP. |
| `expired` | Start date passed without action. |

### Factlet

Unchanged from v1.0. Broadly applicable intelligence. No `clientId`. Global only.

```
Factlet {
  id          String    @id @default(cuid())
  title       String
  summary     String
  url         String?
  source      String?
  relevance   Float?
  createdAt   DateTime  @default(now())
}
```

### Config

Expanded with deployment-type fields.

```
Config {
  id                String  @id @default("config")
  businessName      String?
  description       String?
  serviceArea       String?
  activeEntities    String? // JSON: ["client"] or ["client", "booking"]
  defaultTrade      String? // e.g., "DJ" — for single-trade deployments
  marketplaceEnabled Boolean @default(false)
  leadCaptureEnabled Boolean @default(false)
  ...existing fields...
}
```

---

## Four Output Paths from Harvesters

Every piece of harvested content is classified into exactly one path:

| Output Path | What it is | Where it goes | Example |
|-------------|-----------|---------------|---------|
| **Factlet** | Broadly applicable intel | `create_factlet()` → broadcast queue | "LAUSD board approves new SEL mandate" |
| **Dossier** | Intel about an EXISTING client | `update_client({ dossier: append })` | "Lincoln High won a PBIS grant" |
| **Lead Capture (thin)** | NEW potential client, vague interest | `create_client({ draftStatus: "brewing" })` | Reddit user asking about DJs generally |
| **Lead Capture (hot)** | NEW client WITH booking details | `create_client()` + `create_booking({ status: "leed_ready" })` | "Need a DJ for my wedding in LA, June 15, budget $2000" |

**Classification logic (per harvested item):**

1. Is this about a specific organization/person?
   - NO → **Factlet**
   - YES → step 2
2. Is this org/person already in the DB? (`search_clients()`)
   - YES → **Dossier**
   - NO → step 3
3. Does it contain booking details? (trade + date + location)
   - YES → **Lead Capture (hot)** — create Client + Booking
   - NO → **Lead Capture (thin)** — create Client only

---

## Conversion Funnel

```
Internet chatter
    |
    | harvester classifies
    |
    v
[Factlet]  ←  broadly applicable, no specific person
    |
[Dossier]  ←  about existing client, enriches their record
    |
[Lead Capture thin]  ←  new Client, vague signal
    |  draftStatus: "brewing"
    |  dossier seeded with discovery context
    |
    v
Enrichment loop (existing v1.0 pipeline)
    |  discover → scrape → score → draft → evaluate
    |
    v
[ready] → outreach email sent
    |
    v
[responded] → conversation active
    |
    v
Booking details crystallize (from reply, or from original capture)
    |
    v
[Lead Capture hot] OR [Client.draftStatus = "booked"]
    |
    v
Booking created → evaluator checks completeness
    |
    v
trade + startDate + (location OR zip)?
    |
    YES → status: "leed_ready" → ACTION DECISION
    |         |
    |         ├── Take it (calendar check → claim)
    |         ├── Share to marketplace (share@theleedz.com or MCP createLeed)
    |         └── Both (take it AND share overflow)
    |
    NO → status: "new" → needs more info → outreach continues
```

---

## Evaluator: Booking Completeness Check

The existing evaluator (5 criteria: specificity, recency, pain-to-product, brevity, reply test) stays for outreach drafts. A new check is added for Bookings:

**Booking Action Criterion:**
- Booking has `trade` (maps to a valid Leedz trade name)
- Booking has `startDate`
- Booking has `location` OR `zip`

All three → `status: "leed_ready"` → triggers action decision.
Missing any → `status: "new"` → outreach continues to gather details.

---

## Mapping to The Leedz Marketplace

When a Booking reaches `leed_ready` and the action is "share to marketplace", its fields map to `addLeed.py` params:

| Booking field | addLeed param | Notes |
|---------------|--------------|-------|
| `trade` | `tn` | Must match a valid Leedz trade name |
| `title` | `ti` | Generated from booking context |
| `location` | `lc` | Street address or venue name |
| `zip` | `zp` | Required for geo search |
| `startDate` | `st`, `et`, `dt` | Epoch ms conversion |
| `leedPrice` | `pr` | Price in cents |
| `client.name` | `cn` | Optional contact name |
| `client.email` | `em` | Optional contact email |
| `client.phone` | `ph` | Optional contact phone |
| `description` | `rq` | Requirements/details |

The posting happens via one of:
1. **Email:** share@theleedz.com (existing agent_shareLeed pipeline)
2. **MCP:** `tools/call` → `createLeed` (Phase 4 of AGENTIC_FUTURE.md)
3. **Direct Lambda invoke:** boto3 → addLeed (if running inside AWS)

After posting, `Booking.leedId` is set to the marketplace ID returned by addLeed.

---

## Seeded vs Unseeded Deployments

| Aspect | Seeded | Unseeded (new deployment) |
|--------|--------|--------------------------|
| Client table on day 1 | Pre-loaded contacts | Empty |
| How clients arrive | Already there | Harvesters find them via Lead Capture |
| Factlet utility | Immediate (enriches existing clients) | Stockpiles until first Client arrives |
| First action | Enrichment loop on existing clients | Discovery + harvest → clients trickle in |
| Example | Outreach deployment with imported DB | "Find me DJ gigs in LA" |

**Unseeded flow:**
1. User configures value prop, trade, service area
2. Factlet engine runs: discovers sources, harvests content
3. Harvesters classify output → factlets stockpile, Lead Capture creates new Clients
4. The factlet that promotes a new Client into the DB also seeds that Client's first dossier entry
5. If the capture contains full booking info → Booking created → action triggered immediately
6. If thin capture → Client enters enrichment loop → outreach → response → booking crystallizes later

---

## Three Deployment Archetypes

| Archetype | activeEntities | Booking? | Marketplace? | Example |
|-----------|---------------|----------|-------------|---------|
| **Outreach only** | `["client"]` | No | No | K-12 platform — enrich contacts, draft outreach |
| **Full pipeline** | `["client", "booking"]` | Yes | Optional | Gig service — find bookings, take them OR share |
| **Marketplace seeder** | `["client", "booking"]` | Yes | Yes | Supply engine — find gigs, post to marketplace |

---

## New MCP Tools (to be added)

| Tool | Purpose |
|------|---------|
| `create_booking` | Create a Booking for a Client |
| `update_booking` | Update Booking fields (status, details) |
| `get_bookings` | Get Bookings by status |
| `get_client_bookings` | Get all Bookings for a specific Client |

These extend the existing MCP server. The 11 existing tools are unchanged.

---

## Implementation Sequence

1. **Add Booking model to schema.prisma** — mirrors Invoicer schema + Pre-Crime fields
2. **Run migration** — `migrate-db.js` handles lossless SQLite migration
3. **Add MCP tools** — create_booking, update_booking, get_bookings, get_client_bookings
4. **Expand evaluator** — add Booking Completeness Check alongside existing 5-criteria draft check
5. **Update harvester classification** — four output paths instead of two (factlet / dossier / lead thin / lead hot)
6. **Add Config fields** — activeEntities, defaultTrade, marketplaceEnabled, leadCaptureEnabled
7. **Wire marketplace posting** — Booking → addLeed param mapping → share@theleedz.com or MCP

Steps 1-3 are mechanical. Step 4-5 are where the intelligence lives. Steps 6-7 connect to The Leedz.

---

## Design Rules

1. **Leed = Client + Booking.** Not a separate entity. A leed is what a Client becomes when booking details crystallize.
2. **Booking mirrors Invoicer.** Same field names, same types. Pre-Crime adds `source`, `sourceUrl`, `trade`, `zip`, `leedId`.
3. **Four output paths, always classified.** Every harvested item → exactly one path. Classification is centralized, not per-channel.
4. **Evaluator checks completeness, not quality.** The Booking Action Criterion is mechanical: trade + startDate + location. No LLM judgment needed.
5. **Lead Capture is opt-in.** `leadCaptureEnabled: false` by default. Prevents DB pollution during early runs.
6. **Factlets seed dossiers.** The factlet that discovers a new client also provides that client's first dossier entry. No empty dossiers.
7. **Unseeded is first-class.** A deployment with zero starting clients is not broken — it's the normal state for marketplace-oriented use.
8. **Marketplace posting is the last mile.** Pre-Crime finds the opportunity, enriches it, validates completeness. The actual posting is a single function call.
9. **Existing tools untouched.** The 11 MCP tools, the RSS scorer, the factlet engine skill — all unchanged. New capability is additive.
