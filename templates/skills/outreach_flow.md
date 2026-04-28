---
name: outreach-flow
description: Outreach mode pipeline. Compose outreach emails to high-probability-of-conversion clients enriched against VALUE_PROP.md.
triggers:
  - run outreach
  - outreach mode
  - run precrime outreach
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# Outreach Flow

## Goal

Compose outreach emails ONLY to clients whose Bookings score `draftReady: true` per `DOCS/SCORING.md`. Same scoring as marketplace mode — different terminal action (email instead of marketplace post).

**Out of scope (do not do here):**
- Sharing leedz to marketplace — see `skills/marketplace_flow.md`
- Tuning scoring weights — see `DOCS/SCORING.md`
- Drafting for low-scoring clients — the score is the gate

**Email send dependency:** sending requires the `gmail-sender` MCP server (configured separately). If not installed: drafts still get composed and saved as `draftStatus: "ready"`, but cannot be sent.

---

## Hard Gates (every draft)

| Gate | Rule |
|------|------|
| Booking draftReady | Comes from `precrime__pipeline({ action: "next" })` scoring only |
| Salutation | Must open `Dear {client.name},` on its own line |
| Banned chars | No em-dash, en-dash, `--`, smart quotes |
| Forbidden phrases | Per `DOCS/VALUE_PROP.md` |
| Word limit | Per `DOCS/VALUE_PROP.md` |
| Closing line | Exact text from `DOCS/VALUE_PROP.md` |

---

## Pipeline

Run sequentially. On step error, log and continue. Per-step cap: 20 min.

1. **`skills/source-discovery.md`** — expand sources from VALUE_PROP.md + seeds.
2. **All enabled `skills/*-factlet-harvester/SKILL.md`** per Config.
3. **`skills/client-seeder.md`** — find named contacts.
4. **`skills/enrichment-agent.md`** — link factlets, extract Bookings.
5. **For each Booking with `status = "new"`:**
   ```
   precrime__pipeline({ action: "next", id: bookingId })
   ```
   Read `draftReady` from response.
6. **If `draftReady = true`:**
   1. `skills/outreach-drafter.md` — compose email from VALUE_PROP.md voice + linked factlets + booking context.
   2. `skills/draft-checker.md` with `mode: outreach` — quality check the draft.
   3. If verdict = `brewing` → mark `draftStatus: "brewing"`, save reason, continue.
   4. If verdict = `ready` → save draft, mark `draftStatus: "ready"`, proceed to step 7.
7. **Mode branch:**
   - **Interactive:** print draft, ask `send / hold / edit`. On `hold` → leave `draftStatus: "ready"` for later. On `edit` → loop. On `send` → step 8.
   - **Headless:** mark `draftStatus: "ready"` and stop. Headless mode does NOT auto-send. Sending requires user oversight.
8. **Send via gmail-sender MCP:**
   ```
   mcp__gmail-sender__gmail_send({ to: client.email, subject, body, draft: false })
   ```
   If gmail-sender MCP is missing: log `NO_EMAIL_CONFIG`, leave `draftStatus: "ready"`, continue.
9. **On send success:**
   ```
   precrime__pipeline({ action: "save", id: client.id, patch: { draftStatus: "sent", sentAt: Date.now() } })
   ```
10. **On send error:** save draft to `logs/ROUNDUP.md`, log error, leave `draftStatus: "ready"` (preserves work). Continue to next client.

---

## Logging — `logs/ROUNDUP.md`

```
SENT: {client.name} / {trade} / {startDate}
READY: {client.name} → awaiting send
BREWING: {client.name} → {draft-checker reason}
ERROR: {step} → {message}
```

---

## Rules

1. **`pipeline.next` draftReady is the only draft gate.** Do not invent gates.
2. **A draft must cite ≥1 fresh relevant factlet.** Drafter refuses otherwise.
3. **Drafts never auto-send.** Interactive confirms; headless does not send at all.
4. **On send error, continue.** Stop only the affected client, not the whole workflow.
