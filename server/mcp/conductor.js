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
const { conductorGetReadyTasks, conductorGetReadyInProcessTasks, conductorClaimTask, conductorFailTask, WORKER_SKILL_MAP } = require('./db');

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
const EXT_SCOPE = !!process.env.PRECRIME_GOOSE_EXT_SCOPE;
function gooseExtArgs(taskType) {
    const ext = s => `--with-extension "${s}"`;
    const precrime  = '--with-streamable-http-extension "http://127.0.0.1:5179/mcp"';
    const developer = '--with-builtin developer';
    const tavily    = ext(`python ${path.join(PRECRIME_ROOT, 'tools', 'tavily_lean_mcp.py')}`);
    const rss       = ext(`node ${path.join(PRECRIME_ROOT, 'rss', 'rss-scorer-mcp', 'index.js')}`);
    const base = [precrime, developer];            // every worker: the pipeline tool + shell
    switch (taskType) {
        case 'SCRAPE_SOURCE':       return [...base, tavily, rss];
        case 'DRILL_DOWN':
        case 'ENRICH_CLIENT':
        case 'FIND_CLIENT_SOURCES':
        case 'DISCOVER_SOURCES':    return [...base, tavily];
        case 'LAST_30_DAYS':
        case 'APPLY_FACTLET':
        case 'DRAFT_OUTREACH':      return base;   // no external research -- pipeline + shell only
        default:                    return [...base, tavily];
    }
}

