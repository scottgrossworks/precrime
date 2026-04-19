# PRECRIME: Draft Gate Scoring System

## Context

The current enrichment pipeline always composes a draft (Step 5) and then evaluates it (Step 6), wasting LLM time on clients who aren't ready. The warmthScore (0-10) is manually assessed by the LLM each pass — subjective, non-reproducible, and conflates contact quality with intel depth.

**New system:** Two clean mechanisms that never compensate for each other.
1. **Contact Gate** — binary. Named person + direct email = pass. Generic inbox = fail. No draft until this passes.
2. **Dossier Score** — continuous, unbounded, always growing. Accumulated from factlet references + scrape signals. Must reach 5 (derived from evaluator minimum requirements) before a draft is composed.

Additionally: factlets stored as references (join table) instead of duplicated as prose into every client's dossier.

---

## Files Modified

| File | Change |
|---|---|
| `server/prisma/schema.prisma` | Add `ClientFactlet` join table, add `dossierScore`/`contactGate` to Client |
| `server/mcp/mcp_server.js` | Add `score_client`, `link_factlet`, `get_client_factlets` tools |
| `templates/skills/enrichment-agent.md` | Rewrite Steps 1, 4; add gate between 4 and 5 |
| `templates/skills/evaluator.md` | Remove warmthScore/inbox hard gates (now handled upstream) |

---

## Step 1: Schema — `server/prisma/schema.prisma`

### Add `ClientFactlet` join table

```prisma
model ClientFactlet {
  id         String   @id @default(cuid())
  clientId   String
  factletId  String
  signalType String   // "pain" | "occasion" | "context"
  points     Int      // 2 (pain/occasion) or 1 (context)
  appliedAt  DateTime @default(now())
  client     Client   @relation(fields: [clientId], references: [id])
  factlet    Factlet  @relation(fields: [factletId], references: [id])

  @@unique([clientId, factletId])  // one link per client-factlet pair
}
```

Why: A factlet about school funding cuts is `pain` for one client and `context` for another. The signalType and points live on the join, not the factlet.

### Add fields to Client

```
dossierScore  Int?      // continuous, unbounded — computed by score_client
contactGate   Boolean   @default(false)  // binary: has real named contact + direct email
intelScore    Int?      // D2+D3 — set by enrichment agent after scraping
factlets      ClientFactlet[]
```

