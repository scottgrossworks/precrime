// sourceStore.js -- markdown-backed source store + ephemeral in-memory index.
//
// THE per-channel markdown files are the single source of truth for scrape
// sources (bootstrap by hand; the server appends discoveries). This module is
// the ONLY code that reads or writes those files. It imports fs/path and
// nothing else -- no Prisma, no MCP, no HTTP -- mirroring the db.js boundary.
//
// Scrape-state is EPHEMERAL: claimed / scrapedThisRun / clientsFound / lastError
// live only in the in-memory index for the life of the process and are NEVER
// written back to markdown. A fresh process starts with every source unscraped,
// which is correct for demand-sensing (re-scraping a blog catches new events).
//
// Single-writer discipline: workers never touch the files. They emit one
// structured add_sources call; the server appends here. The conductor is the
// single dispatcher, so nextSource() handing out one URL at a time from the
// in-memory index is sufficient claim coordination -- no DB row, no file lock.
'use strict';

const fs = require('fs');
const path = require('path');

// Mirrors mcp_server.js. Kept here so the module is self-contained; mcp_server
// can import these from the store in a later step to remove the duplication.
const VALID_CHANNELS = new Set(['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website']);
const BROWSER_ONLY_CHANNELS = ['fb', 'ig', 'x'];

// Source lists are DEPLOYMENT DATA, not templated skill content: they live under
// <root>/data/sources/ so they grow per-deployment (driven by VALUE_PROP) and are
// never overwritten by a rebuild. The PRECRIME source repo ships only empty
// placeholders; each deployment's list grows here.
// channel -> { rel: markdown path relative to root, format: parser }
const CHANNEL_FILES = {
    directory: { rel: 'data/sources/directory.md', format: 'directory' },
    rss:       { rel: 'data/sources/rss.md',       format: 'rss' },
    fb:        { rel: 'data/sources/fb.md',         format: 'plain' },
    ig:        { rel: 'data/sources/ig.md',         format: 'handle' },
    reddit:    { rel: 'data/sources/reddit.md',     format: 'handle' },
    x:         { rel: 'data/sources/x.md',          format: 'handle' },
    website:   { rel: 'data/sources/website.md',    format: 'plain' },
    blog:      { rel: 'data/sources/blog.md',       format: 'plain' }
};

