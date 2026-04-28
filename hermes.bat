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

:: API keys for extensions (Tavily search, OpenRouter fallback)
set "OPENROUTER_API_KEY=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"
set "TAVILY_API_KEY=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"

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
