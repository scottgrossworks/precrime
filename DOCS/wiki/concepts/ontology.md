---
title: Pre-Crime Ontology v2.0
tags: [ontology, entities, booking, client, factlet, leed, output-paths]
source_docs: [DOCS/ONTOLOGY.md, DOCS/STATUS.md, DOCS/IG_NOTES.md]
last_updated: 2026-04-14
staleness: none
---

Pre-Crime v2.0 expands from a pure client-enrichment engine (one entity, one output path) into a marketplace supply engine. The same scraping infrastructure that finds factlets also finds gig opportunities — these crystallize as Bookings, which can be posted to The Leedz marketplace.

> WARNING — STALE? `ONTOLOGY.md` header says "Status: Design spec — not yet implemented" (dated 2026-04-01). But `STATUS.md` (sessions 1-8 complete) confirms all 15 MCP tools including all 4 Booking tools are done and the blank DB ships pre-built with the full schema. The ontology as described IS implemented. The "design spec" header is a leftover artifact.

---

## Core Design Rule

**Leed = Client + Booking.** A leed is not a separate entity. It is what a Client becomes when booking details crystallize. A Booking becomes a leed when it reaches `leed_ready` status. Posting to the marketplace is handled by the optional `plugins/leedz-share/` plugin.

---

## Entities

### Client

Primary enrichment target. Represents a business or person who could become a customer.

**Key fields:**
- `draftStatus` — tracks position in the conversion funnel (see below)
- `warmthScore` — float, 0-10. Holistic agent assessment. Score ≥ 9 required (alongside `canDraft`) for draft composition.
- `dossierScore` — int, unbounded. Procedural score (intelScore + factletScore). Must be ≥ 5 for `canDraft`.
- `contactGate` — boolean. Named person + direct email = true. Generic inbox or no contact = false.
- `sentAt` — datetime, nullable. Timestamp of when the draft was actually sent via Gmail. Set alongside `draftStatus = "sent"`.
- `dossier` — timestamped prose. Format: `[date] Source: finding.`
- `targetUrls` — JSON: `[{url, type, label}]`
- `bookings` — relation to Booking[]

**`draftStatus` values:**

| Value | Meaning |
|-------|---------|
| `brewing` | Not enough intel, or gates not met. Needs more enrichment. |
| `ready` | Draft passes evaluator. Ready for review/send. |
| `sent` | Outreach email sent. `sentAt` records when. |
| `responded` | Client replied. Conversation active. |
| `booked` | Booking created. Action phase. |

**Draft composition requires TWO gates:**
1. `canDraft = contactGate AND (dossierScore >= 5)` — procedural
2. `warmthScore >= 9` — agent holistic assessment (two hard gates: verified email + specific event signal)

### Booking

A specific gig opportunity linked to a Client. Mirrors the Invoicer schema field-for-field, with Pre-Crime intelligence fields added (`source`, `sourceUrl`, `trade`, `zip`, `leedId`).

**Booking Action Criterion — the mechanical gate to `leed_ready`:**
- Has `trade` (maps to a valid Leedz trade name)
- Has `startDate`
- Has `location` OR `zip`

All three present → `status: "leed_ready"`. Missing any → `status: "new"`.

This check is applied automatically by `create_booking` AND by `update_booking` (the latter re-evaluates after each field update).

**`status` values:**

| Value | Meaning |
|-------|---------|
| `new` | Just captured. Incomplete. |
| `leed_ready` | Meets Booking Action Criterion. Actionable. |
| `taken` | Business owner claimed it. |
| `shared` | Posted to The Leedz marketplace. |
| `expired` | Start date passed without action. |

**Pre-Crime-specific fields:**

| Field | Purpose |
|-------|---------|
| `source` | Origin platform. Format: `"reddit:r/sub"`, `"instagram:@handle"`, `"facebook:PageName"` |
| `sourceUrl` | Direct link to the post/listing |
| `trade` | Mapped Leedz trade name (e.g., "DJ", "Caterer") |
| `zip` | For geo search on Leedz marketplace |
| `leedPrice` | Price in cents for marketplace listing |
| `leedId` | Marketplace ID after posting (set by leedz-share plugin) |
| `sharedAt` | BigInt epoch ms of when posted |

### Factlet

Broadly applicable intelligence. No `clientId` — global only. Goes into a broadcast queue for all clients.

**Rules:**
- 2-3 sentences. No opinions. No product mentions.
- Sentence 1: What happened (numbers, dates, names).
- Sentence 2: Why it matters for the target audience.
- Sentence 3 (optional): Implication for buying urgency.
- Deduplicate against existing factlets.

### Config

Single-row table (id = "config"). Deployment-wide settings.

**Key fields:**
- `businessName`, `description`, `serviceArea`
- `activeEntities` — JSON: `["client"]` or `["client", "booking"]`
- `defaultTrade` — e.g., "DJ" for single-trade deployments
- `marketplaceEnabled` — Boolean, default false
- `leadCaptureEnabled` — Boolean, default false. Gate on all Lead Capture paths.
- `leedzEmail` — user's email on theleedz.com. Set at workspace setup.
- `leedzSession` — pre-generated HS256 JWT for The Leedz MCP `createLeed` calls.

---

## Four Output Paths

Every harvested item (Reddit post, Instagram caption, RSS article, Facebook post, X/Twitter post) is classified into exactly one path. Classification is centralized — identical logic across all harvesters.

