// Locks per-worker action scoping. The get_task orphan bug (a skill said "do NOT call get_task"
// but it stayed in the worker's schema, so a weak model called it and orphaned the task) was a
// hand-maintained-drift bug with nothing to catch it. This test IS that catch: it asserts each
// spawned worker type's pruned `pipeline.action` enum equals EXACTLY the actions its deployed
// skill calls, and that forbidden/unused actions are never exposed. A one-line WORKER scope edit
// that re-grants get_task (or save to DISCOVER, etc.) fails here instead of in production.
//
// Run: node --test server/mcp/toolDefs.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { scopedToolDefs, TOOL_DEFS } = require('./toolDefs');

const enumOf = defs => defs.find(d => d.name === 'pipeline').inputSchema.properties.action.enum;

// The EXACT pipeline actions each spawned worker skill calls, verified against
// templates/skills/*.md. (The find tool's bookings/clients/factlets are a SEPARATE tool.)
const EXPECTED = {
    DRILL_DOWN:          ['save', 'complete_task'],
    DRILL_CONTAINER:     ['save', 'complete_task'],
    ENRICH_CLIENT:       ['save', 'complete_task'],
    FIND_CLIENT_SOURCES: ['save', 'complete_task'],
    APPLY_FACTLET:       ['get_config', 'save', 'complete_task'],
    DRAFT_OUTREACH:      ['get_config', 'save', 'complete_task'],
    SCRAPE_SOURCE:       ['save', 'complete_task', 'mark_source', 'add_sources'],
    DISCOVER_SOURCES:    ['get_config', 'complete_task', 'add_sources'],
};

for (const [type, expected] of Object.entries(EXPECTED)) {
    test(`scope ${type} == exactly its skill's actions`, () => {
        const actions = enumOf(scopedToolDefs(type));
        assert.deepStrictEqual([...actions].sort(), [...expected].sort(),
            `${type} scoped action enum drifted from its skill's real usage`);
        assert.ok(!actions.includes('get_task'), `${type} must NOT expose get_task (orphan bug)`);
        assert.ok(actions.includes('complete_task'), `${type} needs complete_task (fold + sad path)`);
    });
}

test('DISCOVER_SOURCES cannot save / next_source / mark_source (its skill forbids all three)', () => {
    const a = enumOf(scopedToolDefs('DISCOVER_SOURCES'));
    for (const forbidden of ['save', 'next_source', 'mark_source']) {
        assert.ok(!a.includes(forbidden), `DISCOVER_SOURCES must not expose ${forbidden}`);
    }
});

test('no worker scope exposes resolve_dates or next_source (zero workers call them)', () => {
    for (const type of Object.keys(EXPECTED)) {
        const a = enumOf(scopedToolDefs(type));
        assert.ok(!a.includes('resolve_dates'), `${type} must not expose resolve_dates`);
        assert.ok(!a.includes('next_source'), `${type} must not expose next_source`);
    }
});

const propsOf = defs => defs.find(d => d.name === 'pipeline').inputSchema.properties;
// share_booking / resolve_dates-only props named their action WITHOUT the "action=" prefix, so an
// action=-only prune leaked them into every worker scope. No worker calls share_booking or
// resolve_dates, so none of these may appear in any worker's pruned schema (pure token waste).
const LEAK_PROPS = ['st', 'et', 'dtDraft', 'titleDraft', 'rqDraft', 'defaultDurationHours'];
test('no worker scope leaks share_booking / resolve_dates props (schema token leak)', () => {
    for (const type of Object.keys(EXPECTED)) {
        const p = propsOf(scopedToolDefs(type));
        for (const leak of LEAK_PROPS) {
            assert.ok(!(leak in p), `${type} must not expose the ${leak} prop (no worker calls its action)`);
        }
    }
    // The orchestrator's full defs MUST still carry them.
    const full = propsOf(TOOL_DEFS);
    for (const leak of LEAK_PROPS) assert.ok(leak in full, `full defs must keep ${leak}`);
});

test('unscoped / unknown scope returns full defs incl get_task (orchestrator unchanged)', () => {
    assert.strictEqual(scopedToolDefs(), TOOL_DEFS);
    assert.strictEqual(scopedToolDefs('NOT_A_TYPE'), TOOL_DEFS);
    assert.ok(enumOf(TOOL_DEFS).includes('get_task'), 'full defs must still include get_task for the orchestrator');
});
