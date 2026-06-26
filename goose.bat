@echo off
setlocal
cd /d "%~dp0"

:: ============================================================================
:: PRECRIME launcher (Goose). Required order:
::   1. Validate precrime_config.json exists and parses.
::   2. Lift PRECRIME_* + API keys into env via bootstrap_config.js.
::   3. Parse args -> mode + DB name. Verify DB file exists.
::   4. Verify the chosen LLM provider has its key. Verify Tavily key.
::   5. Run setup.bat (npm install + prisma generate). Idempotent.
::   6. (removed) Config is read in-memory at MCP startup from VALUE_PROP.md.
::   7. Render goose user config + patch GOOSE.md project root.
::   8. Launch goose.
:: ============================================================================

:: --- 1. precrime_config.json gate ---
if not exist "%~dp0precrime_config.json" (
  echo.
  echo  precrime_config.json not found at: %~dp0precrime_config.json
  echo  Copy precrime_config.sample.json to precrime_config.json and fill it in.
  echo.
  pause
  exit /b 1
)

:: --- 2. bootstrap env from precrime_config.json ---
:: Emits: PRECRIME_DEPLOYMENT_NAME, PRECRIME_DATABASE_FILE, PRECRIME_DEFAULT_MODE,
::        PRECRIME_LLM_PROVIDER, PRECRIME_LLM_MODEL, PRECRIME_LLM_BASE_URL,
::        OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, TAVILY_API_KEY
::        (each only when non-empty in the config).
for /f "usebackq delims=" %%v in (`node "%~dp0scripts\bootstrap_config.js"`) do %%v
if errorlevel 1 (
  echo.
  echo  bootstrap_config.js failed. Check precrime_config.json is valid JSON.
  pause
  exit /b 1
)

