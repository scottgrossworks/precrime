// last30daysTopics.js -- deterministic buyer-occasion topics for the LAST_30_DAYS worker.
//
// Topics are phrased as BUYING OCCASIONS (events that hire the trade), not the trade's
// own service name -- "caricature artist" finds competitors; "corporate holiday party
// entertainment ideas" finds event planners with an open entertainment slot. No city-only
// strings (e.g. bare "los angeles" floods X with Lakers/weather noise).
//
// nextTopic() rotates one topic per call via a module-local counter. LAST_30_DAYS is
// serialized (limit 1), so the planner's Stage-8 for-loop only ever runs at i=0 -- a bare
// index would never rotate. The counter is in-memory only: it advances per created task and
// resets on process restart. No DB, no persisted cursor.

// Single source of truth for LAST_30_DAYS topics. Tune wording here after judging the
// scan-topics.js numbers -- the worker and the test harness both read this list.
const L30D_TOPICS = [
    'corporate holiday party entertainment ideas los angeles',
    'wedding reception entertainment vendors los angeles',
    'quinceanera entertainment ideas los angeles',
    'kids birthday party entertainment los angeles',
    'school carnival festival vendors los angeles',
    'bar mitzvah bat mitzvah entertainment los angeles'
];

let _n = 0;

function nextTopic() {
    return L30D_TOPICS[_n++ % L30D_TOPICS.length];
}

module.exports = { L30D_TOPICS, nextTopic };
