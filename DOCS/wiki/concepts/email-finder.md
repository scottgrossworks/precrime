---
title: Email Finder Skill
tags: [skill, enrichment, contact-gate, email, scraping, discovery]
source_docs: [DOCS/EMAIL_FINDER.md, templates/skills/email-finder.md, templates/skills/enrichment-agent.md]
last_updated: 2026-04-11
staleness: none
---

The Email Finder is a callable sub-skill invoked by the enrichment agent at Step 3.6 whenever a client has a generic inbox, no email at all, or a pattern-constructed guess. It runs a deterministic 5-phase browser playbook that hunts down a direct email address for a named contact. It exists because the contact gate (see [[scoring]]) rejects generic inboxes — a client with rich dossier intel but only `info@` is a `READY_BLOCKED_CONTACT` that cannot be drafted until a real address is found.

---

## Key Insight — Why This Skill Works

Four commercial email aggregators (RocketReach, ContactOut, Prospeo, Lead411) expose email-format data directly in their **Google search snippets** without requiring login. A targeted `site:rocketreach.co` query against a company's domain usually returns a snippet like `"uses 2 email formats: 1. first@domain.com (89.8%)"`. **Read the snippet, never click through** — these sites have paywalls. This observation is what makes the skill feasible using only the existing `WebSearch` tool.

---

## Interface

### Input

| Field | Required | Notes |
|---|---|---|
| `target_name` | Yes | First + Last of the target contact |
| `company` | Yes | Company or org name |
| `domain` | No | If known, skip Phase 1 |
| `generic_email` | No | Confirms domain, proves an inbox exists |
| `role` | No | Disambiguates duplicate names |
| `client_id` | No | If set, skill writes result back via `update_client` |

### Output

```
status:       "found" | "high_confidence" | "guessed" | "failed"
email:        constructed address
format:       detected pattern (e.g. "first@domain.com")
confidence:   e.g. "89% per RocketReach"
source:       which aggregator/page produced the format
alt_contacts: [{ name, title, email_guess }]  # other personnel found en route
notes:        free-text context
```

### Write-back Rules

If `client_id` is provided AND status is `found` or `high_confidence`:
- Skill calls `mcp__precrime-mcp__update_client({ id, email, dossier: <append> })`
- **Skill does NOT touch `warmthScore` or `dossierScore`.** The enrichment agent re-runs `score_client` after the skill returns.

---

## The 5-Phase Algorithm

### Phase 1 — Domain Discovery (skip if `domain` provided)

1. `WebSearch`: `"{company}" site:linkedin.com/company`
2. Extract company website from LinkedIn snippet or Google knowledge panel
3. Confirm domain from website

### Phase 2 — Email Format Discovery (the money step)

Five Google queries, snippets-only:

```
"{domain}" email format site:rocketreach.co
"{domain}" email format site:contactout.com
"{domain}" email format site:prospeo.io
"{domain}" email format site:lead411.com
"@{domain}" email -info -contact -support -hello
```

Multiple aggregators agreeing → high confidence. Disagreement → prefer the higher cited percentage.

**Common formats (frequency order):**
1. `first@domain.com`
2. `first.last@domain.com`
3. `flast@domain.com`
4. `firstl@domain.com`
5. `first_last@domain.com`
6. `first.last@parentdomain.com` (subsidiary — parent owns the child's domain)

### Phase 3 — Personnel Discovery (fallback if Phase 2 fails)

1. LinkedIn People tab: `linkedin.com/company/{slug}/people/` via `mcp__Claude_in_Chrome__get_page_text` — names/titles visible without login
2. Company website staff pages (`/about`, `/team`, `/staff`, `/contact`)
3. Facebook About page: `facebook.com/{page}/about`
4. Targeted Google: `"{company}" "{target_name}" email`

Any real full email found for ANY employee → reverse-engineer the format from it.

### Phase 4 — Apply Format

Combine format with target name. Edge cases handled: hyphenated last names (try both `mary-jane@` and `maryjane@`), drop suffixes (Jr/III/PhD), transliterate non-ASCII (`é` → `e`), drop middle names unless format uses them.

### Phase 5 — Validation (optional)

Only runs if the format came from one source with <70% confidence. Quoted `WebSearch` of the constructed email; any public hit upgrades to `high_confidence`, zero hits leaves it as `guessed`.

---

## Decision Tree

```
Have domain?
  NO → Phase 1
  YES → Phase 2
   ↓
Phase 2 hit (>70%)?
  YES → Phase 4 → "high_confidence"
  NO  → Phase 2 hit (<70%)?
          YES → Phase 4 → Phase 5 → "high_confidence" | "guessed"
          NO  → Phase 3
                 ↓
                Real email for ANY employee?
                  YES → reverse format → Phase 4 → "found"
                  NO  → Google target directly
                          ↓
                         "found" | best-guess | "failed"
```

---

## Hard Limits

- **10 browser/search actions max per run.** Enforced to prevent runaway loops.
- **Never click through aggregator sites.** They have paywalls. Snippet-only.
- If cap is hit, return `failed` with the partial `alt_contacts` list gathered so far — even a failed run produces useful personnel intel.

---

## Integration with Enrichment Pipeline

The enrichment agent's Step 3.6 (see [[scoring]] and the `enrichment-agent.md` skill) detects trigger conditions and invokes this skill:

**Trigger conditions:**
- Client email is a generic inbox: `info@, contact@, hello@, support@, sales@, admin@, office@, customerservice@, orders@, memberservices@, etc.`
- Client has no email at all but has a named contact + company
- Client has a format-constructed guess not found verbatim in any source

**Result handling in enrichment-agent Step 3.6:**

| Skill status | Action | Log |
|---|---|---|
| `found` / `high_confidence` | Tier 1. Full credit. `client.email` already written. | — |
| `guessed` | Tier 2. `client.email` NOT written. Cap downstream score at 6. | `GENERIC_EMAIL` |
| `failed` | Leave existing inbox. Enforce cap. | `EMAIL_UNVERIFIED` |

After handoff, the enrichment agent continues to Step 4 (`score_client`) — the fresh email (or lack thereof) feeds the contact gate. This is what turns a `READY_BLOCKED_CONTACT` into a draft-eligible client without re-scraping.

---

## Tool Dependencies

Uses existing MCP tools only — zero new packages, servers, or API keys:

| Tool | Role |
|---|---|
| `WebSearch` | Primary — all Phase 2 and Phase 5 queries |
| `WebFetch` | Company website scraping in Phase 3 |
| `mcp__Claude_in_Chrome__*` | LinkedIn People tab, Facebook About (login-walled paths) |
| `mcp__precrime-mcp__update_client` | Write-back on success |

---

## Generic Template

The skill is fully deployment-agnostic. Lives at `templates/skills/email-finder.md` with the standard `{{DEPLOYMENT_NAME}}` token, copied into each workspace by `deploy.js` alongside the other per-deployment skills. No client names, domains, or project-specific data baked in.

---

## Related
- [[scoring]] — contact gate, dossier score, draft eligibility, Step 3.6 placement in the pipeline
- [[architecture]] — skill files table, data flow
- [[mcp]] — `update_client` tool definition
