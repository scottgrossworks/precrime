// ============================================================================
// share.js -- the marketplace SHARE_BOOKING path (Phase 5).
//
// share_booking is the ONLY sanctioned way to push a Booking to the Leedz
// marketplace. The LLM is not allowed to supply st/et epochs. The MCP loads the
// Booking, rescores via the Judge, demands status==hot + a confirmed trade +
// contactGate + description + zip, converts the Booking's ALREADY-VERIFIED
// wall-clock dates to a tz-correct epoch (it does NOT re-resolve/re-verify),
// then either returns the payload (mode:"draft") or posts it (mode:"post").
//
// Extracted from mcp_server.js. Pulls prisma/responses/runtime/dates itself;
// two server-local deps are injected:
//   - judgeAffected         the in-process Judge (still in mcp_server / factlets.js)
//   - getValidObjectives()  thunk returning the VALID_OBJECTIVES Set (a const
//                           defined later in mcp_server than the wire-up point,
//                           so read lazily to avoid a module-load TDZ)
//
// Usage:
//   const { pipelineShareBooking } = require('./share').createShareHandlers({
//     judgeAffected, getValidObjectives: () => VALID_OBJECTIVES,
//   });
// ============================================================================

const { prisma } = require('./db');
const { createErrorResponse, createSuccessResponse } = require('./responses');
const { RUNTIME_CONFIG } = require('./runtime');
const { zipToTimezone, wallClockInZoneToEpoch, formatIsoWithZone } = require('./dates');

const LEEDZ_REMOTE_URL = 'https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/mcp';

const SHARE_DRAFT_LIMITS = { titleDraft: 120, dtDraft: 1000, rqDraft: 1000 };

function normalizeShareTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const m = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\b/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3] ? m[3].toUpperCase() : null;
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function validateShareDraftField(name, value, booking) {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (typeof value !== 'string') return { ok: false, reason: `${name}:must_be_string` };

    const text = value.trim().replace(/\s+/g, ' ');
    if (!text) return { ok: true, value: null };
    if (text.length > SHARE_DRAFT_LIMITS[name]) return { ok: false, reason: `${name}:too_long` };

    if (name === 'titleDraft' && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return { ok: false, reason: `${name}:contains_email` };
    if (name === 'titleDraft' && /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/.test(text)) return { ok: false, reason: `${name}:contains_phone` };
    if (/\b\d{10,13}\b/.test(text)) return { ok: false, reason: `${name}:contains_epoch_like_number` };
    if (/\b(cn|em|ph|st|et|zp|lc|tn|pr|sh)\s*[:=]/i.test(text)) return { ok: false, reason: `${name}:looks_like_payload_field` };

    const years = new Set([booking.startDate, booking.endDate]
        .filter(Boolean)
        .map(d => new Date(d).getFullYear()));
    const yearHits = text.match(/\b(?:19|20)\d{2}\b/g) || [];
    for (const y of yearHits) {
        if (!years.has(parseInt(y, 10))) return { ok: false, reason: `${name}:unsupported_year_${y}` };
    }

    const monthNames = [
        ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'],
        ['may'], ['june', 'jun'], ['july', 'jul'], ['august', 'aug'],
        ['september', 'sep', 'sept'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec']
    ];
    const allowedMonths = new Set([booking.startDate, booking.endDate]
        .filter(Boolean)
        .map(d => new Date(d).getMonth()));
    const lower = text.toLowerCase();
    for (let i = 0; i < monthNames.length; i++) {
        if (monthNames[i].some(m => new RegExp(`\\b${m}\\b`, 'i').test(lower)) && !allowedMonths.has(i)) {
            return { ok: false, reason: `${name}:unsupported_month_${monthNames[i][0]}` };
        }
    }

    const timeHits = text.match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b/g) || [];
    if (timeHits.length > 0) {
        const allowedTimes = new Set([normalizeShareTime(booking.startTime), normalizeShareTime(booking.endTime)].filter(Boolean));
        if (allowedTimes.size === 0) return { ok: false, reason: `${name}:time_claim_without_booking_time` };
        for (const t of timeHits) {
            if (!allowedTimes.has(normalizeShareTime(t))) return { ok: false, reason: `${name}:unsupported_time_${t}` };
        }
    }

    return { ok: true, value: text };
}

function validateShareDrafts(args, booking) {
    const out = {};
    const errors = [];
    for (const name of ['titleDraft', 'dtDraft', 'rqDraft']) {
        const result = validateShareDraftField(name, args[name], booking);
        if (!result.ok) errors.push(result.reason);
        else if (result.value) out[name] = result.value;
    }
    return { ok: errors.length === 0, errors, drafts: out };
}

function createShareHandlers(deps) {
    const { judgeAffected, getValidObjectives } = deps;

    // Look up the objective recorded on the most-recent active Session (falls back
    // to the most-recent finished Session within the last hour, so a freshly-closed
    // outreach run still blocks a stray share_booking call). Returns null if no
    // session has a recorded objective -- legacy / no-Planner callers stay
    // permissive so this gate is defense in depth, not a regression.
    async function getActiveSessionObjective() {
        try {
            const active = await prisma.session.findFirst({
                where:   { status: 'active' },
                orderBy: { startedAt: 'desc' }
            });
            const sess = active || await prisma.session.findFirst({
                where: {
                    status:     { in: ['complete', 'abandoned'] },
                    finishedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
                },
                orderBy: { finishedAt: 'desc' }
            });
            if (!sess || !sess.metadata) return null;
            let meta;
            try { meta = JSON.parse(sess.metadata); } catch (_) { return null; }
            const obj = meta && meta.objective;
            if (!obj || !getValidObjectives().has(obj)) return null;
            return obj;
        } catch (_) {
            return null;
        }
    }

    async function pipelineShareBooking(id, args) {
        // 1. Forbid LLM-supplied epochs by name.
        if (args.st !== undefined) {
            return createErrorResponse(id, -32602,
                'share_booking: forbidden input "st". The LLM is not allowed to supply marketplace epoch ms. ' +
                'Provide structured start/end fields and let MCP compute st/et.');
        }
        if (args.et !== undefined) {
            return createErrorResponse(id, -32602,
                'share_booking: forbidden input "et". The LLM is not allowed to supply marketplace epoch ms. ' +
                'Provide structured start/end fields and let MCP compute st/et.');
        }

        const bookingId = args.bookingId;
        const mode      = args.mode;
        if (!bookingId) return createErrorResponse(id, -32602, 'share_booking: bookingId required.');
        if (mode !== 'draft' && mode !== 'post') {
            return createErrorResponse(id, -32602, 'share_booking: mode must be "draft" or "post".');
        }

        // 1.5. Defense in depth -- if the active session's objective is 'outreach',
        // refuse marketplace posting even if a caller bypasses the Planner. The
        // Planner already declines to schedule SHARE_BOOKING under outreach; this
        // gate catches direct calls (manual test scripts, stale interactive flows,
        // a future skill that forgets the rule). Legacy sessions with no recorded
        // objective fall through (helper returns null).
        const activeObjective = await getActiveSessionObjective();
        if (activeObjective === 'outreach') {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'share_booking_under_outreach_objective',
                activeObjective,
                hint: 'Active session objective is "outreach"; marketplace posting is disabled. Re-run with --marketplace or --hybrid.'
            }, null, 2));
        }

        // 2. Load booking + client.
        const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
        if (!booking) {
            return createErrorResponse(id, -32602, `share_booking: bookingId not found: ${bookingId}`);
        }
        const client = await prisma.client.findUnique({ where: { id: booking.clientId } });
        if (!client) {
            return createErrorResponse(id, -32603, `share_booking: client not found for booking ${bookingId}`);
        }

        // 3. Rescore via the canonical Judge before publishing.
        const judged = await judgeAffected({
            clientIds:   [client.id],
            bookingIds:  [booking.id],
            reason:      'share_booking',
            writeStatus: true
        });
        const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });

        if (fresh.status !== 'hot') {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'booking_not_hot',
                currentStatus: fresh.status,
                judgedStatus: fresh.status,
                judgedChanged: judged.changed
            }, null, 2));
        }

        // 3b. share-ready gate: client must have a real named contact + direct
        // non-generic email. This is the contactGate flag set by computeClientScore.
        if (!client.contactGate) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'share_ready_gate_fail',
                missing: ['client.contactGate'],
                hint: 'Client must have a real named contact and a direct non-generic email before sharing. Enrich the Client and retry.'
            }, null, 2));
        }

        // 3c. Booking must have a description (the marketplace listing requires it).
        if (!fresh.description || !String(fresh.description).trim()) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'share_ready_gate_fail',
                missing: ['booking.description'],
                hint: 'Booking must have a description before sharing. Add a description and retry.'
            }, null, 2));
        }

        // 3c.5. Marketplace requires a CONFIRMED trade. Outreach can infer the trade from
        // VALUE_PROP, so an outreach-hot booking may carry an empty Booking.trade -- but a
        // leed cannot be listed without a real marketplace category. Refuse until the trade
        // is confirmed (the outreach reply / enrichment writes it). This is what makes a
        // trade-inferred booking outreach-ready but NOT marketplace-ready.
        if (!fresh.trade || !String(fresh.trade).trim()) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'share_ready_gate_fail',
                missing: ['booking.trade'],
                hint: 'Marketplace posting requires a confirmed trade. This booking was promoted for OUTREACH with an inferred trade; confirm the trade (via the outreach reply or enrichment) before sharing to the marketplace.'
            }, null, 2));
        }

        // 4. Derive timezone from Booking.zip. No user-supplied timezone path.
        //    Booking.zip is mandatory for marketplace sharing; if missing or unmappable
        //    we refuse to post with a clear non-posting response.
        const cfg = RUNTIME_CONFIG;
        if (!fresh.zip || !String(fresh.zip).trim()) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'share_ready_gate_fail',
                missing: ['booking.zip'],
                hint: 'Booking must carry a 5-digit US zip before sharing. Enrich the Booking with location data and retry.'
            }, null, 2));
        }
        const tz = zipToTimezone(fresh.zip);
        if (!tz) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'unresolved_location_timezone',
                zip: String(fresh.zip),
                hint: 'zipToTimezone() did not recognize this zip. Check the zip is a valid 5-digit US code. Non-US zips are not yet supported.'
            }, null, 2));
        }
        // The Booking already carries verified wall-clock dates (set + source-checked
        // at enrichment time via verify.js). Do NOT re-resolve or re-verify here -- just
        // convert the stored wall-clock to a tz-correct marketplace epoch using the same
        // DST-safe helper the resolver used. (Timezone derived from Booking.zip above.)
        if (!fresh.startDate || !fresh.endDate) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'missing_date_provenance',
                missing: [!fresh.startDate ? 'startDate' : null, !fresh.endDate ? 'endDate' : null].filter(Boolean),
                hint: 'Booking must carry startDate and endDate (set at enrichment) before sharing.'
            }, null, 2));
        }
        const _sD = new Date(fresh.startDate), _eD = new Date(fresh.endDate);
        const st = wallClockInZoneToEpoch(_sD.getUTCFullYear(), _sD.getUTCMonth() + 1, _sD.getUTCDate(), _sD.getUTCHours(), _sD.getUTCMinutes(), tz);
        const et = wallClockInZoneToEpoch(_eD.getUTCFullYear(), _eD.getUTCMonth() + 1, _eD.getUTCDate(), _eD.getUTCHours(), _eD.getUTCMinutes(), tz);

        const draftCheck = validateShareDrafts(args, fresh);
        if (!draftCheck.ok) {
            return createSuccessResponse(id, JSON.stringify({
                mode,
                posted: false,
                error: 'unsafe_share_draft',
                draftErrors: draftCheck.errors,
                hint: 'Only titleDraft, dtDraft, and rqDraft may contain LLM prose. Do not include emails/phones in titleDraft. Do not include payload fields, epochs, or unsupported date/time claims.'
            }, null, 2));
        }

        // 5. Build marketplace payload server-side from DB hard fields plus
        // validated share-skill prose drafts: tn, ti, lc, dt, rq, st, et, zp,
        // cn, em, ph, pr, sh.
        const payload = {
            tn: fresh.trade || '',
            ti: draftCheck.drafts.titleDraft || fresh.title || '',
            lc: fresh.location || '',
            dt: draftCheck.drafts.dtDraft || fresh.description || fresh.notes || '',
            rq: draftCheck.drafts.rqDraft || fresh.notes || '',
            st: st,
            et: et,
            zp: fresh.zip || '',
            cn: client.name || '',
            em: client.email || '',
            ph: client.phone || '',
            pr: 0,
            sh: '*'
        };

        const humanReadable = {
            startDisplay: formatIsoWithZone(_sD.getUTCFullYear(), _sD.getUTCMonth() + 1, _sD.getUTCDate(), _sD.getUTCHours(), _sD.getUTCMinutes(), tz, st),
            endDisplay:   formatIsoWithZone(_eD.getUTCFullYear(), _eD.getUTCMonth() + 1, _eD.getUTCDate(), _eD.getUTCHours(), _eD.getUTCMinutes(), tz, et),
            timezone:     tz
        };

        if (mode === 'draft') {
            return createSuccessResponse(id, JSON.stringify({
                mode: 'draft',
                bookingId:    fresh.id,
                clientId:     client.id,
                judgedStatus: fresh.status,
                payload,
                humanReadable
            }, null, 2));
        }

        // mode === 'post': actually call the Leedz marketplace endpoint.
        if (!cfg?.leedzSession) {
            return createSuccessResponse(id, JSON.stringify({
                mode: 'post',
                posted: false,
                error: 'leedz_not_configured',
                hint: 'Config.leedzSession is empty. Run configure to set it before sharing.'
            }, null, 2));
        }

        let leedzId = null;
        let postError = null;
        try {
            const envelope = {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'createLeed',
                    arguments: { ...payload, cr: 'theleedz.com@gmail.com', email: 'false', session: cfg.leedzSession }
                }
            };
            const res = await fetch(LEEDZ_REMOTE_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(envelope)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            const txt = body?.result?.content?.[0]?.text;
            try { leedzId = JSON.parse(txt)?.leedId || JSON.parse(txt)?.id || null; } catch (_) { leedzId = null; }
        } catch (e) {
            postError = String(e.message || e);
        }

        if (postError) {
            return createSuccessResponse(id, JSON.stringify({
                mode: 'post',
                posted: false,
                error: postError,
                payload,
                humanReadable
            }, null, 2));
        }

        await prisma.booking.update({
            where: { id: fresh.id },
            data: {
                shared:   true,
                sharedTo: 'leedz_api',
                sharedAt: BigInt(Date.now()),
                leedId:   leedzId,
                status:   'cold'
            }
        });

        return createSuccessResponse(id, JSON.stringify({
            mode: 'post',
            posted: true,
            leedzId,
            bookingId: fresh.id,
            clientId:  client.id,
            payload,
            humanReadable
        }, null, 2));
    }

    return { pipelineShareBooking, getActiveSessionObjective };
}

module.exports = { createShareHandlers };
