@echo off
setlocal EnableExtensions
:: ============================================================================
:: deploy.bat -- deploy the newest build zip to the TDS deployment AND restore
:: the continuity files that every rebuild must preserve (2026-08-06).
::
::   1. Preflight: the TDS\TMP continuity masters must exist (fail loud FIRST).
::   2. Newest dist\precrime-deploy-*.zip (run build.bat before this).
::   3. Stop THIS deployment's precrime processes (same targeted filter as
::      goose.bat -- never touches the INVOICER's node processes).
::   4. Extract to staging, overlay onto TDS\precrime (overwrites code, never
::      deletes deployment data like data\, logs\).
::   5. Continuity restore:
::        TDS\TMP\sources\*            -> TDS\precrime\data\sources\
::        TDS\TMP\BLACKLIST.md         -> TDS\precrime\DOCS\
::        TDS\TMP\VALUE_PROP.md        -> TDS\precrime\DOCS\
::        TDS\TMP\precrime_config.json -> TDS\precrime\
::   6. Ensure llm.models cheap lanes (judge/gate -> gemini-3-flash-preview)
::      in the deployed config -- fills only UNSET keys, never overwrites yours.
::   7. Verify and report.
:: ============================================================================

set "SRC=C:\Users\Scott\Desktop\WKG\PRECRIME"
set "TDS=C:\Users\Scott\Desktop\WKG\TDS\precrime"
set "TMPD=C:\Users\Scott\Desktop\WKG\TDS\TMP"

echo.
echo  ============================================================
echo     PRE-CRIME DEPLOY   dist zip -^> TDS + continuity restore
echo  ============================================================

:: ---- 1. Preflight: continuity masters must exist before we touch ANYTHING --
set "MISSING="
if not exist "%TMPD%\BLACKLIST.md"         set "MISSING=%TMPD%\BLACKLIST.md"
if not exist "%TMPD%\VALUE_PROP.md"        set "MISSING=%TMPD%\VALUE_PROP.md"
if not exist "%TMPD%\precrime_config.json" set "MISSING=%TMPD%\precrime_config.json"
if not exist "%TMPD%\sources\"             set "MISSING=%TMPD%\sources\"
if defined MISSING (
  echo   ERROR: continuity master missing: %MISSING%
  echo   Nothing was deployed. Fix %TMPD% first.
  exit /b 1
)

:: ---- 2. Newest build zip ---------------------------------------------------
set "ZIP="
for /f "delims=" %%Z in ('dir /b /o-d "%SRC%\dist\precrime-deploy-*.zip" 2^>nul') do if not defined ZIP set "ZIP=%SRC%\dist\%%Z"
if not defined ZIP (
  echo   ERROR: no %SRC%\dist\precrime-deploy-*.zip -- run build.bat first.
  exit /b 1
)
echo   Zip: %ZIP%

:: ---- 3. Stop this deployment's processes (targeted, INVOICER untouched) ----
echo   Stopping precrime processes holding %TDS% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*%TDS%\server\mcp\mcp_server.js*' -or $_.CommandLine -like '*%TDS%\server\mcp\mcp_gmail.js*' -or $_.CommandLine -like '*--recipe*precrime-*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

:: ---- 4. Extract + overlay (no /MIR: deployment data is never deleted) ------
set "STAGE=%TEMP%\precrime_deploy_stage"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%STAGE%' -Force"
if not exist "%STAGE%\precrime\" (
  echo   ERROR: zip did not contain a precrime\ folder.
  exit /b 1
)
robocopy "%STAGE%\precrime" "%TDS%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo   ERROR: robocopy failed copying the build onto %TDS%.
  exit /b 1
)
rmdir /s /q "%STAGE%" 2>nul
echo   Build overlaid onto %TDS%

:: ---- 5. Continuity restore --------------------------------------------------
copy /y "%TMPD%\BLACKLIST.md"  "%TDS%\DOCS\" >nul || (echo   ERROR: BLACKLIST.md restore failed & exit /b 1)
copy /y "%TMPD%\VALUE_PROP.md" "%TDS%\DOCS\" >nul || (echo   ERROR: VALUE_PROP.md restore failed & exit /b 1)
copy /y "%TMPD%\precrime_config.json" "%TDS%\" >nul || (echo   ERROR: precrime_config.json restore failed & exit /b 1)
if not exist "%TDS%\data\sources\" mkdir "%TDS%\data\sources"
copy /y "%TMPD%\sources\*" "%TDS%\data\sources\" >nul || (echo   ERROR: sources restore failed & exit /b 1)
echo   Continuity restored: BLACKLIST.md, VALUE_PROP.md, precrime_config.json, data\sources\

:: ---- 6. Ensure llm.models cheap lanes (fills UNSET keys only) --------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%TDS%\precrime_config.json'; $j=Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; if (-not $j.llm) { Write-Host '  WARN: config has no llm block -- skipped models check'; exit 0 }; if (-not $j.llm.PSObject.Properties['models'] -or -not $j.llm.models) { $j.llm | Add-Member -NotePropertyName models -NotePropertyValue (New-Object PSObject) -Force }; $changed=$false; foreach ($r in 'judge','gate') { if (-not $j.llm.models.PSObject.Properties[$r] -or -not $j.llm.models.$r) { $j.llm.models | Add-Member -NotePropertyName $r -NotePropertyValue 'google/gemini-3-flash-preview' -Force; $changed=$true } }; if ($changed) { [IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 12)); Write-Host '  llm.models: judge/gate set to google/gemini-3-flash-preview (cheap lanes ON)' } else { Write-Host ('  llm.models already set: judge=' + $j.llm.models.judge + ' gate=' + $j.llm.models.gate) }"

:: ---- 7. Verify ---------------------------------------------------------------
echo.
echo  ------------------------------ VERIFY ------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t='%TDS%'; $ok=$true; foreach ($f in @('server\mcp\workerManifest.js','server\mcp\workers\DraftOutreachWorker.js','DOCS\BLACKLIST.md','DOCS\VALUE_PROP.md','precrime_config.json')) { $p=Join-Path $t $f; if (Test-Path $p) { Write-Host ('  OK      ' + $f) } else { $ok=$false; Write-Host ('  MISSING ' + $f) } }; $src=(Get-ChildItem (Join-Path $t 'data\sources') -Filter *.md -ErrorAction SilentlyContinue).Count; Write-Host ('  sources : ' + $src + ' channel file(s)'); $bl=(Get-Content (Join-Path $t 'DOCS\BLACKLIST.md') -ErrorAction SilentlyContinue | Where-Object { $_ -and -not $_.StartsWith('#') }).Count; Write-Host ('  blacklist entries: ' + $bl); $j=Get-Content (Join-Path $t 'precrime_config.json') -Raw | ConvertFrom-Json; Write-Host ('  llm.model: ' + $j.llm.model); if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo   DEPLOY FINISHED WITH ERRORS -- check MISSING lines above.
  exit /b 1
)
echo  ---------------------------------------------------------------------
echo   DEPLOY COMPLETE. Launch with: %TDS%\goose.bat
exit /b 0
