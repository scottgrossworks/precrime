# CLAUDE.md -- Pre-Crime

## READ FIRST, EVERY SESSION

1. `DOCS/FOUNDATION.md` -- what this system is, the formula, tool mapping, invariants
2. `DOCS/VALUE_PROP.md` -- what's being sold, to whom, where, when. **Sole source of product identity.** If it has placeholder text, STOP and tell the user to fill it in.
3. **TRADE gate.** VALUE_PROP must contain a `**Trade:**` line whose value matches a canonical Leedz trade (call `precrime__trades()` to verify). No TRADE = no demand-signal detection = no leed_ready. Pipeline does not start the loop until TRADE is valid.

---

## STARTUP

When the user says "start", "run precrime", "let's go": read `skills/init-wizard.md` and follow every step. Do not improvise.

---

## DATABASE -- DO NOT TOUCH

The DB is owned by the precrime MCP server. You never read, write, or look for `.sqlite` files.

- To save: `precrime__pipeline action="save"`. To read: `precrime__find`.
- If `precrime__pipeline` is not connected, tell the user to re-run the launcher. Do not diagnose.

---

## SKILL FILES

| File | Purpose |
|------|---------|
| `skills/init-wizard.md` | Startup -- validate config, show menu |
| `skills/value-prop-validator.md` | Validate VALUE_PROP.md mandatory fields |
| `skills/marketplace_flow.md` | Full workflow -- discover, harvest, enrich, share |
| `skills/outreach_flow.md` | Outreach pipeline -- compose and send emails |
| `skills/enrichment-agent.md` | Enrich clients with intel and scoring |
| `skills/client-seeder.md` | Scrape sources for new contacts |
| `skills/source-discovery.md` | Find new source channels |
| `skills/share-skill.md` | Post leedz to marketplace |
| `skills/shared/` | Reusable modules (classify-contact, factlet-rules, booking-detect) |

---

## CODING

- JS only. Never `.ts`.
- Edit production files directly. No worktrees, no sandboxes.
- Windows -- `cmd.exe /c` for shell.
- No new npm packages without checking `server/package.json`.
- If failing, stop. Don't compound mistakes.

---

## HARD RULES

- Drafts never auto-send. They land at `draftStatus = ready` for human review.
- Em-dashes, en-dashes, double-hyphens banned -- they corrupt in email clients.
- Never invent facts. Thin dossier produces thin draft.
- Never argue with the user.
- See `DOCS/FOUNDATION.md` for all invariants.
