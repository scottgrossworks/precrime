# PRECRIME Architecture Redesign Implementation Spec

Reference article: https://cursor.com/blog/scaling-agents

## Goal

Redesign PRECRIME so the LLM is no longer responsible for understanding and steering the whole workflow.

The new architecture is:

```text
Planner = procedural MCP code that creates Tasks
Worker = LLM skill that executes one Task
Judge = procedural scoring/date/share gatekeeper
Presenter = shows or acts on judged results
Session = audit container for one run
```

The core PRECRIME behavior must remain:

- Recursive discovery: while finding Sources, Clients, Bookings, and Factlets, the system may discover more Sources, Clients, Bookings, and Factlets.
- Promotion by score: marketplace-ready and outreach-ready items are promoted only by Judge/scoring code.
- Interactive mode: user chooses whether to show hot leedz or run the workflow.
- Headless mode: process hot items first, then run workflow automatically.
- Date safety: no LLM-computed marketplace epochs.
- Enrichment: Clients accumulate a useful running dossier from searches, bookings, and reusable Factlets.
- Bounded recursion: one run may discover unlimited future inputs, but it may only execute work up to its Session budgets. Leftover Sources, Clients, Factlets, and Bookings stay in SQLite for the next run.

## How We Know It Works

The implementation solves the problem when all of these are true:

1. A run can start, create Tasks, claim Tasks, complete Tasks, judge affected records, and continue without the LLM choosing the global strategy.
2. Worker prompts are one-job prompts. A `SCRAPE_SOURCE` worker does not need the whole marketplace flow. An `ENRICH_CLIENT` worker does not need the whole discovery loop.
3. Multiple workers can safely claim different ready Tasks without duplicate work on the same target.
4. Interactive startup asks only:
   - `SHOW_HOT_LEEDZ`
   - `RUN_WORKFLOW`
5. Headless startup handles existing hot work first, then runs the workflow.
6. `share_booking` is the only marketplace posting path. Direct `leedz__createLeed` from skills is removed or blocked.
7. `resolve_dates` accepts structured date fields and returns the only valid `st` and `et`.
8. `APPLY_FACTLET` can assimilate live Factlets into Client dossiers without using a complicated factlet graph.
9. `recycler` runs at startup and removes stale Factlets and old finished Tasks using configurable retention.
10. Session reports summarize actual Task outcomes from SQLite, not LLM narration.
11. A Session closes deterministically when Planner creates no new Tasks and no ready/claimed Tasks remain for that Session, or when its Session-wide budgets are exhausted.

## Existing Source Files

A fresh coding agent should read these first:

