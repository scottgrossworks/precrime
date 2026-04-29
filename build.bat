@echo off
setlocal
cd /d "%~dp0"

echo.
echo Pre-Crime -- Build Distribution Zip
echo.

:: Use manifest.json in this directory
if not "%~1"=="" (
  set MANIFEST=%~1
) else (
  set MANIFEST=manifest.json
)

if not exist "%~dp0%MANIFEST%" (
  echo FATAL: Manifest not found: %~dp0%MANIFEST%
  exit /b 1
)

:: Date stamp
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set DATESTAMP=%%I

set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%

:: Output zip dir (arg 2, default dist\)
if not "%~2"=="" (
  set ZIPDIR=%~2
) else (
  set ZIPDIR=%ROOT%\dist
)
if not exist "%ZIPDIR%" mkdir "%ZIPDIR%"

set OUTFILE=%ZIPDIR%\precrime-deploy-%DATESTAMP%.zip

if exist "%OUTFILE%" (
  echo Removing old: %OUTFILE%
  del /f /q "%OUTFILE%"
)

:: Temp staging: parent = TEMP\precrime-bld-DATESTAMP, child = precrime
set TMPPARENT=%TEMP%\precrime-bld-%DATESTAMP%
set STAGEDIR=%TMPPARENT%\precrime

if exist "%TMPPARENT%" (
  echo Cleaning old staging dir...
  rmdir /s /q "%TMPPARENT%"
)
mkdir "%STAGEDIR%"

echo Running deploy.js --no-install to build workspace...
node "%ROOT%\deploy.js" --manifest "%ROOT%\%MANIFEST%" --output "%STAGEDIR%" --no-install
if errorlevel 1 (
  echo FATAL: deploy.js failed.
  rmdir /s /q "%TMPPARENT%"
  exit /b 1
)

:: Copy setup.bat and precrime.bat into workspace root
if exist "%ROOT%\templates\setup.bat" (
  copy "%ROOT%\templates\setup.bat" "%STAGEDIR%\setup.bat" >nul
  echo   + setup.bat
) else (
  echo FATAL: templates\setup.bat not found -- cannot include setup script
  rmdir /s /q "%TMPPARENT%"
  exit /b 1
)
if exist "%ROOT%\templates\precrime.bat" (
  copy "%ROOT%\templates\precrime.bat" "%STAGEDIR%\precrime.bat" >nul
  echo   + precrime.bat
) else (
  echo FATAL: templates\precrime.bat not found -- cannot include launcher
  rmdir /s /q "%TMPPARENT%"
  exit /b 1
)
if exist "%ROOT%\templates\goose.bat" (
  copy "%ROOT%\templates\goose.bat" "%STAGEDIR%\goose.bat" >nul
  echo   + goose.bat
)
if exist "%ROOT%\templates\goose_config.template.yaml" (
  copy "%ROOT%\templates\goose_config.template.yaml" "%STAGEDIR%\goose_config.template.yaml" >nul
  echo   + goose_config.template.yaml
)
if exist "%ROOT%\templates\hermes.bat" (
  copy "%ROOT%\templates\hermes.bat" "%STAGEDIR%\hermes.bat" >nul
  echo   + hermes.bat
)

echo.
echo Packaging zip...
echo   Source: %STAGEDIR%
echo   Output: %OUTFILE%
set PC_SRC=%STAGEDIR%
set PC_OUT=%OUTFILE%
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path $env:PC_SRC -DestinationPath $env:PC_OUT -Force"

if exist "%OUTFILE%" (
  rmdir /s /q "%TMPPARENT%"
  echo.
  echo Build complete: %OUTFILE%
  echo.
  echo === Recipient instructions ===
  echo   1. Unzip -- you get a precrime\ folder
  echo   2. cd precrime
  echo   3. precrime
  echo.
) else (
  echo.
  echo BUILD FAILED -- zip step failed
  rmdir /s /q "%TMPPARENT%"
  exit /b 1
)
