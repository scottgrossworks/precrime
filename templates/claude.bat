@echo off
setlocal
cd /d "%~dp0"

:: --- Load API keys from .env (single source of truth, see .env.sample) ---
if exist "%~dp0.env" (
  for /f "usebackq eol=# delims=" %%i in ("%~dp0.env") do set "%%i"
) else (
  echo  .env file not found at: %~dp0.env
  echo  Copy .env.sample to .env and fill in your API keys.
  pause & exit /b 1
)
if "%ANTHROPIC_API_KEY%"=="" ( echo  ANTHROPIC_API_KEY missing from .env & pause & exit /b 1 )
if "%TAVILY_API_KEY%"==""    ( echo  TAVILY_API_KEY missing from .env & pause & exit /b 1 )

for /f %%i in ('docker ps -q --filter ancestor=claude-precrime 2^>nul') do (
  echo Stopping existing claude container %%i...
  docker kill %%i > nul 2>&1
)
docker run -i --rm ^
  -e ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY% ^
  -e TAVILY_API_KEY=%TAVILY_API_KEY% ^
  -v "%CD%:/precrime" ^
  claude-precrime
