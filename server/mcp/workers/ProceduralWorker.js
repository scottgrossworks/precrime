// ProceduralWorker.js -- base for the non-LLM worker lane.
//
// Procedural workers do their job in plain JS (no goose, no model). This base holds the
// one primitive shared across procedural workers that shell out to a CLI: runCli() spawns
// a command from the repo root and resolves when it exits 0, rejecting otherwise. Concrete
// workers (e.g. Last30DaysWorker) then read whatever file the CLI produced.

const path = require('path');
const { spawn } = require('child_process');

const { Worker } = require('./Worker');

// server/mcp/workers/ -> up three = repo root (where last30days/ and data/ live).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Hard ceiling on any CLI child. Must stay BELOW the conductor's hungKillMs (300s) so a
// slow CLI fails as a real, reportable error instead of being force-killed as a hung job
// (which reports nothing and leaves the task to be re-planned forever). 240s matches the
// last30days package's own eval harness default (scripts/evaluate_search_quality.py).
const CLI_TIMEOUT_MS = 240000;

class ProceduralWorker extends Worker {
    // Spawn `bin args` from REPO_ROOT, inheriting process.env (which carries the API keys
    // applied at startup by runtime.js). Resolves on exit 0.
    //
    // stdio: ['ignore', 'ignore', 'pipe'] -- STDOUT IS DISCARDED AT THE OS LEVEL, NOT
    // "ignored by not reading it" (2026-08-10). The old call used default stdio, which
    // gives stdout a PIPE with a fixed ~64KB kernel buffer, and then never read it. Any
    // CLI that prints more than that buffer blocks forever on write, 'close' never fires,
    // and this promise never settles. last30days.py prints a ProgressDisplay banner AND
    // --emit=json, so it tripped this constantly: 169 failed vs 57 done all-time, five
    // 300s hung-kills in a single observed run, and the demand scanner -- the one
    // component whose job is finding fresh PRIVATE demand -- effectively never ran.
    // The worker reads the CLI's output FILE, never its stdout, so discarding is safe.
    //
    // The timeout kills the child (SIGTERM, then SIGKILL) rather than merely rejecting:
    // an abandoned child keeps its handles and its API budget.
    runCli(bin, args, opts) {
        const timeoutMs = (opts && opts.timeoutMs) || CLI_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            let stderr = '';
            let child;
            try {
                child = spawn(bin, args, {
                    cwd: REPO_ROOT, env: process.env,
                    stdio: ['ignore', 'ignore', 'pipe']
                });
            } catch (e) {
                reject(new Error(`spawn ${bin} failed: ${e.message}`));
                return;
            }
            let settled = false;
            const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
            const timer = setTimeout(() => {
                try { child.kill('SIGTERM'); } catch (_) {}
                setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000).unref();
                finish(reject, new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s (killed): ${stderr.trim().slice(-300)}`));
            }, timeoutMs);
            if (timer.unref) timer.unref();
            if (child.stderr) child.stderr.on('data', d => { stderr += d.toString(); });
            child.on('error', e => finish(reject, new Error(`spawn ${bin} error: ${e.message}`)));
            child.on('close', code => {
                if (code === 0) finish(resolve);
                else finish(reject, new Error(`${bin} exited ${code}: ${stderr.trim().slice(-400)}`));
            });
        });
    }
}

module.exports = { ProceduralWorker, REPO_ROOT };
