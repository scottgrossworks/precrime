---
title: Headless Deployment — PRECRIME on AWS
tags: [deployment, aws, ec2, headless, cron, managed-agents, architecture]
source_docs: [DOCS/PLAN.md, Claude Managed Agents docs (platform.claude.com)]
last_updated: 2026-04-09
staleness: none
---

PRECRIME can run headlessly on AWS with zero architecture changes. The same folder, same .md skills, same MCP server, same SQLite database — triggered by cron instead of a human typing.

---

## The Insight

Claude Code is installed locally. It IS the orchestration backbone — the loop that sends prompts to the Claude API, parses tool calls, executes tools locally, patches results back into the conversation, and sends it back for more processing.

The headless deployment is therefore: install Claude Code on an EC2, point it at the PRECRIME folder, and run it with a starter prompt via cron.

```
claude -p --dangerously-skip-permissions "run enrichment on the next 10 clients"
```

`-p` / `--print` = non-interactive. Runs the prompt, executes autonomously, prints output, exits. No terminal. No human.

`precrime.bat` already does this pattern: `claude --dangerously-skip-permissions "run precrime"`.

---

## Architecture

```
EC2 instance
  ├── Claude Code CLI (npm install -g @anthropic-ai/claude-code)
  ├── PRECRIME/
  │   ├── .mcp.json          ← MCP server config (local stdio, unchanged)
  │   ├── server/             ← Node.js MCP server + Prisma + SQLite
  │   ├── templates/skills/   ← .md skill files (enrichment, harvesters, etc.)
  │   └── DOCS/               ← VALUE_PROP.md, wiki, etc.
  └── cron
      ├── 0 8 * * *  → claude -p "run source discovery"
      ├── 0 9 * * *  → claude -p "harvest RSS and Reddit"
      ├── 0 10 * * * → claude -p "enrich next 10 clients"
      └── 0 11 * * * → claude -p "draft ready clients and share leed_ready bookings"
```

The MCP server runs locally on the EC2 via stdin/stdout (same as desktop). No transport change. No HTTP adapter. No Prisma migration. SQLite stays.

The Claude API is the only external dependency. Claude Code calls it for model inference. Everything else is local.

---

## Managed Agents — The Alternative

Anthropic's Claude Managed Agents (beta, 2026-04-01) is the same concept as a hosted service:

- You define an Agent (model + system prompt + tools + MCP servers)
- You define an Environment (cloud container with packages + networking)
- You create Sessions via API — each session runs the agent autonomously
- Sessions support MCP via remote HTTP endpoints (not stdin/stdout)

**Trade-offs vs. EC2 self-hosting:**

| | EC2 + Claude Code | Managed Agents |
|---|---|---|
| Architecture changes | Zero | MCP server needs HTTP transport adapter |
| Database | SQLite stays | SQLite works in container, or migrate to Postgres |
| MCP transport | stdin/stdout (unchanged) | Must be remote HTTP (streamable HTTP transport) |
| Browser scraping | Install Chrome, use Chrome MCP | Not available — web_fetch/web_search only |
| Cost | EC2 instance + API usage | API usage + managed agent fees |
| Control | Full | Anthropic manages the runtime |
| Scaling | Manual | Automatic |

**Managed Agents is orchestration-as-a-service.** The agent loop is the commodity. Anthropic open-sourced Claude Code so everyone can run it locally, then built Managed Agents to host that same loop in their cloud. Same play as every cloud service: make you not want to manage the infrastructure.

For one enrichment pipeline running a few times a day, the EC2 is the right answer. Managed Agents adds value at scale (hundreds of concurrent sessions, no infrastructure to manage).

---

## Key CLI Flags for Headless Execution

| Flag | Purpose |
|---|---|
| `-p` / `--print` | Non-interactive. Run prompt, execute, print, exit. |
| `--dangerously-skip-permissions` | Skip all permission prompts. Required for unattended. |
| `--system-prompt <prompt>` | Override system prompt (alternative to CLAUDE.md) |
| `--mcp-config <path>` | Point at MCP config (default: .mcp.json in workspace) |
| `--model <model>` | Override model (e.g., `sonnet`, `opus`) |
| `--max-budget-usd <amount>` | Cap spending per invocation |

---

## The Pipeline as Cron Jobs

The full PRECRIME pipeline decomposes into scheduled tasks:

1. **Source refresh** (weekly) — "given VALUE_PROP.md, search for new FB pages, subreddits, RSS feeds, directories. Append to source configs."
2. **Harvest** (daily) — "run RSS, Reddit, and Facebook harvesters. Four-path classify everything."
3. **Seed** (daily, after harvest) — "for any new source URLs or directories, scrape for contacts. Create thin client records."
4. **Enrich** (daily) — "get_next_client loop. Link factlets, scrape, score, gate, draft if ready."
5. **Share** (daily, after enrich) — "find leed_ready bookings, post to The Leedz."

Each is one `claude -p "..."` invocation. Each reads the same .md skills. Each uses the same MCP server and database.

---

## Related
- [[deployment]] — local deployment flow (precrime.bat, setup.bat)
- [[scoring]] — dossierScore and contactGate system
- [[mcp]] — 19 MCP tools available to the agent
- [[architecture]] — two MCP servers, data flow
