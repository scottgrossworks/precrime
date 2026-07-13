@echo off
setlocal
cd /d "%~dp0"

:: --- Require precrime_config.json (Subproject 10) ---
:: Refuse to start when missing. bootstrap_config.js emits `set` lines for
:: PRECRIME_* runtime vars and (if filled) OPENAI_API_KEY/ANTHROPIC_API_KEY/TAVILY_API_KEY.
if not exist "%~dp0precrime_config.json" (
  echo.
  echo  precrime_config.json not found at: %~dp0precrime_config.json
  echo  Copy precrime_config.sample.json to precrime_config.json and fill it in.
  echo.
  pause
  exit /b 1
)
for /f "usebackq delims=" %%v in (`node "%~dp0scripts\bootstrap_config.js"`) do %%v
if errorlevel 1 (
  echo.
  echo  bootstrap_config.js failed. Check precrime_config.json is valid JSON.
  pause
  exit /b 1
)

:: Args -> mode + objective + DB. Same flag set as goose.bat.
:: Usage:  precrime                                  -> interactive (hybrid)
::         precrime --headless                       -> headless (marketplace)
::         precrime --headless --outreach            -> headless outreach (Gmail required)
::         precrime --interactive --marketplace mydb -> interactive marketplace, custom DB
::         precrime ca_schools_migrated              -> interactive (hybrid), custom DB
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

:: Defaults: headless => marketplace, interactive => hybrid.
if "%PRECRIME_OBJECTIVE%"=="" (
  if /i "%PRECRIME_MODE%"=="headless" ( set "PRECRIME_OBJECTIVE=marketplace" ) else ( set "PRECRIME_OBJECTIVE=hybrid" )
)

:: ---------------------------------------------------------------------------
:: DB selection -- precrime_config.json "databaseFile" is the SINGLE knob.
:: bootstrap_config.js (above) emitted it as PRECRIME_DATABASE_FILE. To switch
:: databases, change that ONE line and restart. A CLI arg overrides it for one
:: run. The value may be a path relative to this folder (e.g. data\myproject.sqlite)
:: or an absolute path (e.g. C:\Users\...\leedz.sqlite).
:: ---------------------------------------------------------------------------
if not "%DBARG%"=="" ( set "DBSPEC=%DBARG%" ) else ( set "DBSPEC=%PRECRIME_DATABASE_FILE%" )
if "%DBSPEC%"=="" set "DBSPEC=data\myproject.sqlite"
set "DBSPEC=%DBSPEC:/=\%"
if not "%DBSPEC:~-7%"==".sqlite" set "DBSPEC=%DBSPEC%.sqlite"

:: Resolve DBSPEC -> absolute DBPATH:
::   "X:\..." or "\\..."   absolute, used as-is
::   contains a backslash  path relative to this folder (e.g. data\foo.sqlite)
::   bare name             looked up under the data\ folder
set "DBPATH="
if "%DBSPEC:~1,1%"==":"  set "DBPATH=%DBSPEC%"
if "%DBSPEC:~0,2%"=="\\" set "DBPATH=%DBSPEC%"
set "DBNOBS=%DBSPEC:\=%"
if not defined DBPATH if "%DBNOBS%"=="%DBSPEC%" set "DBPATH=%~dp0data\%DBSPEC%"
if not defined DBPATH set "DBPATH=%~dp0%DBSPEC%"

:: Verify the DB file exists
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

:: Set DATABASE_URL for child processes -- Prisma reads this at runtime (absolute).
set "DATABASE_URL=file:%DBPATH%"

:: --- 4. LLM provider + API key validation ---
:: The MCP server makes LLM calls (Judge, enrichment workers) using these keys.
:: Without a valid key the conductor workers will fail on every LLM call.
set "LLM_PROVIDER=%PRECRIME_LLM_PROVIDER%"
if "%LLM_PROVIDER%"=="" set "LLM_PROVIDER=openrouter"