- `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\FOUNDATION.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\SCORING.json`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\STATUS.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\server\prisma\schema.prisma`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\url-loop.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\enrichment-agent.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\marketplace_flow.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\headless_flow.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\share-skill.md`
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\leed-drafter.md`

## Canonical Terms

Use these terms only:

- `Task`: one unit of work.
- `Session`: container for Tasks in one run; audit/reporting only.
- `Source`: where to look.
- `Client`: who might buy.
- `Booking`: concrete opportunity.
- `Factlet`: temporary reusable evidence.
- `Dossier`: accumulated client understanding.

Do not use `WorkItem`. Do not use `PRESENT_READY`. Use `SHOW_HOT_LEEDZ`.

## Subproject 1: Task Table And Lifecycle

Implement a `Task` table in `server\prisma\schema.prisma` and runtime table creation for old SQLite deployments.

Task is a SQLite row. It is not a JSON file.

Required fields:

```text
id            unique id created by MCP
type          DISCOVER_SOURCES | SCRAPE_SOURCE | ENRICH_CLIENT | APPLY_FACTLET | JUDGE_AFFECTED | SHOW_HOT_LEEDZ | SHARE_BOOKING
status        ready | claimed | done | failed | cancelled
sessionId     optional Session/run container
targetType    Source | Client | Booking | Factlet | none
targetId      id of the target object
input         small JSON input
output        small JSON output
error         short failure text
claimedAt
claimedBy
createdAt
updatedAt
finishedAt
```

The source of every Task is the Planner/MCP server. `targetType` and `targetId` describe what the Task applies to.

Examples:

```json
{
  "type": "SCRAPE_SOURCE",
  "targetType": "Source",
  "targetId": "src_123",
  "input": {
    "url": "https://example.com/events"
  }
}
```

```json
{
  "type": "ENRICH_CLIENT",
  "targetType": "Client",
  "targetId": "cli_123",
  "input": {
    "missing": ["direct_contact", "current_event_signal"]
  }
}
```

Lifecycle:

```text
ready -> claimed -> done
ready -> claimed -> failed
ready -> claimed -> cancelled
claimed timed out -> ready
```

Tasks are consumed by status change, not immediate deletion. Old finished Tasks are deleted later by `recycler`.

Why preserve finished Tasks:

- They are proof of what the run attempted.
- They show what completed and failed.
- They make Dallas/Orlando style stuck states debuggable.
- They let Session reports query SQLite instead of trusting LLM prose.

## Subproject 2: Session As Audit Container

Keep `Session` and `SessionEvent`, but clarify their purpose.

Session is a container of Tasks for one run. It does not decide workflow and does not own ontology.

Session answers:

- What happened during this run?
- When did it start and end?
- Which Tasks belonged to it?
- What did PRECRIME actually accomplish?

Task answers:

- What was one unit of work?
- What target did it apply to?
- Did it finish?
- What was its output?

Required behavior:

- `Task.sessionId` links a Task to its Session.
- `SessionEvent` remains optional append-only detail logging.
- `report_session` summarizes Task counts and outcomes.
- Session must not be required to decide the next action.
- Planner creates or reuses one active Session for a run.
- Planner stamps every Task it creates with that Session id.
- Planner closes the Session when both are true:
  - the current `plan_tasks` call created zero new Tasks for that Session
  - there are zero `ready` or `claimed` Tasks for that Session
- Planner also closes the Session when the configured Session-wide budgets are exhausted.

### Session Budgets

Session budgets are not concurrency limits. They are run-wide work budgets.

Two settings exist:

1. `tasks.limits`: maximum open Tasks of each type at one moment.
2. `tasks.sessionBudgets`: maximum total Tasks of each type that one Session may create before closing.

Example:

```json
{
  "tasks": {
    "limits": {
      "SCRAPE_SOURCE": 5,
      "ENRICH_CLIENT": 10
    },
    "sessionBudgets": {
      "SCRAPE_SOURCE": 25,
      "ENRICH_CLIENT": 50
    }
  }
}
```

Meaning:

- Planner may have at most 5 `SCRAPE_SOURCE` Tasks open at once.
- Over the whole Session, Planner may create at most 25 `SCRAPE_SOURCE` Tasks.
- If the 25th scrape discovers 50 more Sources, those Sources stay in SQLite for the next Session.

This is how PRECRIME stays recursive without becoming infinite. Workers discover new inputs. Planner turns inputs into Tasks only while both conditions hold:

```text
open Tasks for type < tasks.limits[type]
AND
created Tasks for Session/type < tasks.sessionBudgets[type]
```

## Subproject 3: Planner MCP Actions

Planner lives in:

```text
C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js
```

It is implemented as new `precrime__pipeline` actions. Under the covers this is a switch statement dispatching `args.action` to functions.

Add these actions:

```text
plan_tasks
claim_task
complete_task
tasks
```

`plan_tasks`:

- Input: `mode`, optional `objective`, optional `session_id`.
- Reads SQLite state.
- Creates ready Tasks up to configured per-type limits.
- Enforces Session-wide budgets before creating any Task.
- Does not scrape, enrich, judge, or present.
- Returns `session_id`, counts by Task type, budget usage, budget exhaustion flags, and a short explanation.

`claim_task`:

- Input: `role`, optional `types`, optional `session_id`.
- Atomically claims one ready Task.
- Also reclaims timed-out claimed Tasks.
- Returns one compact Task packet.

`complete_task`:

- Input: `taskId`, `status`, optional `output`, optional `error`.
- Marks Task done/failed/cancelled.
- Records affected client/booking/factlet ids in `output`.
- Does not itself perform long scraping or LLM work.

Task `output` canonical keys for affected records are:

- `clientIds`
- `bookingIds`
- `factletIds`
- `sourceIds`

These match the Phase 3 worker skills (`url-loop.md`, `enrichment-agent.md`, `apply-factlet.md`) and the Judge inputs in Subproject 6 below.

For backward compatibility, the Planner also accepts the legacy keys when reading completed Task output to plan `JUDGE_AFFECTED`:

- `affectedClientIds`
- `affectedBookingIds`

Normalization happens in `extractAffectedIds(output)` in `C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js`. It unions and dedupes canonical + legacy. New code must write the canonical keys; legacy names exist only so older `done` Tasks still get judged.

`tasks`:

- Debug/audit list.
- Supports filters: `status`, `type`, `sessionId`, `targetType`, `targetId`.

Planner should be a priority-ordered state machine, not LLM reasoning.

Interactive startup:

```text
Ask:
  1. SHOW_HOT_LEEDZ
  2. RUN_WORKFLOW
