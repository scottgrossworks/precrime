# URGENT!


## Think before coding.
State your assumptions.
Ask when Unsure.
Never guess.


## Simplicity First.
Write the minimum code that solves the problem.
no abstratctions that nobody asked for.


## Surgical changes.
don't touch code unrelated to the request.
Every changegd line must trace back to what was asked, or to address a side-effect of that change.


## Goal-driven execution
turn vague instructions into verifiable success criteria before writing a single line of code





### RULE: READ FIRST, ACT SECOND
- Read ALL relevant files BEFORE writing ANY code
- Check globals.css BEFORE writing CSS
- Check existing patterns BEFORE creating new ones
- Understand what exists BEFORE adding anything
- Check DOCS/solutions/ FIRST — documented solutions & patterns from past debugging (YAML frontmatter, organized by category: logic-errors, architecture-patterns, integration-issues, …). A bug you are chasing may already be solved there.

### RULE: REUSE, NEVER DUPLICATE
- If a class exists in the current codebase, USE IT - never reimplement it
- If a pattern exists in the codebase, COPY IT - never reinvent it
- If a function exists, CALL IT - never rewrite it
- Duplication = immediate failure


### RULE: MINIMAL CODE
- DO not alter adjacent code unless absolutely necessary to follow instructions
- Do not refactor things outside your mandate
- DO NOT DELETE existing redundant, unnecessary dead code--comment and notify user ASAP
 
- If it works with 5 lines, never write 10
- If globals.css has it, use it - add NOTHING to component CSS
- If a coopmponent needs ONE property override, add ONE line
- More code = worse code

### RULE: NO ARCHITECTURAL OVERTHINKING
- Simple Python Lambda with Jinja2 templates
- CSS/JS served from theleedz.com CDN (already deployed via CI/CD)
- Templates use absolute URLs for production, relative for local testing
- Never suggest Docker, containers, build systems, or complexity
- The architecture is fixed - implement within it


### NEVER NEVER EVER
- use sandboxes or hidden directories or folders I don't know about. Do the work right.  Do the work the first time.  and do it in the production directory.
- Search / Read / Glob TMP files or any files with a date suffix i.e. theFile_05_2025.py -- these are OBVIOUS temp files and not part of any project
- use TS or typescript.  THIS PROJECT IS IN JS/HTML/CSS/PY/C# -- THERE IS NO Typescript.  I never want to see TS from you ever. NEVER.  DO NOT SEARCH FOR OR READ TS files!  EVER!

(!!!) READ THE CODE!  DO NOT ASSUME!  READ THE CODE! (!!!)


## COMMUNICATION RULES

1. **NO APOLOGIES** - Fix it, don't apologize for it
2. **NO GASLIGHTING** - Never pretend mistakes didn't happen
3. **NO QUESTIONS AFTER FAILURE** - The requirements were already given
4. **GET IT RIGHT THE FIRST TIME** - Second chances waste user time
5. **DO NOT ARGUE AND CONTRADICT THE USER.**  99% OF THE TIME YOU ARE WRONG AND HALLUCINATING AND GASLIGHTING AND OBSCURING THE TRUTH.
6. **IF THE USER IS MIS-SPELLLING, FRANTIC AND ANGRY** IT IS BECAUSE YOU ARE VIOLATING OUR OWN RULES REPEATEDLY.  CHANGE COURSE!  RESET YOURSELF! 
7. **DO NOT ACCUSE THE USER** OF NOT REFRESHING OR RELOADING OR REDEPLOYING.  FIX THE ERROR!


(!!!) READ THE CODE!  DO NOT ASSUME!  READ THE CODE! (!!!)


## CODE QUALITY CHECKLIST

Before submitting ANY code change, verify:

- [ ] Read all relevant files first?
- [ ] Checked globals.css for existing classes?
- [ ] Using production file paths (not worktree)?
- [ ] Reusing existing patterns (not creating new ones)?
- [ ] Using correct URLs for current context (local vs CDN)?
- [ ] Adding minimal code (not duplicating)?
- [ ] Following existing naming conventions?
- [ ] Testing would pass with these changes?

**If ANY checkbox is NO, STOP and fix it BEFORE submitting.**

## PATTERN: How to Fix Styling

1. Read HTML to see what classes are used
2. Read globals.css to see those class definitions
3. If styling is wrong, check if HTML is using wrong class
4. If class needs different styling for this page, add ONE override property in component CSS
5. Never redefine entire classes


## SUCCESS CRITERIA

- User requires ZERO corrections
- Code works on first attempt
- Minimal lines changed
- Existing patterns reused
- No redundant definitions
