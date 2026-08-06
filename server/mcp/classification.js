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

// ============================================================================
// TEXT-LEVEL OUT-OF-AREA GATE (2026-08-06). The zip gate below only fires when a
// booking HAS a parseable zip -- so "Fan Expo Chicago 2026" with location_with_zip
// still missing sailed past it, ranked near-hot (few missing fields!), and earned
// DRILL_DOWN workers whose job was literally to discover the zip code of a city
// the deployment will never serve. This gate reads what the TEXT already says:
// derive the ALLOWED STATES from serviceZipPrefixes (zip3 -> state, coarse static
// table), then scan title+location for "City, ST" state tokens, full state names,
// and unambiguous major metros. A booking whose text names ONLY out-of-area
// places goes cold before any drill or judge spend. Generic: a Chicago deployment
// with 606xx prefixes resolves IL as allowed and keeps its own events.
// ============================================================================
const ZIP3_STATE_RANGES = [
    ['AL',350,369],['AK',995,999],['AZ',850,865],['AR',716,729],['CA',900,961],
    ['CO',800,816],['CT',60,69],['DE',197,199],['DC',200,205],['FL',320,349],
    ['GA',300,319],['GA',398,399],['HI',967,968],['ID',832,838],['IL',600,629],
    ['IN',460,479],['IA',500,528],['KS',660,679],['KY',400,427],['LA',700,714],
    ['ME',39,49],['MD',206,219],['MA',10,27],['MI',480,499],['MN',550,567],
    ['MS',386,397],['MO',630,658],['MT',590,599],['NE',680,693],['NV',889,898],
    ['NH',30,38],['NJ',70,89],['NM',870,884],['NY',100,149],['NY',5,5],
    ['NC',270,289],['ND',580,588],['OH',430,459],['OK',730,749],['OR',970,979],
    ['PA',150,196],['RI',28,29],['SC',290,299],['SD',570,577],['TN',370,385],
    ['TX',750,799],['TX',885,885],['UT',840,847],['VT',50,59],['VA',201,201],
    ['VA',220,246],['WA',980,994],['WV',247,268],['WI',530,549],['WY',820,831]
];
// Full state names -> code. "washington" and "louisiana"'s ", LA" abbrev are
// EXCLUDED on purpose: "Washington Blvd" and "Los Angeles"/"LA" would misfire.
const STATE_NAME_CODES = {
    'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','colorado':'CO',
    'connecticut':'CT','delaware':'DE','florida':'FL','hawaii':'HI','idaho':'ID',
    'illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS','kentucky':'KY',
    'louisiana':'LA','maine':'ME','maryland':'MD','massachusetts':'MA','michigan':'MI',
    'minnesota':'MN','mississippi':'MS','missouri':'MO','montana':'MT','nebraska':'NE',
    'nevada':'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
    'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR',
    'pennsylvania':'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',
    'tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT','virginia':'VA',
    'washington dc':'DC','west virginia':'WV','wisconsin':'WI','wyoming':'WY','california':'CA'
};
// Unambiguous major metros only -- every name here exists in exactly one state a
// convention would plausibly be in. Deliberately EXCLUDES names California reuses
// (Ontario, Pasadena, Glendale, Long Beach, Richmond, Orange, Riverside...).
const OUT_CITY_STATE = {
    'chicago':'IL','denver':'CO','seattle':'WA','houston':'TX','dallas':'TX',
    'austin':'TX','san antonio':'TX','fort worth':'TX','phoenix':'AZ','tucson':'AZ',
    'albuquerque':'NM','las vegas':'NV','reno':'NV','salt lake city':'UT','boise':'ID',
    'miami':'FL','orlando':'FL','tampa':'FL','jacksonville':'FL','atlanta':'GA',
    'nashville':'TN','memphis':'TN','new orleans':'LA','boston':'MA','philadelphia':'PA',
    'pittsburgh':'PA','baltimore':'MD','detroit':'MI','cleveland':'OH','cincinnati':'OH',
    'indianapolis':'IN','milwaukee':'WI','minneapolis':'MN','st. louis':'MO',
    'kansas city':'MO','oklahoma city':'OK','tulsa':'OK','charlotte':'NC','raleigh':'NC',
    'brooklyn':'NY','manhattan':'NY','honolulu':'HI','anchorage':'AK','denton':'TX'
};
const STATE_ABBREV_SET = new Set(ZIP3_STATE_RANGES.map(r => r[0]));

function statesForZipPrefixes(prefixes) {
    const out = new Set();
    for (const p of prefixes || []) {
        const n = parseInt(String(p), 10);
        if (!Number.isFinite(n)) continue;
        for (const [st, lo, hi] of ZIP3_STATE_RANGES) if (n >= lo && n <= hi) out.add(st);
    }
    return out;
}

