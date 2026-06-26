---
title: leed_ready never promotes - hardcoded URL re-verification and an unwired SCORING.json
date: 2026-06-07
category: logic-errors
module: scoring / leed promotion (server/mcp/mcp_server.js)
problem_type: logic_error
component: service_object
symptoms:
  - "Bookings stay brewing despite a 90+ score, a named direct contact, and explicit demand language"
  - "Editing SCORING.json gates (the verification block / rejectIf) changes nothing at runtime"
  - "share_booking refuses to post and the judge reports booking_not_leed_ready"
root_cause: logic_error
resolution_type: code_fix
severity: critical
tags: [leed-ready, demand-signal, scoring, verification, provenance, dead-config]
---

# leed_ready never promotes - hardcoded URL re-verification and an unwired SCORING.json

> Status: root cause verified by code read on 2026-06-07. The fix is designed (see Solution) but NOT yet implemented. This doc exists so the diagnosis is not re-derived from scratch - the prior agent burned an entire session flailing against this (see TDS DOCS/BUGS.md).

## Problem
Legitimate bookings (real contact, full event details, clear demand) never reach `leed_ready`, so nothing can be shared to the marketplace. Editing `SCORING.json` to loosen the gates has no effect, which makes the cause invisible.

## Symptoms
- Bookings stuck at `brewing` with a 90+ score, a named direct email, venue, date, and explicit "seeking / hiring" language.
- Changing `SCORING.json` `verification` / `rejectIf` entries produces no behavior change.
- `share_booking` / `rescore` keep returning `booking_not_leed_ready`; RFP, PDF, and aggregator/county source pages are the common victims.

## What Didn't Work
- Editing `SCORING.json` `verification.rejectIf` (and removing entries in the TDS copy). That block is dead - no code reads it.
- Rewriting booking titles/descriptions with explicit demand verbs. The save-time check re-validates against the live page, not the stored text.
- Swapping `sourceUrl` to a page that literally contains the terms (provenance swap). Treats the symptom, not the cause, and corrupts provenance.

## Solution
Two separate facts, both verified in `server/mcp/mcp_server.js`:

1. The `verification` block in `DOCS/SCORING.json` (`mustContain`, `rejectIf`, `liveUrlRequired`) is **unwired** - no code path reads it. The real verification is hardcoded. So tuning the JSON is theater.
2. The actual wall is **save-time live-URL re-verification**:
   - `verifyEvidenceUrl` (~line 1862) and `verifyResolvedDateSource` (~line 1489), called from `validatePatchEvidenceUrls` (~line 1888) and the factlet-save path (~line 2808), re-fetch the booking/factlet `sourceUrl` and reject the save unless that single page literally contains the year, the exact start month+day, and a proof term derived from the title/location/description.
   - The `leedReady` gate requires `sourceUrl` present (`SCORING.json`), so a booking needs a URL, but having one triggers the re-fetch that RFP/PDF/aggregator pages fail. Catch-22.
   - Note: the demand signal itself (`detectDemandSignal` ~line 975) does NOT re-scrape; it reads booking text + fresh VALUE_PROP/trade factlet count. The block is the URL re-verification, not the demand gate.

Agreed fix direction (designed 2026-06-07, not yet built):
- Delete the live-URL re-verification from the save/share paths. Capture proof ONCE when a worker first reads the page (store the snippet + date seen on the factlet) and trust the captured evidence afterward.
- Decide demand from the aggregate client dossier (an LLM verdict computed on dossier-change and stored), not from re-scraping one URL.
- Move tuning policy into markdown the engine actually reads, then wire or delete the dead `SCORING.json` `verification` block.

## Why This Works
The over-strict check conflates "this one page does not restate my claim verbatim" with "this claim is synthetic." Real opportunities (RFPs, PDFs, multi-source / county aggregator pages) rarely restate an event in the exact phrasing the regex wants, so valid leeds are rejected. Provenance and demand are properties of the accumulated evidence (the dossier and the sum of factlets), not of one page fetched at save time. Capturing proof at read-time and judging demand over the dossier removes the false rejection and the network dependency in the hot path.

## Prevention
- Never let a policy file look authoritative while the real logic is hardcoded. If `SCORING.json` (or any config) is the tuning surface, code must actually read it; otherwise delete it. A dead config that invites edits is a multi-hour trap.
- Do not verify a claim by re-fetching a single source URL for literal string matches. Capture provenance at the moment of reading; verify from stored evidence.
- When a gate "cannot be loosened by config," suspect the config is unwired before rewriting content - grep for the config keys in the server to confirm they are read.

## Related Issues
- TDS `DOCS/BUGS.md` - the Santa Monica / World Cup transcript where this was hit repeatedly and misdiagnosed as the "inferred" demand logic.
- Redesign decisions (the planned fix): the evidence-model rework recorded for this project (Thread 2).