```

If `SHOW_HOT_LEEDZ`:

- Create one `SHOW_HOT_LEEDZ` Task.
- Do not scrape or enrich.

If `RUN_WORKFLOW`:

- Create one bounded `DISCOVER_SOURCES` Task at the start of the Session unless one already exists for that Session.
- Create claimable `SCRAPE_SOURCE`, `APPLY_FACTLET`, and `ENRICH_CLIENT` Tasks up to configured limits.
- Stop creating a Task type once that Session has reached its `tasks.sessionBudgets[type]`.
- Let workers claim Tasks.

Headless startup:

- Create `SHARE_BOOKING` Tasks for existing unshared `leed_ready` Bookings first.
- Then create the same workflow Tasks as `RUN_WORKFLOW`.

Planner Task creation order for workflow mode:

1. `DISCOVER_SOURCES`, once per Session/cycle.
2. `SCRAPE_SOURCE` for claimable Source rows.
3. `APPLY_FACTLET` for live Factlets not yet broadly assimilated.
4. `ENRICH_CLIENT` for stale/thin Clients.
5. `JUDGE_AFFECTED` for completed Tasks with affected ids.
6. `SHOW_HOT_LEEDZ` if judged hot items exist.

Per-type Task limits and Session budgets come from the top-level runtime config. Limits mean "open right now." Budgets mean "total created in this Session."

Default limits:

```json
{
  "DISCOVER_SOURCES": 1,
  "SCRAPE_SOURCE": 5,
  "APPLY_FACTLET": 5,
  "ENRICH_CLIENT": 10,
  "JUDGE_AFFECTED": 5,
  "SHOW_HOT_LEEDZ": 1,
  "SHARE_BOOKING": 3
}
```

Default Session budgets:

```json
{
  "DISCOVER_SOURCES": 1,
  "SCRAPE_SOURCE": 25,
  "APPLY_FACTLET": 50,
  "ENRICH_CLIENT": 50,
  "JUDGE_AFFECTED": 50,
  "SHOW_HOT_LEEDZ": 1,
  "SHARE_BOOKING": 10
}
```

When a budget is reached, Planner does not delete or discard remaining inputs. It leaves them in their ontology tables:

- unprocessed Sources remain in `Source`
- live Factlets remain in `Factlet`
- stale/thin Clients remain in `Client`
- unshared Bookings remain in `Booking`

The next Session may continue from that leftover work.

## Subproject 4: Worker Skills Become One-Task Skills

Rewrite worker-facing skills so each skill executes exactly one claimed Task.

First rewrites:

- `templates\skills\url-loop.md`
  - Claim or receive one `SCRAPE_SOURCE` Task.
  - Scrape that Source.
  - Save discovered Sources, Clients, Bookings, and Factlets.
  - Mark the Source processed.
  - Complete the Task.
  - Stop.

- `templates\skills\enrichment-agent.md`
  - Claim or receive one `ENRICH_CLIENT` Task.
  - Load that Client.
  - Improve contact info, target URLs, Bookings, and dossier.
  - Save updates.
  - Complete the Task.
  - Stop.

Add one new worker skill:

- `templates\skills\apply-factlet.md`
  - Claim or receive one `APPLY_FACTLET` Task.
  - Load one Factlet.
  - Compare it to Clients using the enrichment flow below.
  - Assimilate relevant evidence into Client dossiers.
  - Complete the Task.
  - Stop.

Workers must not decide global strategy. Workers write truth. Planner decides what comes next.

## Subproject 5: Enrichment And Factlets

This resolves the previous TBD.

Chosen method:

```text
Factlet = temporary reusable evidence in SQLite
Client.dossier = accumulated client understanding
APPLY_FACTLET = decide whether a live Factlet should be assimilated into a Client dossier
Recycler = deletes stale Factlets after N days
```

Do not use `ClientFactlet[]` as the primary enrichment model.

Do not add `Client.zip`. Zip belongs to `Booking`. If a Client has stable geography, write it into the dossier as a permanent note.

Factlet stays simple:

```text
id
content
source
createdAt
status
```

Client dossier is plain text, but disciplined:

```text
[PERMANENT] Static facts that should not expire, such as a venue address or business type.
[2026-05-23] Time-sensitive signal from source...
[2026-06-01] Newer related signal...
```

`clientNotes` is different from `dossier`. Clarify later, but for now:

- `dossier`: intelligence about the Client.
- `clientNotes`: private operational notes about how to communicate or handle the Client.

`ENRICH_CLIENT` behavior:

1. Load Client and existing dossier.
2. Search using name, company, website, existing target URLs, clientNotes, and known Bookings.
3. Find direct contacts, new URLs, Bookings, and Factlets.
4. Any Factlet discovered during this Client-targeted Task is first assimilated into this Client's dossier if relevant.
5. If the Factlet may help other Clients, create an `APPLY_FACTLET` Task targeting that Factlet.
6. Complete the Task with affected Client/Booking ids.

`APPLY_FACTLET` behavior:

1. Load one live Factlet.
2. Compare it to current Clients.
3. Start with fast procedural checks:
   - Client name/company overlap.
   - Website/domain overlap.
   - Regex intersection with `clientNotes`.
   - Regex intersection with `dossier`.
   - Booking title/location/zip/date/trade overlap.
   - Phone area code only when useful and not misleading.
4. If there is no cheap overlap, skip the Client.
5. If there is plausible overlap, use LLM fallback with only:
   - Factlet content/source/date.
   - Client name/company/website.
   - Client dossier.
   - Client notes.
   - Recent Booking summaries.
6. LLM returns one of:
   - `no_change`
   - `append_dossier_entry`
   - `rewrite_existing_dossier_entry`
   - `update_permanent_profile`
7. Save updated dossier when relevant.
8. Complete Task with affected Client/Booking ids.

Duplication rule:

- Do not blindly append the same event or fact twice.
- If the new Factlet is a newer/better mention of an existing dossier item, rewrite or refine the existing entry.
- If it is genuinely new, append a dated entry.

New Client behavior:

- When a Client is created or enriched, it can be exposed to recent live Factlets.
- Fast checks run first.
- LLM fallback runs only on plausible matches.
- Live Factlets remain available until recycler deletes them.

Staleness rule:

- Do not automatically remove old dossier entries.
- They are dated, and the drafter/judge should prefer recent entries.
- Recycler deletes old Factlet rows, not dossier memory.

Legacy `ClientFactlet`:

- Existing schema has `ClientFactlet`.
- New architecture should not depend on it for drafting/scoring.
- If retained for backwards compatibility, treat it as a pointer-only legacy list.
- If a pointer references a missing Factlet, delete that pointer lazily when encountered.

## Subproject 6: Judge And Scoring Boundary

Scoring belongs in Judge, not scattered across workers.

Target boundary:

```text
Worker saves facts.
Worker completes Task with affected ids.
Judge scores affected Client/Booking records.
Planner reacts to judged state.
Presenter acts on judged state.
```

Add or formalize:

```text
judge_affected
```

Inputs:

- `clientIds`
- `bookingIds`
- `factletIds`, optional
- `session_id`, optional

Responsibilities:

- Run client/booking scoring.
- Update `Booking.status` only through canonical scoring logic.
- Do not scrape.
- Do not enrich.
- Do not draft.
- Return changed statuses and missing fields.

Existing `computeBookingTargetScore()` remains the marketplace/outreach promotion authority.

Implementation note:

- Existing `pipeline.save` currently auto-scores. This must be migrated by extraction, not by coexistence.

Required migration decision:

- Create one internal scoring helper first:

```text
judgeAffected({ clientIds, bookingIds, reason, writeStatus })
```

- Move the current `pipeline.save` scoring block into that helper.
- `computeBookingTargetScore()` remains the score authority inside the helper.
- `pipeline.save` may call `judgeAffected` only as a legacy compatibility caller.
- Add optional `judge` input to `pipeline.save`.
- Default: `judge: true`, so existing skills do not break during migration.
- New Task-based workers must call `pipeline.save` with `judge: false`.
- New Task-based workers must return affected ids in Task `output`.
- Planner must then create a `JUDGE_AFFECTED` Task for those affected ids.
- `JUDGE_AFFECTED` is the only scoring caller in the new Task path.

This creates one temporary compatibility path, not two scoring systems:

```text
Legacy path:
pipeline.save(judge: true) -> judgeAffected(...)

