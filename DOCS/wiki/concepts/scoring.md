---
title: Client Scoring & Draft Gate
tags: [scoring, factlet, contact, dossier, draft, enrichment, gate, warmth, sentAt]
source_docs: [DOCS/PLAN.md, DOCS/EMAIL_FINDER.md, server/mcp/mcp_server.js, templates/skills/enrichment-agent.md, templates/skills/email-finder.md, templates/skills/evaluator.md]
last_updated: 2026-04-14
staleness: none
---

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

## Related
- [[mcp]] — tool definitions for link_factlet, get_client_factlets, score_client
- [[ontology]] — Client, Factlet, ClientFactlet entity definitions
- [[architecture]] — enrichment pipeline data flow
- [[email-finder]] — sub-skill that upgrades failing contact gates at Step 3.6
