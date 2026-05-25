@echo off
setlocal
cd /d "%~dp0"

:: --- Require precrime_config.json (Subproject 10) ---
:: Refuse to start when missing.
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
:: Usage:  hermes                       -> data\myproject.sqlite
::         hermes ca_schools_migrated   -> data\ca_schools_migrated.sqlite
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

:: Set DATABASE_URL for child processes.
set "DATABASE_URL=file:%DBPATH%"

:: API keys come from precrime_config.json via bootstrap_config.js.
if "%OPENROUTER_API_KEY%"=="" if "%OPENAI_API_KEY%"=="" if "%ANTHROPIC_API_KEY%"=="" (
  echo  No LLM API key in precrime_config.json apiKeys block.
  pause & exit /b 1
)
if "%TAVILY_API_KEY%"==""     ( echo  TAVILY_API_KEY missing in precrime_config.json apiKeys.tavily & pause & exit /b 1 )

echo.
echo  Pre-Crime (Hermes)
echo  Database: data\%DBNAME%
echo.

:: Setup: install deps + generate Prisma client. Idempotent -- fast if already done.
call setup.bat
if errorlevel 1 (
  echo.
  echo Setup failed. Fix the error above and try again.
  pause
  exit /b 1
)

:: Launch Hermes via Docker
docker run -it --rm ^
  -e OPENAI_API_KEY=%OPENAI_API_KEY% ^
  -e ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY% ^
  -e TAVILY_API_KEY=%TAVILY_API_KEY% ^
  -e DATABASE_URL=%DATABASE_URL% ^
  -v "%CD%:/precrime" ^
  hermes-precrime
