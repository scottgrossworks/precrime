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
set "DBNAME=myproject.sqlite"

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
set "DBNAME=%~1"
shift
goto :parse_args
:args_done

:: Defaults: headless => marketplace, interactive => hybrid.
if "%PRECRIME_OBJECTIVE%"=="" (
  if /i "%PRECRIME_MODE%"=="headless" ( set "PRECRIME_OBJECTIVE=marketplace" ) else ( set "PRECRIME_OBJECTIVE=hybrid" )
)

if not "%DBNAME:~-7%"==".sqlite" set "DBNAME=%DBNAME%.sqlite"

set "DBPATH=%~dp0data\%DBNAME%"

:: Verify the DB file exists
if not exist "%DBPATH%" (
  echo.
  echo  Database not found: data\%DBNAME%
  echo  Put your .sqlite file in the data\ folder and try again.
  echo.
  pause
  exit /b 1
)

:: Set DATABASE_URL for child processes -- Prisma reads this at runtime.
:: Must be absolute (Prisma resolves relative paths from CWD).
set "DATABASE_URL=file:%DBPATH%"

echo.
echo  Pre-Crime
echo  Database: data\%DBNAME%
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

:: Setup: install deps + generate Prisma client. Idempotent -- fast if already done.
call setup.bat
if errorlevel 1 (
  echo.
  echo Setup failed. Fix the error above and try again.
  pause
  exit /b 1
)

:: Sync VALUE_PROP.md masthead into DB Config. This is the source of truth for
:: companyName, companyEmail, businessDescription, defaultTrade, signature, etc.
:: Errors are surfaced (no `2>nul`): a silent failure here means the wizard will
:: interactively prompt for fields that ARE in VALUE_PROP.md.
echo  Syncing VALUE_PROP.md into Config...
node "%~dp0server\sync-config.js"
if errorlevel 1 (
  echo.
  echo  WARNING: sync-config.js failed. The wizard may prompt for VALUE_PROP fields.
  echo  Fix DOCS\VALUE_PROP.md or check DATABASE_URL=%DATABASE_URL%.
  echo.
)

:: Launch Claude -- skip all permission dialogs, pre-seed the startup prompt.
:: Pin to Sonnet 4.5. Without --model, Claude Code defaults to Opus which is far more expensive.
:: Mode + objective are encoded in the trigger prompt so init-wizard.md can
:: detect them deterministically (env-var inheritance into spawned MCP children
:: is not relied on for routing).
if /i "%PRECRIME_MODE%"=="headless" (
  set "PRECRIME_TRIGGER=headless precrime objective=%PRECRIME_OBJECTIVE% (database: %DBNAME%)"
) else (
  set "PRECRIME_TRIGGER=run precrime objective=%PRECRIME_OBJECTIVE% (database: %DBNAME%)"
)
echo  Mode: %PRECRIME_MODE%   Objective: %PRECRIME_OBJECTIVE%
claude --dangerously-skip-permissions --chrome --model claude-sonnet-4-5 "%PRECRIME_TRIGGER%"
