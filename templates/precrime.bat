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

:: Database: optional argument overrides default
:: Usage:  precrime                       -> data\myproject.sqlite
::         precrime ca_schools_migrated   -> data\ca_schools_migrated.sqlite
if "%~1"=="" (
  set "DBNAME=myproject.sqlite"
) else (
  set "DBNAME=%~1"
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

:: Launch Claude -- skip all permission dialogs, pre-seed the startup prompt.
:: Pin to Sonnet 4.5. Without --model, Claude Code defaults to Opus which is far more expensive.
claude --dangerously-skip-permissions --chrome --model claude-sonnet-4-5 "run precrime (database: %DBNAME%)"
