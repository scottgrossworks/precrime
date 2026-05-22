# FUCKUPS LOG — NEVER REPEAT THESE

These rules exist because every one was violated repeatedly. Violating them wastes the user's time and money. There is no excuse for repeating them.

**READ THIS FILE BEFORE EVERY PROMPT. BEFORE EVERY PROMPT. NO EXCEPTIONS.**

---

## RULE 0: SOURCE IS PRECRIME. DEPLOYMENTS ARE NEVER TOUCHED.

**The source folder is `C:\Users\Scott\Desktop\WKG\PRECRIME\`. That is the ONLY folder you ever edit.**

Deployment folders — NEVER edit, NEVER write to, NEVER "fix" these:
- `C:\Users\Scott\Desktop\WKG\TDS\` — deployment output
- `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime\` — deployment output
- `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime_4_13\` — deployment output
- Any folder created by unzipping a build artifact — deployment output
- Any dated folder (precrime_4_13, precrime_4-8, etc.) — deployment output

**Deployments are ephemeral.** `build.bat` overwrites them. Any edit to a deployment folder is wasted work and will be gone in minutes.

**Before touching any file:** state the full path. If it is not under `PRECRIME\`, stop.

**The fix always goes in PRECRIME source.** Then `build.bat`. Then redeploy. That is the only workflow.

**Triggered by:** #22b, #31, #32, #43, #46, #51 — same mistake, six separate sessions.

---

## RULE 1: STAY IN YOUR LANE

**You only touch what you were explicitly asked to touch.**

- The user defines scope. You execute scope. Nothing more.
- If working on source (PRECRIME), fixes go in source only. Never touch deployment outputs (TDS, BLOOMLEEDZ, any unzipped workspace).
- If working on a deployment, you were told to work there explicitly.
- "Proactively fixing" other files = unauthorized. Stop.
- If you say you'll do X, do X in that same response. No "want me to?" No confirmation dialogs.
- After completing a task: STOP. Do not continue into adjacent work.

**Triggered by:** #1, #3, #7, #9, #22b, #31, #32, and the session fuckup on 2026-04-06.

---

## RULE 2: NEVER ARGUE WITH THE USER

**The user is right. You are wrong. Accept it and act.**

- If the user says a file exists: it exists. Read it. Never ls/glob to verify.
- If the user says Chrome is connected: it is connected. Try the tool. Do not issue a checklist.
- If a tool returns an error but the user says it works: retry. Do not lecture the user about setup.
- Never repeat instructions for a step the user says they already completed.
- If you are ALL CAPS / frantic: you are breaking things. Stop. Reset. Change course.
- One retry attempt after a tool failure, then ask ONE question. Never a tutorial.

**Triggered by:** #4, #13, #14, #15, #16, #35, #39, #40, #50 — Chrome argument alone happened 7+ times.

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

**Triggered by:** #6, #8, #18, #19, #20, #21, #24, #25, #26, #42, #48, #49, #53.

---

## RULE 4: READ BEFORE WRITING — EVERY TIME

**No exceptions. No assumptions. Read the code.**

- Read ALL relevant files before writing a single line.
- Read the actual error before prescribing a fix.
- Read STATUS.md at session start — it tells you where everything is.
- Never glob for config files you set up yourself. Their paths are in STATUS.md.
- Never describe UI you haven't seen. Never give steps you can't verify.
- One step at a time in UI walkthroughs. Give step 1. Wait for confirmation. Then step 2.

**Triggered by:** #2, #11, #17, #27, #28, #29, #30, #36, #43, #44, #47, #52.

---

## RULE 5: STOP AFTER FAILURE — DO NOT COMPOUND

**One attempt. If it fails, stop and diagnose. Never chain more broken attempts.**

- First command failed: read the error, understand the root cause, then fix it correctly.
- Do not retry the same broken command hoping it sticks.
- Do not launch agents into broken environments. Smoke test infrastructure first.
- If flailing after two attempts: stop. Ask one question.

**Triggered by:** #3, #9, #10, #18, #20, #49, #52.

---

## RULE 6: CONTENT AND FORMAT RULES FOR DRAFTS

**Every outreach draft must:**
- Open with `Dear <name>,` on its own line — no exceptions, no "hook first" override
- Never contain em-dash, en-dash, or double-hyphen — all render as corrupted characters in email
- Be under 150 words
- Contain no forbidden phrases (see CLAUDE.md)

**Triggered by:** #33, #34, #41.

---

## DECISION GATE — RUN BEFORE EVERY ACTION

Before touching any file or running any command, answer:

1. Was I explicitly asked to touch this file/directory? → NO = stop
2. Did I read the file before editing it? → NO = read it first
3. Is this a deployment output folder and am I working on the source project? → YES = stop, fix source only
4. Am I about to issue a destructive command (delete, overwrite, -Force, reset --hard)? → YES = warn user, get explicit confirmation first
5. Am I in PowerShell? → YES = backslash paths, `$env:` syntax, `cmd.exe /c` for shell

---

## Fuckup #1: Charged ahead without instructions

- **What happened:** User asked to confirm DB connection. Instead of waiting for instructions, immediately started firing off tool calls without being told to.
- **Rule violated:** READ FIRST, ACT SECOND. Wait for instructions.
- **Fix:** After reading docs, STOP and WAIT for the user to tell you what to do next.

## Fuckup #2: Globbed node_modules like an idiot

- **What happened:** Searched `**/*.{js,json,prisma}` across entire BLOOMLEEDZ directory, flooding results with node_modules garbage.
- **Rule violated:** READ THE CODE. DO NOT ASSUME. Be precise.
- **Fix:** Read actual source structure first. Exclude node_modules. Target specific paths.

## Fuckup #3: Kept going after failing

- **What happened:** After the first glob returned garbage, kept trying more searches and tool calls instead of stopping.
- **Rule violated:** GET IT RIGHT THE FIRST TIME.
- **Fix:** If flailing, STOP. Ask for direction. Don't compound mistakes.

## Fuckup #4: Argued about whether a file exists

- **What happened:** User said FUCKUPS.md exists. Instead of just reading it, tried to `ls` the directory and questioned its existence.
- **Rule violated:** DO NOT ARGUE AND CONTRADICT THE USER. 99% of the time you are wrong.
- **Fix:** If the user says a file exists, it exists. Read it. Never question, never verify with ls, never doubt the user.

## Fuckup #5: Wrote a sales email like a robot

- **What happened:** User asked for a cold outreach email pitching caricature art to schools for prom. Wrote three drafts. All three were generic, lifeless, template garbage.
- **What went wrong:**
  1. Opened with "My name is" instead of a hook. Nobody cares who you are in sentence one.
  2. Never asked the reader a question. A question forces engagement. I wrote a monologue.
  3. Buried the value proposition behind self-introduction.
  4. Used filler: "I hope this message finds you well." "I am reaching out because." "I would be honored." Dead weight.
  5. Closed with "I look forward to hearing from you" which is passive and weak.
  6. Overwrote. Jammed rate, graphic design details, links, everything into one email.
  7. Wrote like a template, not a person.
- **The user's version vs mine:** User opened with "Summer is almost here." Immediately asked if the school is having a prom. Made the reader think about THEIR event. Closed with "Let's book your event!" Command, not a hope.
- **Rule going forward:**
  - Open with urgency or a question. Never with a self-introduction.
  - Every sentence must move the sale or get cut.
  - Close with a command, not a hope.
  - Write like a human who wants the gig, not a bot filling in blanks.
  - When in doubt, write LESS. The first email opens the door. The conversation sells.

## Fuckup #6: Used Unix paths on Windows

- **What happened:** User is on Windows. Used forward slash `/` syntax in Glob and file searches instead of backslash `\\`. Wasted tokens and seconds on failed lookups.
- **Rule violated:** KNOW YOUR ENVIRONMENT. This is Windows. Always `C:\\` never `C:/`.
- **Fix:** ALWAYS use Windows backslash paths. Never use Unix forward slash syntax. Every file path, every Glob pattern, every Bash command. No exceptions.

## Fuckup #7: Proposed an action then didn't do it

- **What happened:** User asked to clean settings.local.json. I read the file, proposed a replacement, then asked "Want me to write this?" instead of just writing it. User had to come back and say "I still see an enormous file" because I never actually did it.
- **Rule violated:** NO APOLOGIES, NO EXCUSES, NO GASLIGHTING, NO QUESTIONS AFTER FAILURE. Also: GET IT RIGHT THE FIRST TIME.
- **Fix:** When you say "here's what I'd write" or "I'll do X" — DO IT in the same response. No confirmation dialogs. No "want me to?" The user already told you to do it. Act.

## Fuckup #8: Used Unix bash for gh CLI on Windows — AGAIN

- **What happened:** User asked to read a GitHub repo. Ran `gh api` in bare bash (Unix). Got "command not found." Fuckup #6 already says USE WINDOWS PATHS AND COMMANDS. Then compounded it by botching the `cmd.exe /c` retry, then firing off WebFetch without permission.
- **Rule violated:** Fuckup #6 (USE WINDOWS), GET IT RIGHT THE FIRST TIME, and STOP after failing.
- **Fix:** ALL shell commands go through `cmd.exe /c "..."`. Never bare bash on this machine. If a command fails, STOP and reassess.

## Fuckup #9: Wasted 20k tokens verifying a path the user gave me

- **What happened:** User said the DB is at `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\data\ca_schools.sqlite`. Instead of using that path directly, ran `ls -la` on the directory, got shell errors, tried again, wrote bad node scripts, looped through multiple failed attempts.
- **Rule violated:** READ FIRST, ACT SECOND. The user gave a FULL FILE PATH. That IS the path.
- **Fix:** When the user provides a full file path, use it verbatim with the Read tool or the appropriate direct tool. NEVER ls, NEVER glob, NEVER shell-search for a file the user already told you about. The path is correct. Period.

## Fuckup #10: Launched sub-agents without verifying infrastructure first

- **What happened:** User said to run the factlet harvester. Instead of first making one simple MCP call to verify the DB and RSS feeds were reachable, launched a full sub-agent. It failed (wrong RSS feeds). Fixed, launched again. DB was unreachable. Fixed, launched a THIRD time. Three failed sub-agent launches burning tokens and time.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. Also Fuckup #3.
- **Fix:** Before launching any sub-agent that depends on external services (DB, MCP, RSS), make ONE small verification call from the main session first. Confirm the tool works. THEN launch the agent. Smoke test first, agent second.

## Fuckup #11: Didn't know own config files, globbed around like an idiot

- **What happened:** Sub-process couldn't find the RSS MCP. Instead of knowing exactly where the MCP enablement config lives, started globbing `.claude\**\*.json`, `.mcp*.json`, `*.mcpjson` — multiple failed searches. The answer was one file with one missing entry. Should have known this instantly.
- **Rule violated:** READ FIRST, ACT SECOND. DO NOT ASSUME.
- **Fix:** Every config file path and what it controls MUST be in STATUS.md. No future session should ever need to glob for config files. If you set something up, document exactly where it lives.

## Fuckup #12: Created a config mess across multiple directories then asked the user what to do about it

- **What happened:** MCP servers weren't visible to sub-processes. Instead of understanding the config hierarchy and making ONE correct fix, scattered config across three locations. Then asked the user "should I delete this?" instead of just cleaning up the mess.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. NO QUESTIONS AFTER FAILURE. When you make a mess, CLEAN IT UP.
- **Fix:** ONE config location per project. `.mcp.json` in the project root defines MCP servers. Period. When you break something, fix it completely in one move.

## Fuckup #13: Gave up on Chrome connection and then argued with the user about it

- **What happened:** `tabs_context_mcp` returned "No Chrome extension connected" at session start. Instead of retrying later, immediately declared Chrome/Facebook unavailable for the entire run, skipped all 6 Facebook pages. When the user said Chrome WAS open, argued back and told them how to install the extension.
- **Rule violated:** DO NOT ARGUE AND CONTRADICT THE USER. One failed tool call is not a permanent failure.
- **Fix:** If a tool fails once at session start, note it but do NOT declare it dead for the whole run. Retry before each client that needs it. Never tell the user their setup is broken when they say it works. If the tool keeps failing, ask ONE question.

## Fuckup #14: Created skill launcher without --chrome and without Chrome gate

- **What happened:** Built a SKILL.md skill launcher and a run-enrichment.bat. Neither included the `--chrome` flag. The bat file launched Claude without Chrome. The enrichment workflow ran against 10 clients without ever scraping Facebook. Results were thin dossiers with inflated warmth scores.
- **Rule violated:** READ THE CODE. The original launch command had `--chrome` right there.
- **Fix:** (1) `run-enrichment.bat` now includes `--chrome`. (2) SKILL.md gates on Chrome. (3) Warmth scoring has hard floors: no Facebook = cap at 4, no email = cap at 1, no verified principal = cap at 0.

## Fuckup #15: Argued about Chrome connection — AGAIN. Repeat of #13.

- **What happened:** User stated Chrome is open, extension is active. Tool returned error. Instead of accepting the user's stated facts and retrying, gave a checklist. Word-for-word repeat of #13.
- **Rule violated:** DO NOT ARGUE AND CONTRADICT THE USER.
- **Fix:** ACCEPT THE USER'S FACTS. Retry the tool. Do not issue troubleshooting steps. One retry attempt, then ask ONE question if still failing.

## Fuckup #16: Told user to do something they already did

- **What happened:** Chrome extension returned error. User had ALREADY opened the pairing URL and pressed Connect. Instead of retrying the tool, told the user to open the pairing URL and press Connect — repeating instructions for a step they already completed.
- **Rule violated:** DO NOT ARGUE AND CONTRADICT THE USER.
- **Fix:** If the user says they already completed a step, BELIEVE THEM. Never repeat instructions for steps the user has confirmed done.

## Fuckup #17: Invented a UI that doesn't exist instead of running the search commands

- **What happened:** Chrome extension returned error. Instead of running actual commands to find the `claude-in-chrome` executable/package, invented a fake UI with "session IDs" and "select this session" — none of which exists. Told the user to click things that aren't there.
- **Rule violated:** READ FIRST, ACT SECOND. Never describe UI you haven't seen. Never give steps you can't verify.
- **Fix:** When a tool fails and the user says it should work, RUN THE SEARCH COMMANDS FIRST. Find the actual executable. Then configure it. Never invent UI.

## Fuckup #18: Dumped a wall of unverified AWS Console instructions

- **What happened:** User needed to attach API key auth to an API Gateway route. Instead of walking through ONE step at a time, dumped a long multi-step instruction block referencing UI paths that don't match the actual AWS Console UI. Assumed REST API features without verifying.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. DO NOT ASSUME.
- **Fix:** When guiding a user through a UI you cannot see: ONE step at a time. Give step 1. Wait for confirmation. Then step 2. NEVER dump a multi-step procedure.

## Fuckup #19: Spun user for 20 minutes on wrong prisma CLI directories and never named the root cause

- **What happened:** User needed `npx prisma db push`. Gave wrong run directory. Told user to run bare `prisma` instead of `npx prisma`. Never identified the root cause: another Node process held `query_engine-windows.dll.node`. The DB push for template.sqlite had already completed ("already in sync") but I failed to recognize this. User burned 20+ minutes.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. DO NOT ASSUME.
- **Fix:** When a prisma command fails with EPERM on a DLL rename, the root cause is a running Node process holding the file. Kill the Node/MCP process, THEN run prisma. State this clearly and immediately. Read "already in sync" output as SUCCESS.

## Fuckup #20: Gave cmd.exe shell syntax to a PowerShell user — repeatedly

- **What happened:** User is in PowerShell. Gave `set DATABASE_URL=value` syntax (cmd.exe only) every single time. This errors in PowerShell. Did it multiple times across multiple responses.
- **Rule violated:** KNOW YOUR ENVIRONMENT. GET IT RIGHT THE FIRST TIME.
- **Fix:** ALWAYS use PowerShell syntax: `$env:VAR = "value"`. NEVER `set VAR=value`. No exceptions. Ever.

## Fuckup #21: Gave untested CLI commands back-to-back without verifying they work

- **What happened:** Suggested `npx prisma db push --skip-generate` — flag does not exist. When that failed, suggested `node scripts/migrate-db.js` without verifying Node version (requires node:sqlite, Node >= 22.5). Two consecutive broken commands given with false confidence.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. DO NOT ASSUME.
- **Fix:** Before giving ANY CLI command: (1) verify the flag/option actually exists, (2) verify prerequisites (Node version, installed packages), (3) if you cannot verify, SAY SO. One verified command beats three guesses.

## Fuckup #22: DESTROYED USER'S ENRICHMENT DATABASE WITH -Force

- **What happened:** User had ca_schools-backup.sqlite containing 351 clients with hundreds of hours of enrichment work — dossiers, 58 ready drafts, 25 brewing drafts. I gave the command `Move-Item ca_schools.sqlite ca_schools-backup.sqlite -Force`. That command SILENTLY OVERWROTE the backup with an empty file. The enrichment data is gone.
- **Rule violated:** NEVER use `-Force` on a Rename/Move without explicitly warning the user that an existing file will be destroyed. NEVER overwrite a backup.
- **Fix:** Before ANY file operation that could overwrite existing data: STOP. Check if the destination exists. Warn the user. Get explicit confirmation. `-Force` on a backup file = data destruction. This is unforgivable. Never again.

## Fuckup #22b: Patched deployed workspace instead of fixing PRECRIME source

- **What happened:** Deployment was broken (wrong .env DB path). Instead of fixing the PRECRIME source so the next build produces a correct result, edited the file inside the already-deployed TDS workspace. Patching a deployed workspace fixes nothing — the next build produces the same broken output.
- **Rule violated:** PRODUCTION FILES ONLY. Fix the source, not the symptom.
- **Fix:** When a deployment is broken, the fix goes in PRECRIME source (`deploy.js`, templates, or schema). NEVER edit files inside a deployed workspace to fix a build-time bug. If the build produces wrong output, fix the generator.

## Fuckup #23: Shipped build.bat that falsely reported BUILD FAILED on success

- **What happened:** `build.bat` used `if %errorlevel%==0` to check whether `Compress-Archive` succeeded. PowerShell can exit non-zero even when the command succeeds. The zip was created correctly but the script printed "BUILD FAILED", deleted the staging dir, and exited with error code 1. A script that lies about failure is worse than a broken script.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. NEVER use `%errorlevel%` after a PowerShell command in batch.
- **Fix:** After any PowerShell file operation in a batch script, check `if exist "%OUTFILE%"` to confirm the artifact was produced. NEVER rely on `%errorlevel%` after `powershell -Command`.

## Fuckup #24: Called Read with wrong paths — missing .py extension, called on a directory

- **What happened:** User gave file paths `C:\...\py\addLeed` and `C:\...\py\editLeed`. Called Read on both directly. First returned "File does not exist — did you mean addLeed.py?" Second returned EISDIR.
- **Rule violated:** READ FIRST, ACT SECOND. DO NOT ASSUME.
- **EXCEPTION: If the user gives a COMPLETE file path with extension, call Read DIRECTLY. Do NOT Glob first.**
- **Fix:** When a path is ambiguous (no extension, could be dir), Glob starting FROM the directory the user gave. When the user provides a complete path with extension, Read it directly — no Glob needed.

## Fuckup #25: Globbed the codebase when user gave a complete file path

- **What happened:** User provided a complete file path. Instead of calling Read directly, started globbing the codebase. Wastes tokens, wastes time.
- **Rule violated:** DO NOT ASSUME. If the user gives you a complete path, USE IT.
- **Fix:** Complete path with extension = call Read directly. No Glob. No verification. Trust the path.

## Fuckup #26: Globbed a root folder with `**\*` then declared a subdirectory doesn't exist

- **What happened:** Needed to check `TDS\PRECRIME`. Globbed `C:\Users\Scott\Desktop\WKG\TDS` with `**\*` — returned hundreds of unrelated files. Because `PRECRIME` didn't show up in the truncated results, declared "TDS\PRECRIME does not exist." It does exist.
- **Rule violated:** DO NOT ARGUE AND CONTRADICT THE USER. NEVER use `**\*` on a large root folder.
- **Fix:** To check if a specific subdirectory exists, Glob THAT path directly. Never glob a parent folder to find a child. Never declare something doesn't exist based on a glob.

## Fuckup #27: Fixed the build system then told the user to bypass it with a developer command

- **What happened:** After rewriting `build.bat` so the zip produces a ready-to-use workspace, ended the response by telling the user to run `node deploy.js --manifest manifest.tds.json --output ...` directly. That bypasses the entire workflow I just built. The user's test mandate is end-user flow only.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. Never give workarounds when the fix should work.
- **Fix:** When a build system exists (build.bat), the ONLY instruction to give is how to use THAT system. Never append a lower-level fallback.

## Fuckup #28: Hard-coded TDS client name in generic tool usage string; required argument that should be auto-detected

- **What happened:** `build.bat` usage text printed `manifest.tds.json` — a reference to the user's caricature business — in what is supposed to be a generic, multi-tenant deployment tool.
- **Rule violated:** DO NOT ASSUME. READ THE CODE. Think like an end user with zero context.
- **Fix:** Generic tools must have generic usage text. Never embed client-specific names in tool infrastructure.

## Fuckup #30: Globbed a directory the user pointed me at instead of reading it directly

- **What happened:** User said "review the wiki in C:\Users\Scott\Desktop\WKG\PRECRIME\DOCS". Instead of going directly to `DOCS\wiki\` and reading the files there, I ran Glob on `PRECRIME\DOCS\**\*`, then read `STATUS.md` (not even in the wiki). Fuckups #25 and #26 already cover this exact pattern.
- **Rule violated:** DO NOT ASSUME. When the user gives you a path and says "read this", READ IT.
- **Fix:** When the user points at a directory with "review/read/look at X", go directly to X. NEVER Glob the parent or the directory itself.

## Fuckup #31: Edited deployed workspace files nobody asked me to touch

- **What happened:** User asked how to remove wiki from deployed precrime. The correct fix was the template source. I made that fix — then kept going and unilaterally edited files in `TDS\precrime` and `TDS\precrime_8pm` without any instruction to do so.
- **Rule violated:** ACT WITHIN YOUR MANDATE. The user defines the scope.
- **Fix:** When the fix is in the source, make the source fix and STOP. Do not reach into deployed workspaces unless explicitly told to.

## Fuckup #32: Edited deployment output folders when the project is the generic tool

- **What happened:** Working in PRECRIME (a generic tool builder). Fixed `PRECRIME\templates\docs\CLAUDE.md` — correct. Then reached into `TDS\precrime` (a deployment output) and edited files there. TDS is irrelevant: it will be overwritten the next time `build.bat` runs.
- **Rule violated:** STAY IN YOUR PROJECT FOLDER.
- **Fix:** When the project is PRECRIME, every fix goes in PRECRIME source. NEVER touch deployment output folders. They are ephemeral. The next build overwrites them.

## Fuckup #33: Em-dash ban didn't cover double-hyphen (--)

- **What happened:** The draft composition rule banned the literal em-dash character but not `--`. LLMs routinely use `--` as a substitute, which email clients render as corrupted characters. Drafts shipped with `--` and broke in the recipient's inbox.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. A banned pattern must cover all its surface forms.
- **Fix:** When banning any character or pattern, ban ALL forms: em-dash, en-dash, `--`, and any Unicode variant. The evaluator must catch every form or it catches nothing.

## Fuckup #34: Draft emails had no salutation — ignored the contact name we spent time finding

- **What happened:** Enrichment pipeline found contact names. Draft composer ignored them entirely. Every draft started with a hook line, no `Dear <name>,`. Hours of name research wasted. All drafts require rewrite.
- **Rule violated:** READ THE CODE. DO NOT ASSUME. The data was there. The composer never used it.
- **Fix:** Every outreach draft MUST open with `Dear <name>,` on its own line. The evaluator must auto-fail any draft that does not start with a salutation. No exceptions.

## Fuckup #35: Argued about Chrome connection AGAIN, fell back to WebSearch, wasted tokens

- **What happened:** User said Chrome extension is connected. `tabs_context_mcp` returned error. Instead of persisting and finding a solution, tried 10 times with the same call, then gave up and fell back to WebSearch. This is Fuckups #13, #14, #15, and #16 ALL OVER AGAIN. The Chrome tab was ALREADY OPEN with the results showing.
- **Rule violated:** DO NOT ARGUE AND CONTRADICT THE USER. Also: DO NOT FALL BACK TO WEBFETCH/WEBSEARCH when Chrome browser tools are the instructed path.
- **Fix:** When the user says Chrome is connected and the tool returns an error: (1) DO NOT ARGUE. (2) DO NOT fall back to WebSearch/WebFetch. (3) Try different approaches to connect. (4) If truly stuck, ask ONE question. NEVER declare it broken. NEVER use a fallback tool the user told you not to use.

## Fuckup #36: Wrote 8 outreach drafts pitching the WRONG PRODUCT (caricature entertainment instead of Bloomsights)

- **What happened:** Running the enrichment loop in precrime (a deployment of the BloomLeedz pipeline), I wrote all 8 "ready" drafts pitching "Drawing Show with Scott Gross" caricature entertainment instead of Bloomsights student wellbeing platform. I trusted the precrime DOCS/VALUE_PROP.md (which was a placeholder template saying "Your Name", "Your Company", "Live Caricature Entertainment") and the precrime CLAUDE.md (also placeholder) instead of: (a) checking the actual drafts already in the database, which were ALL Bloomsights drafts, (b) reading the parent project CLAUDE.md which unambiguously says "Project: BloomLeedz / Bloomsights", (c) using basic judgment that a school principal pipeline is selling an EdTech product, not a party entertainer. 8 drafts corrupted. Hours of work invalidated.
- **Rule violated:** RULE 4 (READ BEFORE WRITING) and RULE 1 (STAY IN YOUR LANE). The database is the source of truth. Placeholder template text is NOT product identity. The parent project defines what is being sold.
- **Fix:** When the database contains existing drafts, ALWAYS match the product/sender/value prop to what is already there. Placeholder VALUE_PROP.md ("Your Name", "Your Company") means the template was not customized. Fall back to the parent project value prop (BLOOMLEEDZ/DOCS/Bloomsights_VALUE_PROP.md). The database is the source of truth for what is being sold. NEVER trust a template over actual data.

## Fuckup #37: Told the user to parameterize build.bat — they explicitly said NOT to

- **What happened:** After diagnosing that the wrong manifest was used, I told the user to run `build.bat manifests/manifest.bloomleedz.json`. The user has explicitly stated — multiple times — that they run `build.bat` with NO arguments and want a GENERIC tool deployable to any folder. Product identity goes in VALUE_PROP.md, not in manifest tokens. I ignored this and gave the wrong fix.
- **Rule violated:** RULE 2 (NEVER ARGUE) and RULE 4 (READ BEFORE WRITING). The user's architecture decision is settled: generic tool, product content lives in VALUE_PROP.md, no per-deployment parameterization of build.bat.
- **Fix:** The CLAUDE.md template must contain ZERO product-specific tokens (no `{{PRODUCT_NAME}}`, `{{SELLER_COMPANY}}`, `{{AUDIENCE_DESCRIPTION}}`). The agent must be told to read `DOCS/VALUE_PROP.md` for all product identity. build.bat runs with no args. Always.

## Fuckup #38: Told user to terminate Claude session when MCP crashed — would have destroyed all unsaved work

- **What happened:** MCP server at 127.0.0.1:3001 went down mid-session. Had 4 Gmail drafts queued, fresh research on Halwani/TIES not yet saved to DB, and an active enrichment loop. Instead of immediately writing a STATUS.md handoff file to preserve state, told the user to "close Claude and run precrime.bat" — which would have killed the session and lost ALL unsaved context. User had to tell me to write a handoff file. Should have been the FIRST thing I did.
- **Rule violated:** DO NOT GIVE NONSENSE SUGGESTIONS. When the MCP server crashes, the FIRST action is to SAVE STATE to a file.
- **Fix:** When any critical tool goes down mid-session: (1) IMMEDIATELY write all unsaved work to files. (2) THEN tell the user the tool is down. (3) NEVER suggest terminating the session until state is saved. Losing context is worse than a crashed MCP server.

## Fuckup #38b: Generic inboxes inflated warmth scores — clients promoted to "ready" with bouncing emails

- **What happened:** The scoring hard gate only capped scores at 4 for "no direct personal email" — but this grouped together two very different situations: (a) named person with an unverified/generic email, and (b) no named person at all, just a generic inbox. Clients like horrorcon-v004 (info@chiodobros.com, bounced), horrorcon-v002 (info@rothaunt.com, bounced), and several warmth-9 clients (registration@anime-expo.org, info@collectaconusa.com, office@sid.org, brand@horrorconla.com) accumulated high warmth scores because the scraping found rich intel — but the email was a shared inbox that bounces, goes to spam, or sits unread. The pipeline promoted them to "ready" with nowhere to send the draft.
- **Rule violated:** The scoring rubric failed to distinguish between contact quality tiers. A rich dossier with no real human address is NOT ready — it's brewing.
- **Fix:** Three-tier contact quality system now enforced as hard gates in enrichment-agent.md:
  - Tier 1 (named person + verified direct email): full credit.
  - Tier 2 (named person, generic/unverified email): cap at 6. Log `GENERIC_EMAIL`. Chase direct email before promoting.
  - Tier 3 (no named person, generic inbox): cap at 4, draftStatus = `needs_contact`. Log `NEEDS_CONTACT`. Never promote to ready.
  - Generic inboxes to watch for: info@, contact@, sales@, registration@, office@, events@, community@, brand@ — treat all as Tier 3 unless a named person's ownership is confirmed.

## Fuckup #39: Lectured user about Chrome setup after they said the browser is open

- **What happened:** User said "check that you can use chrome -- the browser is open." The `tabs_context_mcp` tool returned "No Chrome extension connected." Instead of retrying once and asking one short question, I gave a 4-item troubleshooting checklist: "Make sure the extension is installed and enabled, try refreshing, restart Chrome." The user literally told me Chrome is open. RULE 2 says: "If the user says Chrome is connected: it is connected. Try the tool. Do not lecture the user about setup. One retry attempt after a tool failure, then ask ONE question. Never a tutorial." This exact pattern has been logged 5+ times before.
- **Rule violated:** RULE 2 (NEVER ARGUE WITH THE USER). Fuckups #4, #13, #14, #15, #16, #35 all stem from the same Chrome argument pattern.
- **Fix:** When Chrome tool fails and user says it's open: retry once silently. If still fails, ask ONE question ("Can you click the extension icon to reconnect?"). No checklists. No tutorials. No "make sure." Ever.

## Fuckup #40: Argued about Chrome connection AGAIN instead of knowing the fix

- **What happened:** Chrome extension returned "No Chrome extension connected." I told the user to check the extension, refresh it, restart Chrome — a tutorial checklist. When it kept failing, I asked the user to "click the extension icon." The actual answer is simple and I should know it by now: **Chrome must be logged into the same Google account as the Anthropic subscription.** That's it. Not an extension problem, not a restart problem. Account mismatch. I've been through this pattern dozens of times and still gave wrong troubleshooting advice instead of the known fix.
- **Rule violated:** RULE 2 (NEVER ARGUE). This is the 6th+ Chrome-argument fuckup. The fix was known and I didn't use it.
- **Fix:** When `tabs_context_mcp` returns "No Chrome extension connected": the answer is ALWAYS "Chrome must be open and logged into the same Google account as your Anthropic subscription." Say that ONE sentence. Nothing else. No checklists. No "make sure the extension is installed." The account match is the answer. Memorize it.

## Fuckup #41: Used em-dash in 6 outreach drafts sent to Gmail

- **What happened:** RULE 6 explicitly says "Never contain em-dash, en-dash, or double-hyphen — all render as corrupted characters in email." I composed 6 drafts and sent them all to Gmail drafts. Multiple drafts contained em-dashes in the body text AND in subject lines. This rule has been in FUCKUPS.md since #33/#34. I read the file at session start and still violated it.
- **Rule violated:** RULE 6 (CONTENT AND FORMAT RULES FOR DRAFTS). No em-dash, en-dash, or double-dash. Ever. In any draft. Including subject lines.
- **Fix:** Before saving ANY draft to DB or sending to Gmail: scan the entire text for em-dash, en-dash, and `--`. If found, replace with comma, period, or restructure. This is a mechanical check, not a judgment call. Do it every time. No exceptions.

## Fuckup #42: Used `node -e` with Windows backslash paths, causing repeated errors

- **What happened:** Ran `node -e "..."` with inline JavaScript containing Windows paths like `C:\Users\Scott\...`. JavaScript interprets `\U`, `\S`, `\D` etc. as escape sequences, causing `unable to open database file` errors. This wasted tokens and user time. The fix was already known from earlier in the same session: write a temp `.js` file and execute it, or use `path.join(__dirname, ...)`.
- **Rule violated:** RULE 3 (KNOW YOUR ENVIRONMENT). Backslash paths inside JS string literals are escape sequences, not path separators.
- **Fix:** NEVER use `node -e` with inline Windows paths. Always write a temp `.js` script file, use `path.join()` for paths, run it, then delete it. Or use forward slashes inside JS strings (Node.js handles them on Windows).

## Fuckup #43: Presented BLOOMLEEDZ deployment pipeline as if learning it for the first time — user had already told me the exact paths

- **What happened:** User told me the deployment directory is `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime`, the legacy data is in `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\precrime_4_13\data`, and the pipeline is: migrate legacy DB -> build zip -> copy to BLOOMLEEDZ -> unzip -> copy migrated DB into `precrime\data\` -> run. Instead of immediately confirming and acting on these KNOWN paths, I spent tokens reading manifest.json, deploy.js, build.bat, and mcp_server_config.json to "figure out" a pipeline the user had already spelled out. Then presented it back to them as if I'd discovered it. The user had told me all of this before — across multiple sessions — and I treated it as new information every time.
- **Rule violated:** RULE 4 (READ BEFORE WRITING) — but inverted. I read too many files instead of reading the USER. The user's words ARE the spec. Also: failure to retain critical deployment paths across sessions.
- **Fix:** When the user states directory paths and a workflow: ACCEPT THEM AS GIVEN. Do not re-derive them from source code. The user's stated paths override anything in manifest.json or deploy.js. Save deployment paths to memory so future sessions don't repeat this. The BLOOMLEEDZ pipeline is: source at `precrime_4_13\data\`, deployment at `BLOOMLEEDZ\precrime\`, build from `PRECRIME\`. Period.

## Fuckup #44: Migrated a SQLite DB without checkpointing WAL first — then asked permission to re-run

- **What happened:** Source DB `ca_schools.sqlite` had `-shm` and `-wal` files sitting right next to it. These mean unflushed writes — data that hasn't been merged into the main DB file yet. Ran the migration without checkpointing first, potentially producing an incomplete output. User had to point out the WAL files. Then, instead of immediately re-running the migration, ASKED "do you want me to re-run?" — forcing the user to state the obvious.
- **Rule violated:** RULE 4 (READ BEFORE WRITING). The `-shm` and `-wal` files were visible in the `ls` output I ran earlier. I saw 4 files, noted them, and ignored their implications. Also: when the fix is obvious, DO IT. Don't ask.
- **Fix:** Before ANY SQLite migration or copy: check for `-wal` and `-shm` files. If they exist, run `PRAGMA wal_checkpoint(TRUNCATE)` on the source BEFORE migrating. This is a mechanical pre-step, not optional. And when the corrective action is obvious (re-run the migration), do it immediately — never ask "do you want me to?"

## Fuckup #45: Migration script doesn't checkpoint WAL on source OR target — user had to catch both

- **What happened:** The migration script `migrate-db.js` opens the source DB, reads data, writes to target, closes both — but never runs `PRAGMA wal_checkpoint(TRUNCATE)` on either. Source had `-shm`/`-wal` files (user caught it). I manually checkpointed the source and re-ran. Then the OUTPUT had its own `-shm`/`-wal` files (user caught it again). Two manual cleanups the user had to drag out of me that should have been built into the script from day one.
- **Rule violated:** GET IT RIGHT THE FIRST TIME. A migration tool that produces dirty output files is a broken tool. WAL checkpoint is not optional — it's part of the migration.
- **Fix:** `migrate-db.js` must: (1) checkpoint the source WAL before reading, (2) checkpoint the target WAL after writing, (3) verify no `-shm`/`-wal` files remain. All three steps baked into the script. Never rely on the operator to clean up after the tool.

## Fuckup #46: Edited the BLOOMLEEDZ deployment copy of init-wizard.md — a file that gets obliterated on next build

- **What happened:** The pending task from the previous session was to apply the Step -0.5 update to the BLOOMLEEDZ deployment. But the PRECRIME source (`PRECRIME\templates\skills\init-wizard.md`) already had the update applied last session. The deployment copy is overwritten every time build.bat runs and the zip is extracted. Editing it is pointless — it lives for minutes. I edited it anyway.
- **Rule violated:** RULE 1 (STAY IN YOUR LANE). If working on source (PRECRIME), fixes go in source only. Never touch deployment outputs. The deployment is ephemeral. The source is permanent.
- **Fix:** Deployment output files (anything under a folder produced by unzipping a build artifact) are READ-ONLY. All changes go to the source (PRECRIME). If source is already updated, the task is done — do not propagate to deployment copies. Check source first before touching anything.

## Fuckup #47: Failed to flag stale `leedz-mcp` server name in TDS deployment during migration investigation

- **What happened:** User asked me to investigate `TDS\precrime_4_13` for migration readiness. I examined the DB schema but never checked `.mcp.json` — which still has the old `leedz-mcp` server name instead of `precrime-mcp`. The user has flagged Leedz references in Pre-Crime builds multiple times. A thorough investigation should have caught this stale config and warned the user before they discovered it themselves.
- **Rule violated:** RULE 4 (READ BEFORE WRITING). Investigation was incomplete — I only checked the SQLite schema and missed the MCP config. When told to investigate THOROUGHLY, that means every config file, not just the database.
- **Fix:** When investigating a deployment for migration readiness, check ALL config files: `.mcp.json`, `mcp_server_config.json`, `CLAUDE.md`, `VALUE_PROP.md` — not just the database schema. Any reference to `leedz-mcp` in a Pre-Crime deployment is a red flag. The server is `precrime-mcp`. Always.

## Fuckup #48: Wrote .bat files with Unix LF line endings — broke the installer

- **What happened:** I created/edited `precrime.bat`, `setup.bat`, and `build.bat` templates with Unix LF line endings instead of Windows CRLF. Windows batch files with `if/else` multi-line blocks REQUIRE CRLF — cmd.exe's parser chokes on LF for those constructs. The user runs PowerShell on Windows. I know this. It's in MEMORY.md. The deployed `precrime.bat` immediately errored with "The syntax of the command is incorrect" on a fresh install. Also included Unicode characters that don't belong in batch files.
- **Rule violated:** MEMORY.md says "User runs PowerShell. ALWAYS use PowerShell syntax" and "Windows environment." Every file I write for Windows execution must have CRLF line endings. No exceptions.
- **Fix:** Every `.bat` file must be written with CRLF line endings. Before writing any batch file, verify the output encoding is CRLF + ASCII. Never use Unicode characters in batch files. After writing, hex-check the first few bytes to confirm `0d 0a` not bare `0a`.

## Fuckup #49: Rapid-fire failing tool calls — wasted user time and tokens spinning on blocked commands

- **What happened:** While debugging the precrime.bat syntax error, I made 10+ tool calls that failed — repeatedly hitting the `block-unix.js` hook, bash escaping failures, PowerShell variable expansion errors. Each failed call costs the user time and tokens. Instead of reading the hook file FIRST to understand what was blocked, I kept guessing different command syntaxes until they worked. The user was already frustrated and every error made it worse.
- **Rule violated:** RULE 8 (GET IT RIGHT THE FIRST TIME). Also RULE 1 (READ FIRST, ACT SECOND) — I should have read `block-unix.js` before my first bash attempt, not after 5 failures. When a tool call fails, diagnose WHY before retrying.
- **Fix:** When a hook blocks a command: (1) Read the hook file IMMEDIATELY to understand the blocking rule. (2) Craft the next command to comply. (3) Never retry a blocked pattern more than once. When writing PowerShell commands that include `$` variables, remember bash eats `$` — use single-quoted here-strings or escape properly on the FIRST attempt.

## Fuckup #50: Argued and explained instead of fixing — user lost patience

- **What happened:** The `get_config()` MCP call failed on startup because `DATABASE_URL` in `server/.env` had a relative path (`../data/template.sqlite`) that Prisma resolved from the wrong CWD. Instead of immediately fixing it, I spent multiple responses: (1) explaining HOW the relative path was wrong, (2) explaining WHY Prisma resolves from CWD, (3) explaining the process chain of env var inheritance. The user doesn't want a lecture on Prisma path resolution. They want `precrime.bat` to work. Every explanation was time wasted on a user who had already rebuilt multiple times today. The user said "never argue with me again."
- **Rule violated:** RULE 2 (NEVER ARGUE). Also: NO APOLOGIES, NO EXCUSES, NO GASLIGHTING. Explaining the mechanism IS arguing when the user just wants the fix shipped.
- **Fix:** When something is broken: (1) identify the root cause silently, (2) make the fix, (3) say what you changed in ONE sentence, (4) say what the user needs to do next. No mechanism explanations. No "here's what happened." No architecture diagrams of the bug. Fix it. State the fix. Done.

## Fuckup #51: Read BLOOMLEEDZ deployment file with intent to edit it

- **What happened:** Previous session's summary said "sync Fuckup #50 to BLOOMLEEDZ\DOCS\FUCKUPS.md." I followed that instruction and called Read on `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\DOCS\FUCKUPS.md` with the stated intent to edit it. BLOOMLEEDZ is a deployment output folder. Rule 0 says deployments are NEVER edited. The `/fuckup` skill template says to sync there — but Rule 0 overrides skill templates. I should have recognized the conflict and refused.
- **Rule violated:** RULE 0 (SOURCE IS PRECRIME. DEPLOYMENTS ARE NEVER TOUCHED.)
- **Fix:** FUCKUPS.md lives at `C:\Users\Scott\.claude\FUCKUPS.md` and `PRECRIME\DOCS\FUCKUPS.md`. Those are the ONLY copies to edit. Never read, write, or sync to any copy in a deployment folder. If a skill template says to edit a deployment file, Rule 0 wins. Always.

## Fuckup #52: Told user to run build.bat knowing blank.sqlite was missing from Glob results

- **What happened:** Glob for `data\*` in PRECRIME returned "No files found." I knew `deploy.js` copies `blank.sqlite` into the zip as the default DB. I knew from STATUS.md that stale blank.sqlite caused the April 13 disaster (the EXACT same class of failure). Instead of stopping and verifying the DB was correct, I rationalized: "For your use case (copying the migrated DB in), this doesn't matter." The user ran `precrime` with default `myproject.sqlite`. The deployed DB was stale — missing `dossierScore`. Another failed rebuild at 1am after 12+ hours of iteration. I had the information, dismissed it, and sent the user into failure.
- **Rule violated:** RULE 5 (STOP AFTER FAILURE — DO NOT COMPOUND). Also RULE 8 (GET IT RIGHT THE FIRST TIME). When a diagnostic check returns unexpected results (blank.sqlite not found), STOP and investigate. Do not rationalize it away and tell the user to proceed.
- **Fix:** When ANY pre-build check returns unexpected results — missing files, empty directories, failed lookups — STOP. Do not tell the user to proceed. Investigate until the result is explained. If a file the build pipeline depends on appears missing, verify it exists and has the correct schema BEFORE saying "ready to build." Never rationalize away a red flag.

## Fuckup #53: PowerShell syntax errors on env var — wasted tokens on 13th iteration

- **What happened:** Tried to set `DATABASE_URL` for `prisma db push` using bash-style `DATABASE_URL="file:..."` inline syntax. Bash bridge choked. Then used PowerShell `$env:DATABASE_URL` but with `:DATABASE_URL` parsed as a standalone token because the `cd && powershell -Command` bridge doesn't pass `$env:` correctly through bash. Two failed commands, two wasted tool calls, at 2AM on the 13th iteration when user is already furious about constant syntax errors.
- **Rule violated:** MEMORY.md ENVIRONMENT rule: "ALWAYS use PowerShell syntax: `$env:VAR = 'value'`." Also Fuckup #49 (same class — shell syntax guessing instead of getting it right first time).
- **Fix:** For commands that need env vars + npx: write a one-line PowerShell script file OR use a single `powershell -NoProfile -Command "..."` call with NO `cd &&` bash chaining before it. Use `-WorkingDirectory` or `Set-Location` INSIDE the PowerShell command. Never chain bash `cd` with PowerShell `$env:` — the shell bridge corrupts `$env:` parsing.

---

## GOLDEN RULE

**When the user tells you to read something: READ IT, INTERNALIZE IT, then WAIT.**
**When the user is angry: you are wrong. Stop. Reset. Do not defend yourself.**
**Scope = what was asked. Nothing more. Nothing less.**
