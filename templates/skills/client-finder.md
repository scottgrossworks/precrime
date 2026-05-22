---
name: {{DEPLOYMENT_NAME}}-client-finder
description: Find direct email address for a named contact. 5-phase playbook.
triggers:
  - find email
  - find contact
  - email lookup
---

# Client Finder (Email Discovery)

Find a direct email address for a named person at a known company. Called by the enrichment agent when a client has a generic inbox or no email.

---

## Input

- `target_name` -- the person's name
- `company` -- company name
- `domain` -- company domain (from email or website, if known)
- `generic_email` -- current email if generic (info@, contact@, etc.)
- `client_id` -- for saving results

---

## 5-Phase Playbook

### Phase 1: Domain Discovery

If domain unknown, search: `"[company]" site` via SESSION_AI or Tavily. Extract the primary domain.

### Phase 2: Email Format Lookup

Search Google for email patterns: `"[domain]" email format site:rocketreach.co OR site:prospeo.io OR site:contactout.com`

Common patterns: `first@domain`, `first.last@domain`, `flast@domain`, `firstl@domain`.

### Phase 3: Personnel Discovery

Search: `"[company]" "[target_name]" site:linkedin.com/in/`

If the target name yields nothing, search for other personnel at the company to confirm naming patterns.

### Phase 4: Format Application

Apply discovered format to target name. Generate 2-3 candidate emails.

### Phase 5: Validation

Search each candidate: `"[candidate@domain]"` (exact quoted). Any hit confirms it.

---

## Output

| Status | Meaning | Action |
|--------|---------|--------|
| `found` | Verified direct email | Save to client record |
| `high_confidence` | Pattern-inferred, not verified | Save to client record |
| `guessed` | Low confidence | Do NOT save. Log only. |
| `failed` | Nothing found | Leave existing email. Log. |

On `found` or `high_confidence`:
```
precrime__pipeline({ action: "save", id: client_id, patch: { email: "[found email]" }})
```

---

## Rules

1. Spend max 60 seconds per contact. Volume over depth.
2. Never fabricate emails. Pattern-infer only from confirmed formats.
3. Never save a `guessed` email to the client record.
