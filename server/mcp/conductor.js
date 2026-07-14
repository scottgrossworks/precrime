// conductor.js -- Procedural Node.js conductor loop (Thread 1 / REDESIGN_2026-06-07)
//
// The orchestrator is NOT an LLM. It is this while loop. It polls the Task
// table, claims ready Tasks, spawns one-shot Goose (or Claude) worker processes,
// and marks Tasks failed on non-zero exit or timeout. The conductor never reads
// worker LLM output -- results go through MCP -> SQLite. Worker context is
// isolated per process and dies with it. Context cannot accumulate.
//
// Called from startMcpServer() after the HTTP transport is bound.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { conductorGetReadyTasks, conductorGetReadyInProcessTasks, conductorClaimTask, conductorFailTask, conductorFailIfClaimed, WORKER_SKILL_MAP } = require('./db');

const PRECRIME_ROOT = path.resolve(__dirname, '..', '..');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Per-worker MCP extension scoping (GOOSE ONLY, opt-in via PRECRIME_GOOSE_EXT_SCOPE).
// Every loaded extension re-sends its FULL tool schema on EVERY model turn -- a flat
// per-turn token tax. By default goose loads all 6 config extensions (precrime,
// tavily, rss, gmail, developer, tom) into every worker, even a DRILL_DOWN that only
// needs precrime + tavily + shell. When the env flag is set, we spawn workers with
// `--no-profile` (ZERO config extensions) and add back ONLY what the task type uses.
// gmail (send) is never needed by a spawned worker; rss only by scraping; tavily only
// by research types. Orchestrator-agnostic: goose.bat sets the flag; claude workers
// (precrime.bat) leave it unset and keep their own tool scoping.
// Robust truthiness: an unset var OR the strings "0"/"false"/"" all mean OFF. (CMD `set "X="`
// unsets it; but a future `set "X=0"` would otherwise read as ON because !!"0" is true in JS.)
const _extScopeRaw = (process.env.PRECRIME_GOOSE_EXT_SCOPE || '').trim().toLowerCase();
const EXT_SCOPE = _extScopeRaw !== '' && _extScopeRaw !== '0' && _extScopeRaw !== 'false';

// In-process types whose handler is HEAVY and long-running (LAST_30_DAYS spawns a
// multi-minute Python CLI). These must NOT be awaited inline in the dispatch loop —
// doing so suspends the loop for the whole run and starves the ready worker queue
// (observed: 13 workers stuck ready while one last30days ran). They are launched as
// tracked background jobs instead (counted against maxWorkers via `active`). Cheap
// in-process types (JUDGE_AFFECTED, SHOW_HOT_LEEDZ) still run inline because JUDGE
// gates the planner and both finish in well under a second.
const INPROC_BACKGROUND = new Set(['LAST_30_DAYS', 'BOUNCE_SWEEP']);

// Injected at the END of EVERY spawned worker's instructions (one place -> system-wide).
// A worker is an automated tool-caller, not a chat assistant. Every token the model EMITS
// is appended to the transcript and RE-BILLED as input on every later turn (the 5A+4B+...
// accumulation), so terse output shrinks all downstream turns too. goose exposes no
// per-call max_tokens knob, so this instruction IS the cap. The worker model (gemini-flash)
// is non-reasoning, so there is no hidden chain-of-thought to suppress.
const OUTPUT_DISCIPLINE = `

---
## OUTPUT DISCIPLINE (system — overrides any verbosity implied above)
You are an automated PRECRIME worker, not a chat assistant. Minimize output tokens:
- Emit ONLY tool calls, then a single one-line final status. No narration, no "Now I will…", no preamble, no restating the task or plan.
- Do not think out loud in text. Decide, call the tool, move on.
- Keep every tool argument minimal — a clause, not sentences. Put no prose in a field beyond what that field requires.
- Never re-read or re-summarize a prior tool result; it is already in your context.`;

function gooseExtArgs(taskType) {
    const ext = s => `--with-extension "${s}"`;
    // Use localhost, NOT 127.0.0.1: goose derives the extension name (and thus every tool's
    // function-call name) from this URL host. "127.0.0.1" sanitizes to "127_0_0_1_5179_mcp",
    // which STARTS WITH A DIGIT -- and Gemini/OpenRouter reject function names that don't start
    // with a letter or underscore, 400ing EVERY worker's first LLM call so it dies before doing
    // anything (the months-long "0 saves / workers exit without completing" bug). "localhost"
    // sanitizes to "localhost_5179_mcp" (starts with a letter) -> valid names -> workers run.
    // ?scope=<taskType> lets the server (tools/list) advertise a PRUNED pipeline schema for
    // this worker (see toolDefs.js scopedToolDefs). The derived goose extension name already
    // isn't "precrime" (it's host-derived, e.g. localhost_5179_mcp) and workers map tools by
    // semantics, so appending the query is safe; the host still starts with a letter so the
    // function-name-must-start-with-a-letter rule (see host note above) still holds.
    const precrime  = `--with-streamable-http-extension "http://localhost:5179/mcp?scope=${taskType}"`;
    const developer = '--with-builtin developer';
    const tavily    = ext(`python ${path.join(PRECRIME_ROOT, 'tools', 'tavily_lean_mcp.py')}`);
    const rss       = ext(`node ${path.join(PRECRIME_ROOT, 'rss', 'rss-scorer-mcp', 'index.js')}`);
    const base = [precrime, developer];            // every worker: the pipeline tool + shell
    switch (taskType) {
        case 'SCRAPE_SOURCE':       return [...base, tavily, rss];
        case 'DRILL_DOWN':
        case 'DRILL_CONTAINER':
        case 'ENRICH_CLIENT':
        case 'FIND_CLIENT_SOURCES':
        case 'DISCOVER_SOURCES':    return [...base, tavily];
        case 'LAST_30_DAYS':
        case 'APPLY_FACTLET':
        case 'DRAFT_OUTREACH':      return base;   // no external research -- pipeline + shell only
        default:                    return [...base, tavily];
    }
}

