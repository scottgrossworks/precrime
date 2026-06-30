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

## Step 1.5: Sources (no action needed)

Source lists are the single source of truth in `data/sources/<channel>.md` and are
loaded into the server's in-memory index automatically at startup -- there is NO
import step. The user adds sources by editing `data/sources/<channel>.md` (one URL
per line) between runs; the server picks them up on the next launch. At runtime,
`DISCOVER_SOURCES` and scrape-time recursion grow the list via `add_sources` (the
server is the sole writer). Nothing to run here -- proceed.

Returns `{ byChannel: { directory:{added,duplicates,...}, rss:{...}, ... }, total_added, total_duplicates, total_invalid }`.

After Step 1.5, the agent uses `next_source` / `mark_source` / `add_sources` for the queue. Seed files are not consulted again during the run.

## Step 1.6: Mandatory Config gate (BLOCKING)

Runtime config is built in-memory by the MCP server at startup from `DOCS/VALUE_PROP.md` (identity) and `precrime_config.json` (LLM/runtime). There is no writable Config table: the wizard can READ config but cannot set it. The only way to fix a missing field is to edit the source file and restart. Missing mandatory fields mean drafts will refuse to compose and `share_booking` may stall.

Mandatory fields (all sourced from `DOCS/VALUE_PROP.md`):

- `companyName` (VALUE_PROP `**Seller:**`)
- `companyEmail` (VALUE_PROP `**Email:**`)
- `businessDescription` (VALUE_PROP `## THE PITCH`)
- `defaultTrade` (VALUE_PROP `**Trade:**` -- re-validated in Step 1.7)
- `signature` (VALUE_PROP signature heading)
- (`leedzEmail` auto-defaults to `companyEmail`; `defaultBookingAction` is fixed to `leedz_api` -- not user-entered)

Probe config:

```
status = precrime__pipeline({ action: "status" })   // already have this
cfg    = status.config
```

If any mandatory field in `cfg` is empty/null:

- **Both modes:** do NOT try to write it -- `configure` is retired. STOP with: `CONFIG_INCOMPLETE: missing <comma-separated field names>. Fill the matching markers in DOCS/VALUE_PROP.md (Seller / Email / THE PITCH / Trade / signature heading) and restart.` Exit.

Drafting skills that need identity / signature call `pipeline.get_config({ key })` (served from the in-memory config), not re-reading VALUE_PROP.md for those fields.

## Step 1.7: Trade gate (BLOCKING)

Trade is the marketplace category and the seed for demand-signal detection. The server matches `**Trade:**` from VALUE_PROP.md against the canonical Leedz list at startup, in-memory. The wizard only validates; it cannot set the trade (edit VALUE_PROP.md + restart to change it).

```
trades = precrime__trades()
status = precrime__pipeline({ action: "status" })   // already have this
cfg    = status.config
```

- **Valid trade -> proceed.** If `cfg.defaultTrade` is set AND `trades` contains it (case-insensitive exact match) -> proceed to Step 2.
- **Otherwise STOP (both modes):** `TRADE_UNRESOLVED: defaultTrade not set or not a canonical Leedz trade. Set **Trade:** in DOCS/VALUE_PROP.md to one of the canonical trades (see precrime__trades()), then restart.` No prompt, no configure.

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

### Interactive choice

The launcher (`goose.bat` / `precrime.bat`) prints the startup menu itself and bakes the
user's pick into the trigger prompt as `choice=workflow` or `choice=hot`. Read it from the prompt:

- prompt contains `choice=workflow` -> choice = `RUN_WORKFLOW`.
- prompt contains `choice=hot`      -> choice = `SHOW_HOT_LEEDZ`.

When `choice=` is present, do NOT print your own menu — the launcher already showed it. Just route.

ONLY if mode = `interactive` AND there is no `choice=` token in the prompt (a launcher that
didn't pre-select), present this two-choice menu and read the reply:

```
What now?
  (1) SHOW_HOT_LEEDZ -- show already-judged hot bookings so you can share / email / skip per item.
  (2) RUN_WORKFLOW   -- full discovery + scrape + enrich + judge loop.
```

- "1" / "SHOW_HOT_LEEDZ" -> choice = `SHOW_HOT_LEEDZ`; "2" / "RUN_WORKFLOW" -> choice = `RUN_WORKFLOW`.

In headless mode, skip the menu entirely.

## Step 4: Route

Pass `objective` to every `plan_tasks` call.

- Mode = headless -> follow `skills/headless_flow.md` with `objective=<resolved value>`.
- Mode = interactive, choice = `SHOW_HOT_LEEDZ`:
  1. `precrime__pipeline({ action: "plan_tasks", mode: "hot_only", objective: "<resolved>" })`
  2. `precrime__pipeline({ action: "claim_task", role: "interactive-orchestrator", types: ["SHOW_HOT_LEEDZ"] })`
  3. If `CLAIMED`, pass the returned Task packet to `skills/show-hot-leedz.md`. The presenter must complete that exact `task.id`. Stop after one Task.
- Mode = interactive, choice = `RUN_WORKFLOW`:
  1. `precrime__pipeline({ action: "plan_tasks", mode: "workflow", objective: "<resolved>" })`
  2. Note the returned `workflowStrategy` for the user (inform them whether the run will prioritize factlet processing or source discovery).
  3. Exit. The conductor (Node.js loop inside `mcp_server.js`) owns all Task dispatch from this point. Do NOT call `claim_task`. Do NOT dispatch worker skills. Do NOT poll or loop. The conductor claims Tasks, spawns one-shot workers, and marks them done -- without your involvement.
  4. Inform the user: "Queue seeded. The conductor is running. Call `report_session` when you want a summary."

## Rules

- Config (name, email, pitch, trade, bookingAction) is built in-memory at MCP startup from DOCS/VALUE_PROP.md + precrime_config.json. It is read-only at runtime. Never ask for it and never try to `configure` it.
- If any config field is empty at Step 1, say: `Config incomplete. Fill in DOCS/VALUE_PROP.md and restart.` STOP.
- Never auto-launch. Wait for mode selection (interactive) or detect headless.
