// ============================================================================
// factletMatch.js -- factlet->client candidate matching + near-hot ranking.
//
// The matching brain the planner leans on: which clients a factlet applies to
// (identity vs broad market-signal), near-hot booking ranking, and event-date
// detection. Requires db/classification/factlets/runtime by same names; the tiny
// safeJsonParse task-util is injected (its home is the task domain in mcp_server).
// ============================================================================

const { prisma } = require('./db');
const classification = require('./classification');
const { factletMentionsValueProp, collectValuePropDemandTerms, normalizeDemandText, VALUE_PROP_TOKEN_STOPWORDS, bookingActionToMode } = require('./factlets');
const { RUNTIME_CONFIG, SCORING, VALUE_PROP } = require('./runtime');

function createFactletMatch(deps) {
    const { safeJsonParse } = deps;

// Client.targetUrls carries the enrichment source-summary queue produced by the
// FIND_CLIENT_SOURCES worker: entries shaped { url, summary, consumed }. An
// entry with `consumed === false` is a pending source summary for ENRICH_CLIENT
// to fold into the dossier. Legacy targetUrls entries ({ url, type, label }) have
// no `consumed` property and are ignored here.
function parseClientSourceSummaries(targetUrls) {
    const arr = safeJsonParse(targetUrls);
    return Array.isArray(arr) ? arr : [];
}

// Server-side candidate-client filter for one Factlet. Mirrors (in reverse) the
// Returns client ids that should receive an APPLY_FACTLET task for this factlet.
// Path A: factlet names a specific client (identity match on name/company/website).
// Path B: factlet is about the VALUE_PROP trade AND the client's booking context
//         has topical overlap with the factlet's specific content.
//         Clients with no bookings are always included (uncharted, no context to check).
//         Clients with bookings are included only when >=2 factlet-specific tokens
//         (non-VALUE_PROP, non-stopword, length>=5) appear in their booking context.
//         If the factlet has no specific tokens (pure market signal), all clients qualify.
// Returns { ids, broad }. `broad` = a pure market-signal factlet that applies to ~every
// client (mentions the trade but nothing client-specific). The planner prunes ONLY broad
// dateless factlets to live clients; identity/profile-specific matches reach a client even
// when it is dead, which is how a relevant factlet RE-INVIGORATES a dormant client.
// The candidate-client load (id + identity fields + booking context). It is identical
// for every factlet in one planning pass, so the planner loads it ONCE and passes the
// array in via preloadedClients -- instead of this function re-loading the whole Client
// + Bookings table per factlet (the dominant APPLY_FACTLET planning cost). Standalone
// callers omit preloadedClients and get the self-load.
async function loadCandidateClients() {
    return prisma.client.findMany({
        select: {
            id: true,
            name: true,
            company: true,
            website: true,
            segment: true,
            clientNotes: true,
            dossier: true,
            lastEnriched: true,
            bookings: {
                select: { title: true, description: true, trade: true, location: true }
            }
        }
    });
}

async function candidateClientIdsForFactlet(factlet, preloadedClients) {
    if (!factlet) return { ids: [], broad: false };
    const hay = `${factlet.content || ''} ${factlet.source || ''}`.toLowerCase();
    if (!hay.trim()) return { ids: [], broad: false };

    const clients = preloadedClients || await loadCandidateClients();

    // Path A -- identity match: factlet literally names this client.
    const identityMatched = [];
    for (const c of clients) {
        const toks = [];
        const add = (s) => { const t = String(s || '').trim().toLowerCase(); if (t.length >= 4) toks.push(t); };
        add(c.name);
        add(c.company);
        if (c.website) {
            try { add(new URL(c.website).hostname.replace(/^www\./, '')); }
            catch { add(c.website); }
        }
        if (toks.some(t => hay.includes(t))) identityMatched.push(c);
    }
    if (identityMatched.length > 0) {
        return { ids: identityMatched.map(c => c.id), broad: false };
    }

    // Path B -- VALUE_PROP factlet: gate on whether factlet mentions the trade,
    // then filter per-client by topical overlap with their booking history.
    if (!factletMentionsValueProp(factlet, null, RUNTIME_CONFIG)) return { ids: [], broad: false };

    // Build the set of VALUE_PROP tokens so we can exclude them from the
    // specificity check -- those confirm the factlet is about the trade but
    // don't tell us WHICH clients it's relevant to.
    const vpTerms = collectValuePropDemandTerms(null, RUNTIME_CONFIG);
    const vpTokenSet = new Set([
        ...vpTerms.tokens,
        ...[...vpTerms.phrases].flatMap(p => p.split(/\s+/))
    ]);

    // Factlet-specific tokens: what the factlet is about BEYOND the trade.
    // These are the signals we use to match against client booking context.
    const factletNorm = normalizeDemandText(`${factlet.content} ${factlet.source}`);
    const specificTokens = factletNorm.split(/\s+/).filter(t =>
        t.length >= 5 && !vpTokenSet.has(t) && !VALUE_PROP_TOKEN_STOPWORDS.has(t)
    );

    const byLeastRecentlyEnriched = (a, b) =>
        (a.lastEnriched ? new Date(a.lastEnriched).getTime() : 0) -
        (b.lastEnriched ? new Date(b.lastEnriched).getTime() : 0);

    // No specific tokens: pure market-signal factlet, applies to every client. BROAD.
    if (specificTokens.length === 0) {
        return { ids: [...clients].sort(byLeastRecentlyEnriched).map(c => c.id), broad: true };
    }

    // Specific factlet: match each client on its PROFILE (who they are — segment, notes,
    // dossier, name/company) AND its booking history. Profile matching is what lets a
    // dormant, bookingless client be re-invigorated by a relevant factlet — e.g. "prom
    // season" matches a school-activities-coordinator client by its profile, not by a
    // booking it doesn't have. A client with no matchable text is skipped (not blanket
    // included), so a truly specific factlet stays specific instead of hitting everyone.
    const relevant = clients.filter(client => {
        const ctx = normalizeDemandText([
            client.name, client.company, client.segment, client.clientNotes, client.dossier,
            ...client.bookings.map(b => `${b.title || ''} ${b.description || ''} ${b.trade || ''} ${b.location || ''}`)
        ].filter(Boolean).join(' '));
        if (!ctx) return false;
        let hits = 0;
        for (const tok of specificTokens) {
            if (ctx.includes(tok)) hits++;
            if (hits >= 2) return true;
        }
        return false;
    });

    return { ids: relevant.sort(byLeastRecentlyEnriched).map(c => c.id), broad: false };
}

// Near-hot detection for the active drill-down stage. For each LIVE booking
// (future-dated, not yet shared), compute the hot prerequisites it is still
// missing via classify(). "near-hot" reflects the real FIELD gaps -- a dated
// booking is its own demand signal, independent of accumulated factlets. Returns
// bookings ranked by closeness (fewest missing) then urgency (soonest event);
// hot_eligible bookings (nothing missing) are excluded.
async function computeNearHotBookings() {
    const now = Date.now();
    const futureMinHours = (SCORING.classification && SCORING.classification.futureMinHours) ?? 12;
    const opts = {
        futureMinHours,
        mode: bookingActionToMode(RUNTIME_CONFIG && RUNTIME_CONFIG.defaultBookingAction),
        defaultTrade: (VALUE_PROP && VALUE_PROP.trade) || (RUNTIME_CONFIG && RUNTIME_CONFIG.defaultTrade) || '',
        genericEmailPrefixes: (SCORING.booking && SCORING.booking.genericEmailPrefixes) || [],
        orgNameTokens: (SCORING.classification && SCORING.classification.orgNameTokens) || []
    };
    const bookings = await prisma.booking.findMany({
        where: {
            status: { in: ['cold', 'brewing'] },
            startDate: { gt: new Date() },
            shared: false
        },
        include: { client: true }
    });
    const ranked = [];
    for (const b of bookings) {
        let proc;
        try { proc = classification.classify(b.client, b, opts); } catch (_) { continue; }
        const missing = (proc && proc.missing) || [];
        if (proc && proc.state === 'hot_eligible') continue; // nothing missing
        if (!missing.length) continue;
        const daysToEvent = Math.max(0, Math.round((new Date(b.startDate).getTime() - now) / 86400000));
        ranked.push({
            bookingId: b.id, clientId: b.clientId,
            missing, missingCount: missing.length,
            startDate: b.startDate, daysToEvent
        });
    }
    // Closeness first (fewest missing), then urgency (soonest event).
    ranked.sort((a, b) => (a.missingCount - b.missingCount) || (a.daysToEvent - b.daysToEvent));
    return ranked;
}

// A factlet "carries booking info" when its text has a concrete date signal (year,
// month+day, or numeric date). Such a factlet can attach/justify a FUTURE booking,
// so the pruning below lets it reach clients that aren't live yet. A dateless tidbit
// does not — it only enriches clients that already have a future booking.
function factletHasEventSignal(factlet) {
    const t = `${(factlet && factlet.content) || ''} ${(factlet && factlet.source) || ''}`.toLowerCase();
    if (!t.trim()) return false;
    return /\b20\d{2}\b/.test(t)                                                              // a year
        || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/.test(t) // month + day
        || /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(t);                                        // 6/26 or 6/26/2026
}

    return { parseClientSourceSummaries, candidateClientIdsForFactlet, computeNearHotBookings, factletHasEventSignal, loadCandidateClients };
}

module.exports = { createFactletMatch };
