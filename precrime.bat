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
if /i "%~1"=="--share" (
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

:: Verify the DB path resolved and the file exists
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
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','claude.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*mcp_server.js*' -or $_.CommandLine -like '*--print*' -or $_.CommandLine -like '*--no-session*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul

:: Setup: install deps + generate Prisma client. Idempotent -- fast if already done.
call setup.bat
if errorlevel 1 (
  echo.
  echo Setup failed. Fix the error above and try again.
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
:: NONE sentinel: Windows CMD `set "VAR="` deletes the var; use NONE to signal "no flag".
set "PRECRIME_WORKER_BIN=claude"
set "PRECRIME_WORKER_ARGS=--dangerously-skip-permissions --print --model claude-haiku-4-5-20251001"
set "PRECRIME_WORKER_INST_FLAG=NONE"

:: Start MCP server (HTTP mode). .mcp.json now points Claude at http://127.0.0.1:5179/mcp
:: instead of spawning mcp_server.js as a child. DATABASE_URL is already in env above.
start "" /B node "%~dp0server\mcp\mcp_server.js"
:: Poll until :5179 is listening (up to 10s) instead of fixed sleep.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[DateTime]::Now.AddSeconds(10);while([DateTime]::Now -lt $d){if(Get-NetTCPConnection -LocalPort 5179 -EA SilentlyContinue){break};Start-Sleep -Milliseconds 500}"

:: Launch Claude -- skip all permission dialogs, pre-seed the startup prompt.
:: Pin to Sonnet 4.5. Without --model, Claude Code defaults to Opus which is far more expensive.
:: Mode + objective are encoded in the trigger prompt so init-wizard.md can
:: detect them deterministically (env-var inheritance into spawned MCP children
:: is not relied on for routing).
if /i "%PRECRIME_MODE%"=="headless" (
  set "PRECRIME_TRIGGER=headless precrime objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
) else (
  set "PRECRIME_TRIGGER=run precrime objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
)
echo  Mode: %PRECRIME_MODE%   Objective: %PRECRIME_OBJECTIVE%
claude --dangerously-skip-permissions --chrome --model claude-sonnet-4-5 "%PRECRIME_TRIGGER%"
