---
name: outreach-drafter
description: Compose pro-forma outreach email from client + booking + factlets + VALUE_PROP.md. Deterministic template.
triggers:
  - draft outreach
  - draft email
  - compose draft
---
<!-- v2-compat: tools migrated to precrime__pipeline / precrime__find / precrime__trades surface -->

# Outreach Drafter

Pro-forma email composer. The score gate (computed inside `precrime__pipeline.save`) has already passed, your job is to template a clean, sendable draft. Quality is verified afterward by `skills/draft-checker.md`.

## Inputs

- `client` (name, email, company, segment, dossier)
- `booking` (trade, startDate, location)
- Linked factlets, normally already hydrated on the client returned by `precrime__pipeline({ action: "next", entity: "client" })`. If not present, fetch via `precrime__find({ action: "factlets", filters: { clientId } })`. Filter to `relevance: true`.
- `DOCS/VALUE_PROP.md` — read every time. Source of truth for voice, closing line, forbidden phrases, word limit.

## Output

Plain-text email body. Persisted via:

```
precrime__pipeline({ action: "save", id: client.id, patch: { draft: "<body>", draftStatus: "brewing" } })
```

`draftStatus` flips to `ready` only after `draft-checker.md` passes.

---

## Template

```
Dear {client.name},

{HOOK — 1 sentence referencing the most specific recent factlet (event, post, hire, program). NOT a generic fact about their org.}

{BRIDGE — 1 sentence connecting that factlet to a specific capability in VALUE_PROP.md. The reader thinks "they understand my situation".}

{ASK — 1 sentence asking for a specific next step (15-min call, sample, etc.). Imperative, not passive.}

{CLOSING — copy verbatim from DOCS/VALUE_PROP.md "Permitted closing line".}

{SIGNOFF — Config.companyName per VALUE_PROP.md voice section.}
```

Total: ≤4 short paragraphs, under VALUE_PROP.md word limit.

---

## Rules baked into the template

1. **Open `Dear {client.name},` on its own line.** Never "Hello", "Hi", "Greetings". Never start with the hook.
2. **One factlet citation, one bridge, one ask.** No more, no less.
3. **No em-dash, en-dash, `--`, or smart quotes.** Anywhere. Replace with comma, period, or restructure.
4. **No forbidden phrases.** Check `DOCS/VALUE_PROP.md` "Forbidden phrases" section.
5. **No "X is great BUT Y" / negging / interrogation patterns.** Warm and collegial, never adversarial.
6. **No filler.** Banned: "I hope this finds you well", "I'm reaching out because", "I am writing to", "I would love to".
7. **Closing line is exact text from VALUE_PROP.md.** No paraphrasing.

---

## Failure modes (do not draft, set `draftStatus: "brewing"`, log reason, return)

| Condition | Log line |
|---|---|
| Client has zero factlets with `relevance=true` | `NO_FACTLETS` |
| All factlets stale (zero weight per `pipeline.save` factletStats) | `STALE_INTEL` |
| `client.email` missing or generic | `NO_DIRECT_EMAIL` (failsafe, pipeline.save scoring should catch) |
| `DOCS/VALUE_PROP.md` contains placeholder text | STOP entire flow. Tell user. |
