---
name: leed-drafter
description: Build addLeed JSON payload from booking + client + factlets. Procedural.
triggers:
  - draft leed
  - build leed json
---

# Leed Drafter

Build the `addLeed` JSON payload for a server-promoted `leed_ready` booking. This is procedural -- no LLM creativity. Map fields from the booking and client records to the API schema and `DOCS/SCORING.json`.

---

## Required Fields

| API Field | Source | Notes |
|-----------|--------|-------|
| `tn` | `precrime__trades()` | Must match exactly. Lowercase. |
| `ti` | Booking title or event name | Short, descriptive |
| `lc` | Booking location | Venue/address/location text |
| `dt` | Booking details | Third-person event description. No greetings, no first-person, no pricing, no vendor names. |
| `rq` | Requirements from dossier/booking | What the event needs. Third-person. |
| `st` | MCP-resolved Booking startDate | Epoch ms derived by `precrime__pipeline({action:"resolve_dates"})` or already saved server-resolved booking date. Never compute by LLM. |
| `et` | MCP-resolved Booking endDate | Epoch ms after `st`. Never share without an end time. Never compute by LLM. |
| `zp` | Booking zip | 5-digit zip code |
| `cn` | Client name | From CLIENT record |
| `em` | Client email | From CLIENT record |
| `ph` | Client phone | From CLIENT record (empty string if none) |
| `pr` | Always `0` | Free listing |
| `sh` | Always `"*"` | Broadcast to all matching vendors |
| `session` | Config leedzSession | JWT token |

---

## Procedure

1. Load booking and client data (if not in context).
2. Fetch trade list: `precrime__trades()`. Match the booking trade.
3. Resolve dates procedurally. If the booking does not already contain server-resolved `startDate` and `endDate`, call:
   `precrime__pipeline({ action: "resolve_dates", text: "[verbatim date/time text from source]", sourceUrl: "[proof URL]" })`.
   Use only returned `st` and `et`. If `ok:false`, stop and report the missing/ambiguous date field.
4. Compose `dt` and `rq` from dossier + booking notes. Keep factual. No sales language.
5. Assemble JSON with all fields above.
6. Validate against `DOCS/SCORING.json` `addLeedBusinessRequired`: `tn`, `ti`, `lc`, `zp`, `st`, `et`, `cn`, `em`, and `dt` must be present; `zp` must be 5 digits; `em` must be a direct non-generic email; `pr` must be `0`; `sh` must be `"*"`. If any check fails, report which field and stop.
7. Return the complete JSON. Show every field -- no ellipsis.

## Date Rule

The LLM extracts verbatim date text; the MCP server computes epoch milliseconds. Do not manually calculate, infer, or "fix" `st`/`et`. If the source does not prove the date/year or does not provide enough time information to produce an end time, the booking is brewing, not shareable.