// Short human-readable subject for a task, for log lines. Unique ids tell you
// nothing; this says WHAT a task is working on -- the target record and, for
// drill-downs, which fields it is chasing. Pure string-building, no DB hit.
function taskDesc(task) {
    let inp = {};
    try { inp = task.input ? JSON.parse(task.input) : {}; } catch (_) {}
    const tail = task.targetId ? task.targetId.slice(-6) : null;
    switch (task.type) {
        case 'DRILL_DOWN': {
            const missing = Array.isArray(inp.missing) && inp.missing.length
                ? ` missing=[${inp.missing.join(',')}]` : '';
            const what = task.targetType === 'Client' ? 'client' : 'booking';
            return `${what} ${tail}${missing}`;
        }
        case 'LAST_30_DAYS': return 'last30days demand scan (VALUE_PROP topics)';
        case 'SCRAPE_SOURCE': return `source ${inp.url || inp.channel || tail || ''}`.trim();
        case 'ENRICH_CLIENT':
        case 'FIND_CLIENT_SOURCES': return `${task.targetType.toLowerCase()} ${tail || ''}`.trim();
        case 'APPLY_FACTLET': return `factlet -> ${task.targetType.toLowerCase()} ${tail || ''}`.trim();
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
function armConductor() {
    if (armed) return;
    armed = true;
    console.error('[conductor] ARMED — workflow selected; conductor now claiming & dispatching tasks');
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

    console.error(`[conductor] ready — pollMs=${pollMs} maxWorkers=${maxWorkers} hungKillMs=${hungWorkerKillMs}`);
    // GUARD: log the resolved worker config so the active orchestrator is never ambiguous.
    // 'NONE (positional prompt)' = claude-style; any '--flag' = file-passed (e.g. goose).
    const _flagDesc = workerInstFlag === '' ? 'NONE (positional prompt)' : workerInstFlag;
    console.error(`[conductor] worker config — bin=${workerBin} baseArgs=[${workerBaseArgs.join(' ')}] instFlag=${_flagDesc}`);
    console.error(`[conductor] self-feed ${replan ? `ENABLED (idle replan cooldown ${idleReplanCooldownMs}ms)` : 'DISABLED (no replan hook)'}; in-process exec ${runInProcess ? 'ENABLED (JUDGE_AFFECTED, SHOW_HOT_LEEDZ)' : 'DISABLED'}`);
    console.error('[conductor] DORMANT — waiting for RUN_WORKFLOW (plan_tasks) before claiming/dispatching');

    while (true) {
        // Dormant until armed. No claim, no spawn, no self-feed before the user
        // (or a headless launch) actually starts the workflow. See armConductor().
        if (!armed) { await sleep(pollMs); continue; }

        // Execute in-process tasks FIRST (JUDGE_AFFECTED → promotes bookings to hot;
        // SHOW_HOT_LEEDZ → marks them ready). These GATE the planner: a pending judge
        // or hot action suppresses APPLY_FACTLET / enrichment / discovery, so they
        // must reach terminal before the next replan or the pipeline deadlocks. Runs
        // synchronously in-process (no worker spawn), using the server's LLM.
        let inprocHandled = 0;
        if (runInProcess) {
            let inproc = [];
            try {
                inproc = await conductorGetReadyInProcessTasks(maxWorkers);
            } catch (e) {
                console.error('[conductor] in-process poll error:', e.message);
            }
            for (const t of inproc) {
                const workerId = `conductor-inproc-${process.pid}-${t.id.slice(-6)}`;
                if (!(await conductorClaimTask(t.id, workerId))) continue;
                try {
                    const r = (await runInProcess(t)) || {};
                    inprocHandled++;
                    console.error(`[conductor] in-process done — ${t.type}: ${taskDesc(t)}${r.changed != null ? ` changed=${r.changed}` : ''}${r.hotCount != null ? ` hot=${r.hotCount}` : ''}`);
                } catch (e) {
                    console.error(`[conductor] in-process error — task=${t.id} type=${t.type}: ${e.message}`);
                    await conductorFailTask(t.id, `inproc_error: ${e.message}`);
                }
            }
            // We just changed gating state (judge/hot cleared) — let the next replan
            // fire immediately rather than waiting out the cooldown.
            if (inprocHandled > 0) lastReplanAt = 0;
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

                // On Windows, npm CLI wrappers (.cmd files such as 'claude') cannot be
                // directly spawned by Node's spawn — CreateProcess only finds .exe files.
                // Write skill content to a temp .md file; write a temp .bat file that
                // uses cmd.exe's < redirect to feed it as claude's stdin. The redirect
                // operator inside the batch file is interpreted by cmd.exe correctly —
                // no quoting issues, no Node.js pipe race conditions.
                let proc;
                if (process.platform === 'win32') {
                    const tmpMd  = path.join(os.tmpdir(), `precrime-${task.id}.md`);
                    const tmpBat = path.join(os.tmpdir(), `precrime-${task.id}.bat`);
                    fs.writeFileSync(tmpMd, skillContent, 'utf8');
                    // Pass the skill FILE PATH as the prompt, not the skill content.
                    // Skill files exceed cmd.exe's 8191-char arg limit and contain
                    // markdown special chars that break cmd.exe quoting. Passing the
                    // path instead lets the worker read the file via its Read tool
                    // (claude) or --instructions file path (goose Phase 2) and execute
                    // from there. Stdin redirect is avoided entirely — this also
                    // sidesteps the stdin-pipe/tool-call bug (GH #28010).
                    const skillPrompt = workerInstFlag
                        ? `${workerInstFlag} "${tmpMd}"`
                        : `"Read the skill file at ${tmpMd} using the Read tool, then execute every instruction in it exactly. This is an automated PRECRIME worker task — use the precrime__pipeline MCP tools as the file directs. Do not ask for confirmation; proceed immediately."`;
                    // Scope the worker to only the MCP extensions its task type needs
                    // (goose only; see gooseExtArgs). Cuts the per-turn tool-schema tax.
                    const extFlags = EXT_SCOPE ? ` --no-profile ${gooseExtArgs(task.type).join(' ')}` : '';
                    const cmdLine = `${workerBin} ${workerBaseArgs.join(' ')}${extFlags} ${skillPrompt}`;
                    fs.writeFileSync(tmpBat,
                        `@echo off\r\n${cmdLine}\r\nexit /b %errorlevel%\r\n`,
                        'utf8');
                    // GUARD: log the actual command so a wrong flag (e.g. an unexpected
                    // --instructions on a claude worker) shows up here, not as a crash.
                    console.error(`[conductor] batch → task=${task.id} cmd=${cmdLine.slice(0, 160)}${cmdLine.length > 160 ? '…' : ''}`);
                    proc = spawn('cmd.exe', ['/c', tmpBat], {
                        env:   { ...process.env, PRECRIME_TASK_ID: task.id },
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                    const _clean = () => setTimeout(() => {
                        try { fs.unlinkSync(tmpMd);  } catch (_) {}
                        try { fs.unlinkSync(tmpBat); } catch (_) {}
                    }, 500);
                    proc.once('exit',  _clean);
                    proc.once('error', _clean);
                } else {
                    const argv = workerInstFlag
                        ? [...workerBaseArgs, workerInstFlag, skillContent]
                        : [...workerBaseArgs, skillContent];
                    // GUARD: log argv (skill body elided) so the active flag is visible.
                    console.error(`[conductor] spawn → task=${task.id} cmd=${workerBin} ${argv.slice(0, -1).join(' ')} <skill>`);
                    proc = spawn(workerBin, argv, {
                        env:   { ...process.env, PRECRIME_TASK_ID: task.id },
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
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
                    // code 0 / null (SIGTERM) = worker finished via MCP complete_task.
                    // Nonzero = failed; surface the captured output so the cause is visible.
                    if (code !== 0 && code !== null) {
                        const why = outTail.replace(/\s+/g, ' ').trim().slice(-240) || '(no worker output)';
                        console.error(`[conductor] FAILED — ${label} exit=${code}: ${why}`);
                        await conductorFailTask(task.id, `exit_${code}: ${why.slice(0, 140)}`);
                    } else {
                        console.error(`[conductor] DONE — ${label}`);
                    }
                    active.delete(task.id);
                });

                proc.on('error', async (e) => {
                    clearTimeout(killTimer);
                    console.error(`[conductor] spawn error — task=${task.id}: ${e.message}`);
                    await conductorFailTask(task.id, `spawn_error: ${e.message}`);
                    active.delete(task.id);
                });

                active.set(task.id, { proc, killTimer });
                console.error(`[conductor] spawned — ${task.type}: ${taskDesc(task)}`);

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

module.exports = { startConductor, armConductor, isArmed };
