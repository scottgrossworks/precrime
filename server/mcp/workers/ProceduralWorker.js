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

class ProceduralWorker extends Worker {
    // Spawn `bin args` from REPO_ROOT, inheriting process.env (which carries the API keys
    // applied at startup by runtime.js). stdout is ignored (the CLI writes its own file);
    // stderr is collected for the rejection message. Resolves on exit 0.
    runCli(bin, args) {
        return new Promise((resolve, reject) => {
            let stderr = '';
            let child;
            try {
                child = spawn(bin, args, { cwd: REPO_ROOT, env: process.env });
            } catch (e) {
                reject(new Error(`spawn ${bin} failed: ${e.message}`));
                return;
            }
            if (child.stderr) child.stderr.on('data', d => { stderr += d.toString(); });
            child.on('error', e => reject(new Error(`spawn ${bin} error: ${e.message}`)));
            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(-400)}`));
            });
        });
    }
}

module.exports = { ProceduralWorker, REPO_ROOT };
