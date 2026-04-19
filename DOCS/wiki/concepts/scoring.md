---
title: Scoring — Client Draft Gate & Booking Readiness
tags: [scoring, factlet, contact, dossier, draft, enrichment, gate, warmth, sentAt, booking, shareReady]
source_docs: [DOCS/SCORING_SYSTEM.md, DOCS/EMAIL_FINDER.md, server/mcp/mcp_server.js, templates/skills/enrichment-agent.md, templates/skills/email-finder.md, templates/skills/evaluator.md]
last_updated: 2026-04-18
staleness: none
---

Two independent scoring systems live in this project:

1. **Client scoring** — gates draft composition (outreach emails). Procedural contactGate + dossierScore + LLM warmth. See sections below through "sentAt".
2. **Booking readiness scoring** — gates sharing (marketplace post or forwarded opportunity). Fully procedural, no LLM. See the bottom of this page.

They share only the generic-email detection. Neither feeds into the other.

The client scoring system determines when a client qualifies for automated outreach draft composition. Three mechanisms gate drafting: a binary contact gate, a continuous dossier score, and a holistic warmth assessment.

---

## Design Principle

Two categories of readiness. Neither compensates for the other.

1. **Contact Gate** — binary. Can we reach a real decision-maker? Generic inbox (info@, contact@, admin@) = fail. No amount of intelligence compensates for an unreachable inbox.
2. **Dossier Score** — continuous, unbounded, always growing. Do we know enough to write something non-generic? Accumulated from scrape signals and linked factlets across sessions.

---

## Contact Gate

Procedural check using the existing `isGenericEmail()` function (same list used by `score_booking`).

| Condition | Result |
|---|---|
| Named person + verified direct email | **PASS** |
| Named person + unverified direct email (pattern-constructed) | **PASS** (flagged for verification) |
| Named person + generic inbox (info@, office@, admin@) | **FAIL** |
| No named person | **FAIL** |

FAIL = `draftStatus` stays `brewing`. No draft composed. Factlets still accumulate.

**Upgrading a failing contact gate:** when the enrichment agent encounters a generic inbox, missing email, or pattern-constructed guess at Step 3.6, it hands off to the [[email-finder]] sub-skill before calling `score_client`. If the skill returns `found` or `high_confidence`, it writes `client.email` directly and the contact gate flips to PASS on the subsequent score call — no re-scraping needed. A `guessed` result leaves the email in place and caps downstream score at 6; `failed` leaves everything untouched and logs `EMAIL_UNVERIFIED`.

---

## Dossier Score

Two components, summed:

### Intel Score (D2 + D3, max 7)

Set by the enrichment agent after scraping. Measures what we learned from the client's own sources.

**D2 — Intel Depth (0-3):**

| Condition | Points |
|---|---|
| 2+ sources scraped with useful content | 3 |
| 1 source scraped with useful content | 2 |
| Sources found but thin | 1 |
| All fetches failed | 0 |

**D3 — Direct Signals (0-4, additive):**

| Signal | Points |
|---|---|
| Explicit pain / stated problem | +2 |
| Buying occasion / deadline / active project | +2 |
| Implied need / org context | +1 |
| Timing / geography alignment | +1 |

### Factlet Score (D4, unbounded)

Computed procedurally from the `ClientFactlet` join table. Each linked factlet is classified per-client:

| Signal Type | Points |
|---|---|
| `pain` — confirms or adds to a problem this client faces | 2 |
| `occasion` — signals a buying trigger, deadline, or event | 2 |
| `context` — useful background (industry trend, segment news) | 1 |

No cap. A client enriched across 5 sessions with 8 relevant factlets might accumulate 12-16 factlet points.

**Dossier Score = Intel Score + Factlet Score**

---

## Draft Eligibility — Two Independent Gates

Draft composition requires BOTH gates to pass. Neither compensates for the other.

### Gate 1: Procedural (canDraft)

```
canDraft = contactGate AND (dossierScore >= 5)
```

