<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->
***
*** FIXME FIXME FIXME
*** client finder
*** goal is to define a client with all relevant contact info
***


# Email Finder

Find a direct email address for a named contact. Called by the enrichment agent when the client has a generic inbox, no email, or a format-constructed address.

## Inputs

```
target_name:   client.name
company:       client.company
domain:        <from client.email or client.website, if known>
generic_email: <current client.email, if generic — else null>
role:          client.role (if set — else null)
client_id:     client.id
```

## Output

One of four statuses:

| Status | Meaning | DB write? |
|--------|---------|-----------|
| `found` | Email confirmed verbatim in a public source | YES, `precrime__pipeline({ action: "save", id: client_id, patch: { email: <email> } })` |
| `high_confidence` | Email constructed from confirmed domain + confirmed format + confirmed person name | YES, `precrime__pipeline({ action: "save", id: client_id, patch: { email: <email> } })` |
| `guessed` | Email constructed but format unconfirmed (only one source, or format not cross-checked) | NO — do not write to DB |
| `failed` | Could not find a usable email | NO — leave existing inbox unchanged |

**If `found` or `high_confidence`:** Write the email to the DB immediately before returning. Do not leave this to the caller.

**If `guessed` or `failed`:** Do NOT update the client record. Return status only.

---

## Tool Priority

**Detect mode from session context set in Step A of enrichment-agent (HEADLESS flag).**

**Do NOT attempt to install Chrome, a browser, or any software. If Chrome is unavailable, use headless tools and proceed.**

**Interactive mode (Chrome available, HEADLESS = false):**
- Personnel search → SESSION_AI (Gemini/Grok) first. Never use tavily__tavily_search in interactive mode.
- Page scraping → Chrome navigate + get_page_text

**Headless mode (HEADLESS = true, or Chrome tools fail):**
- Personnel search → tavily__tavily_search (or your equivalent web search tool)
- Page scraping → tavily__tavily_extract (or your equivalent fetch tool)
- LinkedIn People tab → skip, use web search instead

---

## Phase 1: Domain Discovery

Establish the company's email domain.

**If `domain` is already known (from client.website or client.email):** skip to Phase 2.

**If not known:**
1. Search: `"[company name]" email OR contact`
2. Look at any website URL — strip to root domain (e.g., `acme.com`)
3. Check if the company has multiple domains (e.g., .org vs .com variant) — pick the one that appears in contact emails in search results

**If no domain found:** Return `failed`. Log `DOMAIN_NOT_FOUND`.

---

## Phase 2: Email Format Lookup

Find the company's standard email format (e.g., `firstname.lastname@`, `f.lastname@`, `firstname@`).

Search each of these in order. Stop when you find a consistent format — do not exhaust all four:

1. `site:rocketreach.co "[company name]" email format`
2. `site:prospeo.io "[company name]" email`
3. `site:contactout.com "[company name]" email format`
4. `site:lead411.com "[company name]" email`

**Extract from Google snippet text** — you are reading preview text, not visiting the pages (they require login).

**Pattern to extract:** Look for phrases like:
- `"The most common email format at [company] is firstname@"`
- `"[company] uses f.lastname@[domain]"`
- Actual sample emails with a person's name visible

**Confirm format:** If two sources agree, format is confirmed. If only one source, format is unconfirmed.

**If no format found:** Note this — Phase 4 will fall back to common patterns.

---

## Phase 3: Personnel Discovery

Find the specific target person's full name if `target_name` is generic, a first name only, or missing.

**Skip Phase 3 if:** `target_name` is already a full first + last name AND `role` matches a decision-maker role for this context.

**Search strategy:**
1. LinkedIn People tab: `site:linkedin.com/in "[company name]" "[role]"` — look for the right person
2. Company website: navigate to `/about`, `/team`, `/staff`, `/contact` — look for named staff with matching role
3. If SESSION_AI is available, ask: `"Who is the [role] at [company name] in [city]? I need their full name."`

