# Global Claude Code Rules — Pre-Crime Docker Container

## ENVIRONMENT: HEADLESS LINUX CONTAINER

You are running inside a Linux Docker container with no browser and no display.

### Tools that DO NOT exist here — never call them
- `mcp__Claude_in_Chrome__*` — Chrome is not connected. These tools do not exist.
- `browser_*`, `computer`, `navigate`, `browser_console` — no browser automation.

### What IS available — use these for everything
- **`WebSearch`** — use wherever a skill says to search the web or use Gemini/Grok research.
- **`WebFetch`** — use wherever a skill says to scrape a page or use Chrome navigate + get_page_text.
- **`mcp__precrime-rss__get_top_articles`** — RSS feeds work fine in headless. Call this directly.
- **`mcp__precrime-mcp__*`** — all 19 database tools work normally.

### Headless fallback rules (apply to every skill)
- Skill says "REQUIRES Chrome → STOP" → ignore STOP. Use WebSearch/WebFetch fallback instead.
- Skill says "Interactive mode (Chrome available)" → go to headless branch.
- Skill says "Skip if not accessible headless" → try WebFetch first. Only skip if it returns a login wall or nothing.
- Reddit: use `WebFetch("https://www.reddit.com/r/{subreddit}/new.json?limit=25")` — no browser needed.
- X/Twitter: use `WebSearch("from:{account} site:x.com")` as fallback.

### RSS MCP note
`precrime-rss` does not implement the `prompts/list` MCP method. "Method not found" on that call is normal and does NOT mean the tool is unavailable. Call `mcp__precrime-rss__get_top_articles` directly.

## WORKING DIRECTORY

Your working directory is `/precrime`. The user's deployment folder is bind-mounted there. All file paths are under `/precrime`.

## EXECUTION RULES

- No fluff. No filler. No apologies. Execute the pipeline step by step.
- If a tool call fails, log the error and move to the next item. Do not retry endlessly.
- Never stop because a tool is "unavailable" — use the fallback in the skill file.
- Never surface tool errors to the user as blockers.
- **Per-URL time limit:** If a WebFetch or WebSearch takes more than 30 seconds or errors, log `SKIP_TIMEOUT: [url]` and move on immediately.
- **Per-step limit:** If a harvester step produces zero results after 5 attempts, log the failure and move to the next pipeline step.
