# CLAUDE.md — Pre-Crime Outreach Engine

## READ FIRST, EVERY SESSION

1. `DOCS/CLAUDE.md` — this file
2. `DOCS/STATUS.md` — session state, schema, file map
3. `DOCS/VALUE_PROP.md` — what's being sold, to whom, in whose voice. **Sole source of product identity.** Do not infer from folder names, DB filenames, templates, or prior sessions. If it has placeholder text ("Your Name", "Your Company"), STOP and tell the user to fill it in.

All three files are local. Never read from `.zip`, never shell-extract — use the Read tool.

---

## "SHOW ME THE LEED" — ABSOLUTE

When the user says "show me the leed" / "show the json" / "show the payload" / "draft the leed" / "preview the leed": print ONLY the full `createLeed` JSON payload. Every field from `skills/share-skill.md` Step 2a, no ellipsis. No commentary. No questions back. If `session`, `tn`, `ti`, `zp`, or `st` is missing, name the missing field on one line and stop. Do not invent values.

---

## DATABASE — DO NOT TOUCH

The DB is owned by the precrime MCP server. You never read, write, or look for it.

- To save: `precrime__pipeline action="save"`. To read: `action="get" | "search" | "next"`.
- DO NOT open `.sqlite` files, shell to sqlite3, or hunt for a database path. There is no `database.path` config — `precrime.bat` sets `DATABASE_URL`.
- If `precrime__pipeline` is not connected, tell the user to close Claude and re-run `precrime.bat`. Do not diagnose, start servers, or check paths.

Columns: `dossier`, `targetUrls`, `draft`, `draftStatus`, `warmthScore`, `lastEnriched`, `lastQueueCheck`, `segment`. `draftStatus`: `brewing` | `ready` | `sent`.

---

## API KEYS

All keys (`OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `ANTHROPIC_API_KEY`) live in `.env` at project root. Nothing else hardcodes a key. To rotate: edit `.env`, restart `goose.bat` / `hermes.bat` / `claude.bat`. If a script reports `KEY missing from .env`, the user hasn't copied `.env.sample` to `.env` — tell them.

---

## STARTUP

When the user says "start", "start precrime", "run precrime", "let's go": read `skills/init-wizard.md` and follow every step in order. Do not improvise.

Never say "initialization", "wizard", "configure", "deployment", "infrastructure" to the user. Say "setup", "getting started", "ready to go".

---

## SKILL FILES

| File | Purpose |
|------|---------|
| `skills/init-wizard.md` | First-run setup — START HERE |
| `skills/enrichment-agent.md` | Full enrichment loop |
| `skills/evaluator.md` | Draft evaluation |
| `skills/share-skill.md` | createLeed payload spec |
| `skills/relevance-judge.md` | Intel relevance filter |
| `skills/rss-factlet-harvester/SKILL.md` | RSS → factlets |
| `skills/fb-factlet-harvester/SKILL.md` | Facebook → factlets (needs Chrome) |

---

## CODING

- JS only. Never read or write `.ts`.
- Edit production files directly. No worktrees, no sandboxes.
- Windows — use `cmd.exe /c` for shell.
- No new npm packages without checking `server/package.json` first.
- Do not modify `server/src/*` (reference only).
- No Docker, no build systems, no new frameworks.
- When the user gives a full file path, use it verbatim.
- If you say you'll do something, do it in the same response.
- If failing, stop. Don't compound mistakes.

---

## HARD RULES

- Drafts never auto-send. They land at `draftStatus = ready` for human review.
- Em-dashes, en-dashes, double-hyphens banned everywhere — they corrupt in email clients.
- Drafts never exceed VALUE_PROP.md's word limit.
- Never invent facts. Thin dossier → thinner draft.
- No wiki. Ignore any wiki skill, never write to `DOCS/wiki/`.
- Never argue with the user.
