# Plan: "Dumb worker" turn reduction — inject task + fold complete into save

- **Date:** 2026-07-05
- **Status:** Ready to implement (green-lit)
- **Goal:** Remove the two lowest-value turns from every spawned worker — the opening
  `get_task` fetch and the trailing `complete_task` call — cutting ~2 model round-trips
  per worker. Because a stateless model re-bills the whole transcript every turn
  (`5A + 4B + 3C + …`), deleting the *first* turn removes the most-multiplied term.
- **Scope:** goose + claude spawned workers only. In-process types (JUDGE_AFFECTED,
  SHOW_HOT_LEEDZ, LAST_30_DAYS) are unaffected.
- **Non-goals:** No change to task lifecycle states, judging, or the marketplace path.
  Action-level schema scoping is a separate follow-on (see Phase 3 pointer).

## Why this is the highest-ROI turn cut

A `drill-down` worker runs ~5–7 turns: `get_task` → `find`×1–2 → `tavily_extract`×N →
`save` → `complete_task`. `get_task` is **turn 1** (re-billed on every later turn) and
`complete_task` is a whole extra round-trip that only writes a status the server could
infer. Both are pure overhead. The conductor already has the data for both.

---

## Half A — Inject the claimed task packet (remove `get_task`)

**Fact that makes this free:** `conductorGetReadyTasks()` (db.js) returns the full task
row (`{...r, skillFile}`), and the conductor claims it atomically (`conductor.js:272`)
*before* spawning. So the conductor already holds `{id, type, targetType, targetId,
input, sessionId}` — exactly what `get_task` returns to the worker.

**Change (conductor.js, ~1 spot):** after reading `skillContent` and before writing
`tmpMd` / passing it as the arg, append a task-packet block. This sits right next to the
existing `skillContent += OUTPUT_DISCIPLINE;` injection, so both spawn paths (win32 temp
file + non-win32 direct arg) inherit it automatically.

```js
// Inject the already-claimed task packet so the worker does NOT spend turn 1 calling
// get_task. Shape MUST mirror the get_task response so skills read identical fields.
const packet = {
  id: task.id, type: task.type, targetType: task.targetType,
  targetId: task.targetId, sessionId: task.sessionId,
  input: (typeof task.input === 'string' ? safeJson(task.input) : task.input) || {}
};
skillContent =
  `## ASSIGNED TASK — do NOT call get_task; this IS your task packet\n` +
  '```json\n' + JSON.stringify(packet, null, 2) + '\n```\n\n' +
  skillContent + OUTPUT_DISCIPLINE;
