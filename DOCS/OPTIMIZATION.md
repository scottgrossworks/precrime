# Pre-Crime — Token Optimization Strategy

Last updated: 2026-04-04

Goal: reduce Anthropic rate-limit pressure. Not a refactor — targeted cuts only.

---

## The Problem

Rate limits are being hit during live workflow runs. Total loaded context per enrichment session is approximately 10,000–10,500 tokens before any client data or dossier content is added. Dossier content scales unboundedly with enrichment history.

---

## Strategy 1 — Strip CUSTOMIZATION comment blocks at build time

Every skill file contains an HTML comment block (`<!-- ... -->`) with deployer guidance — 18–31 lines each. These are **not stripped before sending to the LLM.** The LLM processes them on every skill load.

- Total across all skills: ~160 lines / ~500 tokens
- Fix: add a comment-stripping pass in `deploy.js` — regex remove `<!--` ... `-->` blocks during file copy
- Risk: zero. These blocks exist for the developer, not Claude.
- Savings: ~500 tokens/session

---

## Strategy 2 — Move parallel-agent mode to a separate skill file

`enrichment-agent.md` contains ~35 lines of multi-agent Chrome tab orchestration (pre-assigning Gemini tabs, launching N background agents, preventing contention). Every solo operator loads this dead weight on every enrichment session.

- Fix: extract to `enrichment-agent-parallel.md`. Load only when `agentCount > 1` in config.
- Risk: low. Solo mode behavior unchanged.
- Savings: ~450 tokens/session for all single-operator deployments

---

## Strategy 3 — Remove outreach rules from skill files

`CLAUDE.md` is loaded at every session start and stays in context for the entire session. It already contains the full outreach writing rules (word cap, tone, open/close, forbidden phrases).

Those same rules are duplicated verbatim in:
- `enrichment-agent.md` Step 5
- `evaluator.md` Criterion 4

- Fix: delete the duplicated sections from both skill files. CLAUDE.md is authoritative.
- Risk: low. CLAUDE.md is always in context when these skills run.
- Savings: ~150–200 tokens/session

---

## Strategy 4 — Deduplicate the four-path classification tree

The classification logic (existing client → dossier update / has booking details → lead hot / no details → lead thin / new org → create client) is written out in full in all four harvester files:
- `factlet-harvester.md`
- `fb-factlet-harvester/SKILL.md`
- `reddit-factlet-harvester.md`
- `ig-factlet-harvester/SKILL.md`

Options:
- a) Extract to `DOCS/CLASSIFICATION.md`, reference by name in each harvester
- b) Compress each copy to 4 bullet lines (the prose version is over-explained)

- Risk: medium — need to verify that all four harvesters handle edge cases identically before collapsing
- Savings: ~300 tokens across loaded harvesters

---

## Strategy 5 — Cache get_config() result within skill sessions

`get_config()` is called:
- Twice in `init-wizard.md` (Step 0 and Step 7)
- In `plugins/leedz-share/share-skill.md` when only `leedzSession` is needed
- Potentially multiple times in enrichment loop for email/trade fields

It always returns the full Config record — JWT, all settings, trade, marketplace flags, etc. No field selection available.

- Fix (skill-level): instruct Claude to store config result as a named variable at first call and reuse it. Note at top of skill: "Call get_config() once and reference result throughout."
- Fix (MCP-level, lower priority): add optional `fields` param to return partial record
- Savings: indirect — eliminates redundant large JSON responses from DB

---

## Strategy 6 — Cap get_new_factlets() for first-run clients

When `lastQueueCheck` is null (first time a client enters the enrichment loop), the skill falls back to `since: "1970-01-01T00:00:00Z"` — returning ALL factlets ever created. For mature deployments this response grows without bound.

- Fix: add a `limit` parameter to the `get_new_factlets` MCP tool (e.g., default 50)
- Fix (skill-level): pass `limit: 50` explicitly in the first-run fallback call
- Risk: low
- Savings: unbounded downside risk eliminated

---

## Strategy 7 — search_clients() existence checks: add limit: 1

The four-path classification in all harvesters calls `search_clients({ company: name })` purely to check if an org exists. The tool defaults to returning up to 50 results. Only 1 is needed.

- Fix: pass `limit: 1` on all existence-check calls in harvester skills
- Risk: zero
- Savings: indirect — keeps context clean, faster DB round-trip

---

## Strategy 8 — Use browser-based LLMs as free satellite compute

**This is the highest-leverage architectural shift on the list.**

The Chrome MCP tools are already wired (`navigate`, `form_input`, `get_page_text`, `javascript_tool`). The harvesters already drive Chrome for Facebook. The agent can navigate to Gemini (free) or Grok (already paid subscription) and use them as subordinate LLMs.

**The pattern: Claude orchestrates. Browser LLMs labor.**

### Use cases

| Task | Without this | With this |
|------|-------------|-----------|
| Structure raw scraped HTML | Claude processes 3,000 tokens of HTML | Paste to Gemini → get back 200-token JSON |
| Research (event venues, expos, etc.) | Claude runs search loop in-context | Navigate Gemini/Grok → paste result back |
| Relevance filtering on large RSS dumps | Claude reads every item | Feed dump to Grok: "which mention a booking?" → Claude gets filtered list |
| Draft alternatives | Claude generates and evaluates | Gemini generates alternatives → Claude evaluates the best one |
| List compilation from factlets | Claude processes all factlet text | Paste factlets to Gemini → deduped structured list returned |
| Bulk JSON formatting | Claude parses raw text | Gemini formats → Claude ingests clean output |

### Implementation approach

1. Agent navigates to `gemini.google.com` or `grok.com` in a browser tab
2. Uses `form_input` or `javascript_tool` to paste prompt + raw data
3. Waits for response, uses `get_page_text` to extract output
4. Parses/uses the clean result

Skills that most benefit: all four harvesters, enrichment-agent Step 3 (research), enrichment-agent Step 5 (draft alternatives).

### Constraints
- Gemini/Grok session state is transient — don't depend on conversation history across skill invocations
- Don't paste PII (client email, phone) into third-party LLMs
- Gemini free tier has its own rate limits — don't loop it on hundreds of records sequentially

---

## Priority Order

| # | Strategy | Est. Token Savings | Effort | Risk |
|---|----------|--------------------|--------|------|
| 1 | Strip CUSTOMIZATION comments in deploy.js | ~500/session | Low | Zero |
| 2 | Parallel-agent mode → separate file | ~450/session | Low | Low |
| 3 | Remove duplicate outreach rules from skills | ~200/session | Low | Low |
| 4 | Deduplicate four-path classification | ~300/session | Medium | Medium |
| 5 | Cache get_config() in skill sessions | Indirect | Low | Low |
| 6 | Cap get_new_factlets() with limit param | Risk elimination | Low | Low |
| 7 | search_clients existence checks → limit: 1 | Indirect | Low | Zero |
| **8** | **Browser LLMs as satellite compute** | **Structural — unbounded** | **Medium** | **Low** |

Strategy 8 is the only one that changes the architecture. All others are cuts. Strategy 8 is an addition that multiplies the capacity of the system by adding free compute. It should run in parallel with the cuts, not after them.

---

## What NOT to Touch

- MCP tool descriptions — already tight one-liners, not a meaningful source
- CLAUDE.md structure — it is the session anchor, don't compress it aggressively
- The Leedz MCP — separate system, not the bottleneck
