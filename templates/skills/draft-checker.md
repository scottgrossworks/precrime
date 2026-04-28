---
name: draft-checker
description: Quality gate for outreach drafts (mode=outreach) and leed JSON payloads (mode=marketplace). Returns ready | brewing.
triggers:
  - check draft
  - check leed
  - validate draft
  - validate leed
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# Draft Checker

Mechanical quality gate run AFTER a drafter produces output. **Not** a scoring algorithm — `score_target` already approved the target. This skill checks whether the produced artifact (email or leed JSON) meets pre-ship requirements.

## Input

- `mode`: `outreach` | `marketplace`
- `artifact`: the draft email body (outreach) OR the addLeed JSON payload (marketplace)
- Context available: client, booking, linked factlets via `precrime__find({ action: "factlets", filters: { clientId } })`, `DOCS/VALUE_PROP.md`

## Output

```
VERDICT: ready | brewing
REASON:  [one sentence — which check failed, or "all checks pass"]
FIX:     [one specific instruction; only present if brewing]
```

ALL checks must PASS for `ready`. ANY fail → `brewing`.

Note: scoring already happened upstream via `precrime__pipeline({ action: "next" })`. This skill only does mechanical post-draft checks.

---

## Mode: outreach (draft email)

| Check | PASS | FAIL |
|---|---|---|
| Salutation | Opens `Dear {client.name},` on its own line | Missing or wrong name |
| Factlet citation | ≥1 linked factlet referenced specifically (not a generic directory fact) | No factlet referenced |
| Bridge sentence | One sentence connects factlet → product capability per VALUE_PROP.md | No bridge or feature dump |
| Banned chars | Zero em-dash, en-dash, `--`, smart quotes, ellipsis chars | Any present |
| Forbidden phrases | None present (per VALUE_PROP.md "Forbidden phrases") | Any present |
| Closing line | Exact text from VALUE_PROP.md "Permitted closing line" | Missing or paraphrased |
| Word limit | Under VALUE_PROP.md word limit | Over |
| Tone | Warm, collegial. No "X is great BUT Y" / negging / interrogation | Confrontational, lecturing, template-feel |

---

## Mode: marketplace (leed JSON payload)

The leed must be worth a Leedz subscriber paying for.

| Check | PASS | FAIL |
|---|---|---|
| `tn` (trade) | Lowercase, in `precrime__trades()` | Missing or invalid |
| `ti` (title) | ≤200 chars, descriptive | Missing or generic |
| `zp` (zip) | 5-digit | Missing |
| `st` (start) | Valid epoch ms | Missing |
| `lc` (location) | Includes street/venue + zip | Missing or city-only |
| `cn` (contact name) | Real first+last (not "Info Desk", not blank) | Generic or blank |
| `em` (contact email) | Non-generic (NOT `info@` / `contact@` / `support@` / `sales@` / etc.) | Generic prefix |
| `ph` (contact phone) | Present | Blank |
| Demand backing | ≥1 fresh relevant factlet on the client expressing need (not just context) | Speculative — only context factlets |
| `pr` | Exactly `0` | Anything else |
| `email` | Exactly literal string `"false"` | Anything else (including `false` boolean) |
| Buyer-viability | A subscriber paying for this could call `cn` with portfolio + availability and book | Information too thin for a cold call |

---

## Rules

1. Binary gate. Every check passes or the artifact is `brewing`. No averaging.
2. Mechanical only. Do not re-grade the SCORE — `pipeline.next` already passed.
3. On FAIL, return ONE specific FIX line. The drafter or enrichment will act on it.
4. Read `DOCS/VALUE_PROP.md` for forbidden phrases, closing line, word limit. Never hardcode them.