The threshold (5) is not user-configurable. It is derived from the evaluator's minimum structural requirements:
- Specificity requires client-specific intel (needs D2 >= 2)
- Recency requires a recent signal (needs >= 1 from D3 or D4)
- Pain-to-Product Bridge requires a pain/occasion signal (needs >= 2 from D3 or D4)

Minimum: 2 + 1 + 2 = 5.

### Gate 2: Warmth Assessment (warmthScore >= 9)

`warmthScore` is set by the enrichment agent at Step 4.5, not procedurally. It is a holistic 0-10 assessment of lead readiness. **This is NOT deprecated** — it is actively written and enforced alongside the procedural gate.

| Score | Criteria |
|-------|----------|
| 10 | Specific expressed need with date, location, and service request. Verified direct email to decision-maker. |
| 9 | Strong signal of upcoming relevant event. Verified direct email. |
| 8 | Good fit signals (books entertainment, same category, upcoming events). Email is pattern-inferred, not verified. |
| 7 | General venue/planner fit. Named contact. Pattern-inferred email. No specific event signal. |
| 5-6 | Generic email only (info@, contact@, events@), or speculative fit. |
| 1-4 | No contact, no fit signal, or wrong segment. |

**Two hard gates for warmthScore 9+:**
1. **Verified direct email** — pattern-inferred (RocketReach, ZoomInfo, LinkedIn guessing) caps at 8.
2. **Specific event signal** — "They host events" is not a signal. "Hosting a Mother's Day brunch on May 10" is. General fit caps at 8.

Both hard gates must pass for 9+. Most clients from a prospecting run will stay brewing. That is correct.

### Combined Gate

```
eligible = canDraft AND (warmthScore >= 9)
```

If either fails → `draftStatus = "brewing"`, enrichment agent logs what's missing, skips to next client.

---

## Factlet Storage Model

Factlets are **linked, not copied**. The `ClientFactlet` join table associates a factlet with a client, along with a per-client `signalType` and `points`. The same broadcast factlet can be linked to many clients with different classifications (a factlet about school funding cuts might be `pain` for one school and `context` for another).

MCP tools:
- `link_factlet(clientId, factletId, signalType)` — creates or updates the association
- `get_client_factlets(clientId)` — hydrates all linked factlets with content
- `score_client(clientId, intelScore?)` — computes gate + score, writes back to DB

---

## Enrichment Pipeline Flow (revised)

1. **Load client** (Step 0)
2. **Hydrate existing factlets** + check for new ones, link relevant ones (Step 1)
3. **Discovery + Ingestion** (Steps 2-3)
4. **Intel scoring** — assess D2+D3 from scraping (Step 3.5)
5. **Score client** — one `score_client` call (Step 4)
6. **Warmth assessment** — agent assigns 0-10 `warmthScore` (Step 4.5)
7. **Draft gate** — if `canDraft = false` OR `warmthScore < 9`, set brewing, skip to next client (Step 4.6)
8. **Compose draft** — only if both gates pass (Step 5)
9. **Evaluate draft** — quality check only, no upstream gates (Step 6)
10. **Send + mark sent** — gmail send → `update_client({ draftStatus: "sent", sentAt })` (Step 6.5)

---

## score_client Response

```json
{
  "contactGate": true,
  "dossierScore": 14,
  "factletScore": 8,
  "factletCount": 5,
  "intelScore": 6,
  "canDraft": true,
  "breakdown": {
    "contact": "PASS — Jane Smith / jane@school.org",
    "intel": "6/7 — D2+D3 from scraping",
    "factlets": "8 pts from 5 linked factlets",
    "total": "14 (threshold: 5)"
  },
  "action": null
}
```

When `canDraft = false`, `action` recommends next steps:
- `CHASE_CONTACT: info@school.org is a generic inbox...`
- `THIN_DOSSIER: dossierScore 3 < 5. Need more signals or factlets.`

Special log category: `READY_BLOCKED_CONTACT` — client has dossierScore >= 5 but contactGate fails. Worth prioritizing email verification.

---

## Stats

`get_stats` now returns:
- `contactGate: { pass: N, fail: N }` — pipeline health at a glance
- `dossierScores: { high: (>=10), mid: (5-9), low: (<5), unscored: (null) }`
- `totalLinkedFactlets` — total client-factlet associations in the system

