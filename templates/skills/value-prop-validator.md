---
name: value-prop-validator
description: Validate VALUE_PROP.md and extract mandatory config fields. Pipeline cannot continue without a passing result.
triggers:
  - validate value prop
  - check config
  - validate identity
---

# VALUE_PROP Validator

This skill is the config parser. It reads `DOCS/VALUE_PROP.md`, validates mandatory fields, and returns a structured config object. The pipeline does not proceed until this skill returns success.

Called by `init-wizard.md` at startup. Called from error path if headless mode detects an incomplete VALUE_PROP.

---

## Mandatory Fields

Every field below must be present and non-placeholder. Placeholder patterns: `[YOUR`, `[FILL`, `[NAME`, `[COMPANY`, `TBD`, `TODO`, `PLACEHOLDER`, empty string, or the literal template text.

| Field | Where in VALUE_PROP.md | Extracted As |
|-------|----------------------|--------------|
| **Trade** (Leedz category) | `## THE PRODUCT` section, `**Trade:**` line | `TRADE` |
| Product name | `## THE PRODUCT` section, first bold line | `PRODUCT_NAME` |
| Seller name | `**Seller:**` line | `SELLER_NAME` |
| Seller company | `**Seller:**` line | `SELLER_COMPANY` |
| Seller email | `**Seller:**` line or seller section | `SELLER_EMAIL` |
| Website | `**Website:**` line | `SELLER_WEBSITE` |
| Geography | `**Geography:**` line | `GEOGRAPHY` |
| Pitch | `## THE PITCH` section | `PITCH` |
| At least 1 differentiator | `## WHY US` section | `DIFFERENTIATORS[]` |
| Primary buyers | `## WHO BUYS THIS` section | `AUDIENCE_ROLES[]` |
| Segments | `## WHO BUYS THIS` section | `AUDIENCE_SEGMENTS[]` |
| At least 1 relevance signal | `## RELEVANCE SIGNALS` section | `RELEVANT_TOPICS[]` |

**TRADE is the marketplace category.** It MUST match a canonical Leedz trade name returned by `precrime__trades()`. Without TRADE, demand-signal detection cannot pattern-match, scoring cannot promote to `leed_ready`, and the marketplace post will fail. Validate the value is in the `precrime__trades()` list before returning success. If the user supplied a free-text trade that does not match, ask them to pick from the list.

## Optional But Valuable

These improve output quality but do not block the pipeline:

| Field | Effect if present |
|-------|------------------|
| Pain points | Enrichment and drafts reference specific pains |
| Outreach examples | Composer mimics proven draft style |
| Objections | Drafts preemptively address concerns |
| Proof points | Drafts cite real evidence |
| Pricing | Drafts can reference rate |
| Not-relevant signals | Tighter relevance filtering, fewer wasted scrapes |

---

## Procedure

### Step 1: Read

```
Read DOCS/VALUE_PROP.md
```

If the file does not exist: FAIL with `VALUEPROP_MISSING`.

### Step 2: Extract

Parse each mandatory field from the document. For each field:
- Found and non-placeholder -> store the value
- Found but placeholder text -> mark as `MISSING`
- Not found -> mark as `MISSING`

### Step 3: Validate

Count MISSING fields.

**ALL PRESENT** -> return success:
```json
{
  "status": "valid",
  "config": {
    "PRODUCT_NAME": "...",
    "SELLER_NAME": "...",
    "SELLER_COMPANY": "...",
    "SELLER_EMAIL": "...",
    "GEOGRAPHY": "...",
    "PITCH": "...",
    "DIFFERENTIATORS": ["..."],
    "AUDIENCE_ROLES": ["..."],
    "AUDIENCE_SEGMENTS": ["..."],
    "RELEVANT_TOPICS": ["..."]
  },
  "optional_present": ["pain_points", "outreach_examples"],
  "optional_missing": ["objections", "proof_points"]
}
```

**ANY MISSING** -> return failure:
```json
{
  "status": "incomplete",
  "missing": ["GEOGRAPHY", "AUDIENCE_SEGMENTS"],
  "present": ["PRODUCT_NAME", "SELLER_NAME", "..."]
}
```

### Step 4: Handle Failure

**Interactive mode:**

For each missing field, ask the user a plain-language question:

| Missing Field | Question |
|---------------|----------|
| `TRADE` | What Leedz trade category? Call `precrime__trades()` and show the list; ask user to pick one. |
| `PRODUCT_NAME` | What is the name of your product or service? |
| `SELLER_NAME` | What is your name? |
| `SELLER_COMPANY` | What is your company name? |
| `SELLER_EMAIL` | What is your email address? |
| `SELLER_WEBSITE` | What is your website URL? |
| `GEOGRAPHY` | What area do you serve? (city, metro, region) |
| `PITCH` | Describe what you sell in 2-3 sentences. |
| `DIFFERENTIATORS` | What makes you different from competitors? Name 1-3 specific facts. |
| `AUDIENCE_ROLES` | Who typically buys this? (job titles or roles) |
| `AUDIENCE_SEGMENTS` | What types of clients do you serve? (e.g., corporate, weddings, schools) |
| `RELEVANT_TOPICS` | What topics signal that someone might need your product? |

After collecting answers, write them into `DOCS/VALUE_PROP.md` in the appropriate sections. Then re-run Step 2 and Step 3 to confirm.

**Headless mode:**

Log `VALUEPROP_INCOMPLETE: missing [field list]`. Exit with error. The pipeline cannot proceed headless without a valid VALUE_PROP.

---

## Rules

1. Never invent values. If the user doesn't provide a field, it stays missing.
2. Never modify sections the user has already completed. Only fill blanks.
3. After writing, re-validate. The write must have actually fixed the missing fields.
4. This skill produces no side effects except writing to VALUE_PROP.md. No client records, no factlets, no tool calls beyond file read/write.
5. The config object returned by this skill is the ONLY source of business identity for all downstream skills. No other skill reads VALUE_PROP.md directly.
