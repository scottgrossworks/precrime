---
name: {{DEPLOYMENT_NAME}}-enrichment-parallel
description: Parallel orchestrator — launches N enrichment agents simultaneously, each with a dedicated Gemini tab
triggers:
  - run enrichment in parallel
  - parallel enrichment
  - run N agents
---

# {{DEPLOYMENT_NAME}} — Parallel Enrichment Orchestrator

Use when processing 5+ clients and speed matters. You (the orchestrator) set up Chrome tabs, then launch N sub-agents simultaneously. Each sub-agent runs `skills/enrichment-agent.md` with a pre-assigned Gemini tab.

## Orchestrator Protocol

1. `mcp__Claude_in_Chrome__tabs_context_mcp({ createIfEmpty: true })` — confirm Chrome connected
2. Decide N (default: 5, max: 10)
3. For each of N slots:
   - `mcp__Claude_in_Chrome__tabs_create_mcp({})` → `newTabId`
   - `mcp__Claude_in_Chrome__navigate({ tabId: newTabId, url: "https://gemini.google.com" })`
   - Record in `AI_TABS = [tabId_1, ..., tabId_N]`
4. `mcp__precrime-mcp__get_stats()` — verify DB
5. Launch all N agents in **one message** (parallel Agent tool calls):
   ```
   Each prompt: "Run skills/enrichment-agent.md. Your assigned Gemini tab ID is: <tabId_N>.
   Store as SESSION_AI = { gemini: <tabId_N> }. Do NOT call tabs_context_mcp."
   ```

## Sub-agent Rules

- **Do NOT call `tabs_context_mcp`** — tab is pre-assigned. Use it directly.
- `SESSION_AI = { gemini: <YOUR_ASSIGNED_TAB_ID> }`
- Do NOT open new tabs or navigate away from Gemini during the session
- `get_next_client` atomic stamp guarantees no duplicate work across agents
- Append ROUNDUP.md block independently when done

## Key Benefits

- N clients processed in wall-clock time of 1
- Zero Chrome contention — each agent owns one tab
- Atomic cursor prevents duplicate client processing
