---
name: {{DEPLOYMENT_NAME}}-evaluator
description: Evaluate outreach drafts against the three-paragraph structure. Ready or needs work.
triggers:
  - evaluate draft
  - score draft
---

# Draft Evaluator

Evaluate an outreach draft email. Is this good enough to send to a real human?

---

## Input

- The draft text
- The client record (dossier, factlets)
- VALUE_PROP config (PRODUCT, RATE, SIGNATURE, differentiators, forbidden phrases)

---

## Evaluation

Score each paragraph against the structure in `skills/outreach-drafter.md`:

| Element | PASS | FAIL |
|---------|------|------|
| **P1: Event + question** | Names their event, weaves in dossier/factlet context, asks a YES-question specific to their situation | Generic opening, no event, or formulaic question |
| **P2: The scene** | Reader can see the product at their event. Uses differentiators to make it concrete. | Declares fit without showing it. "This is a great match" with no visualization. |
| **P3: Rate + close** | Anchors rate, closes with a specific action tied to their event | Missing rate, generic close, or "let me know" |
| **Signature** | Present, from VALUE_PROP | Missing or invented |
| **Flow** | Reads as one coherent pitch, not three disconnected blocks | Feels modular or robotic |
| **No banned patterns** | Zero AI-isms, zero banned phrases | Any violation |

---

## Booking Readiness

Booking scoring runs automatically on every `pipeline.save`. To force re-score:
```
precrime__pipeline({ action: "rescore", scope: clientId })
```

---

## Output

```
VERDICT: ready | brewing
FAILURES: [specific failed elements]
FIXES: [what to change -- be concrete]
```
