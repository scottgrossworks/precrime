@echo off
:: killnode.bat -- stop PRECRIME processes ONLY.
::
:: DO NOT use `taskkill /F /IM node.exe` or `/F /IM claude.exe`. Claude Code (and
:: an interactive Goose session) themselves run as node/claude processes, so a
:: blanket image-name kill crashes the very session you are working in. We match
:: the COMMAND LINE instead, killing only:
::   *mcp_server.js*  -> the PRECRIME MCP server + conductor (holds the Prisma lock)
::   *--print*        -> one-shot Claude workers
::   *--no-session*   -> one-shot Goose workers (Phase 2)
:: Interactive Claude Code / Goose sessions carry none of those, so they survive.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','claude.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*mcp_server.js*' -or $_.CommandLine -like '*--print*' -or $_.CommandLine -like '*--no-session*') } | ForEach-Object { Write-Host ('  killed ' + $_.Name + ' PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo  PRECRIME processes stopped. Interactive Claude/Goose sessions were NOT touched.