:: --- 3. Args -> mode + objective + DB ---
:: Usage:  goose.bat                                 -> interactive (hybrid), default DB
::         goose.bat --headless                      -> headless (marketplace), default DB
::         goose.bat --headless --outreach           -> headless outreach (Gmail required)
::         goose.bat --headless --hybrid mydb        -> headless hybrid with custom DB
::         goose.bat --interactive --marketplace     -> interactive marketplace-only
::         goose.bat mydb                            -> interactive (hybrid) with custom DB
::
:: Mode    : --headless | --interactive
:: Objective : --marketplace | --outreach | --hybrid
:: Defaults: headless => marketplace; interactive => hybrid.
set "PRECRIME_MODE=interactive"
set "PRECRIME_OBJECTIVE="
set "DBARG="

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
if /i "%~1"=="--share" (
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
set "DBARG=%~1"
shift
goto :parse_args
:args_done

:: Apply objective defaults (headless => marketplace, interactive => hybrid).
if "%PRECRIME_OBJECTIVE%"=="" (
  if /i "%PRECRIME_MODE%"=="headless" (
    set "PRECRIME_OBJECTIVE=marketplace"
  ) else (
    set "PRECRIME_OBJECTIVE=hybrid"
  )
)

:: DB selection -- precrime_config.json "databaseFile" is the SINGLE knob
:: (emitted as PRECRIME_DATABASE_FILE by bootstrap_config.js above). Change that
:: one line + restart to switch DBs. CLI arg overrides for one run. Value may be
:: relative to this folder (data\myproject.sqlite) or absolute (C:\...\leedz.sqlite).
if not "%DBARG%"=="" ( set "DBSPEC=%DBARG%" ) else ( set "DBSPEC=%PRECRIME_DATABASE_FILE%" )
if "%DBSPEC%"=="" set "DBSPEC=data\myproject.sqlite"
set "DBSPEC=%DBSPEC:/=\%"
if not "%DBSPEC:~-7%"==".sqlite" set "DBSPEC=%DBSPEC%.sqlite"
:: Resolve DBSPEC -> absolute DBPATH: absolute as-is; contains "\" relative to here;
:: bare name under data\.
set "DBPATH="
if "%DBSPEC:~1,1%"==":"  set "DBPATH=%DBSPEC%"
if "%DBSPEC:~0,2%"=="\\" set "DBPATH=%DBSPEC%"
set "DBNOBS=%DBSPEC:\=%"
if not defined DBPATH if "%DBNOBS%"=="%DBSPEC%" set "DBPATH=%~dp0data\%DBSPEC%"
if not defined DBPATH set "DBPATH=%~dp0%DBSPEC%"

if "%DBPATH%"=="" (
  echo.
  echo  FATAL: Could not resolve database path.
  echo  Set "databaseFile" in precrime_config.json, e.g.:
  echo    "databaseFile": "data/myproject.sqlite"
  echo.
  pause
  exit /b 1
)
if not exist "%DBPATH%" (
  echo.
  echo  Database not found: %DBPATH%
  echo  Set "databaseFile" in precrime_config.json, or pass a name/path arg, then retry.
  echo.
  pause
  exit /b 1
)

:: Set DATABASE_URL absolute (Prisma resolves relative paths from CWD).
:: Inherited by the goose-spawned MCP server.
set "DATABASE_URL=file:%DBPATH%"

:: Ensure goose is on PATH (default install location from download_cli.ps1).
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

:: --- 4. API key validation tied to the chosen LLM provider ---
:: Provider comes from precrime_config.json llm.provider via PRECRIME_LLM_PROVIDER.
:: Each provider needs its own key emitted into env by bootstrap_config.js.
set "LLM_PROVIDER=%PRECRIME_LLM_PROVIDER%"
if "%LLM_PROVIDER%"=="" set "LLM_PROVIDER=openai"

if /i "%LLM_PROVIDER%"=="openai" (
  if "%OPENAI_API_KEY%"=="" (
    echo.
    echo  llm.provider=openai but apiKeys.openai is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else if /i "%LLM_PROVIDER%"=="anthropic" (
  if "%ANTHROPIC_API_KEY%"=="" (
    echo.
    echo  llm.provider=anthropic but apiKeys.anthropic is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else if /i "%LLM_PROVIDER%"=="openrouter" (
  if "%OPENROUTER_API_KEY%"=="" (
    echo.
    echo  llm.provider=openrouter but apiKeys.openrouter is empty in precrime_config.json.
    echo  Edit: %~dp0precrime_config.json
    echo.
    pause & exit /b 1
  )
) else (
  echo.
  echo  Unknown llm.provider="%LLM_PROVIDER%" in precrime_config.json.
  echo  Expected one of: openai, anthropic, openrouter.
  echo.
  pause & exit /b 1
)

if "%TAVILY_API_KEY%"=="" (
  echo.
  echo  TAVILY_API_KEY missing. Set apiKeys.tavily in precrime_config.json.
  echo  Tavily is required for url-loop / source discovery scraping.
  echo.
  pause & exit /b 1
)

:: GOOSE_MODEL precedence: pre-set env wins > PRECRIME_LLM_MODEL > hardcoded default.
if "%GOOSE_MODEL%"=="" if not "%PRECRIME_LLM_MODEL%"=="" set "GOOSE_MODEL=%PRECRIME_LLM_MODEL%"
if "%GOOSE_MODEL%"=="" set "GOOSE_MODEL=google/gemini-3-flash-preview"

:: Preflight: confirm goose binary is on PATH.
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
echo  Pre-Crime (Goose)  -  Provider: %LLM_PROVIDER%  Model: %GOOSE_MODEL%
echo  Database: %DBPATH%
echo.

:: Stop a prior PRECRIME MCP server + any orphaned workers to release the Prisma
:: DLL lock. Match COMMAND LINE, never image name -- a blanket `taskkill /IM
:: node.exe` / `claude.exe` would crash the user's interactive Claude Code session
:: (Claude Code runs as node/claude too). Kills only mcp_server.js + worker procs.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','claude.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*mcp_server.js*' -or $_.CommandLine -like '*--print*' -or $_.CommandLine -like '*--no-session*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul

:: --- 5. Setup ---
call setup.bat
if errorlevel 1 (
  echo.
  echo Setup failed. Fix the error above and try again.
  pause
  exit /b 1
)

:: --- 6. (Config sync removed) ---
:: VALUE_PROP.md identity + precrime_config.json runtime config are read into an
:: in-memory struct by the MCP server at startup. No DB Config table to sync.
:: Edit DOCS\VALUE_PROP.md or precrime_config.json and restart to change config.

:: --- 6b. Start MCP server (HTTP mode) ---
:: mcp_server.js binds :5179 and conductor.js starts inside it.
:: Goose connects via type:streamable_http -- it no longer spawns the server.
:: DATABASE_URL and all API keys are already in env from steps 2-3 above.
start "" /B node "%~dp0server\mcp\mcp_server.js"
:: Poll until :5179 is listening (up to 10s) instead of a fixed sleep -- a 2s sleep
:: can race the server bind and make the goose 'precrime' extension fail to init.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[DateTime]::Now.AddSeconds(10);while([DateTime]::Now -lt $d){if(Get-NetTCPConnection -LocalPort 5179 -EA SilentlyContinue){break};Start-Sleep -Milliseconds 500}"

:: --- 7. Render goose user config + GOOSE.md from templates ---
:: Goose reads %APPDATA%\Block\goose\config\config.yaml. Regenerated every launch
:: so the project always owns its config (stale config can pin to a different project).
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

set "GOOSE_MD=%~dp0GOOSE.md"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Get-Content -Raw -LiteralPath $env:GOOSE_MD; $out = $f.Replace('__PROJECT_ROOT__', $env:PROJECT_ROOT); [System.IO.File]::WriteAllText($env:GOOSE_MD, $out, [System.Text.UTF8Encoding]::new($false))"
if errorlevel 1 (
  echo  Failed to patch GOOSE.md
  pause & exit /b 1
)

:: --- 8. Launch goose ---
:: Trigger text encodes BOTH mode and objective so init-wizard.md can detect
:: them without depending on env-variable inheritance into the goose process.
:: PRECRIME_OBJECTIVE is also exported (env) for any tool that prefers env over
:: prompt parsing.
if "%PRECRIME_MODE%"=="headless" (
  set "GOOSE_TRIGGER=headless precrime objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
) else (
  set "GOOSE_TRIGGER=run precrime objective=%PRECRIME_OBJECTIVE% (database: %DBPATH%)"
)
echo  Mode: %PRECRIME_MODE%   Objective: %PRECRIME_OBJECTIVE%
"%USERPROFILE%\.local\bin\goose.exe" run --system "First call developer__shell: type %~dp0GOOSE.md. Then follow it tersely." -t "%GOOSE_TRIGGER%" -s
