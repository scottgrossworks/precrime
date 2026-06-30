// Tests for sourceStore.js -- run: node --test server/mcp/sourceStore.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSourceStore, dedupKey, CHANNEL_FILES } = require('./sourceStore');

// Build a throwaway root with channel files seeded from `seed` (channel -> lines[]).
function makeRoot(seed = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srcstore-'));
    for (const [channel, lines] of Object.entries(seed)) {
        const file = path.resolve(root, CHANNEL_FILES[channel].rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    }
    return root;
}

function readLines(root, channel) {
    const file = path.resolve(root, CHANNEL_FILES[channel].rel);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

test('load builds index across channels and skips comments/blanks', () => {
    const root = makeRoot({
        rss: ['# a comment', '', 'https://a.com/feed | Site A | events', 'https://b.com/feed'],
        directory: ['https://dir.com | weddings']
    });
    const store = createSourceStore({ root });
    const c = store.load();
    assert.strictEqual(c.total, 3);
    assert.strictEqual(c.byChannel.rss.total, 2);
    assert.strictEqual(c.byChannel.directory.total, 1);
});

test('addSources appends exactly one line for a new url and returns added:1', () => {
    const root = makeRoot({ rss: ['https://a.com/feed'] });
    const store = createSourceStore({ root });
    store.load();
    const r = store.addSources([{ url: 'https://new.com/feed', channel: 'rss', label: 'New' }]);
    assert.deepStrictEqual(r, { added: 1, duplicates: 0, invalid: 0 });
    const lines = readLines(root, 'rss');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.some(l => l.startsWith('https://new.com/feed')));
});

test('addSources dedups on case/trailing-slash variants', () => {
    const root = makeRoot({ rss: ['https://a.com/feed'] });
    const store = createSourceStore({ root });
    store.load();
    const r = store.addSources([{ url: 'https://A.com/feed/', channel: 'rss' }]);
    assert.deepStrictEqual(r, { added: 0, duplicates: 1, invalid: 0 });
    assert.strictEqual(readLines(root, 'rss').length, 1); // nothing appended
});

test('handle-channel input is normalized before dedup/storage', () => {
    const root = makeRoot({});
    const store = createSourceStore({ root });
    store.load();
    const r = store.addSources([{ url: 'r/EventProduction', channel: 'reddit' }]);
    assert.strictEqual(r.added, 1);
    // Re-adding the already-normalized full URL is a duplicate.
    const r2 = store.addSources([{ url: 'https://www.reddit.com/r/EventProduction', channel: 'reddit' }]);
    assert.strictEqual(r2.duplicates, 1);
});

test('nextSource hands out each source once, then QUEUE_EMPTY; default excludes browser-only', () => {
    const root = makeRoot({
        rss: ['https://a.com/feed', 'https://b.com/feed'],
        ig: ['@some_account']
    });
    const store = createSourceStore({ root });
    store.load();
    const first = store.nextSource();
    const second = store.nextSource();
    const third = store.nextSource();
    assert.strictEqual(first.status, 'CLAIMED');
    assert.strictEqual(second.status, 'CLAIMED');
    assert.strictEqual(third.status, 'QUEUE_EMPTY'); // ig is browser-only, excluded by default
    // explicit channel reaches the browser-only source
    const ig = store.nextSource('ig');
    assert.strictEqual(ig.status, 'CLAIMED');
    assert.strictEqual(ig.channel, 'ig');
});

test('markSource flips scrapedThisRun and writes nothing to the file', () => {
    const root = makeRoot({ rss: ['https://a.com/feed'] });
    const store = createSourceStore({ root });
    store.load();
    const before = fs.readFileSync(path.resolve(root, CHANNEL_FILES.rss.rel), 'utf8');
    const claim = store.nextSource('rss');
    store.markSource(claim.url, { clientsFound: 3 });
    assert.strictEqual(store.nextSource('rss').status, 'QUEUE_EMPTY'); // not re-handed
    const after = fs.readFileSync(path.resolve(root, CHANNEL_FILES.rss.rel), 'utf8');
    assert.strictEqual(before, after); // ephemeral state never persisted
});

test('unknown channel is counted invalid, nothing appended', () => {
    const root = makeRoot({});
    const store = createSourceStore({ root });
    store.load();
    const r = store.addSources([{ url: 'https://x.com/y', channel: 'bogus' }]);
    assert.deepStrictEqual(r, { added: 0, duplicates: 0, invalid: 1 });
});

test('readySources picks up to limit, marks claimed, excludes channels and urls', () => {
    const root = makeRoot({
        rss: ['https://a.com/feed', 'https://b.com/feed', 'https://c.com/feed'],
        ig: ['@acct']
    });
    const store = createSourceStore({ root });
    store.load();
    // exclude one url, exclude ig channel, limit 2
    const picked = store.readySources({ limit: 2, excludeChannels: ['ig'], excludeUrls: ['https://a.com/feed'] });
    assert.strictEqual(picked.length, 2);
    assert.ok(!picked.some(p => p.url.includes('a.com')));
    assert.ok(!picked.some(p => p.channel === 'ig'));
    // picked are now claimed -> not handed again
    const again = store.readySources({ limit: 5 });
    assert.ok(!again.some(p => picked.map(x => x.url).includes(p.url)));
});

test('recursion: a source added mid-run is immediately claimable', () => {
    const root = makeRoot({ rss: ['https://a.com/feed'] });
    const store = createSourceStore({ root });
    store.load();
    store.markSource(store.nextSource('rss').url, {}); // drain the seed
    assert.strictEqual(store.nextSource('rss').status, 'QUEUE_EMPTY');
    store.addSources([{ url: 'https://mid.com/feed', channel: 'rss' }]);
    const claim = store.nextSource('rss');
    assert.strictEqual(claim.status, 'CLAIMED');
    assert.strictEqual(dedupKey(claim.url), 'https://mid.com/feed');
});
