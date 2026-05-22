---
name: {{DEPLOYMENT_NAME}}-enrichment
description: Enrich clients -- scrape intel, score, compose drafts for qualifying contacts
triggers:
  - run enrichment
  - enrich clients
  - run the enrichment workflow
---

# Enrichment Agent

Takes thin client records and enriches them with intelligence. This is the ENRICH function from `DOCS/FOUNDATION.md`. For each client: discover URLs, scrape them, extract signals, score, compose draft if qualified.

---

## Setup

1. **Use latched mode.** The caller already selected interactive or headless. If unset, default to interactive and do not run tree/session scans.
2. **Verify tools.** `precrime__pipeline({ action: "status" })` -- if this fails, STOP.
3. **Hold VALUE_PROP config** from the validated config object passed by init-wizard. Do not re-read VALUE_PROP.md.

---

## The Loop

### Step 0: Load Client

```
precrime__pipeline({ action: "next", criteria: {
  lastEnrichedBefore: "<ISO timestamp 30 days ago>"
}})
```

Always pass `lastEnrichedBefore`. Without it, the queue cycles through all clients forever instead of prioritizing new contacts.

- Returns nothing -> `QUEUE_EXHAUSTED`. Log it. Stop the loop.
- Returns client with `draftStatus === "sent"` -> skip. Log `SKIPPED_ALREADY_SENT`. Next client.
- Returns client with `lastEnriched` within 30 days AND `dossierScore >= 3` -> skip. Log `SKIPPED_FRESH`. Next client.

### Step 1: Factlet Check

```
precrime__find({ action: "factlets", filters: { clientId } })
```

Load linked factlets into context. Check for new factlets since `lastQueueCheck` and link relevant ones:

```
precrime__pipeline({ action: "save", id: clientId, patch: {
  factlets: [{ content, source, signalType: "pain"|"occasion"|"context" }],
  lastQueueCheck: new Date().toISOString()
}})
```

See `skills/shared/factlet-rules.md` for signal types and classification.

### Step 2: URL Discovery

If `targetUrls` is empty, find up to 5 URLs for the client: website, LinkedIn, Facebook, news, directory. Write them:

```
precrime__pipeline({ action: "save", id: clientId, patch: { targetUrls: JSON.stringify([...]) }})
```

### Step 2.5: Relationship Check

**One question: if this engagement happens, does the seller get paid -- or pay them?**

- **GET_PAID** (they hire the seller) -> proceed to Step 3.
- **VENDOR_OPPORTUNITY** (seller pays them for booth/vendor access) -> save `warmthScore: 0`, log `VENDOR_OPPORTUNITY`, skip to next client. Do not scrape or score.

### Step 3: Scrape + Intel Scoring

Scrape each URL in `targetUrls`. Use SESSION_AI (interactive) or Tavily (headless).

Extract signals relevant to VALUE_PROP config: pain points, buying occasions, org context.

**Intel Score (D2 + D3, max 7):**
- D2 Intel Depth: 0-3 (actionable content from sources scraped)
- D3 Direct Signals: 0-4 (explicit pain, buying occasion, org context, timing/geography)

For contacts found about OTHER people/orgs -> run `skills/shared/classify-contact.md`.
For broadly applicable intel -> follow `skills/shared/factlet-rules.md`.

### Step 3.5: Email Verification

If client email is generic (info@, contact@, etc.) or missing, invoke `skills/client-finder.md` with the client's name, company, and domain.

### Step 4: Score + Save

```
precrime__pipeline({ action: "save", id: clientId, patch: {
  dossier: "[appended findings]",
  intelScore: N,
  warmthScore: N,
  lastEnriched: new Date().toISOString()
}})
```

Scoring runs automatically. Check returned `canDraft` and `contactGate`.

### Step 5: Draft Gate

If `canDraft = true` AND `warmthScore >= 9` -> compose draft using `skills/outreach-drafter.md`. Save with `draftStatus: "ready"`.

Otherwise -> save with `draftStatus: "brewing"`. Note what's missing in dossier.

### Step 6: Next Client

Repeat from Step 0.

---

## Run Log

Write to `logs/ROUNDUP.md` as you go. Per client:
```
### Client: [name] -- [company]
- Score: contactGate=[PASS/FAIL] | intel=[N/7] | factlets=[N pts] | warmth=[N]
- Draft: [composed/skipped -- reason]
```