Keep `warmthScore` for now (don't break existing deployments). Deprecated — not written to after this change.

### Add relation to Factlet

```
clients  ClientFactlet[]
```

### Re-generate pre-built DB

After schema change: `npx prisma db push` to update the shipped SQLite. Existing client data is preserved (new fields are nullable/default).

---

## Step 2: MCP Server — `server/mcp/mcp_server.js`

### New tool: `link_factlet`

```
Params: clientId (required), factletId (required), signalType (required: "pain"|"occasion"|"context")
```

- Computes points: pain=2, occasion=2, context=1
- Creates `ClientFactlet` record (upsert — idempotent on the unique constraint)
- Returns the created/existing link

### New tool: `get_client_factlets`

```
Params: clientId (required)
```

- Fetches all `ClientFactlet` records for client, includes the `Factlet` content/source
- Returns array of `{ id, factletId, signalType, points, appliedAt, factlet: { content, source } }`
- This is what the enrichment agent calls to hydrate factlets into context at the start of each enrichment pass

### New tool: `score_client`

```
Params: clientId (required), intelScore (optional Int — D2+D3, written by enrichment agent)
```

Procedural. No LLM. Modeled after `computeBookingScore`.

**Contact Gate** — reuses existing `isGenericEmail()`:
```
hasName = client.name exists and non-empty
email = client.email
generic = isGenericEmail(email)
hasDirectEmail = email && !generic

contactGate = hasName && hasDirectEmail
```

**Factlet Score (D4)** — sum from join table:
```
SELECT SUM(points) FROM ClientFactlet WHERE clientId = ?
```

**Dossier Score**:
```
dossierScore = (intelScore || client.intelScore || 0) + factletScore
```

If `intelScore` param is provided, write it to `client.intelScore`. Always recompute `dossierScore` from current `intelScore + factletScore`.

**Draft Eligibility**:
```
canDraft = contactGate AND (dossierScore >= 5)
```

5 is hardcoded — derived from evaluator minimum: needs intel(2) + pain/occasion(2) + signal(1) = 5.

**Write back to DB**: `dossierScore`, `contactGate`, `intelScore` (if provided)

**Return**:
```json
{
  "contactGate": true/false,
  "dossierScore": 14,
  "factletScore": 8,
  "intelScore": 6,
  "canDraft": true/false,
  "factletCount": 5,
  "action": null | "CHASE_CONTACT: info@school.org is generic..." | "THIN_DOSSIER: need more signals"
}
```

### Register all three tools in the MCP tool list and router

Add to `TOOLS` array and `handleToolCall` switch.

---

## Step 3: Enrichment Agent — `templates/skills/enrichment-agent.md`

### Step 1 (Factlet Queue) — REWRITE

Old: copy factlet text into dossier prose.
New:
1. `get_new_factlets({ since: client.lastQueueCheck || "1970-01-01..." })`
2. For each factlet: evaluate relevance to THIS client
3. If relevant: `link_factlet({ clientId, factletId, signalType })` — classify as pain/occasion/context per-client
4. Client-specific intel from scraping still goes into `dossier` as prose (not a factlet — it's unique to this client)
5. Update `lastQueueCheck`

### Step 3 (Ingestion) — ADD intel scoring

After scraping, the enrichment agent assesses D2 + D3:

**D2 — Intel Depth (0-3):**
- 2+ sources with useful content: 3
- 1 source with useful content: 2
- Sources found but thin: 1
- All failed: 0

**D3 — Direct Signals (0-4):**
- Explicit pain/stated problem: +2
- Buying occasion/deadline: +2
- Implied need/org context: +1
- Timing/geography alignment: +1

Write `intelScore = D2 + D3` (max 7).

### Step 4 (Score) — REWRITE

Old: manually assess warmthScore 0-10 across 5 categories.
New: `score_client({ clientId, intelScore })` — one MCP call. Returns `canDraft`, `contactGate`, `dossierScore`, `action`.

### NEW GATE — between Step 4 and Step 5

```
if (!canDraft) {
  update_client({ id, draftStatus: "brewing" })
  log reason from score_client action field
  → next client
}
```

No draft composed. No LLM time spent. Factlets are banked. Score is recorded.

Special log category when `contactGate = false` but `dossierScore >= 5`: `READY_BLOCKED_CONTACT` — this client is worth chasing the contact for.

### Steps 5+6 — ONLY if canDraft = true

No changes to compose/evaluate logic. They just don't run unless the gate passes.

---

## Step 4: Evaluator — `templates/skills/evaluator.md`

### Remove upstream gates (now handled by score_client)

Delete:
- Hard gate 1: "Generic inbox only → brewing" (replaced by contactGate)
- Hard gate 2: "warmthScore < 9 → brewing" (warmth scoring rubric with two gates: verified email + event signal)

The evaluator now only runs AFTER the enrichment gate passes (canDraft + warmthScore >= 9). Its job simplifies to: **evaluate draft quality only**. The 6 criteria (Intel Sufficiency, Specificity, Recency, Bridge, Tone/Format, Reply Test) remain unchanged.

Update hard gate section to:
```
Hard gate: If this evaluator is running, the client has already passed the
contact gate, dossier score threshold, and warmthScore >= 9. Evaluate the DRAFT, not the client.
```

### Update Booking Readiness section

No changes — `score_booking` is independent and stays as-is.

---

## Step 5: Stats / Ranking

Update `handleGetStats` to include dossier score distribution alongside draft status counts:
```
dossierScores: { high: (>=10), mid: (5-9), low: (<5), unscored: (null) }
```

Update `handleGetReadyDrafts` to order by `dossierScore desc` instead of `warmthScore desc`.

The user can now ask "show me top-scoring clients" and get a ranked list by accumulated intelligence.

---

## Verification

1. **Schema**: `npx prisma db push` succeeds, existing data preserved
2. **link_factlet**: create a factlet, link it to a client with signalType=pain, verify ClientFactlet record and points=2
3. **get_client_factlets**: retrieve linked factlets for a client, verify content is hydrated
4. **score_client**: 
   - Client with generic email → contactGate=false, canDraft=false regardless of dossierScore
   - Client with direct email + intelScore=3 + 2 linked factlets (pain+context) → dossierScore=6, canDraft=true
   - Client with direct email + intelScore=2 + 0 factlets → dossierScore=2, canDraft=false
5. **Enrichment flow**: run enrichment on a test client, verify factlets are linked (not pasted), gate blocks draft when appropriate, drafts only when canDraft=true

---

# PART II — Booking Readiness Score

Independent of client scoring. Computed procedurally by `computeBookingScore()` in `server/mcp/mcp_server.js`. Exposed via the `score_booking` MCP tool. No LLM involvement.

**Purpose:** determine whether a Booking has enough structured detail that a vendor could quote a price and show up. A Booking that passes this gate is the handoff unit for the share pipeline (`share-skill.md` → Leedz marketplace or email).

**This algorithm has been tuned based on real-world scoring failures.** Earlier versions rewarded any date and any location equally; the tuned version penalizes vague multi-week date ranges and campus/complex names without a specific venue.

---

## Scoring Categories (Total = 100)

| Category     | Max | Gate role                                    |
|--------------|-----|----------------------------------------------|
| `trade`      | 20  | Classification — can this be categorized?    |
| `date`       | 20  | When — is there a bookable event window?     |
| `location`   | 20  | Where — can a vendor physically show up?     |
| `contact`    | 20  | Who — is there a real person to deal with?   |
| `description`| 10  | Why — is there enough context to draft?      |
| `time`       | 10  | Hours — can a vendor quote a price?          |

---

### Trade (0 or 20)

Binary. `booking.trade` is set → 20. Otherwise 0.

### Date (0 / 5 / 10 / 20)

| Condition                                             | Points |
|-------------------------------------------------------|--------|
| `startDate` present, no `endDate` (single-day event)  | 20     |
| `startDate` + `endDate` span ≤ 7 days                 | 20     |
| Span 8–30 days (rough multi-week window)              | 10     |
| Span > 30 days (ongoing/recurring series)             | 5      |
| No `startDate`                                        | 0      |

Rationale: "June through July" and "every Friday all year" are not bookable events. A vendor needs a specific window to hold inventory.

### Location (0 / 5 / 10 / 15 / 20)

Requires BOTH `location` text AND `zip`. Three regex classifiers are applied to `booking.location`:

```js
HAS_STREET   = /\d+\s+\w+\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|way|ln|lane|ct|court|pl|place)\b/i
HAS_VENUE    = /\b(hall|arena|stadium|ballroom|theater|theatre|auditorium|pavilion|lawn|plaza|center|centre|gym|library|room|building|bldg)\b/i
CAMPUS_VAGUE = /\b(campus|university|college|complex|fairgrounds|convention center|park)\b/i
```

`isVague = CAMPUS_VAGUE.test(loc) AND NOT hasVenue`.

| Condition                                                  | Points |
|------------------------------------------------------------|--------|
| `location + zip`, hasStreet AND hasVenue                   | 20     |
| `location + zip`, hasStreet (not campus-vague)             | 15     |
| `location + zip`, hasVenue (no street)                     | 15     |
| `location + zip`, hasStreet but inside campus-vague text   | 10     |
| `location + zip`, campus-vague only (no street, no venue)  | 10     |
| **`location + zip`, bare city/neighborhood name only**     | **5**  |
| `zip` only OR `location` only (one is missing)             | 5      |
| Nothing                                                    | 0      |

Rationale: "CSUN campus" + zip is 10 — a vendor can't show up to a 356-acre university without knowing which hall. "CSUN MatArena, 18111 Nordhoff St" + zip is 20. "Los Angeles, 90210" is 5 — a bare city name is not a vendor-actionable location and fails the `b.location >= 15` hard gate.

### Contact (0 / 10 / 15 / 20)

Pulled from the linked `Client` record, not the Booking itself. Uses the shared `isGenericEmail()` function.

| Condition                                      | Points |
|------------------------------------------------|--------|
| Client has `name` AND direct (non-generic) email | 20   |
| Direct email only (no name)                    | 15     |
| Name only (no email)                           | 10     |
| Generic email only (`info@`, `events@`, etc.)  | 0      |
| Nothing                                        | 0      |

Generic email ALWAYS scores 0 — same policy as client scoring. `GENERIC_EMAIL_PREFIXES` is a hard-coded set of ~35 role-inbox prefixes (see `mcp_server.js` line ~998).

### Description (0 or 10)

`booking.description` word count:
- ≥ 10 words → 10
- Fewer → 0

Previous versions scored 0/10/20 (20 for ≥ 20 words). Reduced because description is supporting detail, not a primary gate — trade/date/location/contact carry the weight.

### Time (0 or 10)

New category. `booking.startTime` set OR `booking.duration > 0` → 10. Neither → 0.

Rationale: "May 10, 2026" isn't enough — is it a 2-hour cocktail hour or a 10-hour festival? A vendor cannot quote without hours.

---

## Share Threshold — Hard API Gates

```
shareReady = total >= 70
          AND b.trade    >= 20   // addLeed requires tn
          AND b.location >= 15   // addLeed requires lc (full address) — must resolve to a real venue
          AND b.date     >= 20   // addLeed requires st/et — must be a tight, specific window
          AND b.contact  >= 10   // buyer needs a real named person
```

**Every hard gate must pass.** No mechanical compensation allowed. The Leedz `addLeed` Lambda (see `LEEDZ/FRONT_3/DOCS/wiki/api/addleed-api.md`) rejects POSTs missing `tn`, `lc`, `zp`, `st`, or `et`. A booking that fails any of these gates would either be rejected by the API or — worse — posted to the marketplace in a state no vendor could act on.

| Gate | Source requirement | What fails it |
|---|---|---|
| `total >= 70`     | Quality floor | Thin overall detail even if individual fields are present |
| `b.trade >= 20`   | addLeed `tn` (required) | No trade classification |
| `b.location >= 15`| addLeed `lc` (required) | No location, zip-only, city-name-only ("Los Angeles" + zip), or campus/park name without a specific venue |
| `b.date >= 20`    | addLeed `st`/`et` (required) | No start date, or window > 7 days |
| `b.contact >= 10` | Buyer actionability | No named person (regardless of email) |

If `shareReady = true`, the Booking is handed off to `share-skill.md`. Otherwise it stays at `leed_brewing` with a recommended action.

**Note on endDate/et:** addLeed requires `et`. The scorer accepts a single-day event (`startDate` only) as `b.date = 20`. `share-skill.md` is responsible for deriving `et` from `startDate` if `booking.endDate` is null — see the share skill's Step 2a.

---

## Contact Quality Labels

Written back to the DB (`booking.contactQuality`) for stats and filtering:

| Score | Label                  |
|-------|------------------------|
| 20    | `named_email_and_name` |
| 15    | `named_email`          |
| 10    | `name_only`            |
| 0 (generic)  | `generic_email` |
| 0 (empty)    | `none`          |

---

## Recommended Action (when not shareReady)

Picked in priority order — hard gates first (API will reject without these), then soft gaps:

**Hard gates:**
1. `b.trade === 0` → `CLASSIFY: Assign a trade category before sharing. addLeed requires tn.`
2. `b.contact === 0 && generic` → `ENRICH: {email} is a generic inbox. Find a named contact...`
3. `b.contact === 0` → `ENRICH: No contact found. Search for a named person...`
4. `b.location < 15` → `ENRICH: Location is not specific enough to share. A vendor needs a real venue address they can show up to. Find the specific hall, lawn, or room.`
5. `b.date < 20` → either `ENRICH: No event date...` (if no startDate) or `ENRICH: Date range is too broad to be a single bookable event...`

**Soft gaps** (improve score but don't block sharing):

6. `b.time === 0` → `ENRICH: No start time or duration...`
7. `b.description === 0` → `ENRICH: No description...`
8. All else → `OUTREACH: Send probe email to confirm missing details.`

The enrichment agent consumes this `action` field as its next step directive.

---

## score_booking Response

```json
{
  "id": "cmxyz...",
  "score": 95,
  "shareReady": true,
  "contactQuality": "named_email_and_name",
  "breakdown": {
    "trade":       "20/20  — photo booth",
    "date":        "20/20  — 2026-05-10",
    "location":    "20/20 — CSUN MatArena, 18111 Nordhoff St, 91330",
    "contact":     "20/20 — jane@csun.edu",
    "description": "10/10 — 34 words",
    "time":        "10/10  — 18:00"
  },
  "action": null
}
```

Example of a hard-gate failure — note `shareReady: false` despite `score >= 70`:

```json
{
  "id": "cmabc...",
  "score": 80,
  "shareReady": false,
  "contactQuality": "named_email_and_name",
  "breakdown": {
    "trade":       "20/20  — photo booth",
    "date":        "20/20  — 2026-06-15",
    "location":    "10/20 — CSUN campus, 91330",
    "contact":     "20/20 — jane@csun.edu",
    "description": "10/10 — 22 words",
    "time":        "0/10  — MISSING"
  },
  "action": "ENRICH: Location is not specific enough to share. A vendor needs a real venue address they can show up to. Find the specific hall, lawn, or room."
}
```

Written back to DB: `bookingScore` (total), `contactQuality` (label).

---

## Relation to Client Scoring

Client scoring (Part I) gates draft **composition** (outreach emails).
Booking scoring (Part II) gates draft **sharing** (posting to marketplace or forwarding a confirmed opportunity).

They share the generic-email detection (`isGenericEmail`, `GENERIC_EMAIL_PREFIXES`) but nothing else. A client can be `canDraft = true` and still have zero shareable Bookings. A Booking can be `shareReady = true` while its client is `canDraft = false` — e.g., a confirmed inbound gig with a named contact but no accumulated dossier for outbound sales.

---

## Tuning Notes

**Policy lives in `server/mcp/scoring_config.json`** — weights, thresholds, regex patterns, and the generic-email list. `mcp_server.js` loads it at startup and fails fast if it's missing or malformed. To retune the scorer, edit the JSON and restart the MCP server. Do NOT edit the JS; the JS is a harness that reads values from the config.

Fields in `scoring_config.json`:

- `client.draftThreshold` — minimum `dossierScore` for a client to be `canDraft` (default 5)
- `client.signalPoints` — per-factlet points by signalType (`pain` / `occasion` / `context`)
- `booking.hardGates` — absolute minimums for `shareReady` (total / trade / location / date / contact)
- `booking.trade`, `booking.date`, `booking.contact`, `booking.description`, `booking.time` — per-category weight tiers
- `booking.location.patterns` — three case-insensitive regexes: `street`, `venue`, `campusVague`
- `booking.location.tiers` — points for each tier (streetAndVenue / cleanStreet / namedVenue / streetInVague / vagueOnly / bareCity / partial / none)
- `booking.genericEmailPrefixes` — string array; any email whose prefix matches scores 0 contact

The booking score is procedural by design — **changes require config edits, not LLM reasoning**. Real-world failure modes that triggered the current tuning:

- **No hard gates on API-required fields** — a booking missing `lc` (location) could still pass `shareReady` because contact + trade + date + description + time summed to ≥ 70. The Leedz `addLeed` Lambda would reject the POST, or worse, accept a blank-location leed that no vendor could act on. **Fixed by adding four independent hard gates on top of the 70-point floor: `b.trade >= 20 AND b.location >= 15 AND b.date >= 20 AND b.contact >= 10`.** No mechanical compensation allowed. Source of truth: `LEEDZ/FRONT_3/DOCS/wiki/api/addleed-api.md`.
- **Bare city name scoring 15** — "Los Angeles, 90210" was matching the `else` branch and scoring 15 because it had no campus keyword. Fixed: when there's no street AND no venue AND no campus keyword, the result is 5 — not vendor-actionable, fails the hard gate.
- **Vendor-opportunity contamination** — county fairs and festivals being scored as hot leads when the actual relationship is Scott-pays-them. Addressed upstream at enrichment-agent Step 2.5 (VENDOR_OPPORTUNITY gate), not in this scorer.
- **Campus without venue** — "CSUN" + zip scoring 20 when the actual event could be anywhere on a massive campus. Fixed with CAMPUS_VAGUE regex (score 10) and then the hard gate (shareReady requires ≥ 15).
- **Vague multi-week dates** — "June through July 2026" scoring 20 when no vendor could reserve inventory. Fixed with date-span tiers + `b.date >= 20` hard gate.
- **Missing hours** — events scored ready with only a date. Added Time category.

See also: the live tuning work is happening in `PHOTOBOOTH/precrime/server/mcp/mcp_server.js`. When tuning stabilizes, sync back to `PRECRIME/server/mcp/mcp_server.js` so future deployments ship the tuned version.
