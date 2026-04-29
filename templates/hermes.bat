@echo off
setlocal
cd /d "%~dp0"

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

:: Write DATABASE_URL to server\.env -- Prisma reads this at runtime
:: Must use absolute path (Prisma resolves relative paths from CWD, not from .env location)
>"%~dp0server\.env" echo DATABASE_URL="file:%DBPATH%"

:: Also set env var for child processes
set "DATABASE_URL=file:%DBPATH%"

:: --- Load API keys from .env (single source of truth, see .env.sample) ---
if exist "%~dp0.env" (
  for /f "usebackq eol=# delims=" %%i in ("%~dp0.env") do set "%%i"
) else (
  echo  .env file not found at: %~dp0.env
  echo  Copy .env.sample to .env and fill in your API keys.
  pause & exit /b 1
)
if "%OPENROUTER_API_KEY%"=="" ( echo  OPENROUTER_API_KEY missing from .env & pause & exit /b 1 )
if "%TAVILY_API_KEY%"==""     ( echo  TAVILY_API_KEY missing from .env & pause & exit /b 1 )

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
  -e OPENROUTER_API_KEY=%OPENROUTER_API_KEY% ^
  -e TAVILY_API_KEY=%TAVILY_API_KEY% ^
  -e DATABASE_URL=%DATABASE_URL% ^
  -v "%CD%:/precrime" ^
  hermes-precrime