New Task path:
pipeline.save(judge: false) -> complete_task(output.affectedIds) -> JUDGE_AFFECTED -> judgeAffected(...)
```

Forbidden:

- Do not leave a copied scoring block inside `pipeline.save`.
- Do not let `pipeline.save(judge: false)` update `Booking.status`.
- Do not let workers set `Booking.status` directly except terminal operational states explicitly owned elsewhere, such as `shared`, `taken`, or `expired`.
- Do not run both `pipeline.save` auto-score and `JUDGE_AFFECTED` for the same Task output.

End state:

- Task-based workflow always scores through `JUDGE_AFFECTED`.
- `pipeline.save(judge: true)` remains only for unmigrated legacy/manual callers until they are removed or rewritten.

## Subproject 7: Structured Dates And `share_booking`

This bug must never happen again:

```text
LLM hand-computed st/et and posted a marketplace leed.
```

The LLM is a fuzzy date recognizer. MCP is the deterministic date validator/converter.

Required `resolve_dates` input shape:

```json
{
  "action": "resolve_dates",
  "rawText": "Grad Nite, June 10, 9:30pm to 5am, Santa Monica",
  "start": {
    "year": 2026,
    "month": 6,
    "day": 10,
    "hour": 9,
    "minute": 30,
    "ampm": "PM"
  },
  "end": {
    "year": 2026,
    "month": 6,
    "day": 11,
    "hour": 5,
    "minute": 0,
    "ampm": "AM"
  },
  "timezone": "America/Los_Angeles",
  "zip": "90405",
  "sourceProof": {
    "kind": "email|url|snippet",
    "value": "proof text, email id, or source URL"
  }
}
```

MCP must:

- Reject missing year, month, day, time, end time, ambiguous AM/PM, and missing timezone.
- An explicit IANA `timezone` is REQUIRED. Zip-to-timezone derivation is not supported -- if only `zip` is supplied, the call is rejected with `timezone:missing_zip_only_derivation_unsupported`. `zip` is echoed in the response for provenance only.
- Validate calendar dates.
- Validate end is after start.
- Validate start has not passed.
- Calculate `st` and `et`.
- Return `st`, `et`, ISO fields, human display string, and provenance.

LLM must:

- Copy raw messy date evidence.
- Extract structured start/end fields.
- Extract timezone or zip/location.
- Never compute epoch milliseconds.
- Never repair or reinterpret MCP output.

Add:

```text
share_booking
```

Inputs:

- `bookingId`
- `mode`: `draft` or `post`

Not inputs:

- `st`
- `et`

`share_booking` must:

1. Load Booking and Client.
2. Run Judge/rescore.
3. Reject unless Booking is still `leed_ready`.
4. Require structured date provenance.
5. Build addLeed JSON server-side.
6. In `draft` mode, return addLeed JSON and human display dates.
7. In `post` mode, call Leedz and save `leedId`, `sharedAt`, `sharedTo`.

Remove direct `leedz__createLeed` instructions from:

- `templates\skills\share-skill.md`
- `templates\skills\leed-drafter.md`
- `templates\skills\headless_flow.md`
- `templates\GOOSE.md`
- `DOCS\FOUNDATION.md`

## Subproject 8: Recycler

Add a startup cleanup MCP action:

```json
{
  "action": "recycler",
  "olderThanDays": 30,
  "dryRun": true
}
```

Recycler runs at PRECRIME startup.

Responsibilities:

- Delete Factlets older than configured N days.
- Delete or summarize finished Tasks older than configured N days.
- Requeue timed-out claimed Tasks.
- Never delete ready Tasks.
- Never delete active claimed Tasks unless timeout has expired.
- Never delete ontology truth: Clients, Bookings, Sources.

Factlet cleanup:

- Delete stale Factlet rows.
- Do not chase dossier entries.
- If legacy `ClientFactlet` pointers remain, drafting/scoring should delete stale pointers lazily when they point to missing Factlets.

Task cleanup:

- Purge `done`, `failed`, and `cancelled` Tasks older than retention.
- Do not purge Tasks attached to active Sessions.
- Preserve enough Session summary to report old runs.

Retention defaults:

```json
{
  "factletStaleDays": 180,
  "taskRetentionDays": 30,
  "claimTimeoutMinutes": 10
}
```

## Subproject 9: Presenter And Modes

Presenter handles judged outputs only.

Interactive:

- `SHOW_HOT_LEEDZ` displays `leed_ready` and `outreach_ready` items.
- User decides share/email/skip.
- Marketplace share calls `share_booking(mode="post")`.

Headless:

- Existing hot work first.
- `SHARE_BOOKING` Tasks for `leed_ready`.
- Outreach sending only if configured.
- No direct Leedz calls from LLM.

Presenter must not scrape, enrich, or score.

## Subproject 10: User-Editable Config (Two Separate Surfaces)

PRECRIME has two user-facing config concepts. They do not overlap.

1. `DOCS\VALUE_PROP.md` -- product/sales truth.
   What is being sold, seller identity, seller email, trade/category, geography, pitch, buyers, relevance signals, pricing, outreach style, examples. This is the soul of the deployment.

2. `precrime_config.json` -- runtime/API config.
   API keys, LLM provider/model/baseUrl, database file path, runtime mode, Task limits, Session budgets, recycler limits, marketplace/session/auth tokens, paths to auxiliary config files.

These two files are the only user-editable config surfaces. SQLite `Config` is an internal runtime mirror/cache, not a user surface. `.env` is not part of the build.

Do not collapse VALUE_PROP into precrime_config.json. Do not place product/sales fields (companyName, companyEmail, businessDescription, defaultTrade, leedzEmail, pitch, buyers, geography, pricing, outreach examples) in precrime_config.json.

### Canonical paths

```text
C:\Users\Admin\Desktop\WKG\PRECRIME\precrime_config.json
C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\VALUE_PROP.md
```

### Startup behavior

- Startup reads runtime fields from `precrime_config.json` via `server\config\precrime_config.js` (`loadPrecrimeConfig`).
- Startup syncs product/sales fields from `DOCS\VALUE_PROP.md` into SQLite `Config` via `server\sync-config.js`.
- If a third-party library demands `process.env.X` at import time, startup sets `process.env.X` from the loaded config as internal plumbing. This is not documented as a workflow and is not user-facing.

### Loader contract

`server\config\precrime_config.js` exports `loadPrecrimeConfig({ refresh?, path? })`. Path precedence: explicit `opts.path` > `process.env.PRECRIME_CONFIG_PATH` > project root `precrime_config.json`. The loader reads only `precrime_config.json`. It does not read `.env`. It does not import `dotenv`.

### Wired callers

- `server\mcp\mcp_server.js` reads the config at startup. `TASK_TYPE_LIMITS`, `TASK_SESSION_BUDGETS`, `CLAIM_TIMEOUT_MINUTES`, and `recycler` thresholds come from the config.
- `scripts\bootstrap_config.js` reads `precrime_config.json` and emits Windows `set NAME=value` lines on stdout so the .bat launchers can lift `PRECRIME_*` runtime knobs and `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `TAVILY_API_KEY` into the process environment for inheritance by child processes. It does NOT rewrite `.mcp.json`, and it does NOT rewrite the Goose user config -- `goose.bat` regenerates `%APPDATA%\Block\goose\config\config.yaml` from `goose_config.template.yaml` on every launch.
- `precrime.bat`, `goose.bat`, `hermes.bat` invoke `scripts\bootstrap_config.js` and refuse to start when `precrime_config.json` is missing.
- `server\sync-config.js` reads `DOCS\VALUE_PROP.md` as the sole source for companyName, companyEmail, businessDescription, defaultTrade, leedzEmail, geography, and pitch, then writes those into SQLite `Config`. It does not read product/sales fields from `precrime_config.json`.

