---
date: 2026-07-13
topic: tavily-credit-reduction
focus: cut Tavily credit spend by at least 30%
mode: repo-grounded
---

# Ideation: Cut Tavily Credit Spend >= 30%

## Grounding Context (Codebase)

**The key reframe: credits != tokens.** `tools/tavily_lean_mcp.py` already trims response
*bytes* (LLM tokens) via `max_results` clamp + compact JSON. But Tavily bills per **API call**:
basic search = 1 credit, advanced search = 2, extract billed per URL-group — all independent of
`max_results`. So every "lean" optimization to date saved tokens and **zero credits**. Cutting
credit spend means cutting the *number and depth of calls*, a different lever.

**Tavily call sites (the credit drivers), by likely volume:**

| Task / path | Calls per unit | Volume driver |
|---|---|---|
| `FIND_CLIENT_SOURCES` (find-client-sources.md) | 1–3 search **+ 3–5 extract** = up to ~8 credits | **per client**, ~1,026 clients need enrichment |
| `DISCOVER_SOURCES` (discover-sources.md) | "a few" searches | per cold-start / plan cycle |
| `SCRAPE_SOURCE` (url-loop.md) | 1 extract per non-RSS source (RSS is free via get_top_articles) | per source |
| `DRILL_DOWN` (drill-down.md) | 1–4 search + extract | per near-hot booking |
| `DRILL_CONTAINER` (drill-container.md) | searches for exhibitor rosters | per container |
| `X` harvester headless (x-factlet-harvester) | site:x.com search/extract | per X source, headless only |
| marketplace `rq`/`dt` research (share-skill) | WebFetch/search | per share (now blocked on the outreach mis-route path, fixed 2026-07-13) |

`FIND_CLIENT_SOURCES` is the dominant sink by an order of magnitude: search + up-to-5 extracts,
multiplied across every client. It was starved by the old planner; the 2026-07-12 foundational-stage
fix now lets it run broadly — which turns it from "never runs" into the primary credit explosion.

There is **no result caching** anywhere: identical event/venue/company research reruns fresh every
time (we watched a live session search "LA Auto Show 2026" and "Burning Rubber Toy Company" from
scratch, and the same ~27 leedz recur across runs).

## Topic Axes

- Call elimination (remove redundant / low-value calls: gating, dedup, mis-route fixes)
- Caching & reuse (memoize search/extract across clients, bookings, runs)
- Depth & batching (basic vs advanced; extract billed per URL-group)
- Substitution (free channels — RSS, direct fetch, Chrome, sitemap — before Tavily)
- Budget & prioritization (hard credit ceilings; spend only on promotion-worthy targets)

## Ranked Ideas

### 1. Gate FIND_CLIENT_SOURCES to promotion-worthy clients + go extract-lazy
**Description:** Two procedural cuts on the dominant sink. (a) Planner only enqueues
FIND_CLIENT_SOURCES for clients with a live future booking above a minimum score (brewing /
near-hot), never for cold clients that will never promote. (b) Inside the skill, drop Step 3
entirely on the default path: store `{ url, snippet }` from the search result (the lean wrapper
already returns relevance-scored snippets) with **zero extracts**; let ENRICH_CLIENT extract
lazily, and only when it is actually folding that client's dossier and the snippet is insufficient.
**Axis:** Budget & prioritization / Call elimination
**Basis:** `direct:` find-client-sources.md Steps 2–3 (1–3 search + 3–5 extract); memory note
"1,026 clients needing enrichment"; planner foundational-stage fix now lets this run at full width.
**Rationale:** Cuts per-client cost from ~8 credits to ~1 (search only), and skips cold clients
outright. On the largest driver this alone likely clears the 30% target by itself.
**Downsides:** Snippet-only sources are thinner; some enrichment quality shifts to ENRICH_CLIENT.
Needs a clean "score gate" definition in the planner.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 2. Persistent Tavily result cache (search + extract) in SQLite
**Description:** Add a cache table keyed by normalized `(query, depth)` for search and normalized
`url` for extract, with TTLs (e.g. 30–90d extract, 7–30d search). The lean wrapper checks the
cache before calling Tavily; on hit it returns the stored lean payload for **0 credits** and logs
a `cache_hit`. Content is already the trimmed lean JSON, so storage is small.
**Axis:** Caching & reuse
**Basis:** `direct:` no caching exists today; recurring events/venues/companies across bookings and
the same ~27 leedz reappearing guarantee repeat queries; live session re-searched LA Auto Show /
Burning Rubber from scratch.
**Rationale:** Turns all cross-client and cross-run overlap into free hits; compounds with every
other idea (a gated, batched call still benefits from a cache hit).
**Downsides:** Staleness risk on fast-changing pages (mitigated by TTL + a `force` bypass for
DRILL contact hunts). Adds one table + wrapper branch.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 3. Batch tavily_extract to N URLs per call in the wrapper
**Description:** Tavily's extract endpoint bills per URL-*group* (verify current pricing: ~1 credit
per 5 URLs at basic depth). The lean wrapper currently extracts **one URL per call**, so a worker
extracting 5 URLs pays up to 5x. Change `extract_lean` to accept a URL array and issue one batched
request; update FIND_CLIENT_SOURCES / DRILL to pass their chosen URLs as a batch.
**Axis:** Depth & batching
**Basis:** `external:` Tavily extract pricing is per-URL-group — **flag to verify against current
Tavily plan before building**; `direct:` wrapper `extract_lean(url=...)` is single-URL today.
**Rationale:** If the group-billing model holds, this is up to an ~80% cut on extract credits for
any multi-URL worker, independent of caching/gating.
**Downsides:** Entirely contingent on the pricing model; if extract is billed strictly per-URL,
the credit win evaporates (only a latency win remains). Verify first.
**Confidence:** 60% (pending pricing verification)
**Complexity:** Medium
**Status:** Unexplored

