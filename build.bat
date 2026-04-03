@echo off
setlocal
cd /d "%~dp0"

echo.
echo Pre-Crime -- Build Distribution Zip
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

echo Staging files and compressing...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root='%ROOT%';" ^
  "$out='%OUTFILE%';" ^
  "$s=Join-Path $env:TEMP ('precrime-stage-'+[System.IO.Path]::GetRandomFileName());" ^
  "$d=Join-Path $s 'precrime';" ^
  "New-Item -ItemType Directory -Force $s | Out-Null;" ^
  "New-Item -ItemType Directory -Force $d | Out-Null;" ^
  "New-Item -ItemType Directory -Force (Join-Path $d 'data') | Out-Null;" ^
  "New-Item -ItemType Directory -Force (Join-Path $d 'server\mcp') | Out-Null;" ^
  "New-Item -ItemType Directory -Force (Join-Path $d 'server\prisma') | Out-Null;" ^
  "New-Item -ItemType Directory -Force (Join-Path $d 'scripts') | Out-Null;" ^
  "foreach ($f in @('deploy.js','build.bat','README.md')) { $p=Join-Path $root $f; if (Test-Path $p) { Copy-Item $p $d } };" ^
  "Copy-Item -Recurse (Join-Path $root 'templates') $d;" ^
  "Copy-Item -Recurse (Join-Path $root 'scripts') $d;" ^
  "Copy-Item (Join-Path $root 'server\mcp\mcp_server.js') (Join-Path $d 'server\mcp');" ^
  "Copy-Item (Join-Path $root 'server\package.json') (Join-Path $d 'server');" ^
  "Copy-Item (Join-Path $root 'server\prisma\schema.prisma') (Join-Path $d 'server\prisma');" ^
  "Copy-Item (Join-Path $root 'data\template.sqlite') (Join-Path $d 'data');" ^
  "Compress-Archive -Path $d -DestinationPath $out -Force;" ^
  "Remove-Item -Recurse -Force $s;" ^
  "Write-Host ('SUCCESS: ' + $out)"

if %errorlevel%==0 (
  echo.
  echo Build complete: %OUTFILE%
  echo.
) else (
  echo.
  echo BUILD FAILED -- check output above
  exit /b 1
)
