---
name: precrime-startup
description: Startup -- verify pipeline, detect mode, route to workflow.
triggers:
  - start
  - run precrime
  - go
  - wizard
  - workflow
  - headless
---

# Init Wizard

## Step 1: Pipeline status

```
precrime__pipeline({ action: "status" })
```

Error -> STOP. Say: `Pipeline not connected. Re-run launcher.`

## Step 1.5: Source table seed (always run, idempotent)

ALWAYS run this on every startup:

```
precrime__pipeline({ action: "import_sources" })
```

This reads every `_sources.md` and `discovered_directories.md` seed file and bulk-inserts new URLs into the Source table. Dedup is on URL, so re-running is cheap and safe. This is how the user adds new FB pages / RSS feeds / subreddits / IG handles between runs: they edit the relevant seed file, and Step 1.5 picks up the additions on the next launch.

Do NOT skip this step "because nothing changed" -- the agent has no reliable way to know if the user edited a seed file since last run. The cost (one query per seed file) is trivial.

Returns `{ byChannel: { directory:{added,duplicates,...}, rss:{...}, ... }, total_added, total_duplicates, total_invalid }`.

After Step 1.5, the agent uses `next_source` / `mark_source` / `add_sources` for the queue. Seed files are not consulted again during the run.

## Step 1.6: Mandatory Config gate (BLOCKING)

The runtime tools and drafting skills demand a minimum mirror of `DOCS/VALUE_PROP.md` inside SQLite `Config` (server/sync-config.js writes it at launch). Missing mandatory fields mean drafts will refuse to compose and `share_booking` may stall.

Mandatory fields:

- `companyName`
- `companyEmail`
- `businessDescription`
- `defaultTrade` (re-validated in Step 1.7)
- `leedzEmail` (defaults to `companyEmail` if missing)
- `signature` (literal outreach signature block)
- `defaultBookingAction`

Probe Config:

```
status = precrime__pipeline({ action: "status" })   // already have this
cfg    = status.config
```

For each mandatory field where `cfg[field]` is empty/null:

- **Interactive mode:** ask one direct question per missing field (no menu, no chitchat). For `signature`, ask `Paste the literal signature block for outreach emails (multi-line ok, ends on a blank line):`. For others, ask `<field> is empty in Config. Enter value:`. After collecting a value, write it: `precrime__pipeline({ action: "configure", patch: { <field>: <value> } })`. Re-probe `status` until every mandatory field is populated.
- **Headless mode:** do NOT prompt. STOP with: `CONFIG_INCOMPLETE: missing <comma-separated field names>. Edit DOCS/VALUE_PROP.md or call pipeline.configure to set these, then re-run.` Exit.

After Step 1.6 succeeds, Config has every mandatory mirror field. Drafting skills that need identity / signature MUST call `pipeline.get_config({ key })` rather than re-reading VALUE_PROP.md for those fields.

## Step 1.7: Trade gate (BLOCKING)

Trade is the marketplace category and the seed for demand-signal detection. The loop does not start until config has a `defaultTrade` that matches a canonical Leedz trade.

```
trades = precrime__trades()
status = precrime__pipeline({ action: "status" })   // already have this
cfg    = status.config
```

**A. Config already has a valid trade.** If `cfg.defaultTrade` is set AND `trades` contains it (case-insensitive exact match) -> proceed to Step 2.

**B. Infer from VALUE_PROP.** Read `DOCS/VALUE_PROP.md`. Lowercase the product name + description. For each trade in `trades`, check whether the trade name (or its singular form) appears as a substring.

- Exactly one match -> set it: `precrime__pipeline({ action: "configure", patch: { defaultTrade: "<trade>" } })`. Tell the user: `Trade inferred: <trade>`. Proceed.
- Zero matches OR multiple matches -> ambiguous. Go to C.

**C. Prompt (interactive only).** Show the user the candidate list (matches if any, else the full `trades` list trimmed to 20). Ask: `Which Leedz trade describes <product name>?` Wait for answer, validate the answer is in `trades`, then `configure` it.

**Headless mode:** if A and B both fail, STOP with `TRADE_UNRESOLVED: defaultTrade not set and inference ambiguous. Edit DOCS/VALUE_PROP.md to clarify, or set Config.defaultTrade.` No prompt.

After this step, `cfg.defaultTrade` is set and validated. Demand-signal detection and marketplace post both depend on it.

## Step 2: Greeting

From status:
- clients > 0 -> `Pre-Crime online -- X clients, Y ready, Z in queue.`
- clients = 0 -> `Pre-Crime online -- empty database.`

## Step 3: Mode detection

**If headless** (user message contained `headless`):
- Set mode = headless.
- Skip to Step 4. No questions.

**If interactive:** ask exactly this two-choice menu and nothing else:
```
What now?
  (1) SHOW_HOT_LEEDZ -- show already-judged leed_ready / outreach_ready bookings so you can share / email / skip per item.
  (2) RUN_WORKFLOW   -- full discovery + scrape + enrich + judge loop.
```
- Wait for answer. Do not present marketplace / outreach / hybrid sub-modes. Do not present any other menu.
- Answer "1" / "SHOW_HOT_LEEDZ" -> choice = `SHOW_HOT_LEEDZ`.
- Answer "2" / "RUN_WORKFLOW"   -> choice = `RUN_WORKFLOW`.

## Step 4: Route

- Mode = headless                   -> follow `__PROJECT_ROOT__/skills/headless_flow.md`.
- Mode = interactive, choice = `SHOW_HOT_LEEDZ`:
  1. `precrime__pipeline({ action: "plan_tasks", mode: "hot_only" })`
  2. Follow `__PROJECT_ROOT__/skills/show-hot-leedz.md`. Stop after one Task.
- Mode = interactive, choice = `RUN_WORKFLOW`:
  1. `precrime__pipeline({ action: "plan_tasks", mode: "workflow" })`
  2. Hand off to the worker skills (url-loop / enrichment-agent / apply-factlet) until queues are exhausted, then run `show-hot-leedz.md` against whatever the loop promoted.

## Rules

- Config (name, email, pitch, trade, bookingAction) is set by sync-config.js before goose launches. Never ask for it.
- If any config field is empty at Step 1, say: `Config incomplete. Fill in DOCS/VALUE_PROP.md and restart.` STOP.
- Never auto-launch. Wait for mode selection (interactive) or detect headless.