if /i "%LLM_PROVIDER%"=="openai" (
  if "%OPENAI_API_KEY%"=="" (
    echo.
    echo  MISSING API KEY: llm.provider=openai but apiKeys.openai is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else if /i "%LLM_PROVIDER%"=="anthropic" (
  if "%ANTHROPIC_API_KEY%"=="" (
    echo.
    echo  MISSING API KEY: llm.provider=anthropic but apiKeys.anthropic is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else if /i "%LLM_PROVIDER%"=="openrouter" (
  if "%OPENROUTER_API_KEY%"=="" (
    echo.
    echo  MISSING API KEY: llm.provider=openrouter but apiKeys.openrouter is empty in precrime_config.json.
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
  echo  MISSING API KEY: apiKeys.tavily is empty in precrime_config.json.
  echo  Tavily is required for source discovery and URL scraping.
  echo  Edit: %~dp0precrime_config.json
  echo.
  pause & exit /b 1
)

echo.
echo  Pre-Crime
echo  Database: %DBPATH%
echo.

:: Preflight: confirm claude CLI is on PATH (parity with goose.bat preflight).
where claude >nul 2>&1
if errorlevel 1 (
  echo.
  echo  claude CLI not found on PATH.
  echo  Install: npm install -g @anthropic-ai/claude-code
  echo.
  pause
  exit /b 1
)

:: Stop a prior PRECRIME MCP server + any orphaned workers to release the Prisma
:: DLL lock. Match COMMAND LINE, never image name -- a blanket `taskkill /IM
:: node.exe` / `claude.exe` would crash the user's interactive Claude Code session
:: (Claude Code runs as node/claude too). Kills only mcp_server.js + worker procs.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','claude.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*mcp_server.js*' -or $_.CommandLine -like '*--print*' -or $_.CommandLine -like '*--no-session*' -or $_.CommandLine -like '*mcp_gmail.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul

:: Build-artifact guard. npm install + prisma generate are DEPLOY steps (deploy.js runs
:: them); the launcher only VERIFIES the tree is ready, it does not build. Missing client
:: => deploy or unzip is incomplete; say how to finish and stop (no slow build at launch).
if not exist "%~dp0server\node_modules\@prisma\client\index.js" (
  echo.
  echo  Prisma client missing -- deploy incomplete.
  echo  Run:  setup.bat      ^(or re-run deploy.js on the build machine^)
  echo.
  pause
  exit /b 1
)

:: (Config sync removed.) VALUE_PROP.md identity + precrime_config.json runtime
:: config are read into an in-memory struct by the MCP server at startup. There
:: is no DB Config table to sync. Edit DOCS\VALUE_PROP.md or precrime_config.json
:: and restart to change config.

:: Worker binary -- conductor spawns ONE-SHOT workers that MATCH this orchestrator.
:: precrime.bat = Claude orchestrator -> Claude workers (--print non-interactive).
:: goose.bat    = Goose orchestrator  -> Goose workers  (these vars are NOT set there).
set "PRECRIME_WORKER_BIN=claude"
set "PRECRIME_WORKER_ARGS=--dangerously-skip-permissions --print --model claude-haiku-4-5-20251001"
set "PRECRIME_WORKER_INST_FLAG=NONE"

:: Start MCP server (HTTP mode). .mcp.json points Claude at http://127.0.0.1:5179/mcp.
:: Own window (NOT /B): /B shares the console and the conductor's log writes corrupt
:: the orchestrator's interactive TUI -> "The parameter is incorrect. (os error 87)".
start "PreCrime MCP (conductor)" node "%~dp0server\mcp\mcp_server.js"
:: Poll until :5179 is listening (up to 10s) instead of fixed sleep.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[DateTime]::Now.AddSeconds(10);while([DateTime]::Now -lt $d){if(Get-NetTCPConnection -LocalPort 5179 -EA SilentlyContinue){break};Start-Sleep -Milliseconds 500}"

:: --- 8. Launch. INTERACTIVE shows a MENU (deterministic, model-independent) so YOU pick
:: SHOW HOT LEEDZ vs RUN WORKFLOW. HEADLESS runs the workflow straight through. Each path arms
:: the conductor deterministically and hands Claude a TERSE prompt (no init-wizard read, no
:: narration). Pinned to Sonnet 4.5 (no --model -> Claude defaults to pricier Opus). ---
set "PRECRIME_TRIGGER="

:: Default terse SYS = workflow/headless (background). pick_hot overrides it below.
set "PRECRIME_SYS=You are the Pre-Crime orchestrator on Claude. The workflow has ALREADY been started (plan_tasks was issued by the launcher) and the Node conductor is running all dispatch. Do NOT read any file, do NOT call plan_tasks, start_session, or claim_task, do NOT explain or narrate. Reply with EXACTLY one line: Queue seeded -- conductor running; call status for a summary. Then STOP. If the user later asks for progress, call the precrime pipeline status action and quote it verbatim."

:: Headless: no menu. Seed the workflow trigger, then arm + launch via :pick_workflow.
if /i "%PRECRIME_MODE%"=="headless" (
  set "PRECRIME_TRIGGER=headless precrime objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
  goto :pick_workflow
)

:menu
:: Clear the trigger each pass so a second choice (after returning here) starts clean --
:: otherwise [1] then [2] would inherit [1]'s trigger. pick_hot/pick_workflow set SYS fresh.
set "PRECRIME_TRIGGER="
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
:: SHOW HOT LEEDZ = FOREGROUND presenter. Seed the SHOW_HOT_LEEDZ task via hot_only (this does
:: NOT arm the conductor, so it stays dormant and will not steal the task); the orchestrator
:: only has to CLAIM it and present. Priming here removes the flaky model from the seed step.
set "PRECRIME_PLAN_MODE=hot_only"
call :arm_conductor
set "PRECRIME_TRIGGER=run precrime choice=hot objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
set "PRECRIME_SYS=You are the Pre-Crime orchestrator on Claude running the interactive SHOW HOT LEEDZ review. The SHOW_HOT_LEEDZ task has already been seeded. Do NOT read init-wizard.md, do NOT call start_session, do NOT begin any session or cycle. Do these steps in order, then STOP. Step 1: call the precrime pipeline claim_task action role=interactive-orchestrator with types listing only SHOW_HOT_LEEDZ. Step 2: if it returns a CLAIMED task, read skills/show-hot-leedz.md and follow it exactly against that claimed task id: present each judged-hot booking and let the user pick share, outreach, skip, or enrich per booking, then complete that task id. If claim_task returns no task, reply exactly: No hot leedz to present. then stop. You MAY use find, share_booking (pass a dtDraft you synthesize from the client dossier), dismiss_booking, gmail send, and outreach draft tools. Do NOT record the send yourself -- the gmail send tool PROCEDURALLY marks the client sent and resets its bookings out of hot; you never call save or mark anything. When the user asks to enrich or drill leedz, you MAY call plan_tasks with mode=workflow EXACTLY ONCE to hand enrichment to the background conductor, then keep presenting. Do NOT claim worker tasks such as DRILL_DOWN, DRILL_CONTAINER, or SCRAPE_SOURCE yourself, and do NOT run worker skill files."
goto :launch

:pick_workflow
:: RUN WORKFLOW (and headless) = BACKGROUND. Arm the conductor deterministically; the model
:: just confirms. Interactive [2] has no trigger yet -> set it; headless already set one above.
set "PRECRIME_PLAN_MODE=workflow"
call :arm_conductor
if not defined PRECRIME_TRIGGER set "PRECRIME_TRIGGER=run precrime choice=workflow objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
:: Set the workflow SYS explicitly (NOT relying on the pre-menu default) so a [1]->[2] loop does
:: not inherit the SHOW HOT LEEDZ prompt left by pick_hot.
set "PRECRIME_SYS=You are the Pre-Crime orchestrator on Claude. The workflow has ALREADY been started (plan_tasks was issued by the launcher) and the Node conductor is running all dispatch. Do NOT read any file, do NOT call start_session or claim_task, do NOT explain or narrate. Reply with EXACTLY one line: Queue seeded -- conductor running; call status for a summary. Then STOP. EXCEPTION -- the ONLY time you call plan_tasks: if the user asks to run/loop until a specific NUMBER of hot leedz (e.g. 'until 5 hot leedz'), call the precrime pipeline plan_tasks action with mode=workflow and targetHot=<that number> EXACTLY ONCE; the Node conductor then stops itself automatically once it has produced that many new hot leedz. If the user later asks for progress, call the precrime pipeline status action and quote it verbatim."
goto :launch

:quit
echo   Exiting. The MCP server is still running in its own window; close that window to stop it.
exit /b 0

:: Deterministically POST plan_tasks(%PRECRIME_PLAN_MODE%) to the already-listening MCP server
:: (:5179) so the conductor is primed regardless of what the orchestrator model does. Failure
:: is non-fatal (WARN); Claude still launches.
:arm_conductor
powershell -NoProfile -ExecutionPolicy Bypass -Command "$b = @{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{ name='pipeline'; arguments=@{ action='plan_tasks'; mode=$env:PRECRIME_PLAN_MODE; objective=$env:PRECRIME_OBJECTIVE } } } | ConvertTo-Json -Depth 8; try { Invoke-RestMethod -Uri 'http://127.0.0.1:5179/mcp' -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 20 | Out-Null; Write-Host ('  Conductor primed: plan_tasks ' + $env:PRECRIME_PLAN_MODE + '.') } catch { Write-Host ('  WARN: could not prime conductor via MCP: ' + $_.Exception.Message) }"
exit /b

:launch
echo  Mode: %PRECRIME_MODE%   Objective: %PRECRIME_OBJECTIVE%
claude --dangerously-skip-permissions --chrome --model claude-sonnet-4-5 --append-system-prompt "%PRECRIME_SYS%" "%PRECRIME_TRIGGER%"
:: When the interactive session ends, return to the menu so the user can pick again
:: (e.g. [1] review -> back to menu -> [2] workflow) WITHOUT re-running the launcher or
:: restarting the MCP server (it is still up). Headless is a single run -> exit.
if /i "%PRECRIME_MODE%"=="headless" goto :eof
goto :menu
