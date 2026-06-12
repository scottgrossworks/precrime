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
    'events', 'bookings', 'team', 'mail', 'help', 'noreply'
];

function isGenericEmail(email, prefixes) {
    if (!email) return false;
    const set = new Set((prefixes && prefixes.length ? prefixes : DEFAULT_GENERIC_PREFIXES));
    const prefix = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    return set.has(prefix);
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
 * @param {object} opts    - { factletCount, now, futureMinHours, genericEmailPrefixes }
 */
function classify(client, booking, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const futureMinHours = typeof o.futureMinHours === 'number' ? o.futureMinHours : 12;
    const factletCount = typeof o.factletCount === 'number' ? o.factletCount : 0;
    const prefixes = o.genericEmailPrefixes || [];

    // ---- COLD: nothing to judge ----
    // Acted upon -> recycle to cold (can warm again next cycle).
    if (booking && (booking.shared || booking.sharedAt || booking.leedId)) return cold('acted_on_shared');
    if (client && (client.draftStatus === 'sent' || client.sentAt)) return cold('acted_on_outreach');
    // Event already passed.
    if (booking && booking.startDate && new Date(booking.startDate).getTime() < now) return cold('event_passed');
    // No intelligence accumulated yet.
    if (factletCount <= 0) return cold('no_factlets');

    // ---- HOT PREREQUISITES (all required) -> otherwise BREWING ----
    const missing = [];

    if (!nonEmpty(client && client.name)) missing.push('client_name');
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
        if (!nonEmpty(booking.trade)) missing.push('trade');
        if (!nonEmpty(booking.title) && !nonEmpty(booking.description)) missing.push('title');
    }

    if (missing.length) return { state: 'brewing', missing };
    return { state: 'hot_eligible', missing: [] };
}

module.exports = { classify, isGenericEmail };
