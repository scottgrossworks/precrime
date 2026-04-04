@echo off
setlocal
cd /d "%~dp0"

echo.
echo Pre-Crime -- First-time Setup
echo ============================================================
echo.

:: Check for Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo FATAL: Node.js not found.
  echo Install Node.js 18 or higher from https://nodejs.org then re-run this script.
  exit /b 1
)

for /f "tokens=*" %%V in ('node --version') do set NODE_VER=%%V
echo Node.js found: %NODE_VER%
echo.

:: Check server directory exists
if not exist "%~dp0server\package.json" (
  echo FATAL: server\package.json not found. This workspace may be corrupted.
  exit /b 1
)

:: Install server dependencies
echo [1/2] Installing server dependencies (npm install)...
cd "%~dp0server"
call npm install
if errorlevel 1 (
  echo.
  echo FATAL: npm install failed.
  echo Check your internet connection and try again.
  cd "%~dp0"
  exit /b 1
)
echo       Done.
echo.

:: Generate Prisma client
echo [2/2] Generating Prisma client (npx prisma generate)...
call npx prisma generate
if errorlevel 1 (
  echo.
  echo FATAL: prisma generate failed.
  echo If you see a DLL lock error ^(EPERM on query_engine-windows.dll.node^):
  echo   Close any running Node.js or Claude processes, then re-run setup.bat
  cd "%~dp0"
  exit /b 1
)
echo       Done.
echo.

:: Install RSS scorer dependencies
cd "%~dp0rss\rss-scorer-mcp"
if exist "package.json" (
  echo [+] Installing RSS scorer dependencies...
  call npm install >nul 2>&1
  if errorlevel 1 (
    echo     WARNING: RSS npm install failed. Run manually: cd rss\rss-scorer-mcp ^&^& npm install
  ) else (
    echo     Done.
  )
)

cd "%~dp0"
echo.
echo ============================================================
echo  Setup complete. Server infrastructure is ready.
echo ============================================================
echo.
