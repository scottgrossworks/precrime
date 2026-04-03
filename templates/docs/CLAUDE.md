# CLAUDE.md — {{DEPLOYMENT_NAME}}

This file provides guidance to Claude Code when working in this repository.

---

## MANDATORY READS — DO THIS FIRST, EVERY SESSION

Read in order before touching any file:

1. `DOCS/CLAUDE.md` — This file. Binding rules.
2. `DOCS/STATUS.md` — Full session handoff: state, file map, schema, design decisions.
3. `DOCS/VALUE_PROP.md` — What is being sold and to whom. Read before composing any draft.

---

## PROJECT: {{DEPLOYMENT_NAME}}

Contextual outreach engine for **{{SELLER_COMPANY}}** ({{SELLER_NAME}}).
Product being sold: **{{PRODUCT_NAME}}** — {{PRODUCT_DESCRIPTION}}
Target audience: {{AUDIENCE_DESCRIPTION}}
Geography: {{GEOGRAPHY}}

Runs locally on Windows. Claude is the orchestrator — no local LLM.

---

## DATABASE — SINGLE SOURCE OF TRUTH

**`{{DB_ABS_PATH}}`**

DO NOT use any other .sqlite file.

Key columns: `dossier`, `targetUrls`, `draft`, `draftStatus`, `warmthScore`, `lastEnriched`, `lastQueueCheck`, `segment`

`draftStatus` values: `"brewing"` | `"ready"` | `"sent"`

---

## BINDING RULES

- **Read before writing.** No assumptions. READ THE CODE.
- **JS only.** No TypeScript. Never search for or read `.ts` files.
- **Edit production files directly.** Never use worktrees or sandboxes.
- **Minimal code.** Do not refactor outside your mandate.
- **No Docker, no build systems, no new frameworks.**
- **Windows environment.** Use `cmd.exe /c` for shell commands where needed.
- When the user gives a full file path, USE IT VERBATIM.
- If you say you'll do something, DO IT in the same response.
- If failing, STOP. Don't compound mistakes with more attempts.
- Never argue with or contradict the user.

---

## ARCHITECTURE

No HTTP server. MCP calls Prisma directly.

### MCP Tools

**leedz-mcp** (15 tools): `get_next_client`, `get_client`, `search_clients`, `update_client`, `get_ready_drafts`, `get_stats`, `create_factlet`, `get_new_factlets`, `delete_factlet`, `get_config`, `update_config`, `create_booking`, `get_bookings`, `get_client_bookings`, `update_booking`

**bloomleedz-rss** (1 tool): `get_top_articles`

**gmail-sender** (1 tool): `gmail_send` — use `draft: true` for human review

### Enrichment Loop

```
get_next_client() → factlet check → discovery → scrape → score → compose → evaluate → ready | brewing
```

---

## SKILL FILES

| File | Purpose |
|------|---------|
| `skills/enrichment-agent.md` | Full enrichment loop |
| `skills/evaluator.md` | Draft evaluation logic |
| `skills/factlet-harvester.md` | RSS → factlet pipeline |
| `skills/relevance-judge.md` | Relevance filter for all intel |
| `skills/fb-factlet-harvester/SKILL.md` | Facebook → factlet pipeline (needs Chrome) |
| `skills/init-wizard.md` | First-run setup wizard (say "initialize this deployment") |
| `skills/share-skill.md` | leed_ready → post/email action handler |

---

## OUTREACH WRITING RULES

- Max **{{OUTREACH_MAX_WORDS}} words**.
- Tone: {{OUTREACH_TONE}}
- Open: {{OUTREACH_OPEN_RULE}}
- Close: {{OUTREACH_CLOSE_RULE}}
- Reference something specific and recent from the dossier.
- Connect their pain to {{PRODUCT_NAME}} in ONE sentence.
- No filler. Every sentence sells or gets cut.
- Do NOT auto-send. All drafts go to `ready` for human review.

Forbidden phrases:
{{OUTREACH_FORBIDDEN}}

---

## WHAT NOT TO DO

- Do NOT use any `.sqlite` file other than the one listed above
- Do NOT create an HTTP server
- Do NOT add new npm packages without checking server/package.json first
- Do NOT modify server/src/* files (reference only)
- Do NOT write drafts longer than {{OUTREACH_MAX_WORDS}} words
- Do NOT invent facts — if the dossier is thin, the draft should be thinner
