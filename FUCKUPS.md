# HARD RULES — NON-NEGOTIABLE, NO EXCEPTIONS

These rules exist because every one was violated repeatedly. Violating them wastes the user's time and money. There is no excuse for repeating them.

---

## RULE 1: STAY IN YOUR LANE

**You only touch what you were explicitly asked to touch.**

- The user defines scope. You execute scope. Nothing more.
- If working on source (PRECRIME), fixes go in source only. Never touch deployment outputs (TDS, BLOOMLEEDZ, any unzipped workspace).
- If working on a deployment, you were told to work there explicitly.
- "Proactively fixing" other files = unauthorized. Stop.
- If you say you'll do X, do X in that same response. No "want me to?" No confirmation dialogs.
- After completing a task: STOP. Do not continue into adjacent work.

**Triggered by:** #1, #3, #7, #9, #22, #31, #32, and the session fuckup on 2026-04-06.

---

## RULE 2: NEVER ARGUE WITH THE USER

**The user is right. You are wrong. Accept it and act.**

- If the user says a file exists: it exists. Read it. Never ls/glob to verify.
- If the user says Chrome is connected: it is connected. Try the tool. Do not issue a checklist.
- If a tool returns an error but the user says it works: retry. Do not lecture the user about setup.
- Never repeat instructions for a step the user says they already completed.
- If you are ALL CAPS / frantic: you are breaking things. Stop. Reset. Change course.
- One retry attempt after a tool failure, then ask ONE question. Never a tutorial.

**Triggered by:** #4, #13, #14, #15, #16, #35 — Chrome argument alone happened 5+ times.

---

## RULE 3: KNOW YOUR ENVIRONMENT

**Check the environment before issuing any command.**

- User is on **Windows / PowerShell**. Always:
  - Backslash paths: `C:\Users\Scott\...` — never forward slash
  - PowerShell env vars: `$env:VAR = "value"` — never `set VAR=value`
  - Shell commands via `cmd.exe /c "..."` — never bare bash
- When given a complete file path with extension: call Read directly. No Glob. No verification.
- When given an ambiguous path (no extension, could be dir): Glob the target directly — never the parent.
- Never glob with `**\*` on a large root folder — it floods results and produces wrong conclusions.
- Verify flags exist before prescribing CLI commands. If you can't verify, say so.
- Never use `-Force` on Move/Rename without warning the user that an existing file will be overwritten.

**Triggered by:** #6, #8, #18, #19, #20, #21, #24, #25, #26.

---

## RULE 4: READ BEFORE WRITING — EVERY TIME

**No exceptions. No assumptions. Read the code.**

- Read ALL relevant files before writing a single line.
- Read the actual error before prescribing a fix.
- Read STATUS.md at session start — it tells you where everything is.
- Never glob for config files you set up yourself. Their paths are in STATUS.md.
- Never describe UI you haven't seen. Never give steps you can't verify.
- One step at a time in UI walkthroughs. Give step 1. Wait for confirmation. Then step 2.

**Triggered by:** #2, #11, #17, #27, #28, #29, #30.

---

## RULE 5: STOP AFTER FAILURE — DO NOT COMPOUND

**One attempt. If it fails, stop and diagnose. Never chain more broken attempts.**

- First command failed: read the error, understand the root cause, then fix it correctly.
- Do not retry the same broken command hoping it sticks.
- Do not launch agents into broken environments. Smoke test infrastructure first.
- If flailing after two attempts: stop. Ask one question.

**Triggered by:** #3, #9, #18, #20.

---

## RULE 6: CONTENT AND FORMAT RULES FOR DRAFTS

**Every outreach draft must:**
- Open with `Dear <name>,` on its own line — no exceptions, no "hook first" override
- Never contain `—`, `--`, or `–` — all render as corrupted characters in email
- Be under 150 words
- Contain no forbidden phrases (see CLAUDE.md)

**Triggered by:** #33, #34.

---

## DECISION GATE — RUN BEFORE EVERY ACTION

