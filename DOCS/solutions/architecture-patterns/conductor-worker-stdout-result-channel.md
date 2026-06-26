---
name: conductor-worker-stdout-result-channel
description: Pattern for using worker stdout as a result fallback channel so silent exit-0-without-complete_task failures become visible and recoverable
metadata:
  type: architecture_pattern
module: PRECRIME — conductor.js
problem_type: reliability
severity: medium
---

# Worker Stdout as Result Channel

## Problem

One-shot workers exit code 0 if they complete normally OR if they crash silently without ever calling `complete_task` via MCP. The conductor's exit handler treats code 0 / null as "done" and logs "worker done" — but the task stays `claimed` permanently if `complete_task` was never called. There is no way to distinguish a successful completion from a silent no-op.

This is the "claimed forever" failure mode. It produces zero error output, zero logs, and the task sits in `claimed` state until the 10-minute recycler picks it up.

## Pattern

Workers emit a structured marker line to stdout on exit (success or failure). The conductor captures stdout and checks for it after exit.

### Worker side (skill convention)

Add as the last action in every skill, after `complete_task`:

```
PRECRIME_RESULT:{"taskId":"<taskId>","status":"done|failed","summary":"<one line>"}
```

Workers already call `complete_task` which is the authoritative result. This line is the fallback signal.

### Conductor side

Change `stdio[1]` from `'ignore'` to `'pipe'`:

```javascript
proc = spawn('cmd.exe', ['/c', tmpBat], {
    env:   { ...process.env, PRECRIME_TASK_ID: task.id },
    stdio: ['ignore', 'pipe', 'pipe']   // was ['ignore', 'ignore', 'pipe']
});

let stdoutBuf = '';
proc.stdout.on('data', chunk => { stdoutBuf += chunk.toString(); });

proc.on('exit', async (code) => {
    clearTimeout(killTimer);
    const resultMatch = stdoutBuf.match(/PRECRIME_RESULT:(\{.*\})/);
    if (code === 0 || code === null) {
        if (!resultMatch) {
            // Worker exited clean but emitted no result marker — silent failure
            console.error(`[conductor] WARN: worker exited clean with no result marker — task may be stuck — task=${task.id}`);
        } else {
            console.error(`[conductor] worker result: ${resultMatch[1]}`);
        }
    } else {
        console.error(`[conductor] worker non-zero exit — task=${task.id} code=${code}`);
        await conductorFailTask(task.id, `exit_code_${code}`);
    }
    active.delete(task.id);
});
```

## What This Buys

- **Visible silent failures**: exit-0-without-complete_task now logs a warning instead of silently passing
- **Auditability**: every worker outcome is logged with its structured result
- **Recovery**: conductor can optionally mark the task `failed` when no result marker is found, letting the recycler re-queue it instead of waiting 10 minutes

## Trade-offs

- Workers must emit the marker line as a skill convention — new skills need it, existing skills need a one-time update
- Does not replace MCP `complete_task` — MCP is still the authoritative write path for output data. This is a fallback signal only.
- stdout capture adds minor memory overhead for long-running workers (buffering output until exit)

## Status

Design only — not yet implemented. Identified during ideation 2026-06-23.
