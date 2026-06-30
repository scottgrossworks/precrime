// ============================================================================
// sourceQueue.js -- the source-queue tool handlers + URL-evidence verification.
//
// next/mark/add/import_source over the markdown-backed source store, plus the URL
// predicates + evidence-verify helpers behind add_sources. The store is injected
// (built in bootstrap); responses + logSessionEvent are imported. isHttpUrl is
// returned so the save path shares the one definition.
//
//   const { isHttpUrl, pipelineNextSource, ... } = require("./sourceQueue").createSourceQueue({ sourceStore });
// ============================================================================

const { createSuccessResponse, createErrorResponse } = require('./responses');
const { logSessionEvent } = require('./sessionLog');

function createSourceQueue(deps) {
    const { sourceStore } = deps;

const VALID_CHANNELS = new Set(['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website']);

// Channels that need a real browser to render. Tavily / WebFetch on these
// returns navigation chrome and zero useful content. When pipeline.next_source
// is called WITHOUT an explicit channel filter, we exclude these by default --
// agents that misspell or omit `channel` (a common LLM error) won't burn the
// loop on zero-yield browser-only sources. Dedicated harvesters that need
// these channels pass the channel explicitly (e.g., fb-harvester passes
// channel:'fb' when iterating its own queue).
const BROWSER_ONLY_CHANNELS = ['fb', 'ig', 'x'];
const URL_VERIFY_TIMEOUT_MS = 10000;
const URL_VERIFY_TEXT_LIMIT = 500000;
const URL_VERIFY_CHANNELS = new Set(['directory', 'rss', 'blog', 'website']);

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function compactUrlForCompare(value) {
    try {
        const u = new URL(value);
        return {
            host: u.hostname.replace(/^www\./i, '').toLowerCase(),
            path: (u.pathname || '/').replace(/\/+$/, '') || '/'
        };
    } catch (_) {
        return null;
    }
}

function looksLikeHomepageRedirect(originalUrl, finalUrl) {
    const original = compactUrlForCompare(originalUrl);
    const final = compactUrlForCompare(finalUrl);
    if (!original || !final) return false;
    return original.host === final.host && original.path !== '/' && final.path === '/';
}


async function fetchUrlTextForProof(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_VERIFY_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': 'PreCrimeEvidenceVerifier/1.0',
                'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
            }
        });
        const contentType = res.headers.get('content-type') || '';
        const text = contentType.includes('text') || contentType.includes('html') || contentType.includes('json')
            ? (await res.text()).slice(0, URL_VERIFY_TEXT_LIMIT)
            : '';
        return { ok: true, status: res.status, finalUrl: res.url || url, text };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
        clearTimeout(timer);
    }
}

async function verifyEvidenceUrl(url, options = {}) {
    if (!isHttpUrl(url)) return { ok: true, skipped: true };

    const fetched = await fetchUrlTextForProof(url);
    if (!fetched.ok) return { ok: false, reason: `fetch_failed:${fetched.error}` };
    if (fetched.status < 200 || fetched.status >= 300) {
        return { ok: false, reason: `http_status:${fetched.status}` };
    }
    if (looksLikeHomepageRedirect(url, fetched.finalUrl)) {
        return { ok: false, reason: `redirect_to_homepage:${fetched.finalUrl}` };
    }

    const text = (fetched.text || '').toLowerCase();
    const expectedYear = options.expectedYear;
    if (expectedYear && !text.includes(String(expectedYear))) {
        return { ok: false, reason: `missing_year:${expectedYear}` };
    }

    const terms = options.proofTerms || [];
    if (terms.length > 0 && !terms.some(t => text.includes(String(t).toLowerCase()))) {
        return { ok: false, reason: `source_does_not_mention_claim_terms:${terms.slice(0, 5).join(',')}` };
    }

    return { ok: true, status: fetched.status, finalUrl: fetched.finalUrl };
}


function normalizeSourceUrl(input, channel /*, subtype */) {
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
        // keyword form -> wrap in search query
        return `https://x.com/search?q=${encodeURIComponent(raw)}`;
    }
    // Default: assume bare domain, prefix https
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