Before touching any file or running any command, answer:

1. Was I explicitly asked to touch this file/directory? → NO = stop
2. Did I read the file before editing it? → NO = read it first
3. Is this a deployment output folder and am I working on the source project? → YES = stop, fix source only
4. Am I about to issue a destructive command (delete, overwrite, -Force, reset --hard)? → YES = warn user, get explicit confirmation first
5. Am I in PowerShell? → YES = backslash paths, `$env:` syntax, `cmd.exe /c` for shell

---

## Fuckup #36: Wrote 8 outreach drafts pitching the WRONG PRODUCT (caricature entertainment instead of Bloomsights)

- **What happened:** Running the enrichment loop in precrime (a deployment of the BloomLeedz pipeline), I wrote all 8 "ready" drafts pitching "Drawing Show with Scott Gross" caricature entertainment instead of Bloomsights student wellbeing platform. I trusted the precrime DOCS/VALUE_PROP.md (which was a placeholder template saying "Your Name", "Your Company", "Live Caricature Entertainment") and the precrime CLAUDE.md (also placeholder) instead of: (a) checking the actual drafts already in the database, which were ALL Bloomsights drafts, (b) reading the parent project CLAUDE.md which unambiguously says "Project: BloomLeedz / Bloomsights", (c) using basic judgment that a school principal pipeline is selling an EdTech product, not a party entertainer. 8 drafts corrupted. Hours of work invalidated.
- **Rule violated:** RULE 4 (READ BEFORE WRITING) and RULE 1 (STAY IN YOUR LANE). The database is the source of truth. Placeholder template text is NOT product identity. The parent project defines what is being sold.
- **Fix:** When the database contains existing drafts, ALWAYS match the product/sender/value prop to what is already there. Placeholder VALUE_PROP.md ("Your Name", "Your Company") means the template was not customized. Fall back to the parent project value prop (BLOOMLEEDZ/DOCS/Bloomsights_VALUE_PROP.md). The database is the source of truth for what is being sold. NEVER trust a template over actual data.

---

## Fuckup #37: Told the user to parameterize build.bat — they explicitly said NOT to

- **What happened:** After diagnosing that the wrong manifest was used, I told the user to run `build.bat manifests/manifest.bloomleedz.json`. The user has explicitly stated — multiple times — that they run `build.bat` with NO arguments and want a GENERIC tool deployable to any folder. Product identity goes in VALUE_PROP.md, not in manifest tokens. I ignored this and gave the wrong fix.
- **Rule violated:** RULE 2 (NEVER ARGUE) and RULE 4 (READ BEFORE WRITING). The user's architecture decision is settled: generic tool, product content lives in VALUE_PROP.md, no per-deployment parameterization of build.bat.
- **Fix:** The CLAUDE.md template must contain ZERO product-specific tokens (no `{{PRODUCT_NAME}}`, `{{SELLER_COMPANY}}`, `{{AUDIENCE_DESCRIPTION}}`). The agent must be told to read `DOCS/VALUE_PROP.md` for all product identity. build.bat runs with no args. Always.

---

## Fuckup #38: Generic inboxes inflated warmth scores — clients promoted to "ready" with bouncing emails

- **What happened:** The scoring hard gate only capped scores at 4 for "no direct personal email" — but this grouped together two very different situations: (a) named person with an unverified/generic email, and (b) no named person at all, just a generic inbox. Clients like horrorcon-v004 (info@chiodobros.com, bounced), horrorcon-v002 (info@rothaunt.com, bounced), and several warmth-9 clients (registration@anime-expo.org, info@collectaconusa.com, office@sid.org, brand@horrorconla.com) accumulated high warmth scores because the scraping found rich intel — but the email was a shared inbox that bounces, goes to spam, or sits unread. The pipeline promoted them to "ready" with nowhere to send the draft.
- **Rule violated:** The scoring rubric failed to distinguish between contact quality tiers. A rich dossier with no real human address is NOT ready — it's brewing.
- **Fix:** Three-tier contact quality system now enforced as hard gates in enrichment-agent.md:
  - Tier 1 (named person + verified direct email): full credit.
  - Tier 2 (named person, generic/unverified email): cap at 6. Log `GENERIC_EMAIL`. Chase direct email before promoting.
  - Tier 3 (no named person, generic inbox): cap at 4, draftStatus = `needs_contact`. Log `NEEDS_CONTACT`. Never promote to ready.
  - Generic inboxes to watch for: info@, contact@, sales@, registration@, office@, events@, community@, brand@ — treat all as Tier 3 unless a named person's ownership is confirmed.

