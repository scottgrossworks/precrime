@echo off
setlocal
cd /d "%~dp0"

echo.
echo Pre-Crime -- Build Deployment Zip
echo.

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set DATESTAMP=%%I

set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%

if not exist "%ROOT%\dist" mkdir "%ROOT%\dist"

set OUTFILE=%ROOT%\dist\precrime-deploy-%DATESTAMP%.zip

if exist "%OUTFILE%" (
  echo Removing old: %OUTFILE%
  del /f /q "%OUTFILE%"
)

:: Create temp staging dir
for /f %%I in ('powershell -NoProfile -Command "[System.IO.Path]::GetTempPath().TrimEnd([char]92)"') do set TMPBASE=%%I
set TMPDIR=%TMPBASE%\precrime-build-%DATESTAMP%
set STAGEDIR=%TMPDIR%\precrime

if exist "%TMPDIR%" (
  echo Cleaning old staging dir...
  rmdir /s /q "%TMPDIR%"
)
mkdir "%TMPDIR%"

echo Generating workspace (includes npm install + prisma generate)...
echo.
node "%ROOT%\deploy.js" --manifest "%ROOT%\manifests\manifest.generic.json" --output "%STAGEDIR%"

if %errorlevel% neq 0 (
  echo.
  echo BUILD FAILED -- deploy.js error
  rmdir /s /q "%TMPDIR%"
  exit /b 1
)

echo.
echo Packaging zip...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$src='%STAGEDIR%'; $out='%OUTFILE%'; Compress-Archive -Path $src -DestinationPath $out -Force; Write-Host ('SUCCESS: ' + $out)"

if %errorlevel%==0 (
  rmdir /s /q "%TMPDIR%"
  echo.
  echo Build complete: %OUTFILE%
  echo.
  echo Recipient instructions:
  echo   1. Unzip -- you get a precrime\ folder
  echo   2. cd precrime
  echo   3. claude
  echo   4. Say: initialize this deployment
  echo.
) else (
  echo.
  echo BUILD FAILED -- zip step failed
  rmdir /s /q "%TMPDIR%"
  exit /b 1
)
