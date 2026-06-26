# PRECRIME Classification (authoritative)

Locked 2026-06-10 with Scott. This is the single source of truth for how PRECRIME
classifies and promotes. It supersedes the scoring and label language in
`DOCS/SCORING.json` and `DOCS/REDESIGN_2026-06-07.md` (0-100 scores, the 60/90
thresholds, and the names `shareable` / `emailable` / `leed_ready` /
`outreach_ready`). Those are retired. The names here are final:
`cold` / `brewing` / `hot`, and `outreach-ready` / `marketplace-ready`.

No numeric score. No ordinal. Classification is three states plus two independent
readiness labels, all determined holistically, never graded.

## Leed = Client + Booking

A leed is a Client joined to a Booking. Readiness is judged on the leed (the pair).

## States: cold -> brewing -> hot

Single classifications, not scored. There are no degrees of brewing and no
graduation between states.

- COLD. Start state AND end state. A newly identified and stored client is cold.
  A leed returns to cold after it is acted on: an outreach email is drafted/sent,
  or the leed is shared. A cold leed can warm again later (recurring events).
- BREWING. Enrichment has begun, or a booking is identified but not yet promotable
  for one or more reasons. One flat state: no closeness metric is stored. The gaps
  still to fill are computed at runtime, not graded.
- HOT. Enriched enough to act on. WHICH action is not stored on the leed: in
  interactive mode the chat presents every hot leed and the user chooses share or
  outreach per leed; in headless mode PRECRIME runs ONE objective and acts on hot
  leedz automatically (outreach mode writes an email, marketplace mode shares).

## Acting on a hot leed: outreach vs marketplace

These are two different ACTIONS with different bars, NOT two stored labels on the
booking. The action is chosen at act time: by the user (interactive) or by the
active mode (headless). In headless the LLM judges hotness against the active
mode's bar. The bars are enforced where the action happens, never precomputed.

### outreach  (the user wants the gig himself)
Purpose: the PRECRIME user wants to consume this opportunity. He emails the client
to get more info or to sell himself, aiming to nail down a booking (his own sale).
A clear demand signal is NOT required; outreach is how he closes that gap.

Procedural floor: a real Client name + a real direct email (you need somewhere to
write). Phone is optional, it is exactly the kind of thing outreach itself
solicits. Other fields (end time, full address, etc.) may be missing.

LLM judges the user can be confident that:
- the Client is real,
- the contact is real,
- the Client is a decision-maker who can actually hire for VALUE_PROP,
- the opportunity is real even if the service was never explicitly requested,
- there is product-market fit between VALUE_PROP and the dossier.

### marketplace  (the user does NOT want the gig; sells it to another vendor)
Purpose: package the leed as an information product another vendor will pay
attention to. The dossier is summarized DIFFERENTLY, as a sales pitch for the event
explaining why another vendor should contact the client to try to book it.

Procedural floor (all rock solid, because the receiving vendor measures it against
his own calendar): the full addLeed contract is composable from the dossier
(`tn, ti, lc, zp, st, em, dt`), the location passes the AWS precision gate, and the
start date and time are present and in the future. This floor is enforced at the
share boundary by addLeed itself (the work done 2026-06-10), so an incomplete hot
leed simply cannot be posted. PRECRIME does not precompute a "marketplace-ready"
flag.

LLM judges demand is present: an explicit request, OR inferred demand at HIGH
confidence. Inferred demand is the fuzzy area the LLM owns: prior hiring history,
product-market fit, or reports from other similar providers already enriched into
the dossier. If it clears the bar the leed is worth sharing at price 0 by default
(headless), or the user sets a price in interactive mode for info a vendor would
actually pay for.

## Procedural (JS-gated) vs LLM (qualitative)

Procedure answers "is the data complete, valid, and driveable-to." The LLM answers
"is this a real, fitting opportunity, and what is the demand story." A leed is hot
when the LLM judges a real, fitting, in-demand opportunity: against the active
mode's bar in headless, against the lower outreach bar in interactive so the user
sees every candidate. Procedural completeness for a share is enforced at the
addLeed boundary, not precomputed.

| Procedural / deterministic (JS, against the addLeed contract) | LLM / qualitative judgment |
|---|---|
| Required fields present and composable (tn, ti, lc, zp, st, em, dt) | Is the Client a decision-maker who can hire for VALUE_PROP |
| Location resolves to a precise spot (AWS street-or-POI gate) | Product-market fit between VALUE_PROP and the dossier |
| Start date/time present and in the future | Is the opportunity real even if the service was not requested |
| Email present and direct (not a generic inbox) | Demand: explicit request, or inferred demand at high confidence |
| Phone optional (especially for outreach) | The cold / brewing / hot call |
| End time optional (not defaulted; addLeed is the judge) | Compose the outreach email, or the marketplace sales pitch, from the dossier |

The procedural bar differs by ACTION: outreach needs only a real client + real
email; a share needs the full addLeed contract, which addLeed itself enforces at
post time. Neither is stored on the booking.

## Pricing
Marketplace shares default to price 0 and share `*` (broadcast). Interactive mode
may set a price. Price is never a gate.

## End time (confirmed 2026-06-10)
`et` is a single epoch that fuses end date and end time. End date alone has a safe
default (single-day, so endDate = startDate), but end time is unguessable (a gig
runs one hour or all day), and a fused field cannot be built from a date without a
time. So `et` cannot be defaulted and is optional. A missing `et` does NOT block
marketplace-ready; otherwise an ordinary single-day gig with an unknown end time
could never be shared. We never synthesize an `et`; addLeed accepts its absence.