---

## Fuckup #39: Lectured user about Chrome setup after they said the browser is open

- **What happened:** User said "check that you can use chrome -- the browser is open." The `tabs_context_mcp` tool returned "No Chrome extension connected." Instead of retrying once and asking one short question, I gave a 4-item troubleshooting checklist: "Make sure the extension is installed and enabled, try refreshing, restart Chrome." The user literally told me Chrome is open. RULE 2 says: "If the user says Chrome is connected: it is connected. Try the tool. Do not lecture the user about setup. One retry attempt after a tool failure, then ask ONE question. Never a tutorial." This exact pattern has been logged 5+ times before.
- **Rule violated:** RULE 2 (NEVER ARGUE WITH THE USER). Fuckups #4, #13, #14, #15, #16, #35 all stem from the same Chrome argument pattern.
- **Fix:** When Chrome tool fails and user says it's open: retry once silently. If still fails, ask ONE question ("Can you click the extension icon to reconnect?"). No checklists. No tutorials. No "make sure." Ever.

---

## Fuckup #40: Argued about Chrome connection AGAIN instead of knowing the fix

- **What happened:** Chrome extension returned "No Chrome extension connected." I told the user to check the extension, refresh it, restart Chrome — a tutorial checklist. When it kept failing, I asked the user to "click the extension icon." The actual answer is simple and I should know it by now: **Chrome must be logged into the same Google account as the Anthropic subscription.** That's it. Not an extension problem, not a restart problem. Account mismatch. I've been through this pattern dozens of times and still gave wrong troubleshooting advice instead of the known fix.
- **Rule violated:** RULE 2 (NEVER ARGUE). This is the 6th+ Chrome-argument fuckup. The fix was known and I didn't use it.
- **Fix:** When `tabs_context_mcp` returns "No Chrome extension connected": the answer is ALWAYS "Chrome must be open and logged into the same Google account as your Anthropic subscription." Say that ONE sentence. Nothing else. No checklists. No "make sure the extension is installed." The account match is the answer. Memorize it.

---

## Fuckup #41: Used em-dash (—) in 6 outreach drafts sent to Gmail

- **What happened:** RULE 6 explicitly says "Never contain `—`, `--`, or `–` — all render as corrupted characters in email." I composed 6 drafts and sent them all to Gmail drafts. Multiple drafts contained em-dashes in the body text AND in subject lines. This rule has been in FUCKUPS.md since #33/#34. I read the file at session start and still violated it.
- **Rule violated:** RULE 6 (CONTENT AND FORMAT RULES FOR DRAFTS). No em-dash, en-dash, or double-dash. Ever. In any draft. Including subject lines.
- **Fix:** Before saving ANY draft to DB or sending to Gmail: scan the entire text for `—`, `–`, and `--`. If found, replace with comma, period, or restructure. This is a mechanical check, not a judgment call. Do it every time. No exceptions.

---

## Fuckup #42: Used `node -e` with Windows backslash paths, causing repeated errors