**Accept the name if:**
- Found on the company's own website (staff/team/about page) → `found`-grade confidence
- Found on LinkedIn with matching company and role → `high_confidence`-grade confidence
- Mentioned in a news article or press release → `high_confidence`-grade confidence

**If name confirmed but different from `target_name`:** Use the newly found name for Phase 4. Note the discrepancy in the log.

**If no person found:** Proceed with `target_name` as-is. If `target_name` is null, return `failed`. Log `PERSON_NOT_FOUND`.

---

## Phase 4: Format Application

Construct the email address.

**If format confirmed in Phase 2:**
Apply it to the person's name:
- `firstname.lastname@domain` → e.g., `scott.gross@acme.com`
- `f.lastname@domain` → e.g., `s.gross@acme.com`
- `firstname@domain` → e.g., `scott@acme.com`
- `flastname@domain` → e.g., `sgross@acme.com`

**If format not confirmed:** Try the three most common patterns in order:
1. `firstname.lastname@domain`
2. `firstname@domain`
3. `f.lastname@domain`

Hold all constructed candidates — you will attempt validation in Phase 5.

---

## Phase 5: Validation

Attempt to verify the constructed email before writing to the DB.

**Validation methods (try in order, stop when one succeeds):**

1. **Direct web appearance:** Search `"[constructed email]"` — if it appears verbatim in a public source (website, event listing, press release, PDF), it is `found`. Write and return.

2. **Cross-source consistency:** If the same email address appears in two or more independent sources (e.g., LinkedIn bio AND company site), it is `high_confidence`. Write and return.

3. **Format confirmed + person confirmed:** If Phase 2 confirmed the format AND Phase 3 confirmed the person's name from a reliable source, the constructed address is `high_confidence`. Write and return.

4. **Format confirmed, person unconfirmed OR person confirmed, format unconfirmed:** Status = `guessed`. Do NOT write to DB. Return `guessed`.

5. **No validation possible:** Status = `failed`. Do NOT write to DB. Return `failed`.

---

## DB Write (found / high_confidence only)

```
precrime__pipeline({
  action: "save",
  id: client_id,
  patch: { email: <discovered email> }
})
```

Write this before returning. The caller (enrichment-agent Step 3.6) expects the DB to already be updated when status is `found` or `high_confidence`.

---

## Return Format

```
EMAIL_FINDER RESULT
Status:       found | high_confidence | guessed | failed
Email:        <email address, or null if failed>
Source:       <where it was found / how it was constructed>
Person:       <full name used — may differ from original target_name>
Format:       <format pattern used, e.g., "firstname.lastname@domain">
Format confirmed: yes | no
```

---

## Log Entry (always write to ROUNDUP.md)

Append under the current client entry:

```
- Email Finder: [status] — [email if found, else 'none'] ([source in one phrase])
```

Examples:
```
- Email Finder: found — sarah.jones@acme.com (verbatim on /team page)
- Email Finder: high_confidence — s.jones@acme.com (confirmed format via RocketReach + LinkedIn name confirmed)
- Email Finder: guessed — info@acme.com left unchanged (format unknown, name only partial)
- Email Finder: failed — DOMAIN_NOT_FOUND
```

---

## Edge Cases

**Multiple people found with same role:** Pick the most senior or most recently active one. Note the choice in the log.

**Email domain mismatch:** Company uses `@parent-co.com` for emails but website is `subsidiary.com` — use the email domain confirmed from Phase 2 snippets, not the website domain.

**Name with accent characters:** Construct without accents (e.g., José → jose). Email systems rarely preserve diacritics.

**Company has no web presence:** Return `failed` after Phase 1. Do not proceed.

**Rate limiting / blocked searches:** Switch to the other SESSION_AI or fall back to tavily__tavily_search. Log `SEARCH_BLOCKED`. Do not retry more than twice.