| Path | What it is | MCP action | Example |
|------|-----------|-----------|---------|
| **Factlet** | Broadly applicable intel | `create_factlet()` | "LAUSD approves new SEL mandate" |
| **Dossier** | Intel about an EXISTING client | `update_client({ dossier: append })` | "Lincoln High won a PBIS grant" |
| **Lead Capture (thin)** | NEW potential client, vague interest | `create_client({ draftStatus: "brewing" })` | Reddit user asking about DJs generally |
| **Lead Capture (hot)** | NEW client WITH booking details | `create_client()` + `create_booking({ status: "leed_ready" })` | "Need DJ, LA, June 15, budget $2000" |

**Classification decision tree:**

```
1. Is this about a specific person/org?
   NO  → FACTLET
   YES → 2

2. Is this person/org already in DB? (search_clients)
   YES → DOSSIER
   NO  → 3

3. Does it contain booking details? (trade + date + location/zip — ALL THREE)
   YES → LEAD CAPTURE HOT (create Client + Booking)
   NO  → LEAD CAPTURE THIN (create Client only)
```

**Important constraint:** Lead Capture is gated by `leadCaptureEnabled` in Config. If false, flag in report but do NOT create records. Harvesters never create clients or bookings directly — they report findings and the orchestrator (enrichment-agent) creates records.

---

## Conversion Funnel

```
Internet chatter
  → harvester classifies (four paths above)
  → [Factlet] stockpiles for broadcast
  → [Dossier] enriches existing client record
  → [Lead Capture thin] → draftStatus: "brewing"
  → Enrichment loop: discover → scrape → score → draft → evaluate
  → draftStatus: "ready" → outreach email sent
  → draftStatus: "responded" → conversation active
  → Booking details crystallize
  → Booking created → evaluator checks completeness
  → trade + startDate + (location OR zip)?
      YES → status: "leed_ready" → ACTION DECISION
              ├── Take it (calendar check → claim)
              ├── Share to marketplace (share@theleedz.com or MCP createLeed)
              └── Both (take it AND share overflow)
      NO  → status: "new" → outreach continues
```

---

## Evaluator: Two Gates

The evaluator runs two independent checks:

**1. Draft evaluator (outreach drafts) — 5 criteria:**
- Specificity, recency, pain-to-product fit, brevity, reply test

**2. Booking Action Criterion (Booking completeness) — mechanical:**
- trade + startDate + (location OR zip) → `leed_ready`
- No LLM judgment needed. Pure field check.

---

## Marketplace Posting — Booking → addLeed Params

When a Booking reaches `leed_ready` and the action is "share to marketplace":

| Booking field | addLeed param | Notes |
|---------------|--------------|-------|
| `trade` | `tn` | Must match valid Leedz trade name |
| `title` | `ti` | Generated from booking context |
| `location` | `lc` | Street address or venue name |
| `zip` | `zp` | Required for geo search |
| `startDate` | `st`, `et`, `dt` | Epoch ms conversion |
| `leedPrice` | `pr` | Price in cents |
| `client.name` | `cn` | Optional contact name |
| `client.email` | `em` | Optional contact email |
| `client.phone` | `ph` | Optional contact phone |
| `description` | `rq` | Requirements/details |

Three posting methods:
1. Email: share@theleedz.com (existing agent_shareLeed pipeline)
2. MCP: `tools/call` → `createLeed` on The Leedz MCP
3. Direct Lambda invoke: boto3 → addLeed (if running inside AWS)

After posting: `Booking.leedId` = marketplace ID returned by addLeed.

---

## Seeded vs Unseeded Deployments

| Aspect | Seeded | Unseeded |
|--------|--------|----------|
| Client table day 1 | Pre-loaded contacts | Empty |
| How clients arrive | Already there | Harvesters → Lead Capture |
| Factlet utility | Immediate | Stockpiles until first Client arrives |
| First action | Enrichment loop | Discovery + harvest → clients trickle in |
| Example use | Outreach deployment with imported DB | "Find me DJ gigs in LA" |

Unseeded is first-class. An empty DB is not broken — it's the normal starting state for marketplace-oriented deployments.

---

## Three Deployment Archetypes

| Archetype | activeEntities | Booking? | Marketplace? | Example |
|-----------|---------------|----------|-------------|---------|
| Outreach only | `["client"]` | No | No | K-12 platform — enrich contacts, draft outreach |
| Full pipeline | `["client", "booking"]` | Yes | Optional | Gig service — find bookings, take OR share |
| Marketplace seeder | `["client", "booking"]` | Yes | Yes | Supply engine — find gigs, post to marketplace |

---

## Design Rules (binding)

1. Leed = Client + Booking. Not a separate entity.
2. Booking mirrors Invoicer schema. Pre-Crime adds `source`, `sourceUrl`, `trade`, `zip`, `leedId`.
3. Four output paths, always classified. Every harvested item → exactly one path.
4. Evaluator checks completeness, not quality. Booking Action Criterion is mechanical.
5. Lead Capture is opt-in. `leadCaptureEnabled: false` by default.
6. Factlets seed dossiers. The factlet that discovers a new client also seeds that client's first dossier entry. No empty dossiers.
7. Unseeded is first-class.
8. Marketplace posting is the last mile. Pre-Crime finds and validates; posting is a single function call.
9. Existing tools untouched. New capability is additive only.

---

## Related
- [[architecture]] — system architecture, MCP servers, data flow
- [[scoring]] — dual-gate scoring, warmth rubric, sentAt tracking
- [[mcp]] — all 19 MCP tools, configuration
- [[current]] — what's done, what's pending
