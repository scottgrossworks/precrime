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
