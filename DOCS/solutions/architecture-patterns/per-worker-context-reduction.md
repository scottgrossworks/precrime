---
title: Per-worker LLM context reduction - extension scoping, action scoping, terse output, turn elimination
date: 2026-07-06
category: architecture-patterns
module: conductor / mcp server / tool defs (server/mcp/conductor.js, server/mcp/toolDefs.js, server/mcp/mcp_server.js, templates/skills/*)
problem_type: architecture_pattern
component: service_object
severity: high
tags: [token-reduction, context-scoping, mcp, tool-schema, cheap-model, agent-orchestration, per-turn-rebilling, prompt-caching, worker-context, cost-optimization]
applies_when:
  - "Spawned workers run on a cheap or free model with no prompt caching (e.g. gemini-flash / deepseek via OpenRouter)"
  - "Workers are multi-turn tool-calling agents, not single-shot completions"
  - "Tools are exposed over MCP and a mega-tool hides many actions behind an action discriminator"
  - "LLM cost is dominated by the spawned workers, not the orchestrator glue"
---

# Per-worker LLM context reduction

## Context

PRECRIME spawns one-shot goose/claude workers (DRILL_DOWN, DRILL_CONTAINER, ENRICH_CLIENT, ...) that each run as a multi-turn tool-calling agent against the precrime MCP server. On the target path (goose -> OpenRouter -> a cheap/free model), these workers are ~90% of LLM spend, and the system was not cost-effective: it cost more than the leads it produced.

The root cause is structural, not a framework choice. An LLM is a stateless function: it has no memory between calls. The illusion of a conversation is maintained by the **client** (goose), which re-sends the entire accumulated transcript on every turn — system prompt, all tool schemas, and every prior message and tool result. So cumulative **input** cost grows roughly quadratically with the number of turns: if each turn adds a chunk, turn 1's chunk is re-billed on every later turn (`A + AB + ABC + ... = 5A + 4B + 3C + 2D + E`). Independent measurements of agent trajectories show ~99% of tokens are re-billed input, ~1% generated output.

The usual fix — prompt/KV caching keyed on a byte-stable prefix — is **unavailable on the free OpenRouter path**. So the only lever left is to **send fewer tokens per turn and take fewer turns**. This doc is the pattern for doing that at the worker boundary. It is the context-side companion to [worker-task-one-target-one-call](worker-task-one-target-one-call.md) (which reduces *what a worker does*); this reduces *what a worker is sent*.

## Guidance

Attack two axes: (1) how big the per-turn payload is, and (2) how many turns re-send it. Four levers, in rough order of leverage.

### 1. Per-worker MCP extension scoping
Spawn each worker with only the MCP extensions its task type needs, not the full profile. Every loaded extension re-ships its **entire tool schema on every turn**. In `conductor.js`, `gooseExtArgs(taskType)` launches goose with `--no-profile` + only the `--with-*` extensions that task uses (precrime + shell, plus tavily for research types), instead of all five (precrime, developer, tavily, rss, gmail). Gated behind `PRECRIME_GOOSE_EXT_SCOPE=1` (goose-only; the claude path keeps its own scoping). This drops whole extensions' schemas (gmail, rss) from workers that never call them.

### 2. Action-level schema scoping (connection-time, zero round-trips)
The `precrime` extension exposes one `pipeline` mega-tool with ~25 actions (`save`, `get_task`, `share_booking`, `plan_tasks`, `judge_affected`, ...), each carrying a paragraph of description and its own parameters. A DRILL_DOWN worker uses ~8 of them, yet was shipped all 25 on every turn.

Fix: prune the advertised schema per worker, at the MCP handshake, before the model sees a token:
- The conductor appends the task type to the worker's connection URL: `.../mcp?scope=DRILL_DOWN`.
- The server reads `?scope=` off the `tools/list` request and returns a **pruned** `pipeline` tool: only that scope's allowed action enum values, only those actions' description fragments, and only the properties those actions use. `find`/`trades` stay as separate tools.
- Unknown / absent scope returns the full `TOOL_DEFS`, so the orchestrator and claude path are unchanged (safe by construction).

This is static, not lazy loading: pruning happens once at connect, so there are **no extra round-trips** (unlike a "tool directory + read-file on demand" scheme, which adds a turn per tool and loses money on short worker sessions).

### 3. Terse-output discipline (system-wide, one injection point)
Every token a worker *emits* is appended to the transcript and re-billed as *input* on every later turn, so verbose narration compounds like a scrape blob. The conductor appends one `OUTPUT_DISCIPLINE` block to every worker's instructions (single place -> covers all task types): emit only tool calls + a one-line final status, no narration, no "Now I will...", minimal tool arguments. Since the target model is non-reasoning (gemini-flash / deepseek-flash), there is no hidden chain-of-thought to suppress; goose exposes no per-call max_tokens knob, so this instruction *is* the cap.

### 4. Turn elimination
Because of quadratic re-billing, deleting a turn — especially the *first* — removes the most-multiplied cost.
- **Inject the task packet** (removes the opening `get_task` turn): the conductor already claimed the task and holds the full row, so it appends an `ASSIGNED TASK` JSON block to the worker's instructions. The skill's Step 0 reads the packet instead of calling `get_task`.
- **Fold complete_task into the terminal save** (removes the trailing completion turn): the `save` action accepts an optional `completeTask: { taskId, status, output }`; on a successful save the dispatch marks the task terminal (reusing `pipelineCompleteTask`). Multi-save workers pass it only on the final save; the sad path (nothing to save / tool down) still calls `complete_task` explicitly.

## Why This Matters

- **The cost is agent design, not the orchestrator.** Measured splits put orchestration glue at ~10% of tokens and worker agents at ~70%+. Re-implementing the orchestrator in LangChain/LangGraph does not reduce this (it is also just glue that calls LLMs, at best cost-neutral) and would break the orchestrator-agnostic / AWS-portable constraint. The wins live at the worker's context boundary, in the existing codebase.
- **On a free model, send-less is the only lever.** No prompt caching means you cannot pay-once for a stable prefix; you must physically ship fewer tokens.
- **The levers stack and are cheap.** Extension scoping was already built (just un-flagged); action scoping is one URL param + a prune function; terse output is one injected block; turn elimination is one packet injection + one dispatch fold. None require a rewrite, and the mega-tool and skills' call sites stay intact — only what the server *advertises* per worker shrank.

## When to Apply

- Workers run on a cost-sensitive or free model **without prompt caching** — the "send-less" regime.
- Workers are **multi-turn** tool-callers (single-shot completions do not accumulate).
- Tools are served over a transport whose `tools/list` you control per connection (streamable HTTP here), so you can key pruning on a connection hint.

Do **not** reach for lazy/deferred tool loading (a tool index the model queries on demand) in this regime: it adds a round-trip per tool and, for short worker sessions with a small tool catalog, spends more on re-billed turns than it saves on schema. That pattern wins only with huge tool catalogs and long sessions.

## Examples

Live measurement of the running server, `pipeline` schema, unscoped vs scoped:

| Connection | actions | props | chars |
|---|---|---|---|
| unscoped (orchestrator) | 25 | 47 | 18,356 |
| `?scope=DRILL_DOWN` | 8 | 30 | ~9,700 (~48% smaller) |

Verified end-to-end in the MCP log (`Handling tools/list request (3 tools, scope=DRILL_DOWN)`) — goose passes the query, the server prunes. Top-level tool count stays 3 because pruning happens *inside* the `pipeline` tool, not by removing tools.

Turn elimination, confirmed from a live run: across the whole workflow only the *unedited* container workers called `get_task`; the edited DRILL_DOWN workers produced enrichment saves with **zero** `get_task` calls (Half A), and the happy path is now one `save`-with-`completeTask` call instead of save + complete (Half B) — ~2 fewer turns per worker.

Guard the action allow-list against the skills' real usage before pruning: an early cut omitted `get_config` from the worker allow-list, which three skills call — caught by grepping every worker skill's `action:"..."` usage against the allow-list *before* going live. Anything not provably used by a worker (and several actions explicitly forbidden to workers — `share_booking`, `plan_tasks`, `judge_affected`, `claim_task`) is safe to prune.

Related failure mode: a mega-tool invites the model to call an action *name* as if it were a standalone tool (`audit_session` -> `-32601 Unknown tool`, then self-recover). Mitigated cheaply by sharpening the tool description ("these are ACTIONS of the one `pipeline` tool; call `pipeline` with `action:"<name>"`") rather than splitting the mega-tool — a split rewrites every skill + dispatch and is only worth it if fumbles prove frequent and costly.

## Related

- [worker-task-one-target-one-call](worker-task-one-target-one-call.md) - reduces what a worker *does* (task decomposition for cheap models); this doc reduces what a worker is *sent*.
- [conductor-worker-stdout-result-channel](conductor-worker-stdout-result-channel.md) - the worker spawn/result boundary these changes ride on.
- Plan: `DOCS/plans/2026-07-05-001-perf-dumb-worker-turn-reduction-plan.md` (the turn-elimination design; Phase 3 = action-level scoping).
