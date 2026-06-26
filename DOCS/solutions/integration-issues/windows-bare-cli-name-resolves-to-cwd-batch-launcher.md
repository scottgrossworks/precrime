---
module: conductor worker spawn (Phase 2 goose launcher)
date: 2026-06-26
problem_type: integration_issue
component: tooling
severity: critical
symptoms:
  - "Every spawned worker exits 1 with: Database not found: C:\\...\\precrime-<taskid>.md.sqlite ... Press any key to continue"
  - "The error text is the LAUNCHER's own message, not the worker's"
  - "conductor log shows cmd=goose run --instructions \"<tmp>.md\" yet no work is performed"
root_cause: config_error
resolution_type: config_change
related_components:
  - conductor
  - goose.bat
tags:
  - windows
  - process-spawn
  - name-collision
  - cwd-path-resolution
  - cli-launcher
  - goose
---

# Windows: spawning a bare CLI name runs the same-named .bat launcher in the CWD, not the .exe

## Problem

On Windows, the PRECRIME conductor spawns each worker as `goose run --instructions "<tmp>.md"`. Because the launch script is named `goose.bat` and lives in the working directory, the bare name `goose` resolved to **`goose.bat`** (the launcher) instead of **`goose.exe`** (the CLI) — so every worker re-invoked the launcher, which mis-parsed the skill `.md` path as a database name and died. Zero work was performed for ~two weeks.

## Symptoms

- Every worker exits `1` with `Database not found: C:\...\precrime-<taskid>.md.sqlite ... Press any key to continue`.
- That message is **`goose.bat`'s own** DB-validation error (it appends `.sqlite` to an unrecognized arg and calls `pause`), not goose.exe's.
- The conductor log shows the spawn command (`cmd=goose run --instructions "<tmp>.md"`) but the DB never changes.

## What Didn't Work

- Treating it as a config problem (the error literally says `Set "databaseFile" in precrime_config.json`) — the DB config was already correct; the message was a red herring emitted by the wrong process.
- Earlier passes chased *worker flags* (`--no-session`, `--instructions`) as the failure cause. Those were real but separate; fixing them didn't help because the binary being run was never goose.exe in the first place.

## Solution

Point the spawner at the **absolute** `.exe` path instead of a bare name. The launcher sets it (and the matching args) into the environment **before** starting the server, so the conductor inherits it:

```bat
:: goose.bat — before `start ... node mcp_server.js`
set "PRECRIME_WORKER_BIN=%USERPROFILE%\.local\bin\goose.exe"
set "PRECRIME_WORKER_ARGS=run"
set "PRECRIME_WORKER_INST_FLAG=--instructions"
```

The conductor reads `process.env.PRECRIME_WORKER_BIN` first (before any `goose` default), so it now spawns `C:\Users\<user>\.local\bin\goose.exe run --instructions "<tmp>.md"`.

**Confirmed fixed** when the conductor log changed from `cmd=goose run ...` to `cmd=C:\Users\Scott\.local\bin\goose.exe run ...` and workers began logging `[conductor] DONE — APPLY_FACTLET ...`.

## Why This Works

`cmd.exe` (and `CreateProcess` via PATHEXT) resolves an unqualified program name by searching the **current directory first**, then `PATH`, and tries extensions in `PATHEXT` order (`.COM;.EXE;.BAT;...`). When a `.bat` with the same stem sits in the CWD, it wins over a `.exe` that's only on `PATH`. An absolute path to the `.exe` bypasses all of that resolution. The collision is invisible in the conductor log because the log prints the *intended* command string (`goose ...`), not the resolved target.

## Prevention

- **Spawn external CLIs by absolute path**, especially when a launcher script shares the tool's name. Never rely on bare-name resolution when the CWD contains a same-named script.
- **When a subprocess "fails," first confirm WHICH binary actually ran.** An error that quotes a launcher's own text (here, `Press any key to continue` = a batch `pause`) is the tell that the wrong file was executed — debug the resolution, not the config the message points at.
- Keep the worker binary path injectable via env (`PRECRIME_WORKER_BIN`) so each launcher declares its own orchestrator explicitly rather than inheriting a fragile default. See [conductor-worker-stdout-result-channel](../architecture-patterns/conductor-worker-stdout-result-channel.md) for the conductor↔worker boundary.