function normalizeSourceUrl(input, channel) {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (channel === 'reddit') {
        const sub = raw.replace(/^r\//i, '').replace(/^\//, '');
        return `https://www.reddit.com/r/${sub}`;
    }
    if (channel === 'ig') {
        if (raw.startsWith('@')) return `https://www.instagram.com/${raw.slice(1)}/`;
        if (raw.startsWith('#')) return `https://www.instagram.com/explore/tags/${raw.slice(1)}/`;
        return `https://www.instagram.com/${raw}/`;
    }
    if (channel === 'x') {
        if (raw.startsWith('@')) return `https://x.com/${raw.slice(1)}`;
        if (raw.startsWith('#')) return `https://x.com/hashtag/${raw.slice(1)}`;
        return `https://x.com/search?q=${encodeURIComponent(raw)}`;
    }
    return `https://${raw}`;
}

function inferSubtype(input, channel) {
    const raw = (input || '').trim();
    if (channel === 'ig') return raw.startsWith('#') ? 'hashtag' : 'account';
    if (channel === 'reddit') return 'subreddit';
    if (channel === 'x') {
        if (raw.startsWith('@')) return 'account';
        if (raw.startsWith('#')) return 'hashtag';
        return 'keyword';
    }
    if (channel === 'rss') return 'feed';
    if (channel === 'directory') return 'directory';
    return null;
}

// Canonical dedup key: case-insensitive, trailing slashes stripped, so
// "http://Example.com/" and "http://example.com" collapse to one source.
function dedupKey(url) {
    return String(url || '').toLowerCase().replace(/\/+$/, '');
}

// Parse one non-comment line into an entry, per the channel's format. Returns
// null when the line yields no URL.
function parseLine(line, channel, format) {
    const parts = line.split('|').map(p => p.trim());
    const rawUrl = parts[0];
    if (!rawUrl) return null;
    const url = normalizeSourceUrl(rawUrl, channel);
    if (!url) return null;
    if (format === 'rss') {
        return { url, channel, subtype: 'feed', label: parts[1] || null, category: parts[2] || null };
    }
    if (format === 'directory') {
        return { url, channel, subtype: parts[1] || 'directory', label: null, category: parts[1] || null };
    }
    if (format === 'handle') {
        return { url, channel, subtype: inferSubtype(rawUrl, channel), label: null, category: null };
    }
    // plain
    return { url, channel, subtype: inferSubtype(rawUrl, channel), label: parts[1] || null, category: parts[2] || null };
}

// Render an entry back to a markdown line for append. Trailing empty fields are
// dropped so files stay clean. Handle channels store the full normalized URL.
function renderLine(entry) {
    const cells = [entry.url];
    if (entry.label) cells.push(entry.label);
    if (entry.category && entry.category !== entry.label) cells.push(entry.category);
    return cells.join(' | ');
}

function createSourceStore({ root }) {
    if (!root) throw new Error('createSourceStore requires { root }');
    // key: dedupKey(url) -> { url, channel, subtype, label, category,
    //                         scrapedThisRun, claimed, clientsFound, lastError }
    const index = new Map();

    function fullPath(channel) {
        return path.resolve(root, CHANNEL_FILES[channel].rel);
    }

    // Read every channel file into the index. Missing files are simply empty.
    function load() {
        index.clear();
        for (const channel of Object.keys(CHANNEL_FILES)) {
            const file = fullPath(channel);
            if (!fs.existsSync(file)) continue;
            const lines = fs.readFileSync(file, 'utf8')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'));
            for (const line of lines) {
                const entry = parseLine(line, channel, CHANNEL_FILES[channel].format);
                if (!entry) continue;
                const key = dedupKey(entry.url);
                if (index.has(key)) continue;
                index.set(key, {
                    ...entry,
                    scrapedThisRun: false,
                    claimed: false,
                    clientsFound: 0,
                    lastError: null
                });
            }
        }
        return counts();
    }

    // Append new sources to their channel files (sole-writer). Dedup on the
    // canonical key against the in-memory index. Returns add/dup/invalid counts.
    function addSources(entries) {
        let added = 0, duplicates = 0, invalid = 0;
        const list = Array.isArray(entries) ? entries : [];
        for (const e of list) {
            const channel = e && e.channel;
            if (!channel || !VALID_CHANNELS.has(channel)) { invalid++; continue; }
            const url = normalizeSourceUrl(e.url, channel);
            if (!url) { invalid++; continue; }
            const key = dedupKey(url);
            if (index.has(key)) { duplicates++; continue; }
            const entry = {
                url,
                channel,
                subtype: e.subtype || inferSubtype(e.url, channel),
                label: e.label || null,
                category: e.category || null
            };
            try {
                appendLine(channel, entry);
            } catch (err) {
                invalid++;
                continue;
            }
            index.set(key, { ...entry, scrapedThisRun: false, claimed: false, clientsFound: 0, lastError: null });
            added++;
        }
        return { added, duplicates, invalid };
    }

    function appendLine(channel, entry) {
        const file = fullPath(channel);
        if (!fs.existsSync(file)) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file,
                `# ${channel} sources -- single source of truth. Bootstrap by hand; the server appends discoveries.\n` +
                `# format: <url> | <label?> | <category?>\n`, 'utf8');
        }
        fs.appendFileSync(file, renderLine(entry) + '\n', 'utf8');
    }

    // Hand out one unscraped, unclaimed source. Default excludes browser-only
    // channels (fb/ig/x) unless a channel is explicitly requested -- mirrors the
    // old next_source behavior. Marks the returned source claimed for this run.
    function nextSource(channel) {
        if (channel && !VALID_CHANNELS.has(channel)) {
            return { status: 'INVALID_CHANNEL', channel };
        }
        for (const entry of index.values()) {
            if (entry.scrapedThisRun || entry.claimed) continue;
            if (channel) {
                if (entry.channel !== channel) continue;
            } else if (BROWSER_ONLY_CHANNELS.includes(entry.channel)) {
                continue;
            }
            entry.claimed = true;
            return {
                status: 'CLAIMED',
                url: entry.url,
                channel: entry.channel,
                subtype: entry.subtype,
                label: entry.label,
                category: entry.category
            };
        }
        return { status: 'QUEUE_EMPTY', channel: channel || null };
    }

    // Pick up to `limit` ready (unscraped & unclaimed) sources for the planner to
    // bake into SCRAPE_SOURCE tasks, marking each claimed so it is not re-assigned
    // this run. excludeChannels skips whole channels (e.g. fb/ig headless);
    // excludeUrls skips already-planned URLs. The conductor is the single
    // dispatcher, so claim coordination is this in-memory marking -- no DB row.
    function readySources({ limit = 1, excludeChannels = [], excludeUrls = [] } = {}) {
        const exclude = new Set((excludeUrls || []).map(dedupKey));
        const skipChan = new Set(excludeChannels || []);
        const picked = [];
        for (const entry of index.values()) {
            if (picked.length >= limit) break;
            if (entry.scrapedThisRun || entry.claimed) continue;
            if (skipChan.has(entry.channel)) continue;
            if (exclude.has(dedupKey(entry.url))) continue;
            entry.claimed = true;
            picked.push({
                url: entry.url, channel: entry.channel,
                subtype: entry.subtype, label: entry.label, category: entry.category
            });
        }
        return picked;
    }

    // Record a scrape result in memory only (never written to markdown).
    function markSource(url, { clientsFound = 0, failedReason = null } = {}) {
        const entry = index.get(dedupKey(url));
        if (!entry) return { status: 'NOT_FOUND', url };
        entry.scrapedThisRun = true;
        entry.claimed = false;
        entry.clientsFound = clientsFound;
        entry.lastError = failedReason;
        return { status: 'MARKED', url: entry.url, clientsFound, failedReason };
    }

    // Per-channel counts for status: total, unscraped, claimed (this run), and
    // ready (unscraped AND unclaimed). Scrape-state is ephemeral, so there is no
    // cross-run "stale" notion -- a fresh process sees everything unscraped.
    function counts() {
        const byChannel = {};
        let total = 0, unscraped = 0;
        for (const entry of index.values()) {
            const c = byChannel[entry.channel] ||
                (byChannel[entry.channel] = { total: 0, unscraped: 0, claimed: 0, ready: 0 });
            c.total++; total++;
            if (!entry.scrapedThisRun) {
                c.unscraped++; unscraped++;
                if (entry.claimed) c.claimed++; else c.ready++;
            }
        }
        return { byChannel, total, unscraped };
    }

    return { load, addSources, nextSource, readySources, markSource, counts };
}

module.exports = {
    createSourceStore,
    normalizeSourceUrl,
    inferSubtype,
    dedupKey,
    VALID_CHANNELS,
    BROWSER_ONLY_CHANNELS,
    CHANNEL_FILES
};
