#!/bin/bash
set -e

# Wire up API keys
if [ -n "$ANTHROPIC_API_KEY" ]; then
  export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
fi

if [ -n "$TAVILY_API_KEY" ]; then
  export TAVILY_API_KEY="$TAVILY_API_KEY"
fi

# Copy SQLite database to Linux-native filesystem.
# SQLite WAL mode requires memory-mapped I/O which fails on Windows volume mounts.
mkdir -p /db
if [ -f "/precrime/data/myproject.sqlite" ]; then
  cp /precrime/data/myproject.sqlite /db/myproject.sqlite
  echo ">>> Database copied to native Linux fs (/db/myproject.sqlite)"
else
  echo ">>> No database found at /precrime/data/myproject.sqlite -- Prisma will create one"
fi

# On exit: sync database back to Windows volume so changes persist.
sync_db() {
  echo ">>> Syncing database back to /precrime/data/..."
  cp /db/myproject.sqlite /precrime/data/myproject.sqlite 2>/dev/null && echo ">>> Sync complete." || echo ">>> Sync failed -- check /precrime/data/"
}
trap sync_db EXIT

# Install main MCP server deps
echo ">>> Preparing PRECRIME MCP server..."
cd /precrime/server
npm install --prefer-offline --silent
npx prisma generate --silent 2>/dev/null || npx prisma generate

# Install RSS MCP server deps
echo ">>> Preparing RSS MCP server..."
if [ -f "/precrime/rss/rss-scorer-mcp/rss_config.json" ]; then
  echo ">>> RSS config found OK"
  cd /precrime/rss/rss-scorer-mcp
  npm install --prefer-offline --silent
else
  echo ">>> WARNING: /precrime/rss/rss-scorer-mcp/rss_config.json NOT FOUND"
  echo ">>> Run claude.bat from your deployment folder (e.g. PHOTOBOOTH\\precrime), not from PRECRIME."
fi

echo ">>> Launching Claude Code..."
cd /precrime

# Tell the MCP server to use the native-fs copy of the database.
export DATABASE_URL="file:/db/myproject.sqlite"

# Run non-interactively with full permissions.
# Claude reads CLAUDE.md from /precrime (the mounted deployment volume).
# MCP servers are registered via /precrime/.mcp.json.
# DATABASE_URL is inherited by MCP server child processes.
exec claude --dangerously-skip-permissions -p "run the precrime workflow"
