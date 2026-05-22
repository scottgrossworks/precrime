# {{DEPLOYMENT_NAME}} -- RSS Sources for Factlet Harvesting
#
# SINGLE SOURCE OF TRUTH for RSS feeds. The RSS MCP server reads this file
# directly. Do NOT list feeds anywhere else. Scoring params and keywords
# (not feeds) live in rss/rss-scorer-mcp/rss_config.json.
#
# Format: <feed-url> | <feed-name> | <category>
# One feed per line. Lines starting with # are comments.
# IMPORTANT: When appending lines via shell, escape pipes: echo url ^| name ^| cat >> file

# --- Baseline (event industry feeds -- verified working) ---
https://www.eventbrite.com/blog/feed/ | Eventbrite Blog | events
https://helloendless.com/feed/ | Endless Events | events
https://www.specialevents.com/rss | Special Events Magazine | events