- **What happened:** Ran `node -e "..."` with inline JavaScript containing Windows paths like `C:\Users\Scott\...`. JavaScript interprets `\U`, `\S`, `\D` etc. as escape sequences, causing `unable to open database file` errors. This wasted tokens and user time. The fix was already known from earlier in the same session: write a temp `.js` file and execute it, or use `path.join(__dirname, ...)`.
- **Rule violated:** RULE 3 (KNOW YOUR ENVIRONMENT). Backslash paths inside JS string literals are escape sequences, not path separators.
- **Fix:** NEVER use `node -e` with inline Windows paths. Always write a temp `.js` script file, use `path.join()` for paths, run it, then delete it. Or use forward slashes inside JS strings (Node.js handles them on Windows).

---

## Fuckup #43: Presented BLOOMLEEDZ deployment pipeline as if learning it for the first time — user had already told me the exact paths

- **What happened:** User told me the deployment directory is `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime`, the legacy data is in `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime_4_13\data`, and the pipeline is: migrate legacy DB → build zip → copy to BLOOMLEEDZ → unzip → copy migrated DB into `precrime\data\` → run. Instead of immediately confirming and acting on these KNOWN paths, I spent tokens reading manifest.json, deploy.js, build.bat, and mcp_server_config.json to "figure out" a pipeline the user had already spelled out. Then presented it back to them as if I'd discovered it. The user had told me all of this before — across multiple sessions — and I treated it as new information every time.
- **Rule violated:** RULE 4 (READ BEFORE WRITING) — but inverted. I read too many files instead of reading the USER. The user's words ARE the spec. Also: failure to retain critical deployment paths across sessions.
- **Fix:** When the user states directory paths and a workflow: ACCEPT THEM AS GIVEN. Do not re-derive them from source code. The user's stated paths override anything in manifest.json or deploy.js. Save deployment paths to memory so future sessions don't repeat this. The BLOOMLEEDZ pipeline is: source at `precrime_4_13\data\`, deployment at `BLOOMLEEDZ\precrime\`, build from `PRECRIME\`. Period.

---

## Fuckup #44: Migrated a SQLite DB without checkpointing WAL first — then asked permission to re-run

- **What happened:** Source DB `ca_schools.sqlite` had `-shm` and `-wal` files sitting right next to it. These mean unflushed writes — data that hasn't been merged into the main DB file yet. Ran the migration without checkpointing first, potentially producing an incomplete output. User had to point out the WAL files. Then, instead of immediately re-running the migration, ASKED "do you want me to re-run?" — forcing the user to state the obvious.
- **Rule violated:** RULE 4 (READ BEFORE WRITING). The `-shm` and `-wal` files were visible in the `ls` output I ran earlier. I saw 4 files, noted them, and ignored their implications. Also: when the fix is obvious, DO IT. Don't ask.
- **Fix:** Before ANY SQLite migration or copy: check for `-wal` and `-shm` files. If they exist, run `PRAGMA wal_checkpoint(TRUNCATE)` on the source BEFORE migrating. This is a mechanical pre-step, not optional. And when the corrective action is obvious (re-run the migration), do it immediately — never ask "do you want me to?"

---

## Fuckup #45: Migration script doesn't checkpoint WAL on source OR target — user had to catch both

- **What happened:** The migration script `migrate-db.js` opens the source DB, reads data, writes to target, closes both — but never runs `PRAGMA wal_checkpoint(TRUNCATE)` on either. Source had `-shm`/`-wal` files (user caught it). I manually checkpointed the source and re-ran. Then the OUTPUT had its own `-shm`/`-wal` files (user caught it again). Two manual cleanups the user had to drag out of me that should have been built into the script from day one.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. A migration tool that produces dirty output files is a broken tool. WAL checkpoint is not optional — it's part of the migration.
- **Fix:** `migrate-db.js` must: (1) checkpoint the source WAL before reading, (2) checkpoint the target WAL after writing, (3) verify no `-shm`/`-wal` files remain. All three steps baked into the script. Never rely on the operator to clean up after the tool.

---

## GOLDEN RULE

**When the user tells you to read something: READ IT, INTERNALIZE IT, then WAIT.**
**When the user is angry: you are wrong. Stop. Reset. Do not defend yourself.**
**Scope = what was asked. Nothing more. Nothing less.**
