---
name: precrime-share-skill
description: Post a hot booking to The Leedz marketplace or email it.
triggers:
  - share this booking
  - post this leed
  - share leed
---

# Share Skill

Single source of truth for marketplace sharing. Takes a `hot` Booking, creates a vendor-facing marketplace brief, previews the server-built Leedz payload, and posts or emails it based on `defaultBookingAction` in config.

The audience is a FELLOW vendor deciding whether this event is worth their time. You are pitching that vendor on why the event is worth pursuing, not writing to the Client. The purpose is to make the opportunity attractive, complete, and actionable: explain what the event is, who the client is, the demand signal and fit, and why a vendor should want it. Use only verified logistics and contact facts.

**APPROVAL GATE:** Every share requires the user to type `yes` first. Show the full payload, ask, wait. No batch approvals. No auto-sends.

---

## Step 1: Load Booking + Client

If not already in context, fetch:
```
precrime__find({ action: "bookings", filters: { id: bookingId } })
precrime__find({ action: "clients", filters: { id: clientId }, summary: false })
```

Proceed only if the booking is still `status: "hot"`. `share_booking` (Step 2) enforces this server-side and returns error `booking_not_hot` for any Booking that is not `hot` at the moment of the call. Only `hot` bookings are shareable. The LLM never computes status from this skill.

---

## Step 2: Draft via share_booking (server-built payload)

Do not build the addLeed JSON yourself. Do not compute `st` or `et`.

You may optionally write only these marketplace prose overrides from verified Booking/dossier/factlet/source evidence. The server maps `titleDraft` -> `ti`, `dtDraft` -> `dt`, `rqDraft` -> `rq`:

- `titleDraft`
- `dtDraft`
- `rqDraft`

Compose these as a vendor-to-vendor sales pitch: you are pitching a FELLOW vendor on why this event is worth their time, NOT writing to the Client. Evidence-backed only; if the dossier does not support a claim, omit it.

Rules:

- `titleDraft` (`ti`): punchy event title. No emails or phone numbers.
- `dtDraft` (`dt`): what the event is, who the client is, the demand signal and fit, and why a vendor should want it. May include additional useful contact info when it is present in evidence.
- `rqDraft` (`rq`): requirements and next-step notes. May include additional useful contact info for facilities, vendor coordination, marketing, utilities, onsite logistics, or decision-making when present in evidence.
- Never invent contacts, demand, dates, venue, location, zip, phone, email, or logistics.
- Never output epochs, emails, phone numbers, or other PII in the prose. The server fills `tn` / `lc` / `zp` / `st` / `em` / `et`.
- Never include payload field labels like `em:`, `cn:`, `st:`, `et:`.

Then call:

```
precrime__pipeline({ action: "share_booking", bookingId, mode: "draft", titleDraft, dtDraft, rqDraft })
```

The server derives the IANA timezone from the Booking's zip; do not pass `timezone`. It then loads the Booking + Client, requires `status: "hot"` (else returns `booking_not_hot`), runs structured `resolve_dates`, and returns `{ payload, humanReadable: { startDisplay, endDisplay, timezone } }`. Show EVERY field of `payload`. No ellipsis. No truncation. The `humanReadable` block is the verification dates the user reads before approving.

---

## Step 3: Route by defaultBookingAction

This skill assumes the caller has already obtained user approval (interactive via `show-hot-leedz.md`) or is dispatching post-only (`headless_flow.md`). Execute the route for the current `Config.defaultBookingAction`:

**`leedz_api`:** Call `precrime__pipeline({ action: "share_booking", bookingId, mode: "post" })`. Never call external Leedz tools directly. The server is the only sanctioned poster; it persists `leedId`, `sharedAt`, and returns the leed to `cold` server-side. On error, log the returned object to `logs/ROUNDUP.md` and stop.

**`email_share`:** Send via `gmail__gmail_send` to share@theleedz.com.

**`email_user`:** Send via `gmail__gmail_send` to [companyEmail].

---

## Step 4: Record Result

`share_booking(mode:"post")` already writes `leedId`, `sharedAt`, `sharedTo: "leedz_api"`, and returns the leed to `cold` server-side. Do not write these fields by hand from the LLM.

For `email_share` or `email_user` paths (gmail-based, no marketplace post), record the share via the Client-rooted `bookings[]` patch. `pipeline.save`'s `id` is the CLIENT id; the Booking goes inside `patch.bookings[]`. The server auto-mirrors `Client.draftStatus="sent"` + `Client.sentAt=<now>` whenever it sees a Booking returned to `cold` after a share with `sharedTo` in `{ "email_share", "email_user" }`, so you do NOT have to write the Client marker by hand:

```
precrime__pipeline({ action: "save", id: clientId, judge: false, patch: {
  bookings: [{
    id: bookingId,
    status: "cold",
    sharedTo: "email_share"   // or "email_user"
  }]
}})
```

On skip -> demote back for more enrichment via the same Client-rooted shape:
```
precrime__pipeline({ action: "save", id: clientId, judge: false, patch: {
  bookings: [{ id: bookingId, status: "brewing" }]
}})
```
The booking leaves the hot queue. Enrichment will revisit it. When the dossier improves, the server re-classifies it.

On stop: halt all sharing.

---

## Leed JSON Rules

- The server builds the final payload via `share_booking`. The LLM may supply only `titleDraft`, `dtDraft`, and `rqDraft`; the server validates them before payload assembly.
- The LLM never writes `cn`, `em`, `ph`, `lc`, `zp`, `st`, `et`, `tn`, `pr`, or `sh`.
- `cn`, `em`, `ph` come from the CLIENT record server-side. The user is a vendor, not the contact.
- Additional contacts may appear in `dt` / `rq` only as prose, and only when supported by evidence.
- `st` and `et` are computed by MCP from the Booking's structured date provenance + the IANA timezone derived server-side from `Booking.zip`. Never calculate them in the LLM. Never accept an LLM-supplied `st`/`et`; `share_booking` rejects them by name.
- `dt` and `rq` are vendor-facing marketplace brief fields. No greetings, no first-person, no seller pricing, no pretending the Client has explicitly requested service unless evidence says so.
- `sh: "*"` means broadcast to all matching vendors by default.
- `pr` is always `0` (free).
- Trade must match `precrime__trades()` exactly.
