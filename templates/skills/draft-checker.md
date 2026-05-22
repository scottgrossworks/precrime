---
name: draft-checker
description: Quality gate for outreach drafts and leed JSON payloads. Returns ready | brewing.
triggers:
  - check draft
  - review draft
---

# Draft Checker

Quality gate. Two modes:

## mode: outreach

Validate against `skills/outreach-drafter.md`. The drafter file is the spec. Common failures:
- Salutation uses full name ("Dear Bob Jones,") instead of first-name-only or honorific
- Missing rate (must include "Rates start at [RATE]") or missing signature block
- Close is a question instead of an imperative
- Any phrase from the banned list in outreach-drafter.md

**Verdict:** `ready` if all pass, `brewing` with specific failed checks if not.

## mode: marketplace

Validate an addLeed JSON payload.

| Check | Pass | Fail |
|-------|------|------|
| Required fields | `tn`, `ti`, `dt`, `rq`, `st`, `zp`, `cn` all non-empty | Any missing |
| Trade | Matches `precrime__trades()` exactly | No match |
| Voice | `dt` and `rq` are third-person, no greetings, no first-person, no pricing | Violates voice |
| Substance | `dt` describes the event specifically | Too thin |
| Date | In the future | Past date |
| Zip | Valid 5-digit format | Invalid |

**Verdict:** `ready` or `brewing` with specific failures.