`get_ready_drafts` now sorts by `dossierScore desc` (was `warmthScore desc`).

---

## Draft Send Tracking — `sentAt`

When a draft is sent (via Gmail MCP or manually), the enrichment agent marks:

```
update_client({ id, draftStatus: "sent", sentAt: new Date().toISOString() })
```

- `sentAt` (DateTime, nullable) records the exact timestamp of send
- Gmail send + update_client are treated as atomic — never send without marking
- If gmail send fails, leave as "ready" and log the failure
- `get_ready_drafts()` returns only `draftStatus === "ready"` — sent clients excluded automatically
- The sent guard in enrichment-agent Step 0 skips any client with `draftStatus === "sent"` entirely

**Full lifecycle:** `null` → `"brewing"` → `"ready"` → `"sent"` (with `sentAt` timestamp)

---

---

## Booking Readiness Score

Independent from client scoring. Exposed via `score_booking`. Procedural, no LLM. Implemented in `computeBookingScore()` in `server/mcp/mcp_server.js`, but **all tunable values (weights, thresholds, regex patterns, generic-email list) live in `server/mcp/scoring_config.json`**. The JS is a harness that loads the JSON at startup; to retune, edit the JSON and restart the MCP server.

**Purpose:** decide whether a Booking has enough structured detail that a vendor could quote a price and show up. A shareReady Booking is the handoff unit for `share-skill.md` (marketplace post via Leedz API, or email).

**This algorithm has been actively tuned based on real scoring failures.** Vague multi-week date ranges, campus names without venues, and Bookings lacking start times were all scoring as shareable when they weren't.

### Categories (total = 100)

| Category      | Max | Signal                                     |
|---------------|-----|--------------------------------------------|
| `trade`       | 20  | Categorizable service type                 |
| `date`        | 20  | Bookable event window                      |
| `location`    | 20  | Specific place a vendor can show up        |
| `contact`     | 20  | Named person + direct email                |
| `description` | 10  | Enough context for a draft                 |
| `time`        | 10  | Hours (so a vendor can quote)              |

### Trade (0 or 20)
Binary. Has `booking.trade` → 20, else 0.

### Date (0 / 5 / 10 / 20)

| Condition                                             | Points |
|-------------------------------------------------------|--------|
| `startDate`, no `endDate` (single-day)                | 20     |
| Window ≤ 7 days                                       | 20     |
| Window 8–30 days (rough range)                        | 10     |
| Window > 30 days (ongoing/recurring)                  | 5      |
| No `startDate`                                        | 0      |

### Location (0 / 5 / 10 / 15 / 20)

Needs both `location` text and `zip`. Three regex classifiers:

- `HAS_STREET` — street address pattern
- `HAS_VENUE` — hall, arena, ballroom, auditorium, pavilion, plaza, etc.
- `CAMPUS_VAGUE` — campus, university, complex, fairgrounds, park (vague unless a venue is named)

| Condition                                                  | Points |
|------------------------------------------------------------|--------|
| Street + specific venue                                    | 20     |
| Clean street address (not vague)                           | 15     |
| Named venue only (no street)                               | 15     |
| Street address inside a campus/complex                     | 10     |
| Campus name + zip, no street or venue                      | 10     |
| **Bare city/neighborhood name + zip** (e.g. "Los Angeles") | **5**  |
| Zip only OR text only                                      | 5      |
| Nothing                                                    | 0      |

"CSUN" + 91330 scores 10. "CSUN MatArena, 18111 Nordhoff St" + 91330 scores 20. "Los Angeles, 90210" scores 5 — bare city name is not vendor-actionable and fails the `location >= 15` hard gate.

### Contact (0 / 10 / 15 / 20)

From the linked Client. Uses `isGenericEmail()` (same prefix list as client scoring).

| Condition                          | Points | Label                  |
|------------------------------------|--------|------------------------|
| Name + direct email                | 20     | `named_email_and_name` |
| Direct email only                  | 15     | `named_email`          |
| Name only                          | 10     | `name_only`            |
| Generic email only (info@, etc.)   | 0      | `generic_email`        |
| Nothing                            | 0      | `none`                 |

