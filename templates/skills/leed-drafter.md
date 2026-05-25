---
name: leed-drafter
description: Reference for the addLeed payload shape that share_booking builds server-side. The LLM does NOT assemble this JSON.
triggers:
  - draft leed
  - build leed json
---

# Leed Drafter

The addLeed payload is built by the MCP server, not by the LLM. Use this file only as a reference for the field shape that comes back from `precrime__pipeline({ action: "share_booking", bookingId, mode: "draft", timezone })`.

The LLM never computes `st` or `et`. The LLM never calls `leedz__createLeed`. The only normal sharing path is `share_booking`.

---

## Payload Shape (returned by share_booking)

| API Field | Source (server-side) | Notes |
|-----------|----------------------|-------|
| `tn` | Booking.trade (validated against `precrime__trades()` ahead of time) | Lowercase, exact match. |
| `ti` | Booking.title | Short, descriptive. |
| `lc` | Booking.location | Venue/address/location text. |
| `dt` | Booking.description / Booking.notes | Third-person event description. |
| `rq` | Booking.notes | What the event needs. Third-person. |
| `st` | MCP `resolve_dates` from Booking.startDate + IANA timezone | Epoch ms. NEVER computed by the LLM. |
| `et` | MCP `resolve_dates` from Booking.endDate   + IANA timezone | Epoch ms after `st`. NEVER computed by the LLM. |
| `zp` | Booking.zip | 5-digit zip code. |
| `cn` | Client.name | From CLIENT record. |
| `em` | Client.email | From CLIENT record. |
| `ph` | Client.phone | From CLIENT record (empty string if none). |
| `pr` | Always `0` | Free listing. |
| `sh` | Always `"*"` | Broadcast to all matching vendors. |

The response also includes a `humanReadable` block: `{ startDisplay, endDisplay, timezone }`. Show that block to the user before approving a post.

---

## Procedure

1. Ensure the Booking already carries a clean structured date provenance (`startDate`, `endDate`, `zip`). If it does not, the booking is brewing, not shareable -- enrich first.
2. Call `precrime__pipeline({ action: "share_booking", bookingId, mode: "draft", timezone: "America/Los_Angeles" })` (substitute the relevant IANA timezone).
3. Quote the literal `payload` and `humanReadable` from the response. Show every field. No ellipsis.
4. If the response is `posted: false` with `error: "missing_date_provenance"` or `error: "resolve_dates_failed"`, do NOT try to repair `st`/`et` yourself. Fix the underlying Booking fields and re-run.

## Date Rule

The LLM extracts structured date pieces (year, month, day, hour, minute, ampm) and an IANA timezone. The MCP server computes epoch milliseconds. Do not manually calculate, infer, or "fix" `st`/`et`. The MCP `share_booking` action rejects LLM-supplied `st` and `et` by name.

`leedz__createLeed` is no longer a normal call path. The only sanctioned posting path is `share_booking(mode:"post")`.
