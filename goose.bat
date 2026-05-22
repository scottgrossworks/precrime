@echo off
setlocal
cd /d "%~dp0"

:: Mode: --headless flag triggers autonomous marketplace mode (no user interaction).
:: Usage:  goose.bat                       -> interactive
::         goose.bat --headless            -> headless marketplace
::         goose.bat --headless mydb       -> headless with custom DB
set "PRECRIME_MODE=interactive"
set "DBNAME=myproject.sqlite"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--headless" (
  set "PRECRIME_MODE=headless"
  shift
  goto :parse_args
)
set "DBNAME=%~1"
shift
goto :parse_args
:args_done

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

:: Set env var for child processes -- goose-spawned MCP servers inherit this
set "DATABASE_URL=file:%DBPATH%"

:: Ensure goose is on PATH (default install location from download_cli.ps1)
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

:: --- Load API keys from .env (single source of truth, see .env.sample) ---
:: To rotate any key: edit %~dp0.env, save, re-run.
if exist "%~dp0.env" (
  for /f "usebackq eol=# delims=" %%i in ("%~dp0.env") do set "%%i"
) else (
  echo.
  echo  .env file not found at: %~dp0.env
  echo  Copy .env.sample to .env and fill in your API keys.
  echo.
  pause
  exit /b 1
)

if "%OPENROUTER_API_KEY%"=="" (
  echo  OPENROUTER_API_KEY missing from .env. Add it and re-run.
  pause & exit /b 1
)
if "%OPENROUTER_API_KEY%"=="sk-or-v1-REPLACE_ME" (
  echo.
  echo  API keys not set. Edit this file with your real keys, then restart:
  echo    %~dp0.env
  echo.
  pause & exit /b 1
)
if "%TAVILY_API_KEY%"=="" (
  echo  TAVILY_API_KEY missing from .env. Add it and re-run.
  pause & exit /b 1
)
if "%TAVILY_API_KEY%"=="tvly-REPLACE_ME" (
  echo.
  echo  API keys not set. Edit this file with your real keys, then restart:
  echo    %~dp0.env
  echo.
  pause & exit /b 1
)
if "%GOOSE_MODEL%"=="" set "GOOSE_MODEL=google/gemini-3-flash-preview"

:: --- Write goose user config from template ---
:: Goose reads %APPDATA%\Block\goose\config\config.yaml, NOT this folder's .mcp.json.
:: Without this step, a stale config can pin extensions to a different project. We
:: regenerate it on every launch so the project always owns its config.
:: Edit goose_config.template.yaml (NOT the file in %APPDATA%) to change defaults.
set "GOOSE_CFG_DIR=%APPDATA%\Block\goose\config"
set "GOOSE_CFG=%GOOSE_CFG_DIR%\config.yaml"
set "GOOSE_TPL=%~dp0goose_config.template.yaml"
if not exist "%GOOSE_TPL%" (
  echo.
  echo  goose_config.template.yaml not found at: %GOOSE_TPL%
  echo  Restore it from PRECRIME/templates or git.
  pause & exit /b 1
)
set "PROJECT_ROOT=%~dp0"
if "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
if not exist "%GOOSE_CFG_DIR%" mkdir "%GOOSE_CFG_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tpl = Get-Content -Raw -LiteralPath $env:GOOSE_TPL; $out = $tpl.Replace('__PROJECT_ROOT__', $env:PROJECT_ROOT).Replace('__GOOSE_MODEL__', $env:GOOSE_MODEL); [System.IO.File]::WriteAllText($env:GOOSE_CFG, $out, [System.Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo  Failed to write goose config: %GOOSE_CFG%
  pause & exit /b 1
)

:: Patch GOOSE.md with actual project root (build.bat stamps __PROJECT_ROOT__ as placeholder)
set "GOOSE_MD=%~dp0GOOSE.md"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Get-Content -Raw -LiteralPath $env:GOOSE_MD; $out = $f.Replace('__PROJECT_ROOT__', $env:PROJECT_ROOT); [System.IO.File]::WriteAllText($env:GOOSE_MD, $out, [System.Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo  Failed to patch GOOSE.md
  pause & exit /b 1
)

:: GOOSE.md is the single entry point. init-wizard.md handles both interactive
:: and headless modes (mode passed as arg; default interactive).
:: GOOSE.md is injected via the --system flag at launch (see bottom of this file).

:: Preflight: confirm goose is actually on PATH
where goose >nul 2>&1
if errorlevel 1 (
  echo.
  echo  goose not found on PATH.
  echo  Install: iwr -useb https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 ^| iex
  echo.
  pause
  exit /b 1
)

echo.
echo  Pre-Crime (Goose)
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

:: Sync VALUE_PROP.md masthead into DB Config if available.
node "%~dp0server\sync-config.js" 2>nul

:: Launch goose session.
:: GOOSE.md is the routing table. --system can't hold the whole file (multi-line
:: text gets mangled by Windows arg passing), so the system instruction is short:
:: "Your first action is to read GOOSE.md from disk, then follow it." The model
:: bootstraps itself via developer__shell type on turn 1.
:: Use full path to goose.exe: cmd resolves CWD before PATH, so bare 'goose'
:: would match THIS .bat file and infinite-loop.
:: The -t flag sets the initial user message. "headless" in the message triggers
:: headless mode per GOOSE.md routing table; otherwise "run" triggers interactive.
if "%PRECRIME_MODE%"=="headless" (
  set "GOOSE_TRIGGER=headless precrime (database: %DBNAME%)"
) else (
  set "GOOSE_TRIGGER=run precrime (database: %DBNAME%)"
)
"%USERPROFILE%\.local\bin\goose.exe" run --system "First call developer__shell: type %~dp0GOOSE.md. Then follow it tersely." -t "%GOOSE_TRIGGER%" -s
