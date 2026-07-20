@echo off
setlocal
cd /d "%~dp0"

:: ============================================================================
:: PRECRIME launcher (Goose). Required order:
::   1. Validate precrime_config.json exists and parses.
::   2. Lift PRECRIME_* + API keys into env via bootstrap_config.js.
::   3. Parse args -> mode + DB name. Verify DB file exists.
::   4. Verify the chosen LLM provider has its key. Verify Tavily key.
::   5. Run setup.bat (npm install + prisma generate). Idempotent.
::   6. (removed) Config is read in-memory at MCP startup from VALUE_PROP.md.
::   7. Render goose user config + patch GOOSE.md project root.
::   8. Launch goose.
:: ============================================================================

:: --- 1. precrime_config.json gate ---
if not exist "%~dp0precrime_config.json" (
  echo.
  echo  precrime_config.json not found at: %~dp0precrime_config.json
  echo  Copy precrime_config.sample.json to precrime_config.json and fill it in.
  echo.
  pause
  exit /b 1
)

:: --- 2. bootstrap env from precrime_config.json ---
:: Emits: PRECRIME_DEPLOYMENT_NAME, PRECRIME_DATABASE_FILE, PRECRIME_DEFAULT_MODE,
::        PRECRIME_LLM_PROVIDER, PRECRIME_LLM_MODEL, PRECRIME_LLM_BASE_URL,
::        OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, TAVILY_API_KEY
::        (each only when non-empty in the config).
for /f "usebackq delims=" %%v in (`node "%~dp0scripts\bootstrap_config.js"`) do %%v
if errorlevel 1 (
  echo.
  echo  bootstrap_config.js failed. Check precrime_config.json is valid JSON.
  pause
  exit /b 1
)

:: --- 3. Args -> mode + objective + DB ---
:: Usage:  goose.bat                                 -> interactive (hybrid), default DB
::         goose.bat --headless                      -> headless (marketplace), default DB
::         goose.bat --headless --outreach           -> headless outreach (Gmail required)
::         goose.bat --headless --hybrid mydb        -> headless hybrid with custom DB
::         goose.bat --interactive --marketplace     -> interactive marketplace-only
::         goose.bat mydb                            -> interactive (hybrid) with custom DB
::
:: Mode    : --headless | --interactive
:: Objective : --marketplace | --outreach | --hybrid
:: Defaults: headless => marketplace; interactive => hybrid.
set "PRECRIME_MODE=interactive"
set "PRECRIME_OBJECTIVE="
set "DBARG="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--headless" (
  set "PRECRIME_MODE=headless"
  shift
  goto :parse_args
)
if /i "%~1"=="--interactive" (
  set "PRECRIME_MODE=interactive"
  shift
  goto :parse_args
)
if /i "%~1"=="--marketplace" (
  set "PRECRIME_OBJECTIVE=marketplace"
  shift
  goto :parse_args
)
if /i "%~1"=="--outreach" (
  set "PRECRIME_OBJECTIVE=outreach"
  shift
  goto :parse_args
)
if /i "%~1"=="--hybrid" (
  set "PRECRIME_OBJECTIVE=hybrid"
  shift
  goto :parse_args
)
set "DBARG=%~1"
shift
goto :parse_args
:args_done

:: Apply objective defaults (headless => marketplace, interactive => hybrid).
if "%PRECRIME_OBJECTIVE%"=="" (
  if /i "%PRECRIME_MODE%"=="headless" (
    set "PRECRIME_OBJECTIVE=marketplace"
  ) else (
    set "PRECRIME_OBJECTIVE=hybrid"
  )
)

:: DB selection -- precrime_config.json "databaseFile" is the SINGLE knob
:: (emitted as PRECRIME_DATABASE_FILE by bootstrap_config.js above). Change that
:: one line + restart to switch DBs. CLI arg overrides for one run. Value may be
:: relative to this folder (data\myproject.sqlite) or absolute (C:\...\leedz.sqlite).
if not "%DBARG%"=="" ( set "DBSPEC=%DBARG%" ) else ( set "DBSPEC=%PRECRIME_DATABASE_FILE%" )
if "%DBSPEC%"=="" set "DBSPEC=data\myproject.sqlite"
set "DBSPEC=%DBSPEC:/=\%"
if not "%DBSPEC:~-7%"==".sqlite" set "DBSPEC=%DBSPEC%.sqlite"
:: Resolve DBSPEC -> absolute DBPATH: absolute as-is; contains "\" relative to here;
:: bare name under data\.
set "DBPATH="
if "%DBSPEC:~1,1%"==":"  set "DBPATH=%DBSPEC%"
if "%DBSPEC:~0,2%"=="\\" set "DBPATH=%DBSPEC%"
set "DBNOBS=%DBSPEC:\=%"
if not defined DBPATH if "%DBNOBS%"=="%DBSPEC%" set "DBPATH=%~dp0data\%DBSPEC%"
if not defined DBPATH set "DBPATH=%~dp0%DBSPEC%"

