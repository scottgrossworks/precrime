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

:: Args -> mode + objective + DB. Same flag set as precrime.bat / goose.bat.
:: Usage:  hermes                                   -> interactive (hybrid)
::         hermes --headless                        -> headless (marketplace)
::         hermes --headless --outreach             -> headless outreach (Gmail required)
::         hermes --interactive --marketplace mydb  -> interactive marketplace, custom DB
::         hermes ca_schools_migrated               -> interactive (hybrid), custom DB
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

echo  Mode: %PRECRIME_MODE%   Objective: %PRECRIME_OBJECTIVE%

:: Launch Hermes via Docker. PRECRIME_RUN_MODE and PRECRIME_OBJECTIVE are
:: exported into the container so the agent's init-wizard can detect them
:: even without a startup prompt.
docker run -it --rm ^
  -e OPENAI_API_KEY=%OPENAI_API_KEY% ^
  -e ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY% ^
  -e TAVILY_API_KEY=%TAVILY_API_KEY% ^
  -e DATABASE_URL=%DATABASE_URL% ^
  -e PRECRIME_RUN_MODE=%PRECRIME_MODE% ^
  -e PRECRIME_OBJECTIVE=%PRECRIME_OBJECTIVE% ^
  -v "%CD%:/precrime" ^
  hermes-precrime
