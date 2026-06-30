// ============================================================================
// classification.js -- procedural cold / brewing / hot gates (DOCS/CLASSIFICATION.md)
// ============================================================================
// Pure, deterministic, no DB and no LLM. mcp_server.js passes in the loaded
// Client + Booking records plus a few knobs; this returns the procedural state.
//
//   cold        -> nothing to judge (new, no factlets, acted on, or event passed)
//   brewing     -> a real prospect, but a hot prerequisite is still missing
//   hot_eligible-> every hot prerequisite is met; the caller then runs the LLM
//                  promote-gate (judgeLeed). Only then can the booking become hot.
//
// The LLM never sees a leed that is not hot_eligible, so the cheap/easy cases
// never cost an LLM call. See DOCS/CLASSIFICATION.md for the canonical ladder.
// ============================================================================

const DEFAULT_GENERIC_PREFIXES = [
    'info', 'contact', 'hello', 'support', 'admin', 'office', 'sales',
    'events', 'bookings', 'team', 'mail', 'help', 'noreply',
    // event / vendor role inboxes -- never a real decision-maker
    'expo', 'vendor', 'vendors', 'exhibitor', 'exhibitors', 'exhibits',
    'booth', 'booths', 'registration', 'register', 'tickets', 'boxoffice',
    'sponsor', 'sponsors', 'partnerships', 'partner', 'concessions', 'hospitality'
];

// Tokens that mark a "name" as an organization / team / role rather than a real
// person. A hot leed MUST reach an actual decision-maker, so an org/team name
// (e.g. "VidCon Expo Team", "VidCon LLC", "Informa") holds at brewing.
const DEFAULT_ORG_NAME_TOKENS = [
    'team', 'teams', 'expo', 'llc', 'inc', 'ltd', 'corp', 'corporation',
    'group', 'committee', 'dept', 'department', 'company', 'foundation',
    'association', 'productions', 'production', 'events', 'event', 'festival',
    'convention', 'informa', 'holdings', 'enterprises', 'agency', 'council',
    'society', 'league', 'organization', 'organisation', 'staff', 'crew',
    'exhibits', 'exhibitor', 'exhibitors', 'sponsorship', 'sponsorships'
];

function isGenericEmail(email, prefixes) {
    if (!email) return false;
    const set = new Set((prefixes && prefixes.length ? prefixes : DEFAULT_GENERIC_PREFIXES));
    const prefix = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    return set.has(prefix);
}

// True when `name` looks like an organization / team / role rather than a person.
// Whole-word match (so "Cody" never matches "co"): the name is an org if ANY of
// its words is an org token.
function isOrgName(name, tokens) {
    if (!name) return false;
    const set = new Set((tokens && tokens.length ? tokens : DEFAULT_ORG_NAME_TOKENS).map(t => String(t).toLowerCase()));
    const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return words.some(w => set.has(w));
}

function nonEmpty(v) {
    return !!(v !== null && v !== undefined && String(v).trim());
}

function cold(reason) {
    return { state: 'cold', reason, missing: [] };
}

/**
 * Procedural classification. Returns { state, reason?, missing[] }.
 *   state: 'cold' | 'brewing' | 'hot_eligible'
 *   missing: list of unmet hot prerequisites (only meaningful for 'brewing')
 *
 * @param {object} client  - Client row (name, email, draftStatus, sentAt, ...)
 * @param {object} booking - Booking row (location, zip, startDate, startTime,
 *                           trade, title, description, shared, sharedAt, leedId)
 * @param {object} opts    - { now, futureMinHours, genericEmailPrefixes, orgNameTokens,
 *                            mode, defaultTrade }. mode is 'outreach' | 'marketplace';
 *                            defaultTrade is the VALUE_PROP trade used to INFER a missing
 *                            booking trade in outreach mode (see the trade gate below).
 */
function classify(client, booking, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const futureMinHours = typeof o.futureMinHours === 'number' ? o.futureMinHours : 12;
    const prefixes = o.genericEmailPrefixes || [];
    const orgTokens = o.orgNameTokens || [];
    const mode = o.mode || 'outreach';            // 'outreach' (lower bar) | 'marketplace' (strict)
    const defaultTrade = o.defaultTrade || '';    // VALUE_PROP trade, for outreach inference

    // ---- COLD: nothing to judge ----
    // Acted upon -> recycle to cold (can warm again next cycle).
    if (booking && (booking.shared || booking.sharedAt || booking.leedId)) return cold('acted_on_shared');
    if (client && (client.draftStatus === 'sent' || client.sentAt)) return cold('acted_on_outreach');
    // Event already passed.
    if (booking && booking.startDate && new Date(booking.startDate).getTime() < now) return cold('event_passed');

    // ---- HOT PREREQUISITES (all required) -> otherwise BREWING ----
    // MANDATORY authentic contact: a real PERSON (not an org/team/role) with a
    // direct (non-role) email. Product-market fit alone NEVER makes a leed hot --
    // a generic inbox (expo@, info@) or an org name ("VidCon Expo Team", "Informa")
    // holds at brewing so enrichment finds a real decision-maker first. Phone is
    // preferred but not required.
    const missing = [];

    const name = client && client.name ? String(client.name).trim() : '';
    if (!name) missing.push('client_name');
    else if (isOrgName(name, orgTokens)) missing.push('client_name_not_person');

    const email = client && client.email ? String(client.email).trim() : '';
    if (!email) missing.push('client_email');
    else if (isGenericEmail(email, prefixes)) missing.push('client_email_generic');

    if (!booking) {
        missing.push('booking');
    } else {
        if (!nonEmpty(booking.location) || !nonEmpty(booking.zip)) missing.push('location_with_zip');

        const st = booking.startDate ? new Date(booking.startDate).getTime() : null;
        if (!st) missing.push('start_date');
        else if (st < now + futureMinHours * 3600 * 1000) missing.push('start_date_not_future_enough');

        if (!nonEmpty(booking.startTime)) missing.push('start_time');
        // Trade gate is OBJECTIVE-AWARE. MARKETPLACE posting needs an EXPLICIT,
        // confirmed trade -- you cannot list a leed in the wrong category. But for
        // OUTREACH the trade can be INFERRED from VALUE_PROP (it's what the seller
        // sells); the client hasn't asked for it yet -- the outreach email is how you
        // find out. So in outreach mode a missing booking.trade is satisfied by the
        // inferable default and does NOT block. booking.trade stays empty, which the
        // marketplace share path separately refuses: outreach-ready, NOT marketplace-
        // ready, until the trade is confirmed (the reply / enrichment writes it).
        const tradeInferable = mode === 'outreach' && nonEmpty(defaultTrade);
        if (!nonEmpty(booking.trade) && !tradeInferable) missing.push('trade');
        if (!nonEmpty(booking.title) && !nonEmpty(booking.description)) missing.push('title');
    }

    // Decide on FIELDS + event timing ONLY -- no factlet dependency. A complete lead
    // is hot_eligible; an incomplete one is brewing (a real future event worth working
    // to fill the missing fields). How MUCH enrichment work to spawn is the planner's
    // job (per-type Task budgets), NOT the promotion classifier's. Mixing those two is
    // what produced the stale-factlet false-veto: a 60-day-old post un-promoting a
    // still-future lead. The filled fields ARE the intelligence; a future event does
    // not decay because the post that announced it aged out of the recency window.
    if (missing.length === 0) return { state: 'hot_eligible', missing: [] };
    return { state: 'brewing', missing };
}

module.exports = { classify, isGenericEmail, isOrgName };