// ---------------------------------------------------------------------------
// RECIPE-based scoped worker (replaces the broken --no-profile ad-hoc path).
//
// goose derives an ad-hoc extension's NAME from its URL/command (precrime ->
// "localhost_5179_mcp", tavily -> "python"), so skills calling precrime__/tavily__
// hit "tool not found" and orphaned. A goose RECIPE declares each extension's name
// EXPLICITLY, so names match the skills AND we keep the per-type extension trim AND
// the ?scope=<type> pipeline-schema pruning. gooseExtArgs above is SUPERSEDED by this
// (kept for reference; no longer called). Validate output with `goose recipe validate`.
// ---------------------------------------------------------------------------
const _fwd = p => p.replace(/\\/g, '/');                 // YAML: backslash starts an escape
const _TAVILY_ARG = _fwd(path.join(PRECRIME_ROOT, 'tools', 'tavily_lean_mcp.py'));
const _RSS_ARG    = _fwd(path.join(PRECRIME_ROOT, 'rss', 'rss-scorer-mcp', 'index.js'));

// The per-type extension SET, emitted as recipe YAML lines (2-space list indent).
function recipeExtLines(taskType) {
    const precrime = [
        '  - type: streamable_http', '    name: precrime',
        `    uri: "http://127.0.0.1:5179/mcp?scope=${taskType}"`, '    timeout: 60',
    ];
    const developer = ['  - type: builtin', '    name: developer'];
    const tavily = [
        '  - type: stdio', '    name: tavily', '    cmd: python',
        `    args: ["${_TAVILY_ARG}"]`, '    timeout: 60',
    ];
    const rss = [
        '  - type: stdio', '    name: precrime-rss', '    cmd: node',
        `    args: ["${_RSS_ARG}"]`, '    timeout: 30',
    ];
    const base = [...precrime, ...developer];
    switch (taskType) {
        case 'SCRAPE_SOURCE':       return [...base, ...tavily, ...rss];
        case 'DRILL_DOWN':
        case 'DRILL_CONTAINER':
        case 'ENRICH_CLIENT':
        case 'FIND_CLIENT_SOURCES':
        case 'DISCOVER_SOURCES':    return [...base, ...tavily];
        case 'LAST_30_DAYS':
        case 'APPLY_FACTLET':
        case 'DRAFT_OUTREACH':      return base;
        default:                    return [...base, ...tavily];
    }
}

