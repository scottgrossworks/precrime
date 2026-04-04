@echo off
setlocal
cd /d "%~dp0"

:: Setup: install deps + ensure DB exists. Idempotent — fast if already done.
call setup.bat
if errorlevel 1 (
  echo.
  echo Setup failed. Fix the error above and try again.
  pause
  exit /b 1
)

:: Launch Claude — skip all permission dialogs, pre-seed the startup prompt
claude --dangerously-skip-permissions --chrome "run precrime"
