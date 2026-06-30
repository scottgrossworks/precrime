# Booking Detection

When scraped content contains someone requesting a specific service at a specific time and place, check for ALL THREE:

1. **Trade** -- matches a known Leedz trade name (from `precrime__trades()`)
2. **Date** -- a specific date or date range
3. **Location/zip** -- a specific venue, city, or zip code

## All Three Present AND leadCaptureEnabled

Create the client (if not already in DB -- run classify-contact.md first):
```
precrime__pipeline({ action: "save", judge: false, patch: {
  name: "[contact name]",
  company: "[company]",
  email: "[email if found]",
  source: "[source_type]",
  draftStatus: "brewing"
}})
```

Attach the booking:
```
precrime__pipeline({ action: "save", judge: false, id: clientId, patch: {
  bookings: [{
    trade: "[detected trade -- must match precrime__trades exactly]",
    dateText: "[verbatim date/time text copied from the source page]",
    location: "[location text]",
    zip: "[zip code -- extract or geocode]",
    source: "[source_type]",
    sourceUrl: "[URL where found]"
  }]
}})
```

The server resolves `dateText` into `startDate` / `endDate` procedurally. The Judge classifies the booking server-side as `cold` / `brewing` / `hot`. Do not set status or scores. A booking stays `brewing` until it is enriched enough to act on, which the Judge decides from contact, zip, end date, source URL, and fresh relevant factlet evidence.
`sourceUrl` must be the live page that proves the booking. `pipeline.save` rejects 404s, homepage redirects, pages that do not mention the detected booking terms/year, and event dates not proven on the source page.

Do not invent ISO dates or epoch values. The model's job is to copy raw date text from the source; the MCP server computes exact Leedz wall-clock epoch values.

## Missing One or More Fields

Create the client as LEAD THIN (via classify-contact.md PATH C) and note what's missing in the dossier:
```
"BOOKING_PARTIAL: has [trade] + [date] but missing [location]. Source: [URL]"
```

The enrichment pipeline may fill in the missing field later. Save sparse relevant records; do not promote them manually.

## leadCaptureEnabled = false

Do not create client or booking. Log `LEAD_CAPTURE_OFF` and move on.

## Trade Matching

The trade name MUST come from `precrime__trades()`. Do not invent, paraphrase, or guess trade names. If the detected service doesn't match any trade in the list, do not create a booking.

## Booking vs Client — capture dated events

**A specific upcoming dated event IS a Booking.** When a page names a real EVENT with
a future date and a location — a comic con, festival, fair, expo, gala, fundraiser,
grand opening, school or corporate event, party, etc. — create ONE Booking per dated
event, even if no contact is attached yet. The dated event is itself the demand
signal; you do NOT need a separate RFP or inquiry to prove it. A contact-less booking
stays `brewing` and the enrichment loop chases the organizer's contact later.
- Use `dateText` = the verbatim date copied from the page, plus `location`/`zip` and
  `sourceUrl` (the live page that proves the event). The server resolves the date.
- The event's host/organizer becomes the CLIENT to pitch (create it via
  classify-contact.md and attach the booking to it).

**Create a CLIENT (not a Booking)** for an entity with NO specific dated event:
- A vendor / planner / venue / business profile (e.g. a wedding planner's page).
- A vendor-directory or "businesses in [city]" listing; a conference attendee or
  exhibitor record (they are attending, not hosting an event that needs VALUE_PROP).
These are real prospects — the Booking appears later if a dated event for them surfaces.
Individual profiles and event calendars are equally valuable: profiles become clients,
dated events become bookings; capture both.

**Exclude entirely:** PAST events (already happened), and events with no plausible fit
for the trade.

The cost of a MISSED dated event (silently dropping a real upcoming event) is worse
than a speculative one: the Judge holds a contact-less event at `brewing` until it is
enriched, but a dropped event is a hot leed you never see. When a page lists dated
events, capture them.
