# PRECRIME: START HERE (single bootstrap doc)

Read THIS file first, top to bottom, on every restart. It is the map and the
current state, nothing more. All detail lives in the documents this file points
to. If anything below conflicts with an older doc, this file wins because it is
the newest authority (2026-06-07).

Path note: older docs (`STARTUP.md`, `STATUS.md`) print paths under
`C:\Users\Admin\Desktop\WKG\...`. The live source tree is under
`C:\Users\Scott\Desktop\WKG\PRECRIME`. Use the Scott path. Same files.

---

## 0. Current state (2026-06-07)

NOTHING is built. A planning session with Scott produced an agreed redesign and
one verified bug diagnosis. No code has changed this session.

- Verified bug: bookings never reach `leed_ready`. The cause is SAVE-time
  live-URL re-verification, NOT the demand gate. Full diagnosis at
  `C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\solutions\logic-errors\leed-ready-blocked-by-hardcoded-url-verification.md`
- Agreed redesign (decisions only, no code): full record at
  `C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\REDESIGN_2026-06-07.md`
  Three workstreams: Thread 1 procedural conductor (parallelization), Thread 2
  evidence model (the leed-promotion fix), Thread 3 rebuild and redeploy.
  Thread 1 and Thread 2 are independent. The conductor rebuild does NOT fix the
  scoring bug.

## 1. Resume here (next actions, in order)

1. Read `C:\Users\Scott\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js` fully to
   map module boundaries (DB vs conductor vs Planner/Judge vs tool shell) BEFORE
   the Thread 1 cut.
2. Read `C:\Users\Scott\Desktop\WKG\PRECRIME\deploy.js` to settle whether a
   redeploy overwrites or preserves `precrime_config.json` and `DOCS/SCORING.json`.
3. Decide build order: Thread 2 (evidence model) first or Thread 1 (conductor)
   first. Then build.

## 2. What 2026-06-07 changed, and what it supersedes

These overrides are the whole point of this file. Older docs still state the old
rules. Do not trust them. Edit the named docs at build time.

1. "Supervisor" is now the "procedural conductor." `STATUS.md` and `STARTUP.md`
   section 2 describe a supervisor. REDESIGN refines it: it is a PROCEDURAL Node
   loop, NOT an LLM; it lives INSIDE the `mcp_server.js` process (the only SQLite
   writer); it PUSH-claims one Task per worker; workers are one-shot and exit;
   failed Tasks are garbage-collected (fail-and-forget, no claim-lease, no reaper).

2. Demand signal is now STORED. `STARTUP.md` section 1 and `DOCS/FOUNDATION.md`
   say "demand signal is NEVER stored, recomputed every score." REVERSED. Demand
   is now a STORED LLM verdict over the whole dossier, recomputed ONLY when the
   dossier changes (new factlet, enrichment, contact update). `FOUNDATION.md`
   must be edited to remove the old rule.

3. Two independent labels, not a ladder. Drop the "highest passing gate wins"
   precedence (`leed_ready` else `outreach_ready` else `brewing`). `leed_ready`
   and `outreach_ready` become separate criteria evaluated independently; a
   booking can be both, one, or neither. Compute `shareable` and `emailable` at
   runtime. `booking.status` keeps only lifecycle values (`brewing`, `shared`,
   `expired`).

4. Drop the number as a gate. The 0-100 score and the 60/90 thresholds go away
   as promotion gates. Promotion is decided by the two label checks. Ordering
   within a class is derived at runtime (soonest event first, then demand
   strength).

5. Policy must be markdown-tunable. The dead `verification` block in
   `DOCS/SCORING.json` (nothing reads it) is either wired or retired. Tuning
   policy moves into live markdown the engine actually reads.

## 3. Read order (pointers, newest authority first)

```
1. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\START_HERE.md   <- you are here (2026-06-07, top authority)
2. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\REDESIGN_2026-06-07.md  <- the agreed redesign, full detail
3. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\solutions\logic-errors\leed-ready-blocked-by-hardcoded-url-verification.md  <- verified bug
4. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\STARTUP.md      <- architecture in place (2026-06-02). Read for context; section 1 and 2 partly superseded (see section 2 above)
5. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\STATUS.md       <- 2026-06-02 architectural conclusions. Supervisor specifics superseded by REDESIGN Thread 1
6. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\WHAT_I_LEARNED.md  <- control-loop spec (stage-gated planner; still current)
7. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\FOUNDATION.md   <- the soul (demand signal). The "never stored" rule is superseded (see section 2.2)
8. C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\Claude.md       <- the user's hard rules. Obey them.
```

## 4. Hard rules (unchanged, do not violate)

Full text in `C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\STARTUP.md` section 0 and
`C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS\Claude.md`. The load-bearing ones:

- Source of truth is the PRECRIME root, never a deployed vertical. Edit the
  source; build propagates to verticals.
- Never destroy working markdown or code. Back up to a `.legacy.md` sibling.
- No em dashes in prose. No recap/summary blocks at the end of responses. Use
  full absolute paths in agent-facing markdown.
- The user picks the LLM model and orchestrator deliberately. Never propose a
  model or orchestrator swap as a fix unless evidence genuinely justifies it.
- One source of truth per concern. Do not seed, sync, or copy between stores.

End.
