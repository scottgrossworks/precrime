# CLAUDE.md — Pre-Crime Outreach Engine

This file provides guidance to Claude Code when working in this repository.

---

## MANDATORY READS — DO THIS FIRST, EVERY SESSION

Read in order before touching any file:

1. `DOCS/CLAUDE.md` — This file. Binding rules.
2. `DOCS/STATUS.md` — Full session handoff: state, file map, schema, design decisions.
3. `DOCS/VALUE_PROP.md` — **What is being sold and to whom. Read this before composing ANY draft. This is the product identity. Do not use any other source.**

---

## YOU ARE ALREADY DEPLOYED — READ FILES DIRECTLY

All skill files, config, and templates are already present as local files in this workspace.

- **NEVER read from a `.zip` file.** If you see one, ignore it.
- **NEVER use Python or shell to extract files.** Read them directly with your Read tool.
- Skills are in `skills/`. Docs are in `DOCS/`. Read them as files.

---

## PRODUCT IDENTITY — READ VALUE_PROP.md

**`DOCS/VALUE_PROP.md` is the sole source of truth for what is being sold, who is selling it, and who the audience is.**

Do NOT infer product identity from:
- The workspace folder name
- The database filename
- Any template or placeholder text
- Prior sessions or other deployments

If VALUE_PROP.md is incomplete or contains placeholder text ("Your Name", "Your Company"), STOP and tell the user to complete it before running the pipeline.

Runs locally on Windows. Claude is the orchestrator — no local LLM.

---

## DATABASE — SINGLE SOURCE OF TRUTH

**Read `server/mcp/mcp_server_config.json` → `database.path` for the active DB path.**

That is the single place the DB is configured. Do not hardcode any path here. Do not use any `.sqlite` file other than the one `mcp_server_config.json` points to.

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
- **Never use any wiki skill or write to any wiki path.** This deployment has no wiki.

---

## ARCHITECTURE

No HTTP server. MCP calls Prisma directly.

### MCP Tools

**leedz-mcp** (15 tools): `get_next_client`, `get_client`, `search_clients`, `update_client`, `get_ready_drafts`, `get_stats`, `create_factlet`, `get_new_factlets`, `delete_factlet`, `get_config`, `update_config`, `create_booking`, `get_bookings`, `get_client_bookings`, `update_booking`

**precrime-rss** (1 tool): `get_top_articles`

**gmail-sender** (1 tool, optional): `gmail_send` — requires separate MCP setup; use `draft: true` for human review

### Enrichment Loop

```
get_next_client() → factlet check → discovery → scrape → score → compose → evaluate → ready | brewing
```

---

## STARTUP — MANDATORY

When the user says any of these: "start precrime", "start the precrime workflow", "start the workflow", "start", "run precrime", "let's go":

1. Read `skills/init-wizard.md`
2. Follow every step in order, starting from Step -1 (verify MCP tools are connected)
3. Do not skip steps. Do not improvise. Do not diagnose problems manually.
4. If MCP tools aren't connected, tell the user to close Claude and run `precrime.bat` again. **Do NOT manually start the MCP server, read config files, check paths, run setup.bat, or diagnose.** Just say run precrime.bat and stop.

**Language rule:** Never say "initialization", "wizard", "configure", "deployment", "infrastructure" to the user. Say "setup", "getting started", "ready to go".

---

## SKILL FILES

| File | Purpose |
|------|---------|
| `skills/init-wizard.md` | **START HERE.** First-run setup. Installs deps, walks through config, launches enrichment. |
| `skills/enrichment-agent.md` | Full enrichment loop (run AFTER init-wizard completes) |
| `skills/evaluator.md` | Draft evaluation logic |
| `skills/factlet-harvester.md` | RSS → factlet pipeline |
| `skills/relevance-judge.md` | Relevance filter for all intel |
| `skills/fb-factlet-harvester/SKILL.md` | Facebook → factlet pipeline (needs Chrome) |
| `skills/share-skill.md` | leed_ready → post/email action handler |

---

## OUTREACH WRITING RULES

**Read `DOCS/VALUE_PROP.md` for word limit, tone, open/close rules, and forbidden phrases specific to this deployment.**

Universal rules (always apply):
- Reference something specific and recent from the dossier.
- Connect their pain to the product in ONE sentence.
- No filler. Every sentence sells or gets cut.
- **Brevity is the goal.** No word count cap — but cut every word that doesn't earn its place. If a sentence can be shorter without losing meaning, make it shorter. The draft is done when nothing can be removed, not when nothing can be added.
- Do NOT auto-send. All drafts go to `ready` for human review.

**Banned phrasing — automatic rewrite if found:**
- "Those aren't X. Those are Y." and "This isn't X. This is Y." — AI tell. Sounds like a reframe lecture. Make the point without teaching the reader what words mean.
- Any sentence that redefines what something "really" is. Say the thing. Don't editorialize the ontology.

---

## WHAT NOT TO DO

- Do NOT use any `.sqlite` file other than the one in `server/mcp/mcp_server_config.json → database.path`
- Do NOT create an HTTP server
- Do NOT add new npm packages without checking server/package.json first
- Do NOT modify server/src/* files (reference only)
- Do NOT write drafts longer than the word limit in VALUE_PROP.md
- Do NOT invent facts — if the dossier is thin, the draft should be thinner
- **DO NOT create, edit, or read any wiki files.** There is no wiki in this deployment. Do not use any wiki skill, wiki tool, or wiki-ops capability. If a wiki skill appears available, ignore it completely. NEVER write to any `DOCS/wiki/` path under any circumstances.