if "%DBPATH%"=="" (
  echo.
  echo  FATAL: Could not resolve database path.
  echo  Set "databaseFile" in precrime_config.json, e.g.:
  echo    "databaseFile": "data/myproject.sqlite"
  echo.
  pause
  exit /b 1
)
if not exist "%DBPATH%" (
  echo.
  echo  Database not found: %DBPATH%
  echo  Set "databaseFile" in precrime_config.json, or pass a name/path arg, then retry.
  echo.
  pause
  exit /b 1
)

:: Set DATABASE_URL absolute (Prisma resolves relative paths from CWD).
:: Inherited by the goose-spawned MCP server.
set "DATABASE_URL=file:%DBPATH%"

:: Ensure goose is on PATH (default install location from download_cli.ps1).
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

:: --- 4. API key validation tied to the chosen LLM provider ---
:: Provider comes from precrime_config.json llm.provider via PRECRIME_LLM_PROVIDER.
:: Each provider needs its own key emitted into env by bootstrap_config.js.
set "LLM_PROVIDER=%PRECRIME_LLM_PROVIDER%"
if "%LLM_PROVIDER%"=="" set "LLM_PROVIDER=openai"

if /i "%LLM_PROVIDER%"=="openai" (
  if "%OPENAI_API_KEY%"=="" (
    echo.
    echo  llm.provider=openai but apiKeys.openai is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else if /i "%LLM_PROVIDER%"=="anthropic" (
  if "%ANTHROPIC_API_KEY%"=="" (
    echo.
    echo  llm.provider=anthropic but apiKeys.anthropic is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else if /i "%LLM_PROVIDER%"=="openrouter" (
  if "%OPENROUTER_API_KEY%"=="" (
    echo.
    echo  llm.provider=openrouter but apiKeys.openrouter is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else (
  echo.
  echo  Unknown llm.provider="%LLM_PROVIDER%" in precrime_config.json.
  echo  Expected one of: openai, anthropic, openrouter.
  echo.
  pause & exit /b 1
)

if "%TAVILY_API_KEY%"=="" (
  echo.
  echo  TAVILY_API_KEY missing. Set apiKeys.tavily in precrime_config.json.
  echo  Tavily is required for url-loop / source discovery scraping.
  echo.
  pause & exit /b 1
)

:: GOOSE_MODEL precedence: pre-set env wins > PRECRIME_LLM_MODEL > hardcoded default.
if "%GOOSE_MODEL%"=="" if not "%PRECRIME_LLM_MODEL%"=="" set "GOOSE_MODEL=%PRECRIME_LLM_MODEL%"
if "%GOOSE_MODEL%"=="" set "GOOSE_MODEL=google/gemini-3-flash-preview"

:: Preflight: confirm goose binary is on PATH.
where goose >nul 2>&1
if errorlevel 1 (
  echo.
  echo  goose not found on PATH.
  echo  Install: iwr -useb https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 ^| iex
  echo.
  pause
  exit /b 1
)

echo.
echo  Pre-Crime (Goose)  -  Provider: %LLM_PROVIDER%  Model: %GOOSE_MODEL%
echo  Database: %DBPATH%
echo.

:: Stop a prior PRECRIME MCP server + any orphaned workers to release the Prisma
:: DLL lock. Match COMMAND LINE, never image name -- a blanket `taskkill /IM
:: node.exe` / `claude.exe` would crash the user's interactive Claude Code session
:: (Claude Code runs as node/claude too). Kills only mcp_server.js + worker procs.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','claude.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*mcp_server.js*' -or $_.CommandLine -like '*--print*' -or $_.CommandLine -like '*--no-session*' -or $_.CommandLine -like '*mcp_gmail.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul

:: --- 5. Build-artifact guard (npm install + prisma generate are DEPLOY steps in deploy.js;
:: the launcher only VERIFIES the tree is ready, it does not build). Missing client =>
:: deploy or unzip is incomplete; say how to finish and stop (no slow build at launch).
if not exist "%~dp0server\node_modules\@prisma\client\index.js" (
  echo.
  echo  Prisma client missing -- deploy incomplete.
  echo  Run:  setup.bat      ^(or re-run deploy.js on the build machine^)
  echo.
  pause
  exit /b 1
)

:: --- 6. (Config sync removed) ---
:: VALUE_PROP.md identity + precrime_config.json runtime config are read into an
:: in-memory struct by the MCP server at startup. No DB Config table to sync.
:: Edit DOCS\VALUE_PROP.md or precrime_config.json and restart to change config.

:: --- 7. Render goose user config + GOOSE.md from templates ---
:: Goose reads %APPDATA%\Block\goose\config\config.yaml. Regenerated every launch
:: so the project always owns its config (stale config can pin to a different project).
set "GOOSE_CFG_DIR=%APPDATA%\Block\goose\config"
set "GOOSE_CFG=%GOOSE_CFG_DIR%\config.yaml"
set "GOOSE_TPL=%~dp0goose_config.template.yaml"
if not exist "%GOOSE_TPL%" (
  echo.
  echo  goose_config.template.yaml not found at: %GOOSE_TPL%
  echo  Restore it from PRECRIME/templates or git.
  pause & exit /b 1
)
set "PROJECT_ROOT=%~dp0"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
if not exist "%GOOSE_CFG_DIR%" mkdir "%GOOSE_CFG_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tpl = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:GOOSE_TPL; $out = $tpl.Replace('__PROJECT_ROOT__', $env:PROJECT_ROOT).Replace('__GOOSE_MODEL__', $env:GOOSE_MODEL); [System.IO.File]::WriteAllText($env:GOOSE_CFG, $out, [System.Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo  Failed to write goose config: %GOOSE_CFG%
  pause & exit /b 1
)

set "GOOSE_MD=%~dp0GOOSE.md"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:GOOSE_MD; $out = $f.Replace('__PROJECT_ROOT__', $env:PROJECT_ROOT); [System.IO.File]::WriteAllText($env:GOOSE_MD, $out, [System.Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo  Failed to patch GOOSE.md
  pause & exit /b 1
)

:: --- 7b. Start the MCP server (HTTP transport on :5179) ---
:: The goose 'precrime' extension is streamable_http -> http://127.0.0.1:5179/mcp,
:: so the server MUST already be listening before goose launches, or the extension
:: fails to initialize and goose runs with NO precrime tools. (Mirrors precrime.bat.)
:: FIRST kill any stale server/worker from a prior run (parity with precrime.bat --
:: goose.bat historically lacked this, so a relaunch could bind-fail against a stale
:: server running OLD code, or goose could point at a dead :5179 -> "Transport send
:: error"). Match COMMAND LINE only, never bare image names: interactive goose
:: sessions and the user's Claude Code (also node.exe) must survive.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*mcp_server.js*' -or $_.CommandLine -like '*mcp_gmail.js*' -or $_.CommandLine -like '*--recipe*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul
:: Worker binary MUST be the absolute goose.exe path. The conductor spawns
:: `<bin> run --instructions <skill>` via cmd.exe; bare `goose` would resolve to
:: THIS goose.bat (same name, CWD searched before PATH) and recurse into the
:: launcher, which then treats the .md skill path as a DB arg and dies with
:: "Database not found: ...md.sqlite". Setting the full .exe path bypasses that.
set "PRECRIME_WORKER_BIN=%USERPROFILE%\.local\bin\goose.exe"
set "PRECRIME_WORKER_ARGS=run"
set "PRECRIME_WORKER_INST_FLAG=--instructions"
:: Name each worker's goose session precrime-<TYPE>-<taskId> so token-report.js can attribute
:: tokens + cost per task type from goose's sessions.db. goose only; claude workers ignore it.
set "PRECRIME_WORKER_NAME_FLAG=--name"
:: TOKEN ECONOMY: scope each spawned goose worker via a per-task RECIPE (conductor.js
:: buildWorkerRecipe). The recipe names extensions CORRECTLY (precrime / tavily / precrime-rss),
:: lists ONLY the ones the task type needs, and points precrime at ...?scope=<type> so the server
:: serves a PRUNED pipeline schema. This REPLACES the old --no-profile ad-hoc path, which let
:: goose derive names from the URL/command (precrime -> "localhost_5179_mcp", tavily -> "python")
:: and orphaned every worker with "tool not found" -> 0 hot leedz. Empty/0/false = OFF (plain
:: --instructions + full profile). goose only; claude workers ignore it.
set "PRECRIME_GOOSE_EXT_SCOPE=1"
:: Start in its OWN window (NOT /B). /B shares goose's console, and the conductor's
:: log writes collide with goose's interactive TUI -> goose's stdout handle goes bad
:: and it dies with "The parameter is incorrect. (os error 87)". A separate window
:: keeps the conductor logs visible AND leaves goose sole owner of its console.
start "PreCrime MCP (conductor)" node "%~dp0server\mcp\mcp_server.js"
:: Poll until :5179 is listening (up to 10s) instead of a fixed sleep.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[DateTime]::Now.AddSeconds(10);while([DateTime]::Now -lt $d){if(Get-NetTCPConnection -LocalPort 5179 -EA SilentlyContinue){break};Start-Sleep -Milliseconds 500}"

:: --- 8. Launch goose ---
:: Trigger text encodes BOTH mode and objective so init-wizard.md can detect
:: them without depending on env-variable inheritance into the goose process.
:: PRECRIME_OBJECTIVE is also exported (env) for any tool that prefers env over
:: prompt parsing.
:: Default orchestrator system prompt (workflow + headless): seed the queue, then STOP --
:: the Node conductor owns all dispatch. choice=hot OVERRIDES this in :pick_hot below,
:: because SHOW HOT LEEDZ is a foreground presenter, not background work.
set "PRECRIME_SYS=You are the Pre-Crime orchestrator on Goose. Do NOT read files first, do NOT print a menu, do NOT explain. ON THE FIRST TURN ONLY: your first tool call is mandatory and is the only thing you do -- call precrime__pipeline with action=plan_tasks mode=workflow objective=%PRECRIME_OBJECTIVE%, and when it returns reply with exactly one line: Queue seeded -- conductor running; call status for a summary. Then STOP. The line 'Queue seeded...' is the reply to the SEEDING turn only -- NEVER say it on any later turn. ON EVERY LATER TURN: when the user asks for status, results, progress, a report, or a summary, call precrime__pipeline action=status and reply with ONLY the report field from its JSON result, copied verbatim (it is pre-formatted); add nothing else and never answer a status request from memory or with the Queue-seeded line. Never call claim_task, never dispatch worker skills, never poll or loop -- the Node conductor owns all dispatch from here."

:: Headless: no menu, run straight through.
if /i "%PRECRIME_MODE%"=="headless" (
  set "GOOSE_TRIGGER=headless precrime objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
  goto :launch
)

:: Interactive: the LAUNCHER prints the menu (deterministic, model-independent) and
:: bakes the choice into the trigger as choice=hot|workflow. The wizard honors it and
:: does NOT re-print a menu. (set /p is kept OUT of if() blocks to dodge batch quirks.)
:menu
echo.
echo   ============================================================
echo      PRE-CRIME   --   objective: %PRECRIME_OBJECTIVE%
echo   ============================================================
echo      [1]  SHOW HOT LEEDZ    review judged-hot bookings (share / email / skip)
echo      [2]  RUN WORKFLOW      discover - scrape - enrich - judge (fills the queue)
echo      [Q]  QUIT
echo   ============================================================
set "PRECRIME_CHOICE="
set /p "PRECRIME_CHOICE=   Choose [1/2/Q]: "
if /i "%PRECRIME_CHOICE%"=="1" goto :pick_hot
if /i "%PRECRIME_CHOICE%"=="2" goto :pick_workflow
if /i "%PRECRIME_CHOICE%"=="Q" goto :quit
echo   Please type 1, 2, or Q.
goto :menu

:pick_hot
set "GOOSE_TRIGGER=run precrime choice=hot objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
:: SHOW HOT LEEDZ is a FOREGROUND presenter. Prime the SHOW_HOT_LEEDZ task deterministically
:: (hot_only does NOT arm the conductor, so it stays dormant and will not steal the task);
:: the orchestrator then only has to CLAIM it and present. Priming here removes the flaky
:: model from the seeding step.
set "PRECRIME_TARGET_HOT="
set "PRECRIME_PLAN_MODE=hot_only"
call :arm_conductor
:: ZERO-HOT UX (deterministic, launcher-owned): check the hot count HERE and, when it is
:: zero, present the goal menu in the SAME style as the main menu -- the LLM never formats
:: UX. The user decides a goal before the session even opens; [N] opens it anyway.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$out = '0'; try { $b = @{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{ name='pipeline'; arguments=@{ action='status' } } } | ConvertTo-Json -Depth 8; $r = Invoke-RestMethod -Uri 'http://127.0.0.1:5179/mcp' -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 20; $j = $r.result.content[0].text | ConvertFrom-Json; $out = [string][int]$j.stats.bookings.hot } catch {}; Set-Content -Path (Join-Path $env:TEMP 'precrime_hot.txt') -Value $out"
set "PRECRIME_HOT_COUNT=0"
if exist "%TEMP%\precrime_hot.txt" set /p PRECRIME_HOT_COUNT=<"%TEMP%\precrime_hot.txt"
set /a PRECRIME_HOT_COUNT+=0 2>nul
if %PRECRIME_HOT_COUNT% GTR 0 goto :hot_present
echo.
echo   ============================================================
echo      NO HOT LEEDZ ARE READY
echo   ============================================================
echo      [ENTER]  run the workflow -- auto-stops at the FIRST new hot leed
echo      [I]      interactive mode -- explore the DB, work leedz by hand
echo   ============================================================
set "PRECRIME_GOAL="
set /p PRECRIME_GOAL=   Choice [ENTER/I]:
if /i "%PRECRIME_GOAL%"=="I" goto :hot_present
if /i "%PRECRIME_GOAL%"=="N" goto :hot_present
set "PRECRIME_TARGET_HOT=1"
set "GOOSE_TRIGGER=run precrime choice=workflow objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
set "PRECRIME_PLAN_MODE=workflow"
call :arm_conductor
goto :workflow_sys
:hot_present
set "PRECRIME_SYS=You are the Pre-Crime orchestrator on Goose running the interactive SHOW HOT LEEDZ review. The SHOW_HOT_LEEDZ task has already been seeded for you. This OVERRIDES any routing in GOOSE.md or init-wizard.md: do NOT read init-wizard.md, do NOT call plan_tasks on startup, do NOT call start_session, and do NOT begin any session or cycle. Do these steps in order, then STOP. Step 1: call precrime__pipeline action=claim_task role=interactive-orchestrator with types listing only SHOW_HOT_LEEDZ. Step 2: if it returns a CLAIMED task, read the file skills/show-hot-leedz.md (print it with the developer shell) and follow it exactly against that claimed task id -- present each judged-hot booking and let the user pick share, email, or skip per booking, then complete that task id. If claim_task returns no task, reply exactly: No hot leedz to present. Goal? [number] = run workflow until that many new hot leedz / [ALL] = run continuously. then stop. You MAY use find, share_booking, dismiss_booking, and outreach draft tools. Do NOT claim worker tasks such as DRILL_DOWN or DRILL_CONTAINER or SCRAPE_SOURCE, and do NOT dispatch worker skills. EXCEPTION -- RUN THE WORKFLOW: the startup trigger message (run precrime choice=hot ...) is NOT a workflow request -- on startup ALWAYS do Step 1 first. Only when the user TYPES a later message asking to run, start, or continue the workflow, to fill the queue, or answering with a goal (a bare number, or ALL), you MUST immediately call precrime__pipeline with action=plan_tasks mode=workflow, adding targetHot=<N> for a number, targetHot=0 for ALL/continuous/'don't bother me', or targetHot=1 when no goal was stated (default: stop at the first new hot leed) -- this is the ONE permitted plan_tasks call and it overrides the startup rule above. Then reply exactly: Queue seeded -- conductor running (auto-stops after the goal when a number was given); ask for status anytime. Do not check status first, do not re-claim, do not explain, do not refuse."
goto :launch

:pick_workflow
set "GOOSE_TRIGGER=run precrime choice=workflow objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
:: Arm the conductor DETERMINISTICALLY. The cheap orchestrator model has proven unreliable at
:: issuing the one required plan_tasks call (it improvised start_session and stalled, leaving
:: the conductor DORMANT with no work running). Issue plan_tasks(workflow) ourselves; the Node
:: conductor then owns all dispatch and self-feeds. The goose session below is only for status.
:: GOAL default (2026-07-19): RUN WORKFLOW means run until ONE new hot leed, then
:: stop and surface it. No goal submenu -- the goal is steered MID-SESSION by telling
:: the orchestrator "until 5 hot leedz" (targetHot=5) or "don't bother me / keep
:: going" (targetHot=0 = continuous). Node counts ->hot promotions; zero model math.
set "PRECRIME_TARGET_HOT=1"
set "PRECRIME_PLAN_MODE=workflow"
call :arm_conductor
:workflow_sys
set "PRECRIME_SYS=You are the Pre-Crime orchestrator on Goose. The workflow has ALREADY been started for you (plan_tasks was issued by the launcher) and the Node conductor is now running all dispatch autonomously. This OVERRIDES any routing in GOOSE.md or init-wizard.md: do NOT read any skill file, do NOT call start_session, claim_task, or begin any session or cycle. ON THE FIRST TURN ONLY, reply with exactly one line: Queue seeded -- conductor running; call status for a summary. Then STOP. That line is the first-turn reply ONLY -- NEVER say it again on any later turn. ON EVERY LATER TURN: when the user asks for status, results, progress, a report, or a summary, call precrime__pipeline action=status and reply with ONLY the report field from its JSON result, copied verbatim (it is pre-formatted); add nothing else and never answer a status request from memory or with the Queue-seeded line. GOAL: the conductor is running with a goal of 1 new hot leed (default) -- it stops and goes dormant when found. EXCEPTION -- the ONLY time you call plan_tasks: when the user changes the GOAL mid-session. A number ('until 5 hot leedz') -> call precrime__pipeline action=plan_tasks mode=workflow targetHot=<that number> EXACTLY ONCE. Continuous ('don't bother me', 'keep going', 'no limit', 'run continuously') -> the same call with targetHot=0 EXACTLY ONCE. Reply one line confirming the goal. Never refuse a goal change."
goto :launch

:quit
echo   Exiting. The MCP server is still running in the background; close this window to stop it.
exit /b 0

:: Deterministically POST plan_tasks(%PRECRIME_PLAN_MODE%) to the already-listening MCP server
:: (:5179) so the conductor is primed regardless of what the orchestrator model does. This is
:: the one critical call the cheap model kept getting wrong (improvising start_session, then
:: stalling); the launcher owns it now. Failure is non-fatal (WARN) -- goose still launches.
:arm_conductor
powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = @{ action='plan_tasks'; mode=$env:PRECRIME_PLAN_MODE; objective=$env:PRECRIME_OBJECTIVE }; $th = 0; [void][int]::TryParse($env:PRECRIME_TARGET_HOT, [ref]$th); if ($th -gt 0) { $a.targetHot = $th }; $b = @{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{ name='pipeline'; arguments=$a } } | ConvertTo-Json -Depth 8; try { Invoke-RestMethod -Uri 'http://127.0.0.1:5179/mcp' -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 20 | Out-Null; $goal = ''; if ($th -gt 0) { $goal = ' (goal: ' + $th + ' new hot leedz, then auto-stop)' }; Write-Host ('  Conductor primed: plan_tasks ' + $env:PRECRIME_PLAN_MODE + $goal + '.') } catch { Write-Host ('  WARN: could not prime conductor via MCP: ' + $_.Exception.Message) }"
exit /b

:launch
echo  Mode: %PRECRIME_MODE%   Objective: %PRECRIME_OBJECTIVE%
"%USERPROFILE%\.local\bin\goose.exe" run --system "%PRECRIME_SYS%" -t "%GOOSE_TRIGGER%" -s
:: When the interactive session ends, return to the menu so the user can pick again
:: (e.g. [1] review -> back to menu -> [2] workflow) WITHOUT re-running the launcher or
:: restarting the MCP server (it is still up). pick_hot/pick_workflow reset SYS+TRIGGER each
:: pass, so the next choice starts clean. Headless is a single run -> exit.
if /i "%PRECRIME_MODE%"=="headless" goto :eof
goto :menu
