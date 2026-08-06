@echo off
:: killnode.bat -- stop PRECRIME processes ONLY.
::
:: DO NOT use `taskkill /F /IM node.exe` or `/F /IM claude.exe`. Claude Code (and
:: an interactive Goose session) themselves run as node/claude processes, so a
:: blanket image-name kill crashes the very session you are working in. We match
:: the COMMAND LINE instead, killing only:
::   THIS deployment's mcp_server.js  -> PRECRIME MCP server + conductor (Prisma lock)
::   THIS deployment's mcp_gmail.js   -> PRECRIME's own Gmail sibling
::   *--print* / *--no-session* + 'precrime' -> one-shot workers
:: PATH-SCOPED (2026-08-03): the old loose '*mcp_gmail.js*'/'*mcp_server.js*'
:: patterns ALSO matched the INVOICER's Gmail MCP (:7000) and Claude Desktop MCP --
:: every killnode run silently knocked the Leedz extension's Gmail server offline.
:: Interactive Claude Code / Goose sessions carry none of these, so they survive.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','claude.exe','goose.exe') -and $_.CommandLine -and ($_.CommandLine -like '*%~dp0server\mcp\mcp_server.js*' -or $_.CommandLine -like '*%~dp0server\mcp\mcp_gmail.js*' -or (($_.CommandLine -like '*--print*' -or $_.CommandLine -like '*--no-session*' -or $_.CommandLine -like '*--recipe*') -and $_.CommandLine -like '*precrime*')) } | ForEach-Object { Write-Host ('  killed ' + $_.Name + ' PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo  PRECRIME processes stopped. Interactive Claude/Goose sessions were NOT touched.