### Description (0 or 10)
≥ 10 words → 10, else 0.

### Time (0 or 10)
`startTime` present OR `duration > 0` → 10, else 0.

### Share Threshold — Hard API Gates

```
shareReady = total >= 70
          AND b.trade    >= 20   // addLeed requires tn
          AND b.location >= 15   // addLeed requires lc — real venue address
          AND b.date     >= 20   // addLeed requires st/et — specific window
          AND b.contact  >= 10   // buyer needs a named person
```

**Every hard gate must pass.** No mechanical compensation — a high total cannot rescue a missing API-required field. The Leedz `addLeed` Lambda (see [[addleed-api]]) rejects POSTs without `tn`, `lc`, `zp`, `st`, or `et`. A booking that fails any gate would either be rejected by the API or posted in a state no vendor could act on.

Key consequences:

- "CSUN" + zip scores 10 (campus-vague) → fails `location >= 15` → NOT shareReady, regardless of total.
- "Los Angeles, 90210" scores 5 (bare city name) → fails `location >= 15` → NOT shareReady.
- A 60-day event range scores 5 (date) → fails `date >= 20` → NOT shareReady.
- A great logistics booking with no named person scores 0 (contact) → NOT shareReady.

### Recommended Action (not shareReady)

Priority-ordered. Hard gates first (API will reject without these):

1. no trade → `CLASSIFY`
2. generic inbox → `ENRICH: find named contact`
3. no contact → `ENRICH: find named person`
4. `location < 15` (vague campus, city-only, or missing) → `ENRICH: find specific venue`
5. `date < 20` (missing or too-broad window) → `ENRICH: narrow date`

Then soft gaps (won't block sharing):

6. no time/duration → `ENRICH`
7. thin description → `ENRICH`
8. else → `OUTREACH: send probe`

The enrichment agent consumes `action` as its next-step directive.

### Writes to DB
`booking.bookingScore` (total) and `booking.contactQuality` (label).

---

## Tuning Lineage

Booking score tuning is procedural — edit `server/mcp/scoring_config.json` and restart the MCP server. No LLM reasoning. Keep the config file and this doc in lockstep. Known triggers for the current tuning:

- **Hardcoded thresholds in JS** made the scorer opaque to non-coders and risked drift between deployments. **Fix:** extracted all weights, tiers, regex patterns, hard-gate minimums, and the generic-email prefix list into `scoring_config.json`. `mcp_server.js` loads it once at startup and fails fast if the file is missing or malformed.

- **No hard gate on location** — a booking with no real address could still pass shareReady if other fields compensated. addLeed would reject or a buyer couldn't act on it. **Fix:** added four hard gates (`trade >= 20`, `location >= 15`, `date >= 20`, `contact >= 10`) on top of the 70-point floor. No mechanical compensation allowed. API authority: [[addleed-api]].
- Bare city name ("Los Angeles") scoring 15 → reduced to 5 (fails hard gate).
- Vague multi-week dates scoring 20 → tiered date scoring + `date >= 20` hard gate.
- Campus names without a venue scoring 20 → CAMPUS_VAGUE regex (score 10) + `location >= 15` hard gate.
- Missing hours let events slip through as ready → added `time` category.
- Description over-weighted as a primary gate → reduced to 10 max.
- Vendor-opportunity contamination (fairs charging Scott) scoring hot → addressed upstream at enrichment-agent Step 2.5, not in this scorer.

Live tuning work happens in the PHOTOBOOTH deployment's `server/mcp/mcp_server.js`. When stable, sync back to `PRECRIME/server/mcp/mcp_server.js` so future deployments inherit the tuned version.

---

## Related
- [[mcp]] — tool definitions for link_factlet, get_client_factlets, score_client, score_booking
- [[ontology]] — Client, Factlet, ClientFactlet, Booking entity definitions
- [[architecture]] — enrichment pipeline data flow
- [[email-finder]] — sub-skill that upgrades failing contact gates at Step 3.6
