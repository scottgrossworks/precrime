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

**A. Explicit VALUE_PROP trade wins.** Read `DOCS/VALUE_PROP.md` first and parse the `**Trade:**` line. If it exactly matches one canonical trade (case-insensitive), call:

```
precrime__pipeline({ action: "configure", patch: { defaultTrade: "<trade-from-VALUE_PROP>" } })
```

Then proceed to Step 2. Do this even when Config already has a different valid trade. Config is only a mirror; stale Config must never outrank `VALUE_PROP`.

**B. Config already has a valid trade.** If `cfg.defaultTrade` is set AND `trades` contains it (case-insensitive exact match) -> proceed to Step 2.

**C. Infer from VALUE_PROP.** Lowercase only the product name, `**Trade:**` value, and `**Seller:**` line. For each trade in `trades`, check whether the trade name (or its singular form) appears as a substring. Do not scan relevance examples or body text; they may mention adjacent trades.

- Exactly one match -> set it: `precrime__pipeline({ action: "configure", patch: { defaultTrade: "<trade>" } })`. Tell the user: `Trade inferred: <trade>`. Proceed.
- Zero matches OR multiple matches -> ambiguous. Go to D.

**D. Prompt (interactive only).** Show the user the candidate list (matches if any, else the full `trades` list trimmed to 20). Ask: `Which Leedz trade describes <product name>?` Wait for answer, validate the answer is in `trades`, then `configure` it.

**Headless mode:** if A, B, and C all fail, STOP with `TRADE_UNRESOLVED: defaultTrade not set and inference ambiguous. Edit DOCS/VALUE_PROP.md to clarify, or set Config.defaultTrade.` No prompt.

After this step, `cfg.defaultTrade` is set and validated. Demand-signal detection and marketplace post both depend on it.

## Step 2: Greeting

From status, read the booking counts keyed `cold` / `brewing` / `hot` / `shared`:
- clients > 0 -> `Pre-Crime online -- X clients, Y hot, Z in queue.`
- clients = 0 -> `Pre-Crime online -- empty database.`

## Step 3: Mode + objective detection

Pre-Crime has TWO axes -- detect each from the launcher prompt and env:

**Mode** (`headless` | `interactive`):
- If the startup prompt contains the token `headless` OR `PRECRIME_RUN_MODE` env equals `headless` -> mode = `headless`.
- Otherwise -> mode = `interactive`.

**Objective** (`marketplace` | `outreach` | `hybrid`):
1. If the prompt contains `objective=<value>` with value in `{marketplace, outreach, hybrid}`, use that value.
2. Otherwise if the prompt contains `--marketplace`, `--outreach`, or `--hybrid`, use the matching value.
3. Otherwise if `PRECRIME_OBJECTIVE` env is set to one of those values, use that.
4. Otherwise apply the default: `headless` -> `marketplace`; `interactive` -> `hybrid`.

If the prompt names something OTHER than these three values, STOP with `INVALID_OBJECTIVE: <value>. Expected one of: marketplace, outreach, hybrid.`

### Headless Gmail gate (BLOCKING)

If mode = `headless` AND objective is `outreach` or `hybrid`:
- Verify the Gmail MCP is registered by attempting a probe (e.g. check that the `gmail__gmail_send` tool name is in your available tool surface). Do NOT actually send mail here; just verify the tool exists.
- If unavailable, STOP immediately with: `OUTREACH_REQUIRES_GMAIL: objective=<objective> needs gmail__gmail_send. Register the Gmail MCP server or re-run with --marketplace.` No fallback, no downgrade.

### Interactive menu

If mode = `interactive`, present exactly this two-choice menu and nothing else (objective is already latched; do NOT re-ask for marketplace/outreach/hybrid):

```
What now?
  (1) SHOW_HOT_LEEDZ -- show already-judged hot bookings so you can share / email / skip per item.
  (2) RUN_WORKFLOW   -- full discovery + scrape + enrich + judge loop.
```

- Answer "1" / "SHOW_HOT_LEEDZ" -> choice = `SHOW_HOT_LEEDZ`.
- Answer "2" / "RUN_WORKFLOW"   -> choice = `RUN_WORKFLOW`.