### Stays scattered (per spec)

- `server\mcp\gmail_mcp_config.json` (Gmail OAuth plumbing).
- `rss\...`, `reddit\...`, `ig\...` source lists (source-specific knobs).
- `server\mcp\mcp_server_config.json` (MCP protocol metadata and logging file path).

## Subproject 11: Tests

Add tests or smoke scripts that prove:

1. `plan_tasks` creates no more than configured limits per Task type.
1a. `plan_tasks` creates no more than configured Session budgets per Task type across one Session.
2. `claim_task` atomically claims one ready Task.
3. Claimed timed-out Tasks return to ready.
4. `complete_task` records `output`, status, and timestamps.
5. `report_session` summarizes Tasks for one Session.
6. `SCRAPE_SOURCE` worker saves discoveries and stops after one Source.
7. `ENRICH_CLIENT` worker updates one Client dossier and stops.
8. `APPLY_FACTLET` updates only plausible Client dossiers and avoids duplicate entries.
9. `judge_affected` is the only status promotion path for new architecture flows.
10. `resolve_dates` rejects text-only timezone smuggling and accepts structured input.
11. `share_booking` refuses LLM-provided `st`/`et`.
12. `recycler` deletes stale Factlets at startup and leaves Clients/Bookings intact.
13. Planner closes a Session when no new Tasks are created and no ready/claimed Tasks remain for that Session.
14. Planner leaves leftover recursive inputs in SQLite when a Session budget is exhausted.

