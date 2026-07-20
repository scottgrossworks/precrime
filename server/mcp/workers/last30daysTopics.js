// last30daysTopics.js -- deterministic buyer-occasion topics for the LAST_30_DAYS worker.
//
// Topics are phrased as BUYING OCCASIONS (events that hire the trade), not the trade's
// own service name -- searching the service name finds competitors; searching the host's
// occasion ("quinceanera planning") finds the HOST with an open vendor slot. No city-only
// strings (a bare city floods X with sports/weather noise).
//
// GENERIC SYSTEM RULE (2026-07-13): nothing deployment-specific may be hard-coded here.
// Geography comes from the deployment's VALUE_PROP at load time (the old version
// hard-coded "los angeles" -- that belongs to one deployment's config, not the engine).
//
// PRIVATE-FIRST BIAS (2026-07-13): a single host planning THEIR OWN celebration
// (wedding, birthday, quinceanera, mitzvah, shower, graduation...) is the ideal client
// for ANY vendor -- a one-to-one booking beats working a booth at someone else's event.
// Private occasions dominate the rotation ~3:1 over general/institutional topics, and
// use demand-side phrasing ("<occasion> planning <geo>": hosts mid-plan) while general
// topics use supply-side phrasing ("<occasion> vendors <geo>").
//
// nextTopic() rotates one topic per call via a module-local counter. LAST_30_DAYS is
// serialized (limit 1), so the planner's Stage-8 for-loop only ever runs at i=0 -- a bare
// index would never rotate. The counter is in-memory only: it advances per created task and
// resets on process restart. No DB, no persisted cursor.

const { VALUE_PROP } = require('../runtime');

// First clause of the VALUE_PROP geography, cleaned of filler ("Metro", "Greater",
// "area") and capped at 4 words -- "Metro Los Angeles, within 50 miles" -> "los angeles".
// Empty VALUE_PROP geography -> topics carry no geo term (still valid searches).
function geoTerm() {
    const g = String((VALUE_PROP && VALUE_PROP.geography) || '').toLowerCase()
        .split(/[,(\n]/)[0]
        .replace(/\b(metro|greater|area|region|county)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return g.split(' ').slice(0, 4).join(' ');
}

// Universal life-cycle celebrations -- generic across every trade and deployment.
const PRIVATE_OCCASIONS = [
    'wedding reception', 'kids birthday party', 'quinceanera',
    'bar mitzvah bat mitzvah', 'sweet 16 party', 'graduation party',
    'baby shower', 'engagement party'
];
// Institutional / recurring occasions -- still real buyers, lower priority.
const GENERAL_OCCASIONS = [
    'corporate holiday party', 'school carnival festival', 'community fundraiser gala'
];

// Single source of truth for LAST_30_DAYS topics: private topics interleaved ahead of
// general ones (one general after every third private). The worker and the test
// harness (scan-topics.js) both read this list.
const L30D_TOPICS = (() => {
    const geo = geoTerm();
    const withGeo = s => `${s} ${geo}`.trim();
    const out = [];
    let gi = 0;
    PRIVATE_OCCASIONS.forEach((occ, i) => {
        out.push(withGeo(`${occ} planning`));
        if (i % 3 === 2 && gi < GENERAL_OCCASIONS.length) {
            out.push(withGeo(`${GENERAL_OCCASIONS[gi++]} vendors`));
        }
    });
    while (gi < GENERAL_OCCASIONS.length) out.push(withGeo(`${GENERAL_OCCASIONS[gi++]} vendors`));
    return out;
})();

let _n = 0;

function nextTopic() {
    return L30D_TOPICS[_n++ % L30D_TOPICS.length];
}

module.exports = { L30D_TOPICS, nextTopic };
