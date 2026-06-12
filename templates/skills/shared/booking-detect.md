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

## Speculative / Exhibitor Exclusion (replaces archived convention-leed-pipeline)

A Booking record represents an EVENT THAT REQUIRES VALUE_PROP, not a contact who might one day need it. Do NOT create a Booking when the source only proves the entity exists in a venue with a date. Specifically, exclude:

- Convention or expo exhibitors at a venue/date (their booth IS their event; they are not booking entertainment).
- Vendor directory listings, "businesses in [city]" lists, conference attendee rosters.
- Past-event recaps (the event already happened; no future booking to fill).
- Any source that does not name a SPECIFIC UPCOMING EVENT where VALUE_PROP would be hired.

For these cases, create the CLIENT (via classify-contact.md) with dossier notes capturing the encounter. Let the enrichment loop attach factlets. The booking only appears later, if and when actual demand evidence is found (RFP, inquiry, past purchase of VALUE_PROP at a recurring event, etc.).

The cost of a wrong Booking is that it pollutes the queue with no demand signal. The Judge will hold it at `brewing` rather than `hot`, but the cleaner path is to not create the Booking in the first place.
