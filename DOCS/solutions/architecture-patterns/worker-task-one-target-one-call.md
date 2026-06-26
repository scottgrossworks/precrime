---
title: One target, one call - worker task decomposition for cheap-model multi-agent pipelines
date: 2026-06-15
category: architecture-patterns
module: planner / workers (server/mcp/mcp_server.js, templates/skills/*)
problem_type: architecture_pattern
component: service_object
severity: high
tags: [multi-agent, task-decomposition, planner-worker, cheap-model, fan-out, producer-consumer, anti-hallucination, trusted-state]
applies_when:
  - "Workers run on a small or cost-sensitive model (e.g. gemini-flash via OpenRouter)"
  - "A Planner enqueues tasks that workers claim and execute one at a time"
  - "A worker task touches multiple entities, URLs, or records in a single LLM call"
  - "A trusted state field (status, classification) is written through a shared save tool"
---

# One target, one call - worker task decomposition for cheap-model multi-agent pipelines

## Context

Agentic pipelines fan work out to many LLM workers. When those workers run on a cheap, limited model (here: Goose + OpenRouter + gemini-flash), there is a structural tension: the model is cheapest and most reliable when it makes one bounded decision, but the natural instinct is to hand it open-ended multi-entity or multi-step tasks ("here are 100 clients, find the relevant ones and update them"). That instinct fails - cheap models hallucinate under broad scope, produce unpredictable partial results, and cannot be trusted to own state transitions that carry business consequence.

A multi-agent code review of PRECRIME's Planner/Worker/Judge pipeline surfaced two gaps: (1) hot-path workers were too heavy for a small model - `ENRICH_CLIENT` ran a multi-URL scrape+extract loop in one call, `APPLY_FACTLET` loaded up to 100 clients and scanned them with the LLM; (2) an anti-hallucination gate was prose-only - a worker could write `Booking.status:"hot"` via the shared save tool and the server accepted it verbatim, so a hallucinating worker could fabricate a "hot" lead. The fix inverted the decomposition responsibility: the server does all fan-out and owns trusted state; workers get one pre-scoped input and make exactly one decision.

## Guidance

**The decomposition rule:** every worker task is ONE pre-fetched input + ONE target -> ONE LLM call -> ONE mutation. If a worker is iterating, selecting, or writing to more than one entity, the server has not decomposed far enough.

**The server owns fan-out and trusted state:**

1. **Fan-out is server pre-computation, not LLM work.** Before a worker is spawned, the server computes the candidate set. `candidateClientIdsForFactlet()` applies token/hostname-overlap filtering to find the clients a factlet might mention; the worker never scans a large entity set with open-ended extraction.

2. **Promote-only state is owned by a server-side Judge.** Workers may DEMOTE a record (`cold`/`brewing`) but may never set a state the system trusts for downstream actions (`hot`). `pipelineSave` enforces this in code:

   ```js
   // Booking.status is owned by the server Judge. A worker save may only
   // DEMOTE to 'cold' or 'brewing'; it may NEVER promote to 'hot'.
   if (b.status === 'cold' || b.status === 'brewing') {
       bookingData.status = b.status;
   } else {
       console.error(`[save] ignored worker-supplied Booking.status='${b.status}'`);
   }
   // Promotion to 'hot' happens only in computeBookingTargetScore() / judgeLeed().
   ```

3. **Producer/consumer split when a task has a fetch phase and a synthesis phase.** Split them into two worker types: the producer fetches and stores structured intermediates; the consumer handles one stored item per task. PRECRIME's `FIND_CLIENT_SOURCES` runs Tavily search/extract for one client and stores `{ url, summary, consumed:false }` entries on `Client.targetUrls`; `ENRICH_CLIENT` folds exactly one unconsumed summary into the dossier and marks it consumed. Neither worker does both. This mirrors discovery's existing `DISCOVER_SOURCES` -> `SCRAPE_SOURCE` shape.

4. **Atomic-per-target task creation with a budget-room check.** When one logical target (a factlet, a client) fans out to N sub-tasks, create ALL N in a single pass or create none, and key dedup/"processed" tracking on the original target:

   ```js
   // Only start a factlet if the budget has room for ALL its pairs this pass;
   // otherwise defer the whole factlet to the next replan.
   if ((await createBudget('APPLY_FACTLET')).eff < pairs.length) break;
   for (const cid of pairs) {
       await createTask('APPLY_FACTLET', { targetType: 'Factlet', targetId: factletId, input: { clientId: cid } });
   }
   ```

   Because dedup is keyed on the factlet (not the individual pair), a deferred factlet is deferred cleanly and re-attempted whole next pass - it can never be left half-applied across passes.

## Why This Matters

- **Cheap LLMs fail at open scope.** "Which of these 100 clients is this factlet relevant to?" produces hallucinated matches and missed real ones. "Is this one factlet relevant to this one client?" is reliable and auditable.
- **Workers that own trusted state are a fabrication vector.** If `pipelineSave` accepted `status:"hot"` verbatim, a hallucinating worker could fabricate a hot lead and trigger downstream outreach. The server-side gate makes "hot" a conclusion the server drew from its own judge, not a worker assertion. A gate that lives only in skill markdown ("do not write status") is not a gate.
- **Partial fan-out creates permanent stale state.** If a factlet's 5 client pairs split across two passes (3 in pass 1, 2 in pass 2) while dedup marks the factlet processed after pass 1, the remaining 2 pairs are never created. "All-or-nothing per target" prevents this silent data loss.
- **Producer/consumer keeps each call cheap.** The consumer's prompt is one dossier + one short summary -> one update: a small, predictable context. The old combined worker's context grew unboundedly with the scrape loop and produced inconsistent results.

## When to Apply

- You fan work out to many cheap LLM workers (any cost-sensitive model/API).
- A worker receives a list of entities and is expected to select, filter, or iterate over them.
- A worker does a fetch AND a synthesis in the same call (network I/O + LLM reasoning in one task).
- A trusted state field that gates a high-value downstream action (sending email, posting to a marketplace, flagging for human review) is set by worker output accepted verbatim.
- A task fans out to N per-target sub-tasks and you have not considered what happens if the budget is exhausted mid-target.

Do **not** apply when workers run on frontier models with large context and reliable instruction-following: the decomposition overhead (extra planning code, extra task rows, extra round-trips) can cost more than it saves. Also cap per-target fan-out at or below the task type's open-task limit, or an over-wide target deadlocks the atomic budget check.

## Examples

**Anti-pattern - worker does fan-out:**
```
APPLY_FACTLET worker receives { factletId, allClients: [100 records] }
instruction: "Find relevant clients and append to their dossiers."
```
LLM scans 100 records, hallucinates relevance, writes to many entities, unpredictable cost.

**Pattern - server fans out, worker handles one pair:**
```js
// Planner (server)
const clientIds = await candidateClientIdsForFactlet(factlet);   // token/hostname filter
const pairs = clientIds.length ? clientIds : [null];             // null = a no-op "sweep" task
if ((await createBudget('APPLY_FACTLET')).eff < pairs.length) break;   // atomic-or-defer
for (const cid of pairs) {
    await createTask('APPLY_FACTLET', { targetType: 'Factlet', targetId: factletId, input: { clientId: cid } });
}
```
```
APPLY_FACTLET worker receives { factletId: "f1", clientId: "c42" }
instruction: "Is this factlet relevant to this client? If so, append one dossier line."
```

**Anti-pattern - producer and consumer in one worker:** the worker searches Tavily (N queries), extracts each URL, and synthesizes all results into the dossier in one task: unbounded context, a network failure kills the whole task, no retry granularity.

**Pattern - producer stores intermediates, consumer handles one:**
```
FIND_CLIENT_SOURCES (producer): search + extract top 3-5 URLs ->
    store { url, summary, consumed:false } on Client.targetUrls -> stop.
ENRICH_CLIENT (consumer, per unconsumed entry): input { clientId, url, summary } ->
    fold summary into dossier -> mark entry consumed:true -> stop.
```

## Cross-references

- `DOCS/wiki/concepts/recursive-loop.md` - canonical rule "workers never set Booking.status; the Judge owns it."
- `DOCS/FOUNDATION.md` - the producer (DISCOVER/SCRAPE) vs consumer (ENRICH/APPLY) stage model this pattern generalizes.
- `DOCS/REDESIGN_2026-06-07.md` (Thread 1) - procedural conductor, one-shot workers, server as single DB writer.
- `DOCS/CLASSIFICATION.md` - the cold/brewing/hot classification the server Judge owns.
- `DOCS/solutions/logic-errors/leed-ready-blocked-by-hardcoded-url-verification.md` - related on the trusted-state dimension (Judge owns promotion); candidate for consolidation review.
