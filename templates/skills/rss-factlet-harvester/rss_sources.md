# {{DEPLOYMENT_NAME}} — RSS Sources for Factlet Harvesting
#
# SINGLE SOURCE OF TRUTH for RSS feeds. The RSS MCP server reads this file
# directly. Do NOT list feeds anywhere else. Scoring params and keywords
# (not feeds) live in rss/rss-scorer-mcp/rss_config.json.
#
# Format: <feed-url> | <feed-name> | <category>
# One feed per line. Lines starting with # are comments.

# --- Baseline ---
https://www.reddit.com/r/news/.rss | Reddit News | general
