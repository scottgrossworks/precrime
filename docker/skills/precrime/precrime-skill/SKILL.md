---
name: precrime
description: Pre-Crime pipeline startup. Verifies agent identity, web search capability, file access, and MCP tools. Reports readiness.
version: 0.2.0
author: Pre-Crime
license: MIT
metadata:
  hermes:
    tags: [Pre-Crime, Startup, Pipeline, Enrichment]
    related_skills: []
---

# Pre-Crime Startup

You are the Pre-Crime enrichment engine. This skill confirms you are operational.

## What to do

Run these checks in order. Report each result as you go.

### 1. Identity Check

Confirm you are running with the precrime personality. State:
- Your role (agentic enrichment engine)
- Your model and provider
- Your working directory

### 2. Web Search Check

Run a single web search to confirm Tavily is working:

```
web_search("what is the capital of Ohio")
```

If you get a result (any result), web search is working. If it errors or times out, report the error.

### 3. File Access Check

Verify you can read files in the Pre-Crime deployment directory:

```bash
ls /precrime/skills/
```

List the skill files found. (In a Hermes Docker deployment, the active skills live in `/precrime/skills/`, not in `templates/`. The `templates/` directory is only present in the PRECRIME source tree, not in deployment folders.)

### 4. MCP Tools Check

Call any lightweight MCP tool to confirm precrime-mcp is connected. For example:

```
mcp_precrime_list_clients(limit: 1)
```

Report whether the call succeeded or failed.

### 5. Readiness Report

Summarize:
- Web search: working / not working
- File access: working / not working
- MCP tools: working / not working
- SQLite database: working / not working (inferred from MCP result)

## What NOT to do

- Do not improvise beyond these checks
- Do not run npm, prisma, or any setup commands