### 4. Force search_depth=basic; whitelist advanced by task type
**Description:** The wrapper passes caller-supplied `search_depth` through (advanced = 2 credits).
Clamp to `basic` unless the task type is on a small allowlist (e.g. only DRILL_DOWN's decision-maker
email hunt may go advanced). Enforced in the wrapper, not by prompt.
**Axis:** Depth & batching
**Basis:** `direct:` tavily_lean_mcp.py line ~176 — "Depth stays caller-controllable (advanced is
legitimate for hard queries)."
**Rationale:** Instant 50% cut on every call that currently defaults to or drifts into advanced;
one-line clamp.
**Downsides:** Slightly weaker results on genuinely hard queries not on the allowlist.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 5. Per-task-type Tavily credit budget (hard ceiling)
**Description:** Mirror the existing `TASK_SESSION_BUDGETS` pattern for Tavily. Track credits spent
per run and per task type in the wrapper (or a pipeline gate); when a type exhausts its ceiling,
return a `budget_exhausted` sentinel so the worker completes `cancelled` instead of spending. Makes
total spend deterministic and caps the tail — procedural, not an advisory the weak model ignores.
**Axis:** Budget & prioritization
**Basis:** `direct:` TASK_SESSION_BUDGETS / createBudget infra already exists in mcp_server.js;
em-dash precedent proves advisory prose is ignored, so the cap must be enforced in code.
**Rationale:** Guarantees the 30% target holds even as data volume grows, and localizes overspend
to whichever type is worst.
**Downsides:** A too-tight ceiling starves legitimate enrichment; needs tuning per type.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 6. DISCOVER_SOURCES query ledger + free-channel-first routing
**Description:** (a) Keep a ledger of normalized discovery queries already run, with a cooldown;
skip re-searching the same trade/geo query within N days (VALUE_PROP rarely changes, so cold-start
queries repeat every run). (b) Prefer free channels — RSS `get_top_articles`, sitemaps, and the
Chrome MCP in interactive mode — before spending a Tavily search/extract.
**Axis:** Substitution / Call elimination
**Basis:** `direct:` discover-sources.md runs "a few bounded searches" every cold-start; url-loop.md
already prefers free RSS get_top_articles over tavily_extract, proving the free-first pattern works.
**Rationale:** Removes repeat discovery spend and shifts volume to zero-credit channels.
**Downsides:** Ledger cooldown can miss genuinely new sources; sitemap/Chrome paths add code.
**Confidence:** 70%
**Complexity:** Medium
**Status:** Unexplored

## Recommended combination to clear >= 30%

`#1` (gate + extract-lazy) targets the dominant sink and most likely clears 30% alone. Pair with
`#4` (basic-depth clamp, one line) for an immediate compounding cut, and `#2` (cache) for durable
savings that grow with recurrence. `#3` and `#5` are the next rungs; verify `#3`'s pricing
assumption before investing.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| R1 | Lower `max_results` / `include_answer=false` to save credits | Credit-neutral — Tavily bills per call, not per result; already done as a *token* optimization |
| R2 | Prompt workers to "search less / only when needed" | Advisory prose is ignored by the weak model (em-dash precedent); must be procedural — folded into #1/#5 as enforcement, not a standalone idea |
| R3 | Drop Tavily entirely / re-implement search in LangChain | Subject-replacement + scope overrun; that is the separate "rewrite the orchestrator" question, not a Tavily-spend cut |
| R4 | Route ALL scraping through interactive Chrome to avoid Tavily | Chrome MCP is unavailable in headless runs; partial only — folded into #6's free-first routing |
| R5 | Pretty-print / whitespace trims on responses | Token lever, not a credit lever; already shipped in the lean wrapper |
