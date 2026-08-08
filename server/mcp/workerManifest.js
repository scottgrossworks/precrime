// ============================================================================
// workerManifest.js -- THE single source of worker capability (2026-08-06).
// One entry per spawnable task type: which skill file runs it, which goose
// extensions its recipe ships, which pipeline actions its pruned tool schema
// advertises, and which precrime tools it sees at all.
//
// This truth previously lived in FOUR unlinked places -- db.js WORKER_SKILL_MAP,
// conductor.js recipeExtLines, toolDefs.js SCOPE_ACTIONS/SCOPE_TOOLS, and the
// skill prose -- and drifted: ENRICH workers shipped a tavily schema their skill
// explicitly forbids using (re-billed every turn of up to 50 sessions), and the
// fb/ig harvesters were instructed to read shared rule files with no extension
// capable of opening a file. db.js, conductor.js, and toolDefs.js now all DERIVE
// their structures from this one table; edit capability HERE and nowhere else.
//
// skill:null = in-process type kept only so its (dead) tool scope stays defined.
// ============================================================================
'use strict';

const SAVE_COMPLETE = ['save', 'complete_task'];

const WORKER_MANIFEST = {
    SCRAPE_SOURCE: {
        skill: 'url-loop.md',
        extensions: ['developer', 'tavily', 'rss'],
        actions: ['save', 'complete_task', 'mark_source', 'add_sources', 'signal', 'browse'],
        tools: ['pipeline'],
        // fb/ig sources swap in a harvester skill + the chrome bridge. `developer`
        // ships too (drift fix 2026-08-06): the harvester skills INSTRUCT reading
        // shared/factlet-rules.md, booking-detect.md, classify-contact.md and
        // previously had no tool that could open a file -- the canonical shared
        // rules were silently unreachable.
        browser: {
            skills: { fb: 'fb-factlet-harvester/SKILL.md', ig: 'ig-factlet-harvester/SKILL.md' },
            extensions: ['chrome', 'developer']
        }
    },
    DRILL_DOWN:          { skill: 'drill-down.md',          extensions: ['tavily'], actions: [...SAVE_COMPLETE, 'browse'], tools: ['pipeline', 'find'] },
    DRILL_CONTAINER:     { skill: 'drill-container.md',     extensions: ['tavily'], actions: SAVE_COMPLETE,                tools: ['pipeline', 'find'] },
    DISCOVER_SOURCES:    { skill: 'discover-sources.md',    extensions: ['tavily'], actions: ['get_config', 'complete_task', 'add_sources'], tools: ['pipeline', 'trades'] },
    // MINE_REASON (2026-08-08): the curiosity worker -- given one recontact
    // REASON, hunt backwards through the existing client/booking DB until the
    // affected clients are found. Deliberately a SPAWNED goose session (the
    // multi-turn query loop IS the work) and deliberately ships NO tavily
    // extension: it structurally cannot spend a web-search credit.
    MINE_REASON:         { skill: 'mine-reason.md',         extensions: [],         actions: SAVE_COMPLETE,                tools: ['pipeline', 'find'] },
    // skill:null = IN-PROCESS (never spawns, never connects with ?scope=); the
    // entry is kept so the scope table stays total over historical task types.
    // FIND/ENRICH/DRAFT converted 2026-08-06 (workers/FindClientSourcesWorker.js,
    // EnrichClientWorker.js, DraftOutreachWorker.js): their skills were straight-
    // line procedures with at most one LLM decision -- a full goose session per
    // run was pure overhead. APPLY converted 2026-07-19.
    ENRICH_CLIENT:       { skill: null, extensions: [], actions: SAVE_COMPLETE,                         tools: ['pipeline', 'find'] },
    FIND_CLIENT_SOURCES: { skill: null, extensions: [], actions: SAVE_COMPLETE,                         tools: ['pipeline', 'find'] },
    DRAFT_OUTREACH:      { skill: null, extensions: [], actions: ['get_config', 'save', 'complete_task'], tools: ['pipeline', 'find'] },
    APPLY_FACTLET:       { skill: null, extensions: [], actions: SAVE_COMPLETE,                         tools: ['pipeline', 'find'] }
};

module.exports = { WORKER_MANIFEST };