// States the text names: "City, ST" comma-abbrevs (", LA" ignored -- see above),
// full state names, and major-metro names. Empty array = text is silent on place.
function detectTextStates(text) {
    const found = new Set();
    const t = String(text || '');
    const lower = t.toLowerCase();
    let m;
    const abbrevRe = /,\s*([A-Z]{2})\b/g;
    while ((m = abbrevRe.exec(t)) !== null) {
        if (m[1] !== 'LA' && STATE_ABBREV_SET.has(m[1])) found.add(m[1]);
    }
    for (const [name, code] of Object.entries(STATE_NAME_CODES)) {
        if (new RegExp(`\\b${name.replace('.', '\\.')}\\b`, 'i').test(lower)) found.add(code);
    }
    for (const [city, code] of Object.entries(OUT_CITY_STATE)) {
        if (new RegExp(`\\b${city.replace('.', '\\.')}\\b`, 'i').test(lower)) found.add(code);
    }
    return Array.from(found);
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
    // BANNED TERMS (retro-enforcement, 2026-07-14): save-time blocking only stops NEW
    // rows -- grandfathered rows (and organizer variants like "Comikaze" that dodge the
    // name match) kept re-entering brewing on every re-judge sweep. A banned category is
    // COLD FOREVER, enforced at the one choke point every judge path flows through.
    if (Array.isArray(o.bannedTerms) && o.bannedTerms.length) {
        const hay = (`${(client && client.name) || ''} ${(client && client.company) || ''} ` +
            `${(booking && booking.title) || ''} ${(booking && booking.description) || ''} ` +
            `${(booking && booking.location) || ''}`).toLowerCase();
        for (const t of o.bannedTerms) {
            const needle = String(t || '').trim().toLowerCase();
            if (needle && hay.includes(needle)) return cold('banned_term');
        }
    }
    // SERVICE AREA (zip-prefix gate, 2026-07-16): VALUE_PROP's geography was prose-only
    // -- the classifier checked that a zip EXISTS (location_with_zip) but never its
    // VALUE, so Atlanta/Chicago/NY bookings sailed to brewing/hot while the deployment
    // serves one metro. opts.serviceZipPrefixes (parsed from VALUE_PROP SERVICE AREA
    // DETAILS: "900xx" entries + prefixes of listed 5-digit zips) is the enforceable
    // form: a booking with a US zip OUTSIDE every prefix is out of the service area --
    // COLD FOREVER, same retro-enforcement choke point as banned terms. Bookings with
    // no/invalid zip are NOT judged here (they can never go hot anyway -- the
    // location_with_zip prerequisite holds them at brewing). Empty prefix list = gate off.
    if (Array.isArray(o.serviceZipPrefixes) && o.serviceZipPrefixes.length && booking) {
        const zm = String(booking.zip || '').trim().match(/^(\d{3})\d{2}/);
        if (zm && !o.serviceZipPrefixes.includes(zm[1])) return cold('out_of_area');
        // TEXT gate (2026-08-06): NO parseable zip -- the case the zip gate skips and
        // exactly where drills were being spent finding zips for Chicago/Denver events.
        // If the title/location names a state or major metro and NONE of them fall in
        // an allowed state (derived from the zip prefixes), the booking is out of area
        // NOW; do not wait for a drill to prove it. Text silent on place -> no verdict.
        if (!zm) {
            const allowed = statesForZipPrefixes(o.serviceZipPrefixes);
            if (allowed.size) {
                const named = detectTextStates(`${booking.title || ''} ${booking.location || ''}`);
                if (named.length && !named.some(s => allowed.has(s))) return cold('out_of_area_text');
            }
        }
    }

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

// ============================================================================
// EVENT-CLASS DETECTOR -- direct | container
// ============================================================================
// Orthogonal to classify(): classify() asks "is this booking's CONTACT/FIELD set
// complete enough to be hot?"; this asks "is this a single prospect or a crowd?".
//   - direct    -> a single private host hires us for THEIR event (wedding, birthday,
//                  company party, gala). The booking IS the opportunity. Existing flow.
//   - container -> a PUBLIC / multi-vendor / competitive event (convention, expo, trade
//                  show, festival, fair, tournament, championship, comic-con, marathon).
//                  The opportunity is the ORGANIZER, the VENDORS/EXHIBITORS, and/or the
//                  crowd -- NOT the event's subject. We don't care about taekwondo any
//                  more than nursing at an AMA expo; what matters is that vendors/booths/
//                  a crowd exist. Routed to DRILL_CONTAINER, which then judges VALUE_PROP
//                  FIT (via VALUE_PROP's RELEVANCE SIGNALS) before working it.
// This is a deliberately GENEROUS structural pre-filter, NOT a fit judgment: any public
// gathering is a container CANDIDATE; the worker's LLM fit gate does the real filtering
// (a roofing expo and a comic con are both containers here -- the worker decides which is
// worth pursuing, and which vendors within). Over-inclusion is cheap (worker bails on
// no-fit); under-inclusion loses leads. Pure + deterministic (no DB, no LLM), matched on
// lowercased title+description+location. No persisted field -- recomputed on the fly, no
// migration. NOTE: a convention-center VENUE is a valid container signal now -- a
// championship at a convention center has the same vendors/crowd a trade show does, so we
// do NOT strip the venue name (the event TYPE never mattered, only that it gathers a crowd).

// Substring phrases (multi-word) + whole-word tokens (single words, matched on word
// boundaries so "con" never matches "control"). Together they cover trade-shows, expos,
// conferences, festivals, fairs, and competitive/public gatherings.
const CONTAINER_PHRASES = [
    'trade show', 'comic con', 'fan expo', 'fan fest', 'auto show', 'boat show',
    'home show', 'gift show', 'business expo', 'job fair', 'career fair',
    'exhibit hall', 'exhibitor hall', 'street fair', 'block party', 'food fest',
    'food festival', 'night market', 'art walk', 'county fair', 'state fair',
    'craft fair', 'farmers market', 'music festival', 'film festival',
    'arts festival', 'world cup', 'grand prix'
];
const CONTAINER_WORDS = [
    // trade-show / convention family
    'expo', 'convention', 'exhibitor', 'exhibitors', 'exhibition', 'booth', 'booths',
    'fairplex', 'conference', 'symposium', 'tradeshow', 'congress', 'convocation',
    // festival / fair family
    'festival', 'carnival', 'parade', 'fest', 'fiesta', 'powwow', 'jubilee', 'fair',
    // competitive / public-gathering family
    'tournament', 'championship', 'championships', 'invitational', 'classic', 'cup',
    'marathon', 'regatta', 'games', 'rally', 'showcase'
];

function _hasWord(text, word) {
    return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

// PRIVATE life-cycle celebrations -- a single host hiring a vendor for THEIR OWN
// once-in-a-lifetime (or once-a-year) event. This is the system's IDEAL client class
// for ANY vendor selling ANY service: a private one-to-one booking beats standing up
// a booth at someone else's event no matter what you sell, so 'private' outranks
// 'direct' outranks 'container' at every prioritization point (near-hot ranking,
// enrichment heat sort, presentation order). GENERIC by design: these are universal
// life events -- no deployment/VALUE_PROP-specific terms belong in these lists.
// Container detection runs FIRST, so "bridal expo" / "wedding expo" stay containers.
const PRIVATE_PHRASES = [
    'birthday party', 'wedding reception', 'baby shower', 'bridal shower',
    'engagement party', 'graduation party', 'grad party', 'grad night',
    'retirement party', 'sweet 16', 'sweet sixteen', 'gender reveal',
    'first communion', 'family reunion', 'class reunion', 'bachelor party',
    'bachelorette party', 'anniversary party', 'celebration of life',
    'quinceanera', 'quinceañera', 'quince años', 'quince anos', 'housewarming'
];
const PRIVATE_WORDS = [
    'wedding', 'birthday', 'mitzvah', 'bris', 'baptism', 'christening',
    'prom', 'homecoming'
];

/**
 * Classify a booking's event-class from its text.
 * Returns 'container' | 'private' | 'direct'.
 *   container -> public / multi-vendor / competitive event (worker judges fit)
 *   private   -> a single host's own life-cycle celebration (the IDEAL client)
 *   direct    -> any other single-prospect booking (corporate party, gala, ...)
 * Container wins on overlap ("bridal expo" is a container, not a wedding).
 * Empty/absent text -> 'direct' (never throws).
 *
 * @param {object} booking - Booking row (title, description, location)
 * @returns {'container'|'private'|'direct'}
 */
function classifyEventClass(booking) {
    if (!booking) return 'direct';
    const text = `${booking.title || ''} ${booking.description || ''} ${booking.location || ''}`
        .toLowerCase().replace(/\s+/g, ' ').trim();
    if (!text) return 'direct';
    const isContainer =
        CONTAINER_PHRASES.some(p => text.includes(p)) ||
        CONTAINER_WORDS.some(w => _hasWord(text, w));
    if (isContainer) return 'container';
    const isPrivate =
        PRIVATE_PHRASES.some(p => text.includes(p)) ||
        PRIVATE_WORDS.some(w => _hasWord(text, w));
    return isPrivate ? 'private' : 'direct';
}

// Pipeline priority rank for a booking, lower = worked first:
//   0 private              -- the ideal client, always first in line
//   1 direct               -- other single-prospect bookings
//   2 container-minted     -- vendor leads a container drill expanded (once-removed
//                             directs; they inherit the container's title so the
//                             class check alone would mis-rank them 3)
//   3 container            -- the raw multi-vendor event itself
// Shared by near-hot ranking (factletMatch), the enrichment heat sort (planner
// Stage 5), and anything else that must order bookings by desirability.
function eventClassRank(booking) {
    if (booking && typeof booking.source === 'string' && booking.source.startsWith('container:')) return 2;
    const cls = classifyEventClass(booking);
    return cls === 'private' ? 0 : (cls === 'container' ? 3 : 1);
}

module.exports = { classify, isGenericEmail, isOrgName, classifyEventClass, eventClassRank };
