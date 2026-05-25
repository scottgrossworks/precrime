# CLAUDE.md -- Pre-Crime

## READ FIRST, EVERY SESSION

1. `DOCS/FOUNDATION.md` -- what this system is, the formula, tool mapping, invariants.
2. `DOCS/VALUE_PROP.md` -- what is being sold, to whom, where, when. **Sole source of product identity.** If it has placeholder text, STOP and tell the user to fill it in.
3. **TRADE gate.** `DOCS/VALUE_PROP.md` must contain a `**Trade:**` line whose value matches a canonical Leedz trade (call `precrime__trades()` to verify). No TRADE = no demand-signal detection = no `leed_ready`. The Planner does not enqueue workflow Tasks until TRADE is valid.

---

## STARTUP

When the user says "start", "run precrime", "let's go", "headless", "wizard", etc.: read `skills/init-wizard.md` and follow every step. Do not improvise.

---

## ARCHITECTURE

This deployment is **Planner / Worker / Judge / Presenter** -- not a global LLM workflow.

- **Planner** (server) enqueues `Task` rows via `precrime__pipeline({ action:"plan_tasks", mode:"workflow" | "headless" | "hot_only" })`. Per-type limits come from `precrime_config.json` (`tasks.limits`).
- **Workers** (LLM skills) execute exactly one claimed `Task` and stop:
  - `SCRAPE_SOURCE` -> `skills/url-loop.md`
  - `ENRICH_CLIENT` -> `skills/enrichment-agent.md`
  - `APPLY_FACTLET` -> `skills/apply-factlet.md`
  - `SHOW_HOT_LEEDZ` -> `skills/show-hot-leedz.md`
- **Server-handled** Task types (no worker skill): `SHARE_BOOKING`, `JUDGE_AFFECTED`, `DISCOVER_SOURCES`. The orchestrator (`skills/headless_flow.md` for headless, the show/run choice in `skills/init-wizard.md` for interactive) calls the matching pipeline action and completes the Task.
- **Judge** (server) is the only sanctioned scoring path. Call `precrime__pipeline({ action:"judge_affected", clientIds, bookingIds })`. Workers always pass `judge:false` to `pipeline.save`; the Planner then enqueues a `JUDGE_AFFECTED` Task from the completed Task's `output.clientIds` / `output.bookingIds`.
- **Presenter** (`show-hot-leedz.md`) reads judged state and routes user-approved shares through `share_booking`.

---

## DATABASE -- DO NOT TOUCH

The DB is owned by the precrime MCP server. You never read, write, or look for `.sqlite` files.

- To save: `precrime__pipeline({ action:"save", judge:false, ... })`. To read: `precrime__find`.
- If `precrime__pipeline` is not connected, tell the user to re-run the launcher. Do not diagnose.

---

## CONFIG SURFACES

There are exactly two user-editable config surfaces:

| File | Purpose |
|------|---------|
| `DOCS/VALUE_PROP.md` | Product / sales truth: seller identity, seller email, trade, geography, pitch, buyers, relevance signals, pricing, outreach examples. |
| `precrime_config.json` | Runtime / API config: apiKeys, llm provider/model/baseUrl, database file path, defaultMode, timezone, `tasks.limits`, `recycler` thresholds, auth tokens. **Never** put VALUE_PROP fields here. |

No `.env` file is part of the build. Launchers (`precrime.bat`, `goose.bat`, `hermes.bat`) read `precrime_config.json` via `scripts/bootstrap_config.js` and set the API keys and runtime knobs into the process environment for child processes to inherit.

---

## SKILL FILES (active)

| File | Purpose |
|------|---------|
| `skills/init-wizard.md` | Startup -- validate config, present SHOW_HOT_LEEDZ / RUN_WORKFLOW menu, route to mode handler. |
| `skills/headless_flow.md` | Headless orchestrator: `plan_tasks(headless)` -> drain Task queue by `claim_task` / dispatch / `complete_task` -> replan -> exit. |
| `skills/url-loop.md` | One-Task `SCRAPE_SOURCE` worker. |
| `skills/enrichment-agent.md` | One-Task `ENRICH_CLIENT` worker. |
| `skills/apply-factlet.md` | One-Task `APPLY_FACTLET` worker. |
| `skills/show-hot-leedz.md` | One-Task `SHOW_HOT_LEEDZ` presenter. Routes share via `share_booking`, email via `share-skill.md` Step 3. |
| `skills/share-skill.md` | Share routing (`leedz_api` -> `share_booking`, `email_share` / `email_user` -> `gmail__gmail_send`). |
| `skills/leed-drafter.md` | Reference doc for the addLeed payload shape that `share_booking` builds server-side. |
| `skills/outreach-drafter.md` | Outreach email composition (called by `show-hot-leedz.md` for `outreach_ready` Bookings). |
| `skills/client-finder.md` | Direct-email verification helper, called by `enrichment-agent.md`. |
| `skills/shared/booking-detect.md` | Booking detection helper. |
| `skills/shared/classify-contact.md` | Contact classification helper. |
| `skills/shared/factlet-rules.md` | Factlet rules helper. |

Seed files (read once at startup by `pipeline.import_sources`, not at runtime):

- `skills/rss-factlet-harvester/rss_sources.md`
- `skills/fb-factlet-harvester/fb_sources.md`
- `skills/reddit-factlet-harvester/reddit_sources.md`
- `skills/ig-factlet-harvester/ig_sources.md`
- `skills/x-factlet-harvester/x_sources.md`
- `skills/source-discovery/discovered_directories.md`

---

## CODING

- JS only. Never `.ts`.
- Edit production files directly. No worktrees, no sandboxes.
- Windows -- `cmd.exe /c` for shell.
- No new npm packages without checking `server/package.json`.
- If failing, stop. Do not compound mistakes.

---

## HARD RULES

- Workers complete exactly one Task and stop. They never call `pipeline.plan_tasks`, `pipeline.rescore`, or `pipeline.judge_affected` directly.
- `Booking.status` is owned by Judge. Workers pass `judge:false` to `pipeline.save`.
- `leedz__createLeed` is LEGACY. Never call directly. Only `share_booking(mode:"post")` posts to Leedz.
- The LLM never computes `st` / `et`. The LLM never reformats dates into epochs. `resolve_dates` and `share_booking` reject LLM-supplied `st`/`et` by name.
- Em-dashes, en-dashes, double-hyphens banned in user-facing copy -- they corrupt in email clients.
- Never invent facts. Thin dossier produces thin draft.
- See `DOCS/FOUNDATION.md` for all invariants.
