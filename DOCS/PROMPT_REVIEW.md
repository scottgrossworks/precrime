1. Classification judge (cold / brewing / hot) — server-side, per dossier-change, mode-aware:
  You classify a sales opportunity for {company}, who sells: {VALUE_PROP one-liner}.

  CLIENT DOSSIER:
  {synthesized dossier prose}

  BOOKING (the event):
  title: {title}   date: {startDate}   location: {location}   trade: {trade}


We have to make it clear what we are judging with LLM.
We are not judging the entire client because the important elements of the client are judged procedurally

We are really judging the dossier using LLM
a better way of doing this is: 


A Client.dossier is 
COLD:
-when it is first created.
-when it contains 0 factlets
- when has been acted upon via outreach or marketplace sharing.
...
<<Add more conditions if you can think of them>>

BREWING:
- When it contains one or more factlets
- When a Booking has been created but no exact location has been determined
- When a Booking has been created but no start date has been determined
- if Client.nm is empty
- if Client.em is empty
...
<<Add more conditions if you can think of them>>



sharing a lead is cold when there are no faculty in dossier where it's dossier is empty

















  Decide ONE classification. Reply with exactly one word: cold, brewing, or hot.

  - cold: no real, fitting opportunity here, or nothing worth acting on yet.
  - brewing: a real opportunity may exist but it is not yet established — missing a
    real decision-maker, unclear product-market fit, or no demand you can point to.
  - hot: a real, fitting, in-demand opportunity, ready to act on now.

  Judge against this bar for the active objective "{mode}":
  - A real client and a decision-maker who can actually hire {company} for the VALUE_PROP.
  - The opportunity is real even if the service was never explicitly requested.
  - Product-market fit between the VALUE_PROP and this client/event.
  - Demand: an explicit request, OR demand you can infer with HIGH confidence from
    prior hiring history, strong thematic fit, or reports of similar vendors hired.
  {mode == marketplace ? "MARKETPLACE bar is HIGHER: another vendor will spend time
  and money on this, so demand must be high-confidence, not a faint maybe." : ""}
  {mode == outreach ? "OUTREACH bar is LOWER: a real decision-maker plus product-market
  fit is enough; you are prospecting to learn more, demand can be unproven." : ""}

  After the one word, add one short sentence of reasoning.

  2. Outreach email composition — the user wants the gig himself:
  Write a short outreach email from {company} ({VALUE_PROP one-liner}) to this client.
  Goal: start a real conversation that leads to booking THIS event for us — get the
  missing details (date, venue, needs) or sell ourselves as the right vendor.

  CLIENT DOSSIER:
  {dossier}
  BOOKING:
  {title, date, location, trade}

  Rules:
  - Specific to this client and event — reference real facts from the dossier, never
    generic filler. No invented facts, dates, names, or numbers.
  - Lead with why {company}'s VALUE_PROP fits THIS event.
  - One clear ask. Warm, brief, human. No hard sell.
  - Close with this signature block verbatim:
  {signature}

  3. Leed-pitch / addLeed JSON composition — the user sells the leed to another vendor:
  You are packaging this opportunity as a marketplace leed another vendor will pay to
  act on. You are NOT writing to the client — you are pitching a fellow {trade} vendor
  on why this event is worth their time.

  CLIENT DOSSIER:
  {dossier}
  BOOKING:
  {title, date, location, trade, contact}

  Produce three prose fields for the leed (the server fills tn/lc/zp/st/em/et from
  structured data — do not output dates, epochs, emails, or phone numbers):
  - ti: a punchy event title a vendor scans in a feed.
  - dt: the pitch — what the event is, who the client is, and why a {trade} vendor
    should want it (the demand signal, the fit). Evidence-backed only.
  - rq: requirements / next-step notes — what the vendor would need to know to follow up.

  No invented facts. If the dossier does not support a claim, leave it out.