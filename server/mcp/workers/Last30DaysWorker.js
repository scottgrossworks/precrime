// Last30DaysWorker.js -- procedural (zero-model) LAST_30_DAYS worker.
//
// Runs the last30days CLI on the task's topic, parses + filters its JSON in Node, and turns
// the high-score survivors into Clients (+Booking +Factlet) with a follow-up DRILL_DOWN
// queued to find the real contact/date. No goose, no model tokens for ingestion.
//
// Flow: runCli -> read newest data/<slug>-raw.json -> filter ranked_candidates
//       -> pipelineSave each survivor -> createTaskRow('DRILL_DOWN') on its booking.

const fs = require('fs');
const path = require('path');

const { ProceduralWorker, REPO_ROOT } = require('./ProceduralWorker');
const { createTaskRow } = require('../db');
const { VALUE_PROP } = require('../runtime');

const DATA_DIR = path.join(REPO_ROOT, 'data');
const SCRIPT = 'last30days/skills/last30days/scripts/last30days.py';
const MIN_SCORE = 50;                                  // buyers cluster 60-68; vendors ~38; noise <20
const OFFTOPIC = /off-topic|lacks .* grounding|no .* date/i;
// Only BUYER-intent sources create clients. reddit/x carry people asking/planning;
// tiktok/instagram/youtube score just as high but are VENDORS advertising (confirmed across
// the 6-topic scan) -- excluded. facebook is included because its connector already gates on
// buyer intent in the listing text (facebook.py _is_buyer_intent), so its items ARE buyers.
const CLIENT_SOURCES = new Set(['reddit', 'x', 'facebook']);

class Last30DaysWorker extends ProceduralWorker {
    async run() {
        // --- topic (task.input is a JSON string) ---
        let input = {};
        try { input = typeof this.task.input === 'string' ? JSON.parse(this.task.input) : (this.task.input || {}); }
        catch (_) { input = {}; }
        const topic = input.topic;
        if (!topic) return { status: 'failed', error: 'missing_topic', summary: 'last-30-days: no topic in task.input' };

        // --- run the CLI; it writes data/<slug>-raw.json itself (clean UTF-8) ---
        const startedAt = Date.now();
        try {
            await this.runCli('python', [SCRIPT, topic, '--deep', '--emit=json', '--save-dir', 'data']);
        } catch (e) {
            return { status: 'failed', error: e.message, summary: `last-30-days "${topic}": CLI failed` };
        }

        // --- read the freshest *-raw.json this run produced ---
        let data;
        try {
            data = JSON.parse(fs.readFileSync(this._newestRawFile(startedAt), 'utf8'));
        } catch (e) {
            return { status: 'failed', error: `read_output: ${e.message}`, summary: `last-30-days "${topic}": no output file` };
        }

        // --- procedural filter (zero model) ---
        const all = Array.isArray(data.ranked_candidates) ? data.ranked_candidates : [];
        const keep = all.filter(c =>
            typeof c.final_score === 'number' && c.final_score >= MIN_SCORE &&
            CLIENT_SOURCES.has(c.source) &&
            !OFFTOPIC.test(c.explanation || '')
        );

        // --- ingest survivors: Client + Booking + Factlet, then queue DRILL_DOWN ---
        const clientIds = [];
        const bookingIds = [];
        let drills = 0;
        for (const c of keep) {
            const url = c.url || c.candidate_id || null;
            const title = c.title || '(untitled last-30-days lead)';
            const patch = {
                name:        title,                        // Client.name is required; DRILL_DOWN replaces it with the real contact
                company:     title,
                source:      url,
                draftStatus: 'brewing',
                clientNotes: `last-30-days: ${topic}`,
                bookings:  [{ trade: (VALUE_PROP && VALUE_PROP.trade) || null, title, sourceUrl: url }],
                factlets:  [{ content: (c.snippet || title).slice(0, 2000), source: url }]
            };
            try {
                const resp = await this.deps.pipelineSave('inproc-l30d', null, patch, null, false);
                let body = {};
                try { body = JSON.parse(resp.content[0].text); } catch (_) {}
                if (body.clientId) clientIds.push(body.clientId);
                const bid = Array.isArray(body.affectedBookingIds) ? body.affectedBookingIds[0] : null;
                if (bid) {
                    bookingIds.push(bid);
                    await createTaskRow('DRILL_DOWN', {
                        targetType: 'Booking', targetId: bid,
                        input: { clientId: body.clientId, missing: ['client_email'] },
                        sessionId: this.task.sessionId || null
                    });
                    drills++;
                }
            } catch (e) {
                console.error(`[last30days] save failed for ${url}: ${e.message}`);
            }
        }

        const summary = `last-30-days "${topic}": kept ${keep.length}/${all.length}, ${clientIds.length} client(s), queued ${drills} drill(s)`;
        return { status: 'done', output: { clientIds, bookingIds, kept: keep.length, total: all.length, summary }, summary };
    }

    // Newest *-raw.json in data/ written at/after `since` (LAST_30_DAYS is serialized, so the
    // freshest file is ours). Throws if none is fresh -- i.e. the CLI wrote nothing this run.
    _newestRawFile(since) {
        const files = fs.readdirSync(DATA_DIR)
            .filter(f => f.endsWith('-raw.json'))
            .map(f => { const p = path.join(DATA_DIR, f); return { p, m: fs.statSync(p).mtimeMs }; })
            .filter(x => x.m >= since - 1000)
            .sort((a, b) => b.m - a.m);
        if (!files.length) throw new Error('no fresh *-raw.json produced');
        return files[0].p;
    }
}

// Thin functional entry point for the in-process dispatcher.
async function run(task, deps) {
    return new Last30DaysWorker(task, deps).run();
}

module.exports = { Last30DaysWorker, run };
