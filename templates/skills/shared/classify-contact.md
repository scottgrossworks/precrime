# Contact Classifier

Every extracted contact goes through this:

```
INPUT: a person or organization found during scraping

0. BUYER ARCHETYPE GATE (BLOCKING). Check the candidate against VALUE_PROP "WHO IS NOT A BUYER".
   - Matches a SOURCE archetype (convention organizer, venue, directory, etc.) ->
       do NOT save as Client. Queue the candidate's URL into the Source table via
       precrime__pipeline({ action: "add_sources", ... }). Log and move on.
   - Matches a SKIP archetype (competitor, past-event recap, equipment reseller, etc.) ->
       do NOT save. Log and move on.
   - Matches neither -> proceed to step 1.

1. Apply skip filters (see "What to skip" below). If matched, drop the row.

2. Has ALL three booking fields (trade + date + location/zip)?

   YES -> LEAD HOT
     precrime__pipeline({ action: "save", session_id: sid, patch: {
       name, company, email, website, phone,
       source, segment, draftStatus: "brewing"
     }})
     Then with the returned clientId:
     precrime__pipeline({ action: "save", session_id: sid, id: clientId, patch: {
       bookings: [{ trade, startDate, location, zip, source, sourceUrl }]
     }})
     The server scores the booking against DOCS/SCORING.json. Do not set status manually.

   NO -> LEAD THIN
     precrime__pipeline({ action: "save", session_id: sid, patch: {
       name, company, email, website, phone,
       source, segment, draftStatus: "brewing"
     }})
```

If no `sid` exists because the caller is an older skill, omit `session_id`; otherwise always pass it.

The server dedups by company automatically: if the company already exists, the save merges into the existing record (counts as a save_attempt either way). Do not pre-check the DB.

## What counts as a valid contact

- Has at least a person name OR a company name (company-only is allowed but scores low until enrichment finds a real name)
- Bonus: has a non-generic email (dramatically increases value -- required for contactGate=true)
- Bonus: has a website (enables enrichment to find person names and emails)

## What to skip

- Entries with only a generic inbox and no person name (info@ with no person = useless)
- Entries clearly outside the target geography (per VALUE_PROP config)
- Entries in the SAME trade as the seller -- those are competitors, not clients (e.g. another photo booth company at the same expo). Cross-trade exhibitors at any event are valid client targets and DO proceed to PATH B/C, even if their industry has nothing to do with the seller's. The whole point of harvesting an expo is the OTHER booths.
- Entries that are the page owner/operator, not a listed contact

## Scoring

Scoring runs automatically on every `pipeline.save`. No separate score call needed.
