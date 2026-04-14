# What I Learned: Warmth Scoring

## The Problem

During the Mother's Day 2026 prospecting run, I inflated warmth scores across all 21 new clients. Multiple clients got warmth=10. Scott caught it immediately:

> "How can a client get warmth=10 in absence of a specific time/date/loc expressed need for my service / real non-generic contact? THAT is the only way a client should get a high score."

He was right. I was scoring based on "this venue hosts events that could use caricatures" and a pattern-guessed email address. That is not a hot lead. That is a guess.

## Why It Happened

The `score_client` MCP tool computes a procedural score: contactGate (named person + direct email), factletScore (linked factlet points), dossierScore (intel + factlets). It returns a number. But it does NOT set `warmthScore`. The enrichment agent sets warmthScore manually after reviewing the full picture.

I treated "good venue fit + named contact + inferred email" as warmth 10. That conflates "could be a customer someday" with "is actively looking for this service right now." Those are completely different things.

## The Correct Scoring

**Warmth 10** — Specific expressed need with date, location, and service request, plus a verified direct email to the decision-maker. Example: someone posts "Looking for a caricature artist for our June 14 corporate event" and you have their confirmed email.

**Warmth 9** — Strong signal of an upcoming relevant event, plus a verified direct email. Example: a venue confirmed hosting a Mother's Day brunch, and the event coordinator's email is verified through the company directory or website.

**Warmth 8** — Good fit signals (books entertainment, same service category, upcoming relevant events) but the email is pattern-inferred, not verified. Example: a party planner who books similar acts, email guessed from firstname.lastname@domain via RocketReach.

**Warmth 7** — General venue/planner fit for the service, named contact found, pattern-inferred email. No specific event signal. Example: upscale hotel with an events department, coordinator name from LinkedIn, email inferred from company pattern.

**Warmth 5-6** — Generic email only (info@, contact@, events@), or the fit is speculative.

**Warmth 1-4** — No contact, no fit signal, or wrong segment entirely.

## The Two Gates

A score of 9 or higher requires BOTH:

1. **Verified direct email** to a named human decision-maker. Pattern-inferred emails (first.last@domain from RocketReach, ZoomInfo, LinkedIn guessing) are NOT verified. They cap at warmth 8.
2. **Specific event signal.** "They host events" is not a signal. "They are hosting a Mother's Day brunch on May 10" is a signal. "Looking for entertainment vendors" is a signal. General fit is not.

Without both gates, the client stays at 7-8 regardless of how perfect the venue looks.

## Draft Threshold

Only warmthScore >= 9 gets draftStatus="ready". Everything below stays "brewing" with dossier notes on what is missing to reach 9.

This means most clients from a prospecting run will stay brewing. That is correct. A thin draft sent to a guess email is worse than no draft at all.

## What to Change in the Legacy System

The 268 pre-Mother's Day clients in the database were scored under older, looser rules. Many have warmth 8-10 based on the same inflated logic. To fix:

1. **Audit all warmth >= 9 clients.** For each, check: Is the email verified (not pattern-inferred)? Is there a specific event signal (not just "they host events")? If either answer is no, drop to 7-8.

2. **Audit all draftStatus="ready" clients.** Any ready draft with warmth < 9 after recalibration should be moved back to brewing.

3. **Treat pattern-inferred emails as unverified.** If the dossier says "email inferred from LinkedIn" or "email pattern from RocketReach," that is not verified. The only verified sources are: company website contact page listing the person by name, direct correspondence, or a confirmed directory entry.

4. **Never score on fit alone.** "This hotel hosts corporate events" is a segment match, not a buying signal. Segment match + named contact + inferred email = warmth 7. That is the ceiling without active intent.

5. **Run recalibration before any send batch.** Before moving any drafts to sent, re-examine every ready draft against these tiers. If the score does not hold up, demote it.

## The Lesson

Be honest about what you actually know versus what you are inferring. A caricature artist's ideal client is someone who is planning an event and actively looking for entertainment. Finding a venue that could hypothetically use the service is step one of ten. Do not score it like step ten.
