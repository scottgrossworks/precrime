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

:: Set DATABASE_URL for child processes -- goose-spawned MCP servers inherit this.
set "DATABASE_URL=file:%DBPATH%"

:: Ensure goose is on PATH (default install location from download_cli.ps1)
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

:: API key presence check. Keys come from precrime_config.json via bootstrap_config.js.
if "%OPENROUTER_API_KEY%"=="" if "%OPENAI_API_KEY%"=="" if "%ANTHROPIC_API_KEY%"=="" (
  echo.
  echo  No LLM API key in precrime_config.json apiKeys block.
  echo  Edit: %~dp0precrime_config.json
  echo.
  pause & exit /b 1
)
if "%TAVILY_API_KEY%"=="" (
  echo.
  echo  TAVILY_API_KEY missing in precrime_config.json apiKeys.tavily.
  echo  Edit: %~dp0precrime_config.json
  echo.
  pause & exit /b 1
)
if "%GOOSE_MODEL%"=="" if not "%PRECRIME_LLM_MODEL%"=="" set "GOOSE_MODEL=%PRECRIME_LLM_MODEL%"
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
if "%PRECRIME_MODE%"=="headless" (
  set "GOOSE_TRIGGER=headless precrime (database: %DBNAME%)"
) else (
  set "GOOSE_TRIGGER=run precrime (database: %DBNAME%)"
)
"%USERPROFILE%\.local\bin\goose.exe" run --system "First call developer__shell: type %~dp0GOOSE.md. Then follow it tersely." -t "%GOOSE_TRIGGER%" -s
