# SCORING — Pre-Crime Unified Scoring Algorithm

**Read at runtime by evaluator and drafters. Tuned continuously.**

---

## Goal

Produce a single score that predicts **probability of conversion** — the chance this target becomes a booked gig. Structure completeness alone is worthless; a perfectly-formed record for a random exhibitor scores the same as a tournament director who asked for your service. Conversion probability comes from **factlets** — the intel connecting this client to what VALUE_PROP.md says you sell.

---

## Scoring is automatic on every save

Scoring runs inside every `precrime__pipeline({ action: "save", ... })`. The score is returned in the response payload as `score: { total, shareReady, draftReady, components, action }`. There is no standalone `score_target` tool in v2.

To re-score after enrichment without changing other fields, call save again on the same client with an empty patch (or any fresh field). To inspect a booking's current score without saving, query `precrime__find({ action: "bookings", filters: { ... } })` and read `bookingScore` and `shareReady` from the returned record.

---

## Two inputs, one formula

### Booking target

```
dataScore        = trade(20) + date(20) + location(20) + contact(20) + desc(10) + time(10)   // 0-100
factletScore     = SUM over relevant factlets of max(0, 1 - ageDays / staleDays)              // 0..N
factletMultiplier = min(1.0, factletScore / FACTLET_THRESHOLD)                                // 0..1

total = round(dataScore * factletMultiplier)
```

A booking with 0 relevant factlets → multiplier 0 → total 0. A booking with complete data and 3+ fresh relevant factlets → multiplier 1.0 → total = dataScore.

**shareReady** (marketplace leed post) requires ALL THREE:
1. **Named human contact + direct email** — `contact === 20` (no name-only, no generic info@/events@/customerservice@)
2. **Demand signal** — `factletMultiplier ≥ 1.0` (3+ fresh relevant factlets connecting THIS client to the VALUE_PROP)
3. **Complete data** — total ≥ 70, trade ≥ 20, date ≥ 20, location ≥ 15, AND zip present

If any of the three is missing, status stays `new`. Period. Form completeness alone (trade + date + location) is NOT qualification.

**draftReady** (outreach email):
- same API hard gates
- AND `factletMultiplier ≥ 0.5` (1.5+ fresh relevant factlets — softer than share)

### Client target (no booking bound)

```
factletScore     = SUM over relevant factlets of max(0, 1 - ageDays / staleDays)
dossierScore     = intelScore + round(factletScore * 2)
contactGate      = hasName AND hasDirectEmail (non-generic)
draftReady       = contactGate AND dossierScore >= 5
```

Used to gate enrichment / outreach before a specific booking is pinned down.

---

## Factlet freshness (age decay)

Linear decay from weight 1.0 (today) to 0.0 at `staleDays`:

```
weight = max(0, 1 - ageDays / staleDays)
```

- `staleDays` is tunable per deployment via `Config.factletStaleDays` (default 180).
- Interactive mode's init-wizard asks the user to confirm the value — trades with long planning cycles (conventions, weddings) may set 365+.
- Headless mode uses the stored value; if unset, falls back to 180.

---

## Factlet relevance (binary)

`ClientFactlet.relevance Boolean` — T/F gate at ingestion.

- Set by `relevance-judge` at factlet-ingest time.
- `false` → factlet contributes 0 to any score, regardless of age.
- `true` → factlet contributes `weight` (see age decay above).

The deprecated `signalType` (pain/occasion/context) and `points` fields are retained on the table for back-compat but are NOT consulted by `score_target`.

---

## Tunables (constants in `server/mcp/mcp_server.js`)

| Constant | Default | Location | Meaning |
|---|---|---|---|
| `FACTLET_THRESHOLD` | 3 | `mcp_server.js` line 433 | fresh relevant factlets needed for `factletMultiplier = 1.0` |
| `FACTLET_POINTS_PER` | 2 | `mcp_server.js` line 434 | dossier points per fresh factlet on the client path |
| `DRAFT_THRESHOLD_CLIENT` | 5 | `mcp_server.js` line 435 | `dossierScore` floor for client `draftReady` |
| `Config.factletStaleDays` | 180 | DB row, set via `pipeline.configure` | age at which factlet weight decays to 0 |

To tune algo constants, edit `mcp_server.js` and restart the MCP server (kill goose session, re-run `goose.bat`). To tune the runtime stale-days value, call `precrime__pipeline({ action: "configure", patch: { factletStaleDays: <N> } })` (no restart).

Note: the legacy v1 server is archived at `server/mcp/mcp_server_v1_archive.js` and is no longer loaded by either Claude Desktop or Goose. Both hosts run the unified `mcp_server.js`. Edit one file, both hosts get the change after restart.

---

## Valid leed — absolute criteria (from Leedz API)

Every leed posted to the Leedz `addLeed` Lambda MUST have (this drives the booking hard gates):

| addLeed field | Source in Booking / Client | Hard-gate column |
|---|---|---|
| `tn` (trade) | `Booking.trade` (lowercase, in `getTrades()`) | `b.trade >= 20` |
| `ti` (title) | built by leed-drafter | — |
| `zp` (zip) | `Booking.zip` | (implicit in location) |
| `st` (start epoch ms) | `Booking.startDate` | `b.date >= 20` |
| `lc` (address) | `Booking.location` (must include zip) | `b.location >= 15` |
| `cn / em / ph` (named contact) | `Client.name / email / phone` | `b.contact >= 10` |
| `pr` (price) | always `0` (free) | — |
| `email` (broadcast) | always `"false"` (no broadcast) | — |

A booking failing any hard gate is unshareable regardless of total score.

---

## Running tuning notes

- **2026-04-24** — initial unified `score_target`. Drops `demandSignal` cap mechanism; replaces with factlet-multiplier. `signalType` deprecated in favor of binary `relevance`.
- **2026-04-27** — v2 MCP rewrite collapsed `score_target` into automatic scoring on every `pipeline.save`. Algorithm and constants unchanged. Standalone `score_target`, `score_booking`, `score_client` tools removed from the v2 surface (still present in v1 for legacy deployments).
- **2026-04-28** — Tightened booking `shareReady` hard gate after generic conventions (Anime Expo, KCON, Warped Tour) auto-promoted to leed_ready on form completeness alone. Now requires `contact === 20` (named human + direct non-generic email) AND zip present, in addition to existing trade/date/location/total gates. Demand signal continues to be enforced via `factletMultiplier ≥ 1.0`.
