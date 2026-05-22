# Factlet Creation Rules

A factlet is a short, broadly applicable intelligence item. It captures a fact from the world that is relevant to selling the product described in VALUE_PROP.

## Format

Exactly 2-3 sentences. No more.

- **S1:** What happened. Include numbers, dates, names where available.
- **S2:** Why it matters for the target audience (per VALUE_PROP config).
- **S3 (optional):** Implication for buying urgency or decision timing.

## Rules

1. Facts only. No opinion. No editorializing.
2. Never mention the product in the factlet. The factlet is intelligence -- the composer connects it to the product later.
3. Only broadly applicable findings. Client-specific intel goes in the client's dossier, not a factlet.
4. Two articles about the same story produce ONE factlet. Check existing factlets before creating.
5. Source must be the live URL that proves the claim. `pipeline.save` rejects dead URLs, homepage redirects, and pages that do not mention the factlet terms/year.

## Good Example

"[Industry body] reported a 34% increase in [relevant trend] across [geography] in Q1 2026. Organizations that have not addressed [pain point] face [consequence] by [deadline]."

## Bad Example (pitches the product)

"There's a new trend in [industry]. Organizations should look into tools like [the product]."

## How to Save

Attach to a relevant client:
```
precrime__pipeline({ action: "save", id: clientId, patch: {
  factlets: [{ content: "[2-3 sentences]", source: "[URL]", signalType: "context" }]
}})
```

Signal types:
- `pain` (2 pts): confirms or adds to a problem this client faces
- `occasion` (2 pts): signals a buying occasion, deadline, or trigger
- `context` (1 pt): useful background but no direct pain/occasion

If no client target exists yet, log to `logs/UNLINKED_INTEL.md` with content + source. Promote to a client when one surfaces.

## Dedup

Before creating, check:
```
precrime__find({ action: "factlets", filters: { sinceTimestamp: "<ISO timestamp for 30 days ago>" }, limit: 100 })
```
If an existing factlet covers the same event, policy, or study -- skip.
