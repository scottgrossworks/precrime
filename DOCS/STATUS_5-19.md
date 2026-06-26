# PRECRIME Status

Date: 2026-05-19. Authoritative current state for any agent picking up this project.

Old session logs archived at `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\STATUS_history.md`.

---

## What PRECRIME does

Recursive intelligence system. Identifies people likely to buy VALUE_PROP, enriches them, produces marketplace leeds or outreach drafts. The core act is **demand signal detection**: predicting when a buyer's hair is about to catch fire so the outreach lands at the moment of need. Cold outreach without demand signal does not convert. See `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\FOUNDATION.md`.

---

## Project roots

| Purpose | Path |
|---|---|
| Source tree (dev, where deploys are built from) | `C:\Users\Admin\Desktop\WKG\PRECRIME` |
| Project docs (read for context) | `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS` |
| Active DALLAS deployment (photo booth) | `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\DALLAS\precrime` |
| Active ORLANDO deployment (photo booth) | `C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\ORLANDO\precrime` |
| Working legacy reference (TDS, was working before PRECRIME) | `C:\Users\Admin\Desktop\WKG\TDS\precrime` |

---

## Key source files

### Code
- `C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js` — main MCP server. All scoring, gating, demand-signal detection, save handler, rescore loop, session reporting.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_gmail.js` — gmail send via Chrome OAuth.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\server\prisma\schema.prisma` — DB schema. Booking.status field is plain String (no enum), allowed values: `brewing | outreach_ready | leed_ready | shared | taken | expired`. Promotions are set only by computeBookingTargetScore; share_booking owns the operational `shared` flip.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\rss\rss-scorer-mcp\index.js` — RSS scorer MCP server. Tool: `mcp__precrime_rss__get_top_articles`. Schema is permissive (additionalProperties:true), handler wraps in try/catch and always returns content (never throws to transport).

### Config
- `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\SCORING.json` — canonical scoring policy. Gates: `outreachReady` (score>=60 + named direct email + venue + date window + time), `leedReady` (score>=90 + same fields + demandSignal===true). Demand signal patterns and thresholds.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\FOUNDATION.md` — the soul doc. Bucket-of-water parable, demand signal mechanism, Prom Pattern five-slot archetype, Sources-vs-Clients distinction, recursive process pseudocode.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\CLAUDE.md` — startup checklist for the agent: read FOUNDATION + VALUE_PROP, validate TRADE.

### Templates (what ships into deployments)
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\` — every file copied or token-substituted into deployments by `deploy.js`.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\docs\VALUE_PROP.md` — deployment-specific product identity. Has `**Trade:**` line, `WHO BUYS THIS`, `WHO IS NOT A BUYER (DO NOT TARGET)` sections.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\skills\` — all agent skill files. Active. `_archive/` subfolder does NOT ship (not in deploy.js allowlist).

### Skills (active, ship)
- `init-wizard.md` — startup/router.
- `headless_flow.md` — Planner-driven orchestrator.
- `url-loop.md`, `enrichment-agent.md`, `apply-factlet.md`, `show-hot-leedz.md` — one-Task workers/presenter.
- `share-skill.md`, `outreach-drafter.md` — marketplace and outreach drafting helpers.
- `client-finder.md` — contact finder helper.
- `shared/classify-contact.md` — Step 0 BUYER ARCHETYPE GATE reads VALUE_PROP "WHO IS NOT A BUYER", routes SOURCE/SKIP candidates before save.
- `shared/booking-detect.md` — speculative/exhibitor exclusion rules (replaces archived convention-pipeline). Exhibitors at conventions ARE valid Clients (booth-enhancement buyers); the rule is they don't create a Booking until demand signal exists.
- `shared/factlet-rules.md`.

### Build + deploy
- `C:\Users\Admin\Desktop\WKG\PRECRIME\deploy.js` — token substitution + file copy from `templates/` to a target deployment dir. Allowlist-based.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\build.bat` — runs deploy.js, copies setup.bat + precrime.bat + goose.bat + goose_config.template.yaml (all FATAL if missing), zips to `dist/`.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\setup.bat` — npm install + prisma generate. Idempotent.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\precrime.bat` — Claude Code launcher. Has claude preflight, writes server/.env, calls setup.bat, launches `claude --dangerously-skip-permissions --chrome --model claude-sonnet-4-5 "run precrime (database: %DBNAME%)"`.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\goose.bat` — Goose launcher. Same bootstrap, plus REPLACE_ME detection on .env keys, goose config templating, GOOSE.md patching.
- `C:\Users\Admin\Desktop\WKG\PRECRIME\manifests\manifest.photobooth.json` — generic photo-booth manifest. No DALLAS-specific or ORLANDO-specific manifest exists; rootDir gets edited per build.

### Scripts (dev tools, not shipped)
- `C:\Users\Admin\Desktop\WKG\PRECRIME\scripts\reset-deployment-db.js` — one-shot reset for legacy DBs. Resets non-terminal Bookings to `brewing` with score 0; resets Clients (except sent/ready drafts) to brewing with score 0; preserves terminal states; fixes corrupted draftStatus rows; optional `--throttle N` to backdate `lastEnriched`.

---

## Today's session work (2026-05-19)

### Shipped (in both source tree + deployments)

1. **Tri-state booking status.** `brewing | outreach_ready | leed_ready` plus terminal `shared | taken | expired`. Replaces binary `new | leed_ready`. String field, no migration. Default changed to `brewing`. Set only by `computeBookingTargetScore`.
2. **Demand signal detection.** New `detectDemandSignal()` helper in mcp_server.js. Procedural pass (regex on title+description+notes against patterns in SCORING.json), then factlet-threshold inferred (>=3 fresh relevant), then optional LLM fallback (Anthropic or OpenAI-compatible; only fires when Config.llmApiKey set + booking has substantive text). 5-minute in-memory cache. NEVER stored on the Booking; recomputed every score.
3. **leedReady gate now requires `demandSignal===true`.** Field completeness alone no longer promotes.
4. **outreachReady gate added.** score>=60 + complete contact/venue/date/time. No demand signal required. Cannot post to marketplace; can produce outreach draft.
5. **hot is derived, not stored.** leed_ready + startDate within hotDaysOut window.
6. **Date-passed / acted-on reset.** If startDate < now, status is forced to `brewing` and bookingScore reset to 0. If a Booking is `shared`, `taken`, `expired`, `shared=true`, `sharedAt`, or has `leedId`, its score is reset to 0 and it cannot be promoted again. Fresh future evidence must be saved as a new/enriched Booking.
7. **Generic email hard gate.** pipelineSave rejects any patch with email matching `genericEmailPrefixes` (sales@, info@, contact@, etc.). Agent must run client-finder.md first OR save without email.
8. **Factlet multiplier removed from score.** `total = data.total` directly. The old `data.total * factletMultiplier` double-counted (multiplier suppressed score AND factlets fed demand-signal inference). Multiplier still computed for the `draftReady` gate at 0.5 threshold.
9. **Rescore tri-state.** `pipelineRescore` switched to snapshot before/after counts plus single `changed` total. Old binary promoted/demoted counters gone.
10. **Session reporting fix.** `mark_source` now accepts `session_id` and logs a `source_marked` event. `report_session` distinguishes:
    - `failed_no_data` (0 marks + 0 save_attempts) = real failure
    - `scraped_no_clients` (N marks + 0 save_attempts) = legitimate null result, keep digging
    - `failed_all_rejected` / `under_target` / `complete` as before.
11. **TRADE gate at bootstrap.** init-wizard Step 1.7 reads `precrime__trades()`, matches against VALUE_PROP product, auto-configures if unambiguous, prompts user otherwise. Headless mode fails fast with `TRADE_UNRESOLVED`.
12. **WHO IS NOT A BUYER section** added to VALUE_PROP template. classify-contact.md Step 0 reads it, routes SOURCE candidates into Source table, SKIP candidates dropped.
13. **RSS server hardened.** Permissive input schema, try/catch around the handler, always returns content payload. Fixes "Invalid tool parameters" failures the agent was hitting.
14. **build.bat strict.** goose.bat and goose_config.template.yaml now FATAL if missing in templates/, matching setup.bat + precrime.bat treatment.
15. **claude preflight in precrime.bat** matching the goose preflight in goose.bat.

### Files touched this session (full list)

| File | Change |
|---|---|
| `PRECRIME\server\mcp\mcp_server.js` | demand signal, tri-state status, gates, rescore counters, save handler email gate, session source_marked event, date-passed reset, multiplier removal |
| `PRECRIME\server\prisma\schema.prisma` | status default `new` → `brewing`, comment updated |
| `PRECRIME\rss\rss-scorer-mcp\index.js` | permissive schema, try/catch, never-throw handler |
| `PRECRIME\DOCS\SCORING.json` | demandSignal block, outreachReady gate, leedReady requires demandSignal, statusRules updated |
| `PRECRIME\DOCS\FOUNDATION.md` | demand-signal section, Prom Pattern, Sources-vs-Clients paragraph |
| `PRECRIME\templates\docs\FOUNDATION.md` | same content, template-style `--` punctuation |
| `PRECRIME\templates\docs\CLAUDE.md` | TRADE gate added as bootstrap step 3 |
| `PRECRIME\templates\docs\VALUE_PROP.md` | `**Trade:**` line, no WHO IS NOT A BUYER section in template (that lives per-deployment) |
| `PRECRIME\templates\skills\init-wizard.md` | Step 1.7 trade gate |
| `PRECRIME\templates\skills\shared\classify-contact.md` | Step 0 buyer archetype gate |
| `PRECRIME\templates\skills\shared\booking-detect.md` | speculative/exhibitor exclusion |
| `PRECRIME\precrime.bat` + `PRECRIME\templates\precrime.bat` | claude preflight |
| `PRECRIME\goose.bat` | synced to templates/goose.bat (template was canonical, root was stale) |
| `PRECRIME\build.bat` | goose.bat + goose_config.template.yaml now FATAL |
| `PRECRIME\scripts\reset-deployment-db.js` | new (legacy DB resetter) |
| `PRECRIME\DOCS\STATUS_history.md` | renamed from STATUS.md (preserved) |

### Hot-patched directly in deployments (NOT via rebuild)

These edits were applied directly to live DALLAS/ORLANDO so testing could continue without a rebuild. They MUST be re-shipped on the next build:

| Deployment | File | Patch |
|---|---|---|
| DALLAS | `server\mcp\mcp_server.js` | factlet multiplier removal |
| DALLAS | `rss\rss-scorer-mcp\index.js` | permissive schema + try/catch |
| DALLAS | `DOCS\VALUE_PROP.md` | added `**Trade:** photo booth` line + WHO IS NOT A BUYER section |
| DALLAS | `skills\shared\classify-contact.md` | Step 0 buyer archetype gate |
| ORLANDO | `server\mcp\mcp_server.js` | factlet multiplier removal |
| ORLANDO | `rss\rss-scorer-mcp\index.js` | permissive schema + try/catch |

The next `node deploy.js` for these deployments overwrites the hot patches from `PRECRIME\templates\`. The source tree already has all the same fixes, so the next build will be in sync. The DALLAS VALUE_PROP WHO IS NOT A BUYER section is NOT in the template (it's photo-booth-specific) and will need to be rewritten into each deployment's VALUE_PROP on first launch (the agent should do this from context).

---

## Current state of deployments

### DALLAS (`C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\DALLAS\precrime`)

- Legacy DB carried forward from `precrime_5-19_2026\data\myproject.sqlite`. Schema-compatible, reset to brewing via `scripts\reset-deployment-db.js`.
- Today's hot patches applied (see table above).
- Active testing. RSS just patched; restart pending.
- VALUE_PROP has been hand-edited with photo-booth-specific WHO IS NOT A BUYER archetypes. See `DALLAS\precrime\DOCS\VALUE_PROP.md`.
- Marketplace activity: 7 leeds already posted historically (exhibitor-style: "Hunter Fan Company at Lightovation 2026", "StarFire Crystal at Lightovation 2026", "Fan Expo Dallas 2026", "Dallas Art Fair 2026", "Deep Ellum Arts Festival 2026", "Angels of Care at Abilities Expo", "Win The Storm at Roofing Expo"). Proves the recursive convention->exhibitor pipeline works when it works.

### ORLANDO (`C:\Users\Admin\Desktop\WKG\PHOTOBOOTH\ORLANDO\precrime`)

- New deployment in progress.
- Legacy DB at `ORLANDO\precrime_5_19\data\myproject.sqlite` is schema-compatible.
- Today's mcp_server + RSS hot patches applied.
- VALUE_PROP not yet edited with WHO IS NOT A BUYER section. NEEDS hand-edit per DALLAS template before serious harvesting.
- Not yet running a full pipeline.

---

## CURRENT FAILURES AND OPEN PROBLEMS

### From the last DALLAS test run (after factlet-multiplier fix)

Reported by the agent. NOT yet diagnosed by me. Listed verbatim from the agent's output:

1. **SheBuilds Futures Gala** stuck at brewing despite explicit "Interactive entertainment and photo moments" text, named contact `CRees@shebuildsfutures.org`, precedent (Flashbulb Memories Photo Booth sponsored prior gala), theme + venue + date. Booking score: 57/100 BEFORE multiplier removal. Post-restart this should rise.
2. **HDNP Gala** stuck at brewing. Named contact, date, venue. Booking score: 50/100 with 0 factlets, then 50/100 after adding 2 factlets, status "still brewing". This contradicts the redesign: the factlet add SHOULD have triggered demand-signal inference if 2 factlets is below threshold (3) but the score should not change either way under the new code. Worth verifying that:
   - the deployment actually restarted after the patch
   - bookingScore in the response reflects the new code path
3. **Dallas Art Fair** scoring 0/100 with full fields (title, description, location, zip 75201, contact `kristie.ramirez@giantnoise.com`, sourceUrl, times 17:00-19:00, 1 factlet on client, EXPLICIT demand). Agent suspects 4-day event span (April 16-19). The date scoring tier in SCORING.json: tightWindow up to 7 days = full points, roughWindow up to 30 days = 10 points. So a 4-day span should still score 20, not 0. **Score of 0 is suspicious. Likely candidates:**
   - Booking has zero on a hard gate that wasn't surfaced
   - factletScore field on the booking row is 0 despite the client having factlets (factlets are linked to Client, not Booking; the scorer reads them via Client; but the agent's report says "factlet not counting toward booking score" which would point to a query mismatch)
   - Date-passed reset firing falsely (if endDate parsed wrong)

### Not yet investigated this session

- Convention pipeline retirement: in `templates/_archive/convention-leed-pipeline.md`, replaced by booking-detect.md's speculative exclusion. Verified _archive does NOT ship. Active enrichment skills correctly create Clients from exhibitors per FOUNDATION's Sources-vs-Clients rule.
- LLM demand-signal fallback: implemented but NEVER exercised in testing (no llmApiKey set in Config). Untested code path.
- LLM cache eviction under sustained load: untested.

### Session-level breakage I caused

These are documented so the next agent or coder knows what failure modes to expect from me specifically:

1. Asserted exhibitors at conventions are not valid Clients. Wrong. They are the canonical buyers for booth-enhancement VALUE_PROP. User corrected me. The retired convention-pipeline skill said exactly this.
2. Created `inspect-session.js` as a separate dev tool when `audit_session` MCP action already did the same job. User caught it; file deleted.
3. Created `wiki/concepts/demand-signal.md` as a new file when a section in FOUNDATION.md was sufficient. User caught it; file deleted, content consolidated.
4. Missed that factlet multiplier double-counted after demand signal was split into its own gate. User had to test data, find scores stuck at 50-57, and force the diagnosis. Should have caught this when writing the gates.
5. Recommended Tavily as RSS fallback after agent flailing. Wrong direction. Tavily fetches HTML, not RSS XML. The fix was hardening the existing RSS server, which is what shipped.
6. Persistent verbosity despite repeated user instruction. Tables, headers, recap blocks. Multiple corrections.

---

## What to do next

### Immediate (DALLAS testing)

1. Restart precrime in DALLAS.
2. Run `precrime__pipeline action="rescore" scope="all"`.
3. Verify the three stuck prospects (SheBuilds, HDNP, Dallas Art Fair) move OR diagnose why they don't.
4. For Dallas Art Fair at score 0: read the booking row directly via `precrime__find action="bookings" filters={...}`. Get the bookingScore breakdown from `audit_session` or the score response. Identify which gate is at 0.

### Soon

5. Apply DALLAS-style VALUE_PROP edits to ORLANDO: add WHO IS NOT A BUYER section with photo-booth-specific archetypes.
6. Decide whether to use LLM demand-signal fallback in production: requires Config.llmApiKey set. Untested.

### Eventually

7. Rebuild the source tree to a fresh zip via `build.bat`. All hot patches are already mirrored in the source tree, so a build is safe.
8. Consider promoting WHO IS NOT A BUYER pattern from per-deployment to the template with a generic stub the user fills in.
9. The Goose orchestrator path (goose.bat) is shipping but largely untested in this session. Claude Code via precrime.bat is the path that has been exercised.

---

## How to read this project

1. `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\FOUNDATION.md` — start here. The soul. Parable, demand signal, Prom Pattern, recursive process, Sources-vs-Clients.
2. `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\SCORING.json` — the policy. Read this with FOUNDATION to understand how gates work.
3. `C:\Users\Admin\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js` — `computeBookingTargetScore` at ~line 820 is the heart. `detectDemandSignal` just above it. `pipelineSave` at ~line 2171. `pipelineRescore` at ~line 1796.
4. `C:\Users\Admin\Desktop\WKG\PRECRIME\templates\docs\VALUE_PROP.md` — what the agent reads per session to know what's being sold.
5. `C:\Users\Admin\Desktop\WKG\PRECRIME\DOCS\STATUS_history.md` — full session-log archive, pre-2026-05-19.

End.
