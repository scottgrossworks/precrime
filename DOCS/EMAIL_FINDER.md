# EMAIL_FINDER — Skill Specification for Implementation

**Author:** Scott / Claude session 2026-04-10
**Purpose:** Hand this document to a fresh coding agent to implement as a callable skill.

---

## WHAT THIS IS

A browser-based email discovery skill for the Pre-Crime enrichment pipeline. Given a person's name and company, it systematically hunts for their direct email address using the Chrome browser automation tools already available in this workspace.

**This is NOT a code project.** It is a skill file (like `skills/enrichment-agent.md`) that Claude executes using existing MCP tools. No new npm packages, no new servers, no API keys. Just a structured playbook that uses `mcp__claude-in-chrome__*` tools, `WebSearch`, and `WebFetch`.

---

## THE PROBLEM

The enrichment agent frequently finds a company and a contact name but gets stuck with a generic email (info@, contact@, MemberServices@). Per project rules, generic emails cap warmth at 5-6, well below the ready threshold of 9. The current manual process (demonstrated 2026-04-10 on Griffin Club LA) took ~15 browser actions across LinkedIn, Google, Facebook, and the company website to find the email format. This skill codifies that exact process so it can be invoked with one call.

---

## INTERFACE

### Input (passed by the enrichment agent or user)

```
target_name:    "Jocelyn Contreras"       # Required. First + Last.
company:        "Griffin Club Los Angeles" # Required. Company or org name.
domain:         "griffinclubla.com"        # Optional. If known, skip domain discovery.
generic_email:  "MemberServices@griffinclubla.com"  # Optional. Confirms domain, proves email exists.
role:           "Member Events Manager"    # Optional. Helps filter LinkedIn results.
client_id:      "july4_011"               # Optional. If provided, update the client record on success.
```

### Output

```
status:         "found" | "high_confidence" | "guessed" | "failed"
email:          "jocelyn@griffinclubla.com"
format:         "first@domain.com"
confidence:     "89.8% per RocketReach"
source:         "RocketReach email format page via Google"
alt_contacts:   [{name, title, email_guess}]  # Other personnel discovered
notes:          "Also found Gillian Sterns (Private Events Manager)"
```

If `client_id` is provided AND status is "found" or "high_confidence":
- Update client `email` field
- Append discovery notes to `dossier`
- Do NOT change warmthScore (let the enrichment agent re-score)

---

## THE ALGORITHM

### Phase 1: Domain Discovery (skip if domain provided)

1. Google: `"{company}" site:linkedin.com/company`
2. Extract company website URL from LinkedIn or Google knowledge panel
3. Confirm domain from website

### Phase 2: Email Format Discovery (the money step)

Search Google for the company's email format. These sites index email patterns from public data and almost always have a result:

```
Query 1: "{domain}" email format site:rocketreach.co
Query 2: "{domain}" email format site:contactout.com  
Query 3: "{domain}" email format site:prospeo.io
Query 4: "{domain}" email format site:lead411.com
Query 5: "@{domain}" email -info -contact -support -hello
```

**Parse the Google snippet.** These sites show the format right in the search result without requiring login:
- RocketReach: "uses 2 email formats: 1. first@domain.com (89.8%)"
- Prospeo: "The most common is {first} (e.g., j@domain.com), used 50%"
- ContactOut: shows masked emails like "******@domain.com"

**Rank by confidence.** If multiple sources agree on a format, confidence is high. If they disagree, note both.

Common formats to look for (in order of frequency):
1. `first@domain.com` (most common for small/mid orgs)
2. `first.last@domain.com`
3. `flast@domain.com` (first initial + last)
4. `firstl@domain.com` (first + last initial)
5. `first_last@domain.com`
6. `first.last@parentdomain.com` (if subsidiary — e.g., Bay Club owns Griffin Club)

### Phase 3: Personnel Discovery (if target name is weak or unconfirmed)

If we only have a generic email and no target name, or if we want to validate:

1. **LinkedIn People tab:** Navigate to `linkedin.com/company/{slug}/people/`
   - Read the page text — LinkedIn shows names, titles, and connection degree
   - Filter for event-related titles: "Events Manager", "Event Coordinator", "Marketing", "Special Events", "Entertainment"
   - Note ALL names and titles (useful for alt_contacts output)

2. **Company website:** Check `/about`, `/team`, `/staff`, `/contact` pages
   - Look for staff directories, bios, or email addresses
   - Some sites list department emails (events@, catering@) which are better than info@ but still generic

3. **Facebook About page:** Navigate to `facebook.com/{page}/about`
   - Sometimes lists staff or has email addresses

4. **Google:** `"{company}" "{target_name}" email`
   - Sometimes email appears in event programs, speaker lists, press releases, or vendor directories

### Phase 4: Apply Format to Target

Take the discovered format and apply it to `target_name`:

```
Format: first@domain.com
Target: Jocelyn Contreras
Result: jocelyn@griffinclubla.com
```

Handle edge cases:
- Hyphenated last names: try both `mary-jane@` and `maryjane@`
- Suffixes (Jr, III): drop them
- Non-ASCII characters: transliterate (e.g., e for e-accent)

### Phase 5: Validation (optional, best-effort)

If format came from only ONE source with low confidence:
- Google the constructed email in quotes: `"jocelyn@griffinclubla.com"`
- Check if it appears in any public listing, directory, or event program
- If zero hits AND confidence is low, return status "guessed" instead of "high_confidence"