async function pipelineNextSource(id, channel, maxAgeDays, sessionId) {
    // Markdown-backed. Sources are assigned from the in-memory index; scrape-state
    // is ephemeral (every run starts fresh, which is correct for demand-sensing),
    // so maxAgeDays no longer gates re-scrape. Default excludes browser-only
    // channels (fb/ig/x) unless one is explicitly requested.
    if (channel && !VALID_CHANNELS.has(channel)) {
        return createErrorResponse(id, -32602,
            `next_source: invalid channel "${channel}". Must be one of: ${[...VALID_CHANNELS].join(', ')}.`);
    }
    try {
        const claim = sourceStore.nextSource(channel);
        if (claim.status !== 'CLAIMED') {
            return createSuccessResponse(id, JSON.stringify({
                status: 'QUEUE_EMPTY',
                channel: channel || 'any',
                hint: 'Call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task, or seed via pipeline.add_sources, then retry.'
            }));
        }
        return createSuccessResponse(id, JSON.stringify({
            status: 'CLAIMED',
            id: claim.url,            // markdown store has no row id; the URL is the key
            url: claim.url,
            channel: claim.channel,
            subtype: claim.subtype,
            label: claim.label,
            category: claim.category
        }));
    } catch (err) {
        return createErrorResponse(id, -32603, `next_source failed: ${err.message}`);
    }
}

async function pipelineMarkSource(id, url, scrapedAt, clientsFound, failedReason, sessionId) {
    if (!url) {
        return createErrorResponse(id, -32602, 'mark_source requires url (the URL returned by next_source).');
    }

    try {
        const markedAt = scrapedAt ? new Date(scrapedAt) : new Date();
        const cf = typeof clientsFound === 'number' ? clientsFound : 0;
        const result = sourceStore.markSource(url, { clientsFound: cf, failedReason: failedReason || null });
        if (result.status === 'NOT_FOUND') {
            return createErrorResponse(id, -32602, `mark_source: no source with url "${url}".`);
        }

        // Log to session so report_session can distinguish "agent did nothing"
        // from "agent scraped but URLs yielded no clients".
        await logSessionEvent(sessionId, 'source_marked', {
            url,
            clientsFound: cf,
            failed: !!failedReason
        });

        return createSuccessResponse(id, JSON.stringify({
            marked: true,
            url,
            scrapedAt: markedAt.toISOString(),
            clientsFound: cf,
            failedReason: failedReason || null
        }));
    } catch (err) {
        return createErrorResponse(id, -32603, `mark_source failed: ${err.message}`);
    }
}

async function pipelineAddSources(id, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return createErrorResponse(id, -32602,
            'add_sources requires entries[] (non-empty array of {url, channel, subtype?, label?, category?, discoveredFrom?}).');
    }

    const results = { added: 0, duplicates: 0, invalid: [] };

    // Validate + verify per entry here (so we keep the per-entry invalid[] reasons
    // and URL verification), then hand the survivors to the store, which is the
    // sole writer to the markdown files and owns dedup.
    const verified = [];
    for (const e of entries) {
        if (!e || !e.url || !e.channel) {
            results.invalid.push({ entry: e, reason: 'missing url or channel' });
            continue;
        }
        if (!VALID_CHANNELS.has(e.channel)) {
            results.invalid.push({ entry: e, reason: `invalid channel "${e.channel}"` });
            continue;
        }
        const url = normalizeSourceUrl(e.url, e.channel);
        if (!url) {
            results.invalid.push({ entry: e, reason: 'url normalized to empty' });
            continue;
        }
        if (URL_VERIFY_CHANNELS.has(e.channel)) {
            const verification = await verifyEvidenceUrl(url);
            if (!verification.ok) {
                results.invalid.push({ entry: e, url, reason: `url_verification_failed:${verification.reason}` });
                continue;
            }
        }
        verified.push({
            url,
            channel: e.channel,
            subtype: e.subtype || inferSubtype(e.url, e.channel),
            label: e.label || null,
            category: e.category || null
        });
    }

    try {
        const stored = sourceStore.addSources(verified);
        results.added += stored.added;
        results.duplicates += stored.duplicates;
        // stored.invalid should be 0 (entries were pre-validated); fold defensively.
        if (stored.invalid) results.invalid.push({ reason: `store_rejected:${stored.invalid}` });
    } catch (err) {
        return createErrorResponse(id, -32603, `add_sources failed: ${err.message}`);
    }

    return createSuccessResponse(id, JSON.stringify(results));
}

async function pipelineImportSources(id) {
    // DEPRECATED. Markdown is now the runtime source of truth: the store reads
    // every channel file at startup, so there is no separate "import" step. Kept
    // as a shim that re-reads the files and returns the live counts, so any
    // caller still wired to import_sources keeps working instead of erroring.
    const counts = sourceStore.load();
    return createSuccessResponse(id, JSON.stringify({
        deprecated: true,
        note: 'Sources load from markdown at startup; import_sources just re-reads the files.',
        loaded: counts
    }, null, 2));
}

    return { isHttpUrl, pipelineNextSource, pipelineMarkSource, pipelineAddSources, pipelineImportSources };
}

module.exports = { createSourceQueue };
