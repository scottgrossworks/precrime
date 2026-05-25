---
name: precrime-share-skill
description: Post a leed_ready booking to The Leedz marketplace or email it.
triggers:
  - share this booking
  - post this leed
  - share leed
---

# Share Skill

Handles the final mile: takes a leed_ready Booking and posts it to the marketplace or emails it, based on `defaultBookingAction` in config.

**APPROVAL GATE:** Every share requires the user to type `yes` first. Show the full payload, ask, wait. No batch approvals. No auto-sends.

---

## Step 1: Load Booking + Client

If not already in context, fetch:
```
precrime__find({ action: "bookings", filters: { id: bookingId } })
precrime__find({ action: "clients", filters: { id: clientId }, summary: false })
```

Proceed only if the booking is still `status: "leed_ready"`. `share_booking` (Step 2) re-runs Judge server-side and refuses any Booking that is not `leed_ready` at the moment of the call -- the LLM never calls `pipeline.rescore` from this skill.

---

## Step 2: Draft via share_booking (server-built payload)

Do not build the addLeed JSON yourself. Do not compute `st` or `et`. Call:

```
precrime__pipeline({ action: "share_booking", bookingId, mode: "draft", timezone: "America/Los_Angeles" })
```

The server loads the Booking + Client, rescores via Judge, demands `leed_ready`, runs structured `resolve_dates`, and returns `{ payload, humanReadable: { startDisplay, endDisplay, timezone } }`. Show EVERY field of `payload`. No ellipsis. No truncation. The `humanReadable` block is the verification dates the user reads before approving.

---

## Step 3: Route by defaultBookingAction

This skill assumes the caller has already obtained user approval (interactive via `show-hot-leedz.md`) or is dispatching post-only (`headless_flow.md`). Execute the route for the current `Config.defaultBookingAction`:

**`leedz_api`:** Call `precrime__pipeline({ action: "share_booking", bookingId, mode: "post", timezone })`. Never call `leedz__createLeed` directly. The server is the only sanctioned poster; it persists `leedId`, `sharedAt`, and flips `status` to `shared`. On error, log the returned object to `logs/ROUNDUP.md` and stop.

**`email_share`:** Send via `gmail__gmail_send` to share@theleedz.com.

**`email_user`:** Send via `gmail__gmail_send` to [companyEmail].

---

## Step 4: Record Result

`share_booking(mode:"post")` already writes `leedId`, `sharedAt`, `sharedTo: "leedz_api"`, and `status: "shared"` server-side. Do not write these fields by hand from the LLM.

For `email_share` or `email_user` paths (gmail-based, no marketplace post), record the share manually:
```
precrime__pipeline({ action: "save", id: bookingId, patch: {
  status: "shared",
  sharedTo: "email_share" | "email_user",
  sharedAt: new Date().toISOString()
}})
```

On skip -> demote back for more enrichment:
```
precrime__pipeline({ action: "save", id: bookingId, patch: {
  status: "needs_enrichment"
}})
```
The booking leaves the leed_ready queue. Enrichment will revisit it. When data improves enough to pass `DOCS/SCORING.json`, the server automatically re-promotes it.

On stop: halt all sharing.

---

## Leed JSON Rules

- The server builds the entire payload via `share_booking`. The LLM never assembles `st`, `et`, or any other field by hand.
- `cn`, `em`, `ph` come from the CLIENT record server-side. The user is a vendor, not the contact.
- `st` and `et` are computed by MCP from the Booking's structured date provenance + IANA timezone passed on the action. Never calculate them in the LLM. Never accept an LLM-supplied `st`/`et`; `share_booking` rejects them by name.
- `dt` and `rq` are third-person event descriptions. No greetings, no first-person, no pricing, no vendor names.
- `sh: "*"` means broadcast to all matching vendors by default.
- `pr` is always `0` (free).
- Trade must match `precrime__trades()` exactly.