```

(`safeJson` = try/catch JSON.parse → `{}`. Confirm whether `task.input` arrives parsed or
as a string from the Prisma row before implementing; handle both.)

**Skill change (Step 0), every spawned skill:** replace
`precrime__pipeline({ action:"get_task", taskId })` with:
> Your task packet is in the **ASSIGNED TASK** block above. Set `taskId = packet.id`.
> `targetId`, `input.*` come from that block. Do not call `get_task`.

Keep the `wrong_task_type` guard (cheap; the conductor only ever injects the matching
type, so it becomes a near-dead safety check — acceptable).

**`get_task` stays a registered action** — interactive/manual use and any sad-path
fallback still need it. We just stop calling it from worker Step 0.

---

## Half B — Fold `complete_task` into the terminal `save` (happy path)

**New optional field on the `save` action:**
```
precrime__pipeline({ action:"save", …, completeTask:{ taskId, status:"done", summary?, needsJudge?, output? } })
```

**Orchestration lives in the save dispatch (mcp_server.js), NOT in saveClient.js** — keeps
`pipelineSave` pure and reuses the existing `pipelineCompleteTask`:

```js
const saveRes = await pipelineSave(...);            // unchanged
if (args.completeTask) {
  const ct = args.completeTask;
  const derived = idsFromSaveRes(saveRes);          // { clientIds, bookingIds } this save wrote
  await pipelineCompleteTask(tag, {
    taskId: ct.taskId,
    status: ct.status || 'done',
    output: {
      bookingIds: ct.output?.bookingIds ?? derived.bookingIds,
      clientIds:  ct.output?.clientIds  ?? derived.clientIds,
      factletIds: ct.output?.factletIds ?? [],
      sourceIds:  ct.output?.sourceIds  ?? [],
      summary:    ct.summary ?? `${ct.status || 'done'}`,
      needsJudge: ct.needsJudge ?? true
    }
  });
}
return saveRes;   // worker sees one combined response
```

**Rules (correctness):**
- **Single-save workers** (drill-down, enrichment, apply-factlet, …): pass `completeTask`
  on their one `save`, omit `output` → server derives ids. One combined turn.
- **Multi-save workers** (drill-container mints ≤12 vendors + organizer): pass
  `completeTask` **only on the final save**, and pass the accumulated
  `output.clientIds/bookingIds` explicitly (the worker already assembled them today) so
  the JUDGE_AFFECTED sweep sees every minted vendor, not just the last save's ids.
- **Sad paths** (no terminal save: tavily down, nothing found, wrong_task_type): keep the
  explicit `complete_task` call exactly as today. The fold optimizes only the common,
  expensive happy path.

**Deliberate simplification (be honest):** save-then-complete is **sequential, not a
single DB transaction.** If the save commits but the complete fails, the task stays
`claimed` and the conductor's existing kill-timer / reconciliation fails it out — the
safety net already exists. True single-tx atomicity is a later refactor if it ever bites.

**needsJudge:** default `true` for spawned workers (they mutate bookings/clients); skills
that shouldn't trigger a judge sweep set it `false`.

---

## Touch-points

| File | Change | Size |
|---|---|---|
| `server/mcp/conductor.js` | inject task packet into `skillContent` (next to OUTPUT_DISCIPLINE) | ~12 lines |
| `server/mcp/mcp_server.js` | `save` dispatch honors `completeTask` (reuse `pipelineCompleteTask`); add `idsFromSaveRes` helper | ~20 lines |
| `server/mcp/toolDefs.js` | document `completeTask` on the `save` action schema | ~8 lines |
| `templates/skills/*.md` (8) | Step 0 read-packet; terminal save folds complete | mechanical |

**The 8 spawned skills** (per `WORKER_SKILL_MAP`): apply-factlet, enrichment-agent,
url-loop, find-client-sources, discover-sources, drill-down, drill-container,
outreach-drafter. *(Sweep drill-convention.md / drill-festival.md too if they are
registered in the deployed map — source `WORKER_SKILL_MAP` does not list them; reconcile.)*

## Risks & mitigations

- **Packet shape drift vs get_task.** Mirror the get_task response exactly; add one
  boot-time worker run per changed skill to confirm fields resolve.
- **`task.input` string-vs-object.** Handle both in the conductor (`safeJson`).
- **Multi-save id loss.** Explicit `output` on the final drill-container save (rule above).
- **Skill regression.** Roll out skill-by-skill (drill-down first — highest volume,
  single-save, simplest) and watch a live goose run before converting the rest.

## Verification

1. `node --check` conductor.js + mcp_server.js.
2. Boot goose in TDS; run one `DRILL_DOWN`. Confirm: no `get_task` call in the worker
   transcript, the final `save` carries `completeTask`, the task row reaches `done`, and
   any affected bookings get judged.
3. Run one `DRILL_CONTAINER`; confirm all minted vendor ids appear in the completion
   output and the JUDGE_AFFECTED sweep covers them.
4. Diff a before/after worker transcript for turn count (expect −2 on the happy path).

## Sequencing

1. conductor.js packet injection + drill-down.md Step 0 → boot-verify (Half A alone).
2. save `completeTask` dispatch + toolDefs doc + drill-down.md terminal fold → boot-verify.
3. Convert remaining 7 skills; sync all to `TDS/precrime`; live pass.
4. **Phase 3 (separate, follow-on):** action-level schema scoping — `tools/list` returns a
   `?scope=<taskType>`-pruned `pipeline` schema. Stacks on top of this; not in this plan.

## Sync

Mirror conductor.js, mcp_server.js, toolDefs.js, and every rendered skill to
`C:\Users\Scott\Desktop\WKG\TDS\precrime` ({{DEPLOYMENT_NAME}} → MyProject) after each phase.
