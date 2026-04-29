@echo off
setlocal
cd /d "%~dp0"

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

:: Write DATABASE_URL to server\.env -- Prisma reads this at runtime
:: Must use absolute path (Prisma resolves relative paths from CWD, not from .env location)
>"%~dp0server\.env" echo DATABASE_URL="file:%DBPATH%"

:: Also set env var for any child processes
set "DATABASE_URL=file:%DBPATH%"

echo.
echo  Pre-Crime
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

:: Launch Claude -- skip all permission dialogs, pre-seed the startup prompt.
:: Pin to Sonnet 4.5. Without --model, Claude Code defaults to Opus which is far more expensive.
claude --dangerously-skip-permissions --chrome --model claude-sonnet-4-5 "run precrime (database: %DBNAME%)"
