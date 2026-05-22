---
name: precrime
description: Pre-Crime pipeline startup. Verifies agent identity, web search capability, and reports readiness. Phase 1 — no MCP/SQLite yet.
version: 0.1.0
author: Pre-Crime
license: MIT
metadata:
  hermes:
    tags: [Pre-Crime, Startup, Pipeline, Enrichment]
    related_skills: []
---

# Pre-Crime Startup (Phase 1)

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

Verify you can read files in the Pre-Crime source directory:

```bash
ls /mnt/c/Users/Admin/Desktop/WKG/PRECRIME/templates/skills/
```

List the skill files found.

### 4. Readiness Report

Summarize:
- Web search: working / not working
- File access: working / not working
- MCP tools: NOT YET WIRED (Phase 2)
- SQLite database: NOT YET WIRED (Phase 2)

Then say: "Pre-Crime Phase 1 ready. Awaiting MCP integration."

## What NOT to do

- Do not attempt MCP tool calls (they are not wired yet)
- Do not attempt to read or write SQLite databases
- Do not run npm, prisma, or any setup commands
- Do not improvise beyond these checks
