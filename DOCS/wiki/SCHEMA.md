# Pre-Crime Wiki — Schema & Conventions

---

## Purpose

This wiki is a dense, LLM-queryable knowledge base for the Pre-Crime project. An agent entering a new session should be able to read this wiki and have full working context without re-reading the raw source docs.

---

## Directory Structure

```
PRECRIME\DOCS\wiki\
  SCHEMA.md              <- This file. Conventions for the wiki itself.
  index.md               <- Master catalog of all articles.
  log.md                 <- Append-only ingest log.
  concepts\
    ontology.md          <- Entities, output paths, conversion funnel, design rules
    architecture.md      <- System architecture, two MCP servers, data flow
    deployment.md        <- Build system, end-user flow, file inventory
    mcp.md               <- MCP server details, all 19 tools, config
    scoring.md           <- Client scoring, contact gate, dossier score, draft eligibility
    headless-deployment.md <- Headless AWS deployment, EC2 + cron, Managed Agents comparison
    email-finder.md      <- 5-phase direct-email hunt sub-skill invoked by enrichment Step 3.6
  status\
    current.md           <- Authoritative current project state (mirrors STATUS.md)
  marketing\
    reddit.md            <- Reddit harvester setup and API notes
    instagram.md         <- Instagram harvester integration spec
```

---

## Page Format

Every article file follows this structure:

```markdown
---
title: <Article Title>
tags: [tag1, tag2]
source_docs: [DOCS/FILE.md, DOCS/OTHER.md]
last_updated: YYYY-MM-DD
staleness: none | suspected | confirmed
---

One-paragraph summary of the article.

[Body with ## headers]

## Related
- [[article-name]] — one-line description
```

---

## Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable article title |
| `tags` | list | Searchable tags (e.g., `ontology`, `mcp`, `deployment`) |
| `source_docs` | list | Which DOCS files this article draws from. Relative to PRECRIME root. |
| `last_updated` | date | ISO date of last wiki edit |
| `staleness` | enum | `none` = verified current; `suspected` = may be out of date; `confirmed` = known stale vs STATUS.md |

---

## Link Syntax

Internal links use `[[article-name]]` — the filename without path or extension.

Examples:
- `[[ontology]]` links to `concepts\ontology.md`
- `[[current]]` links to `status\current.md`
- `[[mcp]]` links to `concepts\mcp.md`

---

## Staleness Callout Block

When a source doc contradicts STATUS.md (the authoritative current-state document) or another source doc, use this callout:

```
> WARNING — STALE? `SOURCE_DOC.md` says X but `STATUS.md` says Y. Needs resolution.
```

STATUS.md is the tie-breaker for all factual disputes. If STATUS.md says something is done, it is done — even if another doc says "not yet implemented."

---

## Update Workflow

1. When a source doc in `PRECRIME\DOCS\` changes, update the relevant wiki article(s).
2. Append an entry to `log.md`.
3. Update `index.md` if new articles were created or staleness flags changed.
4. Never modify the source DOCS files from this wiki — wiki is read-only output.

---

## Authoritative Doc Hierarchy

1. `DOCS\STATUS.md` — current state. Overrides all others on factual disputes.
2. `DOCS\ONTOLOGY.md` — entity definitions and design rules.
3. `DOCS\DEPLOYMENT.md` — deployment reference (may be partially stale — see log.md).
4. `DOCS\MCP_BRIEFING.md` — MCP server spec (written pre-implementation — see log.md).
5. `DOCS\REDDIT_NOTES.md` — Reddit setup notes.
6. `DOCS\IG_NOTES.md` — Instagram harvester spec.