// Build a full recipe: named+scoped extensions + the skill (with injected packet) as the
// instructions block scalar. Block scalar (|) needs every line indented; content needs no
// YAML escaping. `prompt` auto-starts the run.
function buildWorkerRecipe(taskType, instructions) {
    // goose recipes treat {{name}} as template PARAMETERS. Deployed skills are rendered
    // ({{...}}-free), but neutralize any residual "{{" defensively -- a rendering miss then
    // degrades to slightly-off text instead of failing recipe validation and orphaning the worker.
    const safe = String(instructions).replace(/\{\{/g, '{ {');
    const indented = safe.split('\n').map(l => '    ' + l).join('\n');
    return [
        'version: "1.0.0"',
        `title: "PRECRIME ${taskType} worker"`,
        'description: "Scoped one-shot PRECRIME worker (named + pruned extensions)."',
        'prompt: "Begin the assigned task now. Follow the instructions exactly, then stop."',
        'extensions:',
        ...recipeExtLines(taskType),
        'instructions: |',
        indented,
        '',
    ].join('\n');
}

// Short human-readable subject for a task, for log lines. Unique ids tell you
// nothing; this says WHAT a task is working on -- the target record and, for
// drill-downs, which fields it is chasing. Pure string-building, no DB hit.
function taskDesc(task) {
    let inp = {};
    try { inp = task.input ? JSON.parse(task.input) : {}; } catch (_) {}
    // Human label (client company / booking "title — company") attached by
    // attachTaskLabels at claim time; raw id tail is the last-resort fallback only.
    const tail = task.label || (task.targetId ? task.targetId.slice(-6) : null);
    switch (task.type) {
        case 'DRILL_DOWN': {
            const missing = Array.isArray(inp.missing) && inp.missing.length
                ? ` missing=[${inp.missing.join(',')}]` : '';
            const what = task.targetType === 'Client' ? 'client' : 'booking';
            return `${what} "${tail}"${missing}`;
        }
        case 'DRILL_CONTAINER': {
            const t = (inp.containerContext && inp.containerContext.title) || task.label;
            return `container "${t || tail}" -> organizer+vendors`;
        }
        case 'LAST_30_DAYS': return 'last30days demand scan (VALUE_PROP topics)';
        case 'BOUNCE_SWEEP': return 'gmail bounce poll';
        case 'SCRAPE_SOURCE': return `source ${inp.url || inp.channel || tail || ''}`.trim();
        case 'ENRICH_CLIENT':
        case 'FIND_CLIENT_SOURCES': return `${task.targetType.toLowerCase()} "${tail || ''}"`.trim();
        case 'APPLY_FACTLET': return `factlet -> ${task.targetType.toLowerCase()} "${tail || ''}"`.trim();
        case 'DRAFT_OUTREACH': return `draft outreach for "${tail || ''}"`.trim();
        case 'DISCOVER_SOURCES': return 'find new scrape sources';
        default: return task.targetId ? `${task.targetType} ${tail}` : task.targetType;
    }
}

// ARMING GATE. The conductor loop boots with the MCP server (so workers can
// connect the instant the port binds) but stays DORMANT — it claims nothing,
// spawns nothing, and never self-feeds — until armConductor() is called. The
// arm signal is the orchestrator's first plan_tasks({mode:"workflow"|"headless"})
// call, i.e. the user picking RUN_WORKFLOW (interactive) or a headless launch.
// This is what stops the scheduler from burning tokens the moment goose/claude
// boots, before the user has chosen to run anything.
let armed = false;
// Target-hot condition (the deterministic "loop until N new hot leedz" supervisor). When a
// workflow is armed with targetHot > 0, the conductor counts how many bookings the in-process
// JUDGE_AFFECTED promotes to 'hot', and STOPS self-feeding once that count reaches the target.
// The check is a plain integer compare in Node — zero LLM tokens, no supervisory model loop.
let hotTarget = 0;
let hotProduced = 0;
// Live status reporter for work_status. Reassigned inside startConductor (where it can see the
// loop's active map + rest/halt scalars). conductorStatus() reads it. The conductor runs IN the
// MCP server process, so the orchestrator just calls precrime__pipeline({action:"work_status"})
// -- no stdin/IPC. Default (before start) says so.
let _reportStatus = () => ({ started: false, note: 'conductor not started' });
function conductorStatus() { return _reportStatus(); }
function armConductor(opts) {
    // A targeted (re)arm sets the goal and resets the counter for a fresh run. Passing no
    // target (the plain launcher arm) leaves any existing target untouched.
    const t = opts && opts.targetHot != null ? parseInt(opts.targetHot, 10) : 0;
    if (Number.isFinite(t) && t > 0) { hotTarget = t; hotProduced = 0; }
    if (armed) return;
    armed = true;
    console.error(`[conductor] ARMED${hotTarget ? ` — goal: ${hotTarget} new hot leed(s)` : ''} — claiming & dispatching tasks`);
}
function isArmed() { return armed; }

async function conductorLoop(cfg, hooks) {
    const w = (cfg && cfg.workers) || {};
    const pollMs           = Number.isFinite(w.pollMs)           ? w.pollMs           : 1500;
    const spawnStaggerMs   = Number.isFinite(w.spawnStaggerMs)   ? w.spawnStaggerMs   : 100;
    const hungWorkerKillMs = Number.isFinite(w.hungWorkerKillMs) ? w.hungWorkerKillMs : 300000;
    const maxWorkers       = Number.isFinite(w.maxWorkers)       ? w.maxWorkers       : 10;
    // The conductor is orchestrator-AGNOSTIC: it spawns whatever worker binary the
    // launcher declares via the PRECRIME_WORKER_* env vars. It hardcodes nothing about
    // claude or goose. Resolution order is always: env var > cfg.workers > default.
    //   Phase 1 (precrime.bat) sets all three vars → Claude workers.
    //   Phase 2 (goose.bat)    sets none           → falls back to the goose defaults.
    // Old config keys (gooseBin / gooseBaseArgs / gooseInstructionsFlag) are still
    // read for backward compatibility with existing precrime_config.json files.
    const workerBin = process.env.PRECRIME_WORKER_BIN
        || w.workerBin || w.gooseBin || 'goose';
    const workerBaseArgs = process.env.PRECRIME_WORKER_ARGS
        ? process.env.PRECRIME_WORKER_ARGS.split(/\s+/).filter(Boolean)
        : (Array.isArray(w.workerBaseArgs) ? w.workerBaseArgs
          : Array.isArray(w.gooseBaseArgs) ? w.gooseBaseArgs
          : ['run']);   // `goose run --instructions <file>`; goose has NO --no-session flag
    // PRECRIME_WORKER_INST_FLAG controls HOW the skill reaches the worker:
    //   'NONE'   → no flag; skill PATH is passed as a positional prompt arg (claude --print).
    //   '--foo'  → prepend this flag before the skill path (e.g. goose --instructions <file>).
    //   (unset)  → fall back to config, else '--instructions' (the goose.bat default).
    // Windows CMD `set "VAR="` DELETES the var (it becomes undefined, NOT ""), which is
    // why an explicit 'NONE' sentinel is used instead of relying on an empty string.
    const _ef = process.env.PRECRIME_WORKER_INST_FLAG;
    const workerInstFlag = _ef === 'NONE'                  ? ''
        : _ef !== undefined                               ? _ef
        : 'workerInstructionsFlag' in w                   ? w.workerInstructionsFlag
        : 'gooseInstructionsFlag'  in w                   ? w.gooseInstructionsFlag
        :                                                   '--instructions';
    // Optional per-worker session-name flag (goose: --name). goose.bat sets it so each worker's
    // goose session is named precrime-<TYPE>-<taskId> -- giving deterministic token/cost
    // attribution per task type in goose's sessions.db (read by token-report.js). Unset for
    // claude workers (no session-name concept), so the naming is skipped there.
    const workerNameFlag   = process.env.PRECRIME_WORKER_NAME_FLAG || '';
    const skillsRoot       = w.skillsRoot
        ? path.resolve(PRECRIME_ROOT, w.skillsRoot)
        : path.resolve(PRECRIME_ROOT, 'skills');

    // Boot guard: every mapped worker skill must exist on disk NOW. A missing file
    // means dispatch later fails with skill_file_missing — a wasted worker spawn and
    // a failed Task. Catch a broken/partial deploy loudly at startup instead.
    {
        const gaps = Object.entries(WORKER_SKILL_MAP)
            .filter(([, f]) => !fs.existsSync(path.resolve(skillsRoot, f)))
            .map(([t, f]) => `${t} -> ${f}`);
        if (gaps.length) {
            console.error(`[conductor] SKILL GAP — missing worker skill file(s) under ${skillsRoot}:`);
            gaps.forEach(g => console.error(`  ✗ ${g}`));
            console.error('[conductor] those task types WILL fail. Fix deploy.js skill list + redeploy, then restart.');
        } else {
            console.error(`[conductor] skill check OK — all ${Object.keys(WORKER_SKILL_MAP).length} worker skills present.`);
        }
    }

    // Self-feed: when the ready queue empties and no workers are running, the
    // conductor calls hooks.replan() (the planner) to top up the queue — draining
    // the backlog across fresh sessions until the planner switches to enrichment +
    // discovery on its own. The conductor never plans itself; replan is injected
    // by mcp_server.js so conductor.js stays orchestrator-agnostic.
    const replan = (hooks && typeof hooks.replan === 'function') ? hooks.replan : null;
    // In-process executor for JUDGE_AFFECTED / SHOW_HOT_LEEDZ (the hot-leedz path).
    // These have no spawned worker; the conductor runs them via this injected hook.
    const runInProcess = (hooks && typeof hooks.runInProcess === 'function') ? hooks.runInProcess : null;
    const idleReplanCooldownMs = Number.isFinite(w.idleReplanCooldownMs) ? w.idleReplanCooldownMs : 30000;

    // taskId -> { proc, killTimer }
    const active = new Map();
    // Start the replan clock at boot so the orchestrator's initial plan_tasks gets
    // a one-cooldown head start before the conductor self-feeds — avoids a
    // startup race where both create a planning session simultaneously.
    let lastReplanAt = Date.now();

    // ---- Pacing + circuit breaker (unattended-safe: pace spend, do NOT die) ----
    // Two mechanisms, deliberately different:
    //   haltReason (TRUE halt): ONLY real credit/quota exhaustion (provider 403 "key limit
    //     exceeded"). Money is actually gone — no amount of looping makes leedz and a human
    //     must top up — so freeze and surface it. This is the ONLY permanent stop left.
    //   restReason (SOFT pacing rest): hitting a normal work ceiling (workers-per-window,
    //     run-time-per-window, or a session's creation budget) is NOT fatal. The loop RESTS
    //     for restMs, resets its per-window counters, and RESUMES on its own — so an overnight
    //     run paces its spend across work/rest cycles instead of halting and waiting for a
    //     human to restart it. In-flight workers always finish first (event-driven cleanup).
    let haltReason = null;
    let haltLogged = false;
    let restReason = null;      // set while paused for a pacing rest; cleared on resume
    let restUntil = 0;          // epoch ms the current rest ends
    let restLogged = false;
    let workersSpawned = 0;     // per-window worker count (reset after each rest)

    // Expose live conductor state for work_status. Reads current values on every call, so it
    // always reflects the live `active` map + rest/halt/armed state -- this IS the answer to
    // "what workers are running right now / why is nothing progressing".
    _reportStatus = () => ({
        started: true,
        armed,
        running: active.size,
        workers: [...active.entries()].map(([taskId, w]) => ({
            taskId, type: w.type || null, task: w.desc || null,
            elapsedSec: w.startedAt ? Math.round((Date.now() - w.startedAt) / 1000) : null,
        })),
        resting: !!restReason && Date.now() < restUntil,
        restReason: restReason || null,
        restRemainingSec: (restReason && restUntil > Date.now()) ? Math.round((restUntil - Date.now()) / 1000) : 0,
        halted: !!haltReason,
        haltReason: haltReason || null,
        hotProduced, hotTarget,
    });
    let firstSpawnAt = 0;       // start of the current work window (reset after each rest)
    const maxWorkersPerRun = Number.isFinite(w.maxWorkersPerRun) ? w.maxWorkersPerRun : 150;
    const maxRunMs = Number.isFinite(w.maxRunMs) ? w.maxRunMs : 15 * 60 * 1000;
    const restMs = Number.isFinite(w.restMs) ? w.restMs : 20 * 60 * 1000;  // breather between work windows
    // LLM provider says credits/quota are gone -> every worker will 403; this one is a TRUE halt.
    // Match ONLY genuine LLM-provider credit/quota exhaustion. The bare "quota exceeded" was too
    // broad -- a Tavily/RSS "API quota exceeded" line tripped this and PERMANENTLY halted the whole
    // pipeline on an unrelated third-party error. Now "quota" only matches with a provider name.
    const CREDIT_EXHAUSTED_RE = /key limit exceeded|insufficient.*credits?|billing.*(hard|limit)|(openrouter|anthropic|openai|x-ai|deepseek|gemini|google)\b.*(quota|credit|rate limit|billing)/i;

    console.error(`[conductor] ready — pollMs=${pollMs} maxWorkers=${maxWorkers} hungKillMs=${hungWorkerKillMs}`);
    // GUARD: log the resolved worker config so the active orchestrator is never ambiguous.
    // 'NONE (positional prompt)' = claude-style; any '--flag' = file-passed (e.g. goose).
    const _flagDesc = workerInstFlag === '' ? 'NONE (positional prompt)' : workerInstFlag;
    console.error(`[conductor] worker config — bin=${workerBin} baseArgs=[${workerBaseArgs.join(' ')}] instFlag=${_flagDesc}`);
    console.error(`[conductor] self-feed ${replan ? `ENABLED (idle replan cooldown ${idleReplanCooldownMs}ms)` : 'DISABLED (no replan hook)'}; in-process exec ${runInProcess ? 'ENABLED (JUDGE_AFFECTED, SHOW_HOT_LEEDZ, LAST_30_DAYS)' : 'DISABLED'}`);
    console.error('[conductor] DORMANT — waiting for RUN_WORKFLOW (plan_tasks) before claiming/dispatching');

    while (true) {
        // Dormant until armed. No claim, no spawn, no self-feed before the user
        // (or a headless launch) actually starts the workflow. See armConductor().
        if (!armed) { await sleep(pollMs); continue; }

        // Circuit breaker tripped: freeze ALL new work (in-process LLM, worker spawn, replan).
        // Let any in-flight workers finish, then idle. Restart the process to resume.
        if (haltReason) {
            if (!haltLogged) {
                console.error(`[conductor] HALTED — ${haltReason}. No new workers/judges/replans; ${active.size} in-flight will finish. Restart to resume.`);
                haltLogged = true;
            }
            await sleep(pollMs);
            continue;
        }

        // Soft pacing rest: a work ceiling was hit. Wait out the breather (in-flight workers
        // finish and self-complete over HTTP — their cleanup is event-driven, not loop-driven),
        // then reset the per-window counters and resume. No restart, no babysitting.
        if (restReason) {
            if (Date.now() < restUntil) {
                if (!restLogged) {
                    console.error(`[conductor] RESTING ${Math.round((restUntil - Date.now()) / 60000)}min — ${restReason}. ${active.size} in-flight will finish; loop resumes automatically.`);
                    restLogged = true;
                }
                await sleep(pollMs);
                continue;
            }
            console.error(`[conductor] resuming after rest — ${restReason} cleared; fresh work window.`);
            restReason = null; restUntil = 0; restLogged = false;
            workersSpawned = 0; firstSpawnAt = 0;
            lastReplanAt = 0;   // let the next pass replan immediately to refill the queue
        }

        // Execute in-process tasks FIRST (JUDGE_AFFECTED → promotes bookings to hot;
        // SHOW_HOT_LEEDZ → marks them ready). These GATE the planner: a pending judge
        // or hot action suppresses APPLY_FACTLET / enrichment / discovery, so they
        // must reach terminal before the next replan or the pipeline deadlocks. Runs
        // synchronously in-process (no worker spawn), using the server's LLM.
        let stateChanged = false;   // did an in-process task actually change GATING state?
        if (runInProcess) {
            let inproc = [];
            try {
                inproc = await conductorGetReadyInProcessTasks(maxWorkers);
            } catch (e) {
                console.error('[conductor] in-process poll error:', e.message);
            }
            for (const t of inproc) {
                // Serialize heavy background in-process types: LAST_30_DAYS workers collide on a
                // shared file if run concurrently ("being used by another process" -> exit 1).
                // The old inline-await path serialized them for free; the background path does
                // not, so enforce one-at-a-time here. Leave extras READY (do NOT claim) for a
                // later poll once the running one settles.
                if (INPROC_BACKGROUND.has(t.type)) {
                    let activeOfType = 0;
                    for (const v of active.values()) if (v.inproc && v.type === t.type) activeOfType++;
                    if (activeOfType >= 1) continue;
                }
                const workerId = `conductor-inproc-${process.pid}-${t.id.slice(-6)}`;
                if (!(await conductorClaimTask(t.id, workerId))) continue;

                // HEAVY in-process job (e.g. LAST_30_DAYS' multi-minute Python CLI): run it
                // as a tracked BACKGROUND job so the dispatch loop keeps spawning the ready
                // worker queue instead of suspending here for the whole run. It occupies a
                // slot (active) so we don't oversubscribe maxWorkers, and self-completes on
                // resolution. A safety timer (below) frees the slot if the Python child hangs,
                // since there is no process handle to SIGTERM. LAST_30_DAYS does not change
                // planner gating state, so it needs none of the JUDGE stateChanged handling.
                if (INPROC_BACKGROUND.has(t.type)) {
                    // Safety kill: a background in-process job (last30days spawns a Python CLI that
                    // can hang on Reddit 403 / --deep — observed stuck 7.5+ min) has no process
                    // handle here, so without a timer it would hold its worker slot forever. At
                    // hungWorkerKillMs, fail it and free the slot; the `settled` guard makes the
                    // timer and the promise mutually exclusive so neither double-frees.
                    let settled = false;
                    const bgKill = setTimeout(async () => {
                        if (settled) return;
                        settled = true;
                        console.error(`[conductor] hung in-process job killed — ${t.type}: ${taskDesc(t)} (>${Math.round(hungWorkerKillMs / 1000)}s)`);
                        try { await conductorFailTask(t.id, 'hung_inproc_timeout'); } catch (_) {}
                        active.delete(t.id);
                    }, hungWorkerKillMs);
                    active.set(t.id, { proc: null, killTimer: bgKill, type: t.type, desc: taskDesc(t), startedAt: Date.now(), inproc: true });
                    console.error(`[conductor] in-process started (background) — ${t.type}: ${taskDesc(t)}`);
                    Promise.resolve()
                        .then(() => runInProcess(t))
                        .then((r) => {
                            // Log the ACTUAL result summary (e.g. "scanned 3, 1 bounced address(es),
                            // dead-flagged 1") when the handler returns one, not the generic
                            // taskDesc() placeholder -- taskDesc has no case for background types
                            // like BOUNCE_SWEEP (targetType:"none") and was silently printing "none".
                            if (!settled) console.error(`[conductor] in-process done — ${t.type}: ${(r && r.summary) || taskDesc(t)}`);
                        })
                        .catch(async (e) => {
                            if (settled) return;
                            console.error(`[conductor] in-process error — task=${t.id} type=${t.type}: ${e.message}`);
                            try { await conductorFailTask(t.id, `inproc_error: ${e.message}`); } catch (_) {}
                        })
                        .finally(() => { clearTimeout(bgKill); if (!settled) { settled = true; active.delete(t.id); } });
                    continue;
                }

                try {
                    const r = (await runInProcess(t)) || {};
                    // JUDGE_AFFECTED can promote/demote bookings (changes the gating state the
                    // planner reads). SHOW_HOT_LEEDZ is a read-only presenter -- it changes
                    // NOTHING, so it must NOT trigger an immediate replan. Treating it as a
                    // state change caused a tight spin: replan -> SHOW_HOT_LEEDZ -> budget
                    // exhausted -> session closed -> replan ... with no cooldown breather,
                    // whenever any hot booking sat unacted (see the container backlog).
                    if (t.type === 'JUDGE_AFFECTED') {
                        stateChanged = true;
                        // Target-hot supervisor: JUDGE_AFFECTED is the ONLY thing that promotes a
                        // booking to 'hot', so its ->hot transitions are exactly "new hot leedz".
                        // Count them; when the goal is met, halt self-feed (in-flight finish).
                        if (Number.isFinite(r.hotProduced) && r.hotProduced > 0) hotProduced += r.hotProduced;
                        if (hotTarget > 0 && hotProduced >= hotTarget) {
                            // GOAL reached = SUCCESS, not a fault. Go DORMANT (disarm) rather than
                            // set haltReason (which is reserved for real credit exhaustion and needs
                            // a process restart). A fresh RUN_WORKFLOW re-arms cleanly; in-flight
                            // workers finish. Fixes the permanent-freeze bug: hitting the goal used
                            // to freeze the conductor for the life of the process.
                            console.error(`[conductor] GOAL REACHED — produced ${hotProduced} new hot leed(s) (goal ${hotTarget}); going dormant. RUN_WORKFLOW again to continue.`);
                            armed = false;
                            hotTarget = 0;
                            hotProduced = 0;
                        }
                    }
                    // Prefer the handler's human-readable summary; fall back to the raw
                    // counters only if a handler doesn't supply one.
                    const detail = r.summary
                        || `${r.changed != null ? `changed=${r.changed}` : ''}${r.hotCount != null ? ` hot=${r.hotCount}` : ''}`.trim()
                        || taskDesc(t);
                    // SIGNAL over noise: a judge pass that moved NOTHING is not an event a
                    // human needs to read -- dozens of "unchanged" lines per cycle buried
                    // the real transitions. Log judge completions ONLY when a bucket moved;
                    // everything else (transitions, other in-process types, errors) prints.
                    const quiet = t.type === 'JUDGE_AFFECTED' && r.changed === 0;
                    if (!quiet) console.error(`[conductor] in-process done — ${t.type}: ${detail}${hotTarget ? ` [hot ${hotProduced}/${hotTarget}]` : ''}`);
                } catch (e) {
                    console.error(`[conductor] in-process error — task=${t.id} type=${t.type}: ${e.message}`);
                    await conductorFailTask(t.id, `inproc_error: ${e.message}`);
                }
            }
            // Only when a JUDGE_AFFECTED actually changed gating state do we let the next
            // replan fire immediately (skip the cooldown) -- there may be fresh hot work to
            // act on. A bare SHOW_HOT_LEEDZ pass changes nothing, so it falls through to the
            // normal idle cooldown instead of spinning.
            if (stateChanged) lastReplanAt = 0;
        }

        const slots = maxWorkers - active.size;
        let readyCount = 0;

        if (slots > 0) {
            let tasks;
            try {
                tasks = await conductorGetReadyTasks(slots);
            } catch (e) {
                console.error('[conductor] poll error:', e.message);
                await sleep(pollMs);
                continue;
            }
            readyCount = tasks.length;

            for (const task of tasks) {
                if (active.size >= maxWorkers) break;
                if (active.has(task.id)) continue;

                // Atomic claim -- skip if another conductor or worker beat us.
                const workerId = `conductor-${process.pid}-${task.id.slice(-6)}`;
                const claimed = await conductorClaimTask(task.id, workerId);
                if (!claimed) continue;

                const skillFile = path.resolve(skillsRoot, task.skillFile);
                let skillContent;
                try {
                    skillContent = fs.readFileSync(skillFile, 'utf8');
                } catch (e) {
                    console.error(`[conductor] skill file missing for task ${task.id} (${task.type}): ${skillFile}`);
                    await conductorFailTask(task.id, 'skill_file_missing');
                    continue;
                }
                // Inject the ALREADY-CLAIMED task packet at the TOP of the worker's
                // instructions so the worker does NOT spend turn 1 calling get_task (that
                // first turn is the most-multiplied term in the 5A+4B+... re-billing). The
                // conductor already holds the full task row (conductorGetReadyTasks returns
                // {...r}); the packet shape mirrors the get_task response so skills read the
                // same fields. task.input may arrive as a JSON string or an object -- handle
                // both. Then append the system-wide terse-output directive (both spawn paths
                // below inherit these via skillContent).
                let _taskInput = task.input;
                if (typeof _taskInput === 'string') {
                    try { _taskInput = JSON.parse(_taskInput); } catch (_) { _taskInput = {}; }
                }
                if (!_taskInput || typeof _taskInput !== 'object') _taskInput = {};
                const _packet = {
                    id: task.id, type: task.type, targetType: task.targetType,
                    targetId: task.targetId, sessionId: task.sessionId, input: _taskInput
                };
                // TOKEN DIET: strip the YAML frontmatter block (name/description/triggers) —
                // it exists for skill DISCOVERY, not execution; the worker already has its
                // assignment, and every char here is re-billed on every worker turn.
                skillContent = skillContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
                // TOKEN DIET: for the VP-consuming worker types, inject the slim VALUE_PROP
                // slice into the packet so the worker skips its get_config / read-VALUE_PROP
                // turn entirely (a whole turn on the highest-count worker type).
                if (task.type === 'APPLY_FACTLET' || task.type === 'DRILL_CONTAINER') {
                    const vp = require('./runtime').VALUE_PROP || {};
                    _packet.vp = {
                        trade: vp.trade, geography: vp.geography, buyerRoles: vp.buyerRoles,
                        audienceSegments: vp.audienceSegments, notBuyer: vp.notBuyer,
                        relevanceSignals: vp.relevanceSignals, notRelevantSignals: vp.notRelevantSignals
                    };
                }
                // Packet + terse directive ride the end of the instructions (recency
                // position, strong for instruction-following).
                skillContent = skillContent +
                    '\n\n## ASSIGNED TASK — do NOT call get_task; this IS your task packet\n' +
                    '```json\n' + JSON.stringify(_packet, null, 2) + '\n```' +
                    OUTPUT_DISCIPLINE;

                // On Windows, npm CLI wrappers (.cmd files such as 'claude') cannot be
                // directly spawned by Node's spawn — CreateProcess only finds .exe files.
                // Write skill content to a temp .md file; write a temp .bat file that
                // uses cmd.exe's < redirect to feed it as claude's stdin. The redirect
                // operator inside the batch file is interpreted by cmd.exe correctly —
                // no quoting issues, no Node.js pipe race conditions.
                let proc;
                // goose scoped-worker mode (EXT_SCOPE on): spawn from a per-task RECIPE that names
                // extensions correctly (precrime / tavily / precrime-rss) and carries ?scope=<type>
                // for schema pruning. Claude / flag-off uses the plain --instructions path below.
                const useRecipe = EXT_SCOPE;
                const tmpRecipe = useRecipe ? path.join(os.tmpdir(), `precrime-${task.id}.yaml`) : null;
                if (useRecipe) fs.writeFileSync(tmpRecipe, buildWorkerRecipe(task.type, skillContent), 'utf8');
                if (process.platform === 'win32') {
                    const tmpMd  = path.join(os.tmpdir(), `precrime-${task.id}.md`);
                    const tmpBat = path.join(os.tmpdir(), `precrime-${task.id}.bat`);
                    // Deterministic session name -> per-type token/cost attribution in sessions.db.
                    const nameFlags = workerNameFlag ? ` ${workerNameFlag} "precrime-${task.type}-${task.id}"` : '';
                    let cmdLine;
                    if (useRecipe) {
                        // The recipe carries BOTH instructions and named/scoped extensions -> no --instructions.
                        cmdLine = `${workerBin} ${workerBaseArgs.join(' ')} --recipe "${tmpRecipe}"${nameFlags}`;
                    } else {
                        // Pass the skill FILE PATH as the prompt, not the content: skill files exceed
                        // cmd.exe's 8191-char arg limit and contain markdown that breaks cmd quoting.
                        // goose reads it via --instructions; claude via its Read tool.
                        fs.writeFileSync(tmpMd, skillContent, 'utf8');
                        const skillPrompt = workerInstFlag
                            ? `${workerInstFlag} "${tmpMd}"`
                            : `"Read the skill file at ${tmpMd} using the Read tool, then execute every instruction in it exactly. This is an automated PRECRIME worker task — use the precrime__pipeline MCP tools as the file directs. Do not ask for confirmation; proceed immediately."`;
                        cmdLine = `${workerBin} ${workerBaseArgs.join(' ')}${nameFlags} ${skillPrompt}`;
                    }
                    fs.writeFileSync(tmpBat,
                        `@echo off\r\n${cmdLine}\r\nexit /b %errorlevel%\r\n`,
                        'utf8');
                    // Raw command only when debugging (PRECRIME_DEBUG_CMD); otherwise the
                    // readable "spawned — <type>: <desc>" line below is all a human needs.
                    if (process.env.PRECRIME_DEBUG_CMD) {
                        console.error(`[conductor] cmd task=${task.id.slice(-6)}: ${cmdLine.slice(0, 160)}${cmdLine.length > 160 ? '…' : ''}`);
                    }
                    proc = spawn('cmd.exe', ['/c', tmpBat], {
                        env:   { ...process.env, PRECRIME_TASK_ID: task.id, PRECRIME_TASK_TYPE: task.type },
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    const _clean = () => setTimeout(() => {
                        try { fs.unlinkSync(tmpMd);  } catch (_) {}
                        try { fs.unlinkSync(tmpBat); } catch (_) {}
                        try { if (tmpRecipe) fs.unlinkSync(tmpRecipe); } catch (_) {}
                    }, 500);
                    proc.once('exit',  _clean);
                    proc.once('error', _clean);
                } else {
                    const nameArgv = workerNameFlag ? [workerNameFlag, `precrime-${task.type}-${task.id}`] : [];
                    const argv = useRecipe
                        ? [...workerBaseArgs, '--recipe', tmpRecipe, ...nameArgv]
                        : (workerInstFlag
                            ? [...workerBaseArgs, ...nameArgv, workerInstFlag, skillContent]
                            : [...workerBaseArgs, ...nameArgv, skillContent]);
                    // GUARD: log argv (skill body elided unless recipe) so the active flag is visible.
                    console.error(`[conductor] spawn → task=${task.id} cmd=${workerBin} ${argv.slice(0, useRecipe ? argv.length : -1).join(' ')}${useRecipe ? '' : ' <skill>'}`);
                    proc = spawn(workerBin, argv, {
                        env:   { ...process.env, PRECRIME_TASK_ID: task.id, PRECRIME_TASK_TYPE: task.type },
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    if (tmpRecipe) {
                        const _rm = () => setTimeout(() => { try { fs.unlinkSync(tmpRecipe); } catch (_) {} }, 500);
                        proc.once('exit', _rm); proc.once('error', _rm);
                    }
                }

                const killTimer = setTimeout(async () => {
                    console.error(`[conductor] hung worker killed — task=${task.id} type=${task.type}`);
                    try { proc.kill('SIGTERM'); } catch (_) {}
                    await conductorFailTask(task.id, 'hung_worker_timeout');
                    active.delete(task.id);
                }, hungWorkerKillMs);

                // Capture worker output (stdout+stderr) into a small rolling buffer so a
                // failure reports WHY, not just an exit code. goose prints its errors to
                // stdout, which is why earlier code=1 failures showed no reason.
                let outTail = '';
                const capture = (chunk) => { outTail = (outTail + chunk.toString()).slice(-600); };
                if (proc.stdout) proc.stdout.on('data', capture);
                if (proc.stderr) proc.stderr.on('data', capture);

                proc.on('exit', async (code) => {
                    clearTimeout(killTimer);
                    const label = `${task.type}: ${taskDesc(task)}`;
                    // Credit/quota exhaustion: the provider 403'd the worker's LLM. Every future
                    // worker will do the same, so trip the breaker instead of spawning more.
                    if (!haltReason && CREDIT_EXHAUSTED_RE.test(outTail)) {
                        haltReason = 'openrouter credits/quota exhausted (LLM 403 key limit)';
                    }
                    // code 0 / null (SIGTERM) = worker finished via MCP complete_task.
                    // Nonzero = failed; surface the captured output so the cause is visible.
                    if (code !== 0 && code !== null) {
                        const why = outTail.replace(/\s+/g, ' ').trim().slice(-240) || '(no worker output)';
                        console.error(`[conductor] FAILED — ${label} exit=${code}: ${why}`);
                        await conductorFailTask(task.id, `exit_${code}: ${why.slice(0, 140)}`);
                    } else {
                        // Exit 0 is SUPPOSED to mean the worker called complete_task. But if the
                        // task is STILL 'claimed', the worker exited WITHOUT completing it (ran out
                        // of turns, silently errored, skipped the final call). Finalize it as failed
                        // instead of leaving it a zombie until the 10-min stale-reclaim -- otherwise
                        // it churns: claimed -> reclaimed -> retried -> exits-without-complete, forever.
                        const orphaned = await conductorFailIfClaimed(task.id, 'worker_exited_without_complete_task');
                        if (orphaned) {
                            // Surface the worker's own stdout/stderr so we can SEE why it exited
                            // without completing (bad provider/key, MCP connect fail, no turns, etc).
                            const why = outTail.replace(/\s+/g, ' ').trim().slice(-400) || '(no worker output captured)';
                            console.error(`[conductor] ORPHAN — ${label}: exited 0, never completed. worker said: ${why}`);
                        } else {
                            console.error(`[conductor] DONE — ${label}`);
                        }
                    }
                    active.delete(task.id);
                });

                proc.on('error', async (e) => {
                    clearTimeout(killTimer);
                    console.error(`[conductor] spawn error — task=${task.id}: ${e.message}`);
                    await conductorFailTask(task.id, `spawn_error: ${e.message}`);
                    active.delete(task.id);
                });

                active.set(task.id, { proc, killTimer, type: task.type, desc: taskDesc(task), startedAt: Date.now() });
                console.error(`[conductor] spawned — ${task.type}: ${taskDesc(task)}`);

                // Per-WINDOW backstop: cap workers and wall-clock per work window, then REST
                // (not halt) so an unattended run paces its spend and resumes on its own after
                // the breather. Trips after the current batch; in-flight workers finish.
                workersSpawned++;
                if (!firstSpawnAt) firstSpawnAt = Date.now();
                if (!restReason && workersSpawned >= maxWorkersPerRun) {
                    restReason = `worker ceiling (${workersSpawned} this window)`;
                    restUntil = Date.now() + restMs;
                } else if (!restReason && Date.now() - firstSpawnAt >= maxRunMs) {
                    restReason = `run-time ceiling (${Math.round((Date.now() - firstSpawnAt) / 60000)} min this window)`;
                    restUntil = Date.now() + restMs;
                }

                if (spawnStaggerMs > 0 && tasks.indexOf(task) < tasks.length - 1) {
                    await sleep(spawnStaggerMs);
                }
            }
        }

        // Self-feed: only when FULLY idle (no ready tasks AND no running workers).
        // created>0 → loop immediately to dispatch the new tasks. created===0 →
        // genuinely no work this pass; back off for idleReplanCooldownMs so we do
        // not busy-loop the planner. As each session's budget exhausts the planner
        // closes it; the next replan (session_id omitted) opens a fresh session.
        if (replan && readyCount === 0 && active.size === 0) {
            const now = Date.now();
            if (now - lastReplanAt >= idleReplanCooldownMs) {
                lastReplanAt = now;
                try {
                    const r = (await replan()) || {};
                    console.error(`[conductor] replan — created=${r.createdTotal || 0} backlog=${r.backlogRemaining} strategy=${r.strategy}${r.sessionClosed ? ` sessionClosed(${r.closeReason})` : ''}`);
                    // Budget exhausted = this session hit its creation cap (it WAS productive —
                    // it created work right up to the limit). Don't die: take a pacing rest, then
                    // the next replan opens a FRESH session with a fresh budget and we keep going.
                    // The REST (rather than an immediate re-plan) is what prevents the old churn /
                    // credit-burn — we pace, we don't stop. In-flight workers finish during the rest.
                    if (r.sessionClosed && /budget_exhausted/i.test(r.closeReason || '')) {
                        if (!restReason) {
                            restReason = `session budget reached (${r.closeReason})`;
                            restUntil = Date.now() + restMs;
                        }
                        continue;
                    }
                    if ((r.createdTotal || 0) > 0) continue; // dispatch new tasks now
                } catch (e) {
                    console.error('[conductor] replan error:', e.message);
                }
            }
        }

        await sleep(pollMs);
    }
}

function startConductor(cfg, hooks) {
    if (cfg && cfg.workers && cfg.workers.enabled === false) {
        console.error('[conductor] disabled via workers.enabled=false');
        return;
    }
    conductorLoop(cfg, hooks).catch(e => console.error('[conductor] fatal loop crash:', e));
}

module.exports = { startConductor, armConductor, isArmed, buildWorkerRecipe, recipeExtLines, conductorStatus };
