---
title: Scoring
tags: [scoring, leed_ready, policy]
source_docs: [DOCS/SCORING.json]
last_updated: 2026-05-07
staleness: none
---

Canonical PRECRIME scoring policy lives in `DOCS/SCORING.json`.

Do not duplicate scoring weights, promotion gates, generic-email lists, or
Leedz readiness requirements in the wiki. The MCP server reads
`DOCS/SCORING.json` at startup, and agents should treat that JSON as the one
source of truth.