## Implementation Order

1. Add `Task` schema and runtime table creation.
2. Add `plan_tasks`, `claim_task`, `complete_task`, and `tasks`.
3. Extract the current `pipeline.save` scoring block into `judgeAffected(...)`.
4. Add `judge_affected` MCP action backed by the same `judgeAffected(...)` helper.
5. Add optional `judge` input to `pipeline.save`; default `true`, but new Task workers must pass `false`.
6. Add `recycler` with dry-run support.
7. Rewrite `url-loop.md` to one `SCRAPE_SOURCE` Task.
8. Rewrite `enrichment-agent.md` to one `ENRICH_CLIENT` Task.
9. Add `apply-factlet.md`.
10. Implement `APPLY_FACTLET` dossier assimilation.
11. Add structured `resolve_dates`.
12. Add `share_booking`.
13. Rewrite presenter/share/headless skills to use `SHOW_HOT_LEEDZ` and `share_booking`.
14. Run smoke tests on a copied Dallas/TDS database.
15. (DONE) `precrime_config.json` is now the canonical runtime/API config surface; `server\config\precrime_config.js` loads it, `scripts\bootstrap_config.js` exports `set NAME=value` lines from it, and the .bat launchers refuse to start without it.

## Non-Goals For First Pass

- Do not add keyword index tables.
- Do not add `Client.zip`.
- Do not build a complex scheduler.
- Do not spawn multiple OS processes yet.
- Do not rewrite every harvester in the first pass.
- Do not rely on LLM prose for audit.
- Do not let workers decide global strategy.
- Do not let presenters post directly to Leedz.
