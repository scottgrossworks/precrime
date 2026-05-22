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

Rescore before sharing:
```
precrime__pipeline({ action: "rescore", scope: bookingId })
```
Proceed only if the booking is still `status: "leed_ready"`. The MCP server is the authority because it applies `DOCS/SCORING.json`.

---

## Step 2: Build Payload

Read and follow `skills/leed-drafter.md` to construct the addLeed JSON.

Show EVERY field. No ellipsis. No truncation.

---

## Step 3: Route by defaultBookingAction

The caller (marketplace_flow or hybrid_flow) already obtained user approval (`post`). Execute immediately:

**`leedz_api`:** Call `leedz__createLeed` with the payload. On error, log full payload to `logs/ROUNDUP.md` and stop.

**`email_share`:** Send via `gmail__gmail_send` to share@theleedz.com.

**`email_user`:** Send via `gmail__gmail_send` to [companyEmail].

---

## Step 4: Record Result

On success:
```
precrime__pipeline({ action: "save", id: bookingId, patch: {
  leedId: "[from API response]",
  status: "shared",
  sharedTo: "leedz_api" | "email_share" | "email_user",
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

- `cn`, `em`, `ph` come from the CLIENT record, not config. The user is a vendor, not the contact.
- `st` and `et` must be MCP-resolved epoch milliseconds. Never calculate them in the LLM. Never share a leed without an end time.
- `dt` and `rq` are third-person event descriptions. No greetings, no first-person, no pricing, no vendor names.
- `sh: "*"` means broadcast to all matching vendors by default.
- `pr` is always `0` (free).
- Trade must match `precrime__trades()` exactly.