In headless mode, skip the menu entirely.

## Step 4: Route

Pass `objective` to every `plan_tasks` call.

- Mode = headless -> follow `__PROJECT_ROOT__/skills/headless_flow.md` with `objective=<resolved value>`.
- Mode = interactive, choice = `SHOW_HOT_LEEDZ`:
  1. `precrime__pipeline({ action: "plan_tasks", mode: "hot_only", objective: "<resolved>" })`
  2. `precrime__pipeline({ action: "claim_task", role: "interactive-orchestrator", types: ["SHOW_HOT_LEEDZ"] })`
  3. If `CLAIMED`, pass the returned Task packet to `__PROJECT_ROOT__/skills/show-hot-leedz.md`. The presenter must complete that exact `task.id`. Stop after one Task.
- Mode = interactive, choice = `RUN_WORKFLOW`:
  1. `precrime__pipeline({ action: "plan_tasks", mode: "workflow", objective: "<resolved>" })`
  2. Respect the returned `workflowStrategy`: `consume_factlets` means prioritize apply-factlet / judge work and do not chase new discovery until the backlog drops; `discover_sources` means factlets are sparse enough to gather more evidence.
  3. **Explicit heartbeat loop.** The Planner owns ordering; you are the executor. Repeat the cycle below until exit:
     1. `precrime__pipeline({ action: "claim_task", role: "interactive-orchestrator" })`.
     2. `NO_TASK` -> go to step 4 (replan).
     3. `CLAIMED` -> dispatch by `task.type` to exactly one handler:
        - `APPLY_FACTLET`  -> pass the claimed Task packet to `__PROJECT_ROOT__/skills/apply-factlet.md`
        - `ENRICH_CLIENT`  -> pass the claimed Task packet to `__PROJECT_ROOT__/skills/enrichment-agent.md`
        - `SCRAPE_SOURCE`  -> route by `task.input.channel` (interactive has the browser MCP): `fb` -> `__PROJECT_ROOT__/skills/fb-factlet-harvester/SKILL.md`, `ig` -> `__PROJECT_ROOT__/skills/ig-factlet-harvester/SKILL.md`, `x` -> `__PROJECT_ROOT__/skills/x-factlet-harvester/SKILL.md`, all others -> `__PROJECT_ROOT__/skills/url-loop.md`
        - `DRAFT_OUTREACH` -> pass the claimed Task packet to `__PROJECT_ROOT__/skills/outreach-drafter.md`
        - `SHOW_HOT_LEEDZ` -> pass the claimed Task packet to `__PROJECT_ROOT__/skills/show-hot-leedz.md`
        - `JUDGE_AFFECTED` -> call `pipeline.judge_affected({ clientIds, bookingIds, session_id })` inline, then `complete_task`.
        - `SHARE_BOOKING`  -> call `pipeline.share_booking({ bookingId, mode:"post" })` inline (only if objective allows marketplace), then `complete_task`.
        - `DISCOVER_SOURCES` -> peer table first: read `DOCS/PEER_SOURCES.json`, enqueue `sources[]` of every `peers[]` entry whose `match[]` hits your trade/segments (`discoveredFrom:"peer-table"`); only if nothing matches, run one bounded discovery search. `pipeline.add_sources`, then `complete_task`.
        Worker skills receive the already-claimed Task packet and call `complete_task` themselves. They MUST NOT call `claim_task`. Inline handlers MUST call `complete_task` after the action returns.
     4. After `NO_TASK` from claim, `precrime__pipeline({ action: "plan_tasks", mode: "workflow", objective: "<resolved>" })` again. Exit when this replan creates ZERO Tasks AND the previous drain claimed ZERO Tasks. Otherwise resume the cycle.
  4. Do NOT preload every worker skill on every heartbeat -- load only the skill that matches the claimed `task.type`. Do NOT decide workflow order yourself; the Planner already chose.

## Rules

- Config (name, email, pitch, trade, bookingAction) is set by sync-config.js before goose launches. Never ask for it.
- If any config field is empty at Step 1, say: `Config incomplete. Fill in DOCS/VALUE_PROP.md and restart.` STOP.
- Never auto-launch. Wait for mode selection (interactive) or detect headless.
