---
title: In-process worker conversion — FIND_CLIENT_SOURCES, ENRICH_CLIENT, DRAFT_OUTREACH
problem_type: architecture_pattern
severity: high
date: 2026-08-06
tags: [tokens, conductor, workers, goose, in-process, llm-cost]
---

# Spawn an agent only when the LLM steers; call a function when it merely answers

## The rule

Two execution patterns share one task queue and one conductor:

- **Spawned goose agent** — the conductor launches `goose.exe run` with a recipe.
  The worker is a multi-turn LLM conversation: think → tool call → look → think.
  Every turn re-bills the system prompt, the pruned tool schemas (~8-9KB), and the
  full skill body. Right for OPEN-ENDED work where the model must decide the next
  step from the last result (DRILL_DOWN, DRILL_CONTAINER, SCRAPE_SOURCE,
  DISCOVER_SOURCES).
- **In-process worker** — the conductor claims the same task row but calls a plain
  JS function in `server/mcp/workers/`. Code does all fetching and writing; the
  LLM (if used at all) answers ONE bounded completion in the middle. No process,
  no schemas, no re-billing, no orphan mode. Right for STRAIGHT-LINE procedures.

Test: if the skill file reads like a checklist ("search, store the snippets,
done", "use that snippet verbatim, do NOT interpret"), it is a procedure wearing
an agent costume — convert it.

## What was converted (2026-08-06)

| Type | Old cost | New shape |
|---|---|---|
| FIND_CLIENT_SOURCES | full goose session | `FindClientSourcesWorker.js` — ZERO LLM: 2 bounded Tavily basic searches, top snippets stored verbatim on `Client.targetUrls` (extract structurally impossible) |
| ENRICH_CLIENT | full goose session per snippet | `EnrichClientWorker.js` — ONE completion returns new dossier lines as strict JSON; written via `dossierAppend` (model can no longer rewrite/mangle dossier history); email/phone accepted only if VERBATIM in the source summary |
| DRAFT_OUTREACH | full goose session incl. 2 turns just fetching the template | `DraftOutreachWorker.js` — ONE completion rewrites the VALUE_PROP Sample Email (template inlined in the prompt); signature appended VERBATIM by code; dash filter procedural; generic-email/already-sent gates procedural |

Wiring (the complete checklist for any future conversion):

1. `workerManifest.js` — set `skill: null` (stops the spawn; scope entry stays).
2. `db.js IN_PROCESS_TYPES` — add the type (conductor claims it in-process).
3. `conductor.js INPROC_BACKGROUND` — add it if it does network I/O (runs as a
   tracked background job instead of blocking the dispatch loop).
4. `mcp_server.js runInProcessTask` — add the case: `run(task, { pipelineSave })`
   then `pipelineCompleteTask(...)` with the worker's `{status, output, summary}`.
5. Writes go through `pipelineSave` so every save-time gate (banned terms,
   service area, email rules, verify-at-enrichment) holds unchanged.
6. Worker LLM calls use `llmComplete(prompt, RUNTIME_CONFIG, maxTokens, role)`
   with a role from `llm.models` so cost is tunable per call class.

## Why (measured/observed)

Session budgets allowed FIND 25 + ENRICH 50 + DRAFT 25 = up to ~100 spawned
sessions per planning cycle, each re-billing setup on every turn, plus a steady
`worker_exited_without_complete_task` ORPHAN tax with unbounded cross-session
retries. The same work is now ~75 bounded completions (FIND's are free) and the
orphan mode cannot occur (no process to die).

## Kept guarantees

- Same task rows, planner stages, budgets, watermarks, and recycler.
- Judge/Worker separation: converted workers save with `judge:false`; only the
  planner schedules JUDGE_AFFECTED.
- The retired skill files remain in `templates/skills/` for reference; the
  conductor no longer reads them for these three types.