---

## DECISION TREE

```
START
  |
  v
Do we have a domain?
  YES --> skip to Format Discovery
  NO  --> Phase 1: Domain Discovery
  |
  v
Search RocketReach/Prospeo/ContactOut for email format
  |
  v
Format found with >70% confidence?
  YES --> Apply to target name --> status: "high_confidence"
  NO  --> Format found with <70%?
            YES --> Apply to target name --> status: "guessed"
            NO  --> Go to Phase 3: Personnel Discovery
  |
  v
Personnel Discovery: find other employees' actual emails
  |
  v
Found a real email for another employee?
  YES --> Reverse-engineer the format --> Apply to target --> status: "found"
  NO  --> Search Google for target's email directly
            |
            v
            Found?
              YES --> status: "found"
              NO  --> Return best guess or status: "failed"
```

---

## TOOL USAGE

This skill uses ONLY existing MCP tools. No new tools needed.

| Tool | Usage |
|------|-------|
| `mcp__claude-in-chrome__tabs_context_mcp` | Get browser context (call once at start) |
| `mcp__claude-in-chrome__tabs_create_mcp` | Open tabs for parallel searches |
| `mcp__claude-in-chrome__navigate` | Navigate to LinkedIn, Google, company sites |
| `mcp__claude-in-chrome__get_page_text` | Extract text from pages |
| `mcp__claude-in-chrome__read_page` | Read page structure when get_page_text is too noisy |
| `mcp__claude-in-chrome__find` | Find specific elements (Contact Info links, staff bios) |
| `mcp__claude-in-chrome__computer` | Click links, take screenshots when needed |
| `mcp__precrime-mcp__update_client` | Update client record on success (if client_id provided) |

---

## INTEGRATION WITH ENRICHMENT AGENT

The enrichment agent (`skills/enrichment-agent.md`) should invoke this skill at the scoring step when:

1. Client has a generic email (info@, contact@, hello@, support@, sales@, MemberServices@, orders@)
2. Client has NO email but has a company name
3. Client has a name + company but warmth is capped due to missing direct email

### Handoff pattern:

```
Enrichment agent detects: client has generic email + company name
  --> "EMAIL_FINDER: Find direct email for {name} at {company} ({domain})"
  --> Email finder runs Phases 1-5
  --> Returns result to enrichment agent
  --> Enrichment agent updates warmthScore based on new email quality
```

---

## FAILURE MODES AND LIMITS

- **Max 10 browser actions per search.** If you haven't found the format by then, return "failed" with notes on what was tried.
- **Private companies with no LinkedIn:** Skip to Google direct search.
- **LinkedIn requires login for some pages:** Use `get_page_text` first. If empty, try `read_page`. If still nothing, skip LinkedIn and rely on Google/format sites.
- **RocketReach/Prospeo behind paywall:** The Google snippet usually shows the format without requiring login. Never click through to these sites — just read the Google search result snippet.
- **Multiple people with same name:** Use role/title to disambiguate.
- **Domain redirect (subsidiary):** If griffinclubla.com redirects to bayclubs.com, try BOTH domains.

---

## EXAMPLE RUN (from actual session)

**Input:**
```
target_name: "Griffin Club Events" (generic — no person name)
company: "Griffin Club Los Angeles"
domain: "griffinclubla.com"
generic_email: "MemberServices@griffinclubla.com"
```

**Execution:**
1. LinkedIn `/company/griffin-club-la/people/` --> Found Jocelyn Contreras (Marketing & Special Events), Gillian Sterns (Private Events Manager)
2. Google `"@griffinclubla.com" email -MemberServices` --> RocketReach snippet: "first@griffinclubla.com (89.8%)"
3. Applied format: jocelyn@griffinclubla.com
4. Google validated: Prospeo confirmed same format

**Output:**
```
status: "high_confidence"
email: "jocelyn@griffinclubla.com"
format: "first@domain.com"
confidence: "89.8% per RocketReach, confirmed by Prospeo"
source: "RocketReach + Prospeo via Google snippets"
alt_contacts: [
  {name: "Gillian Sterns", title: "Private Events Manager", email_guess: "gillian@griffinclubla.com"}
]
```

---

## IMPLEMENTATION NOTES FOR THE CODING AGENT

1. **This is a skill file, not application code.** Create `skills/email-finder.md` following the same frontmatter format as other skills in this directory.
2. **The skill is executed by Claude, not by a script.** It's a set of instructions Claude follows using browser tools.
3. **Keep the phases sequential but allow early exit.** If Phase 2 finds a 90%+ confidence format, skip Phase 3.
4. **Google snippets are the primary data source.** RocketReach, Prospeo, ContactOut, and Lead411 all show email format data in their Google search snippets without login. This is the key insight.
5. **LinkedIn People tab is the primary source for contact names.** It shows names and titles without requiring a connection.
6. **Never click into RocketReach/Prospeo/etc.** These sites have paywalls. Read the Google snippet only.
7. **The enrichment agent integration requires editing `skills/enrichment-agent.md`** to add a handoff call when generic emails are detected. That's a separate change.
8. **Test with these known cases:**
   - Griffin Club LA (MemberServices@ --> jocelyn@griffinclubla.com) — VALIDATED
   - Any client in the DB with an info@/contact@ email
