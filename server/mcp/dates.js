// dates.js -- date / timezone / event-date resolution helpers, extracted from
// mcp_server.js (no prisma/config/logging deps -- pure functions). Text + structured
// date parsing, IANA timezone math, and the legacy + structured event-date resolvers.
'use strict';

const MONTHS = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sept: 9, sep: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12
};
const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function isStrictDateValue(value) {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value === 'number') return value > 1700000000000 && value < 2200000000000;
    const s = String(value || '').trim();
    if (!s) return false;
    if (/^\d{13}$/.test(s)) return true;
    return /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z)?)?$/.test(s);
}

function strictDateToDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number' || /^\d{13}$/.test(String(value || '').trim())) {
        return new Date(Number(value));
    }
    return new Date(String(value).trim());
}

function cleanDateText(text) {
    return String(text || '')
        .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function daysInMonthUtc(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validYmd(year, month, day) {
    return year >= 2024 && year <= 2035 &&
        month >= 1 && month <= 12 &&
        day >= 1 && day <= daysInMonthUtc(year, month);
}

function parseTimeToken(hourRaw, minRaw, meridiemRaw, fallbackMeridiem) {
    let hour = Number(hourRaw);
    const minute = minRaw === undefined || minRaw === '' ? 0 : Number(minRaw);
    const meridiem = (meridiemRaw || fallbackMeridiem || '').toLowerCase();
    if (hour < 1 || hour > 23 || minute < 0 || minute > 59) return null;
    if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
        if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
    }
    return { hour, minute };
}

function extractTimeRange(text) {
    const s = cleanDateText(text);
    const range = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|to|until|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (range) {
        const endMeridiem = range[6].replace(/\./g, '').toLowerCase();
        const startMeridiem = range[3] ? range[3].replace(/\./g, '').toLowerCase() : endMeridiem;
        const start = parseTimeToken(range[1], range[2], startMeridiem);
        const end = parseTimeToken(range[4], range[5], endMeridiem);
        if (start && end) return { start, end, evidence: range[0] };
    }

    const single = s.match(/\b(?:at|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (single) {
        const start = parseTimeToken(single[1], single[2], single[3].replace(/\./g, '').toLowerCase());
        if (start) return { start, end: null, evidence: single[0] };
    }

    return null;
}

function extractDateParts(text) {
    const s = cleanDateText(text);
    const yearMatch = s.match(/\b(20\d{2})\b/);
    if (!yearMatch) return { error: 'missing_year' };
    const year = Number(yearMatch[1]);

    let m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s*,?\\s*${year}\\b`, 'i'));
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        const startDay = Number(m[2]);
        const endDay = Number(m[3]);
        if (validYmd(year, month, startDay) && validYmd(year, month, endDay) && endDay >= startDay) {
            return { year, startMonth: month, startDay, endMonth: month, endDay, evidence: m[0] };
        }
    }

    m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*,?\\s*${year}\\s*-\\s*(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*,?\\s*${year}\\b`, 'i'));
    if (m) {
        const startMonth = MONTHS[m[1].toLowerCase()];
        const startDay = Number(m[2]);
        const endMonth = MONTHS[m[3].toLowerCase()];
        const endDay = Number(m[4]);
        if (validYmd(year, startMonth, startDay) && validYmd(year, endMonth, endDay)) {
            return { year, startMonth, startDay, endMonth, endDay, evidence: m[0] };
        }
    }

    m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*,?\\s*${year}\\b`, 'i'));
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        const day = Number(m[2]);
        if (validYmd(year, month, day)) {
            return { year, startMonth: month, startDay: day, endMonth: month, endDay: day, evidence: m[0] };
        }
    }

    m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
    if (m) {
        const month = Number(m[1]);
        const day = Number(m[2]);
        const numericYear = Number(m[3]);
        if (validYmd(numericYear, month, day)) {
            return { year: numericYear, startMonth: month, startDay: day, endMonth: month, endDay: day, evidence: m[0] };
        }
    }

    return { error: 'no_supported_date_pattern' };
}

function leedzWallClockEpoch(year, month, day, hour, minute) {
    return Date.UTC(year, month - 1, day, hour, minute, 0);
}

// Legacy text-only date resolver. Internal-only. Still used by
// normalizeBookingDatesForSave to keep older legacy save callers working.
// The MCP `resolve_dates` action no longer exposes this path -- see
// resolveEventDatesStructured below for the structured, tz-aware replacement.
async function resolveEventDatesLegacy(args = {}) {
    const text = cleanDateText(args.text || args.dateText || args.rawDate || '');
    if (!text) return { ok: false, errors: ['missing_text'] };

    const date = extractDateParts(text);
    if (date.error) return { ok: false, errors: [date.error] };

    let times = extractTimeRange(text);
    let timeDefaulted = false;
    if ((!times || !times.start) && args.defaultStartTime === true) {
        // Date-only event (the norm for expos/festivals/fairs): default the start
        // to 12:00 PM noon so the Booking can persist and become hot-eligible,
        // instead of being hard-rejected. The caller flags it for later refinement.
        times = { start: { hour: 12, minute: 0 }, end: (times && times.end) || null };
        timeDefaulted = true;
    }
    if (!times || !times.start) return { ok: false, errors: ['missing_start_time'] };

    // If we defaulted the start, also default a 2h duration when none was given,
    // so the same date-only event doesn't then fail on missing_end_time.
    const durationHours = args.defaultDurationHours === undefined
        ? (timeDefaulted ? 2 : null)
        : Number(args.defaultDurationHours);

    let endTime = times.end;
    let explicitDuration = false;
    if (!endTime && Number.isFinite(durationHours) && durationHours > 0 && durationHours <= 24) {
        explicitDuration = true;
    } else if (!endTime) {
        return { ok: false, errors: ['missing_end_time_or_defaultDurationHours'] };
    }

    const st = leedzWallClockEpoch(date.year, date.startMonth, date.startDay, times.start.hour, times.start.minute);
    let et = endTime
        ? leedzWallClockEpoch(date.year, date.endMonth, date.endDay, endTime.hour, endTime.minute)
        : st + Math.round(durationHours * 60 * 60 * 1000);
    if (et <= st && endTime && date.startDay === date.endDay && date.startMonth === date.endMonth) {
        et = leedzWallClockEpoch(date.year, date.endMonth, date.endDay + 1, endTime.hour, endTime.minute);
    }
    if (et <= st) return { ok: false, errors: ['end_not_after_start'] };
    if (st < Date.now()) return { ok: false, errors: ['start_in_past'] };

    const resolved = {
        ok: true,
        timeDefaulted,
        st,
        et,
        startIso: new Date(st).toISOString(),
        endIso: new Date(et).toISOString(),
        display: `${new Date(st).toISOString()} to ${new Date(et).toISOString()}`,
        year: date.year,
        startMonth: date.startMonth,
        startDay: date.startDay,
        endMonth: date.endMonth,
        endDay: date.endDay,
        evidence: {
            date: date.evidence,
            time: times.evidence,
            explicitDuration
        }
    };

    return resolved;
}

// ============================================================================
// STRUCTURED DATE RESOLUTION (Phase 5)
// ============================================================================
// LLMs hand-computing st/et caused production bugs. The contract for the
// MCP `resolve_dates` action is now structured-only: the caller passes
// year/month/day/hour/minute/ampm for both start and end, plus an explicit
// IANA timezone (or, in the future, a zip-to-tz map). The server computes
// the offset for that wall-clock instant in that zone via Intl.DateTimeFormat
// and returns canonical epoch ms.
// No text parsing. No timezone smuggled in rawText. No epoch math by the LLM.
// ============================================================================

// IANA tz validation via Intl. Returns true iff Node accepts the zone.
function isValidIanaTimezone(tz) {
    if (typeof tz !== 'string' || !tz.trim()) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (_) {
        return false;
    }
}

// Deterministic US ZIP -> IANA timezone resolver.
// Used by share_booking to derive the marketplace event timezone from
// Booking.zip at leed creation time. There is no user-configurable timezone.
//
// Coverage is by 3-digit ZIP prefix range. Boundaries are approximate at zone
// edges (parts of FL panhandle, TN/KY/IN/MI splits, west TX, OR/ID border)
// because zone lines do not follow ZIP3 ranges cleanly. The dominant zone for
// each range wins. Returns an IANA name on a confident hit, null otherwise --
// share_booking then refuses to post with error:"unresolved_location_timezone".
function zipToTimezone(zip) {
    if (zip == null) return null;
    const z = String(zip).trim().slice(0, 5);
    if (!/^\d{5}$/.test(z)) return null;
    const n = parseInt(z.slice(0, 3), 10);

    // Pacific
    if (n >= 900 && n <= 961) return 'America/Los_Angeles';     // CA
    if (n >= 970 && n <= 979) return 'America/Los_Angeles';     // OR
    if (n >= 980 && n <= 994) return 'America/Los_Angeles';     // WA
    if (n >= 889 && n <= 898) return 'America/Los_Angeles';     // NV (Pacific)
    // Alaska + Hawaii
    if (n >= 967 && n <= 968) return 'Pacific/Honolulu';        // HI (no DST)
    if (n >= 995 && n <= 999) return 'America/Anchorage';       // AK

    // Mountain
    if (n >= 800 && n <= 831) return 'America/Denver';          // CO / WY
    if (n >= 832 && n <= 838) return 'America/Denver';          // ID (most)
    if (n >= 840 && n <= 847) return 'America/Denver';          // UT
    if (n >= 850 && n <= 865) return 'America/Phoenix';         // AZ (no DST)
    if (n >= 870 && n <= 884) return 'America/Denver';          // NM
    if (n >= 590 && n <= 599) return 'America/Denver';          // MT

    // Central
    if (n >= 500 && n <= 528) return 'America/Chicago';         // IA
    if (n >= 530 && n <= 549) return 'America/Chicago';         // WI
    if (n >= 550 && n <= 567) return 'America/Chicago';         // MN
    if (n >= 570 && n <= 577) return 'America/Chicago';         // SD
    if (n >= 580 && n <= 588) return 'America/Chicago';         // ND
    if (n >= 600 && n <= 629) return 'America/Chicago';         // IL
    if (n >= 630 && n <= 658) return 'America/Chicago';         // MO
    if (n >= 660 && n <= 679) return 'America/Chicago';         // KS
    if (n >= 680 && n <= 693) return 'America/Chicago';         // NE
    if (n >= 700 && n <= 714) return 'America/Chicago';         // LA
    if (n >= 716 && n <= 729) return 'America/Chicago';         // AR
    if (n >= 730 && n <= 749) return 'America/Chicago';         // OK
    if (n >= 750 && n <= 799) return 'America/Chicago';         // TX (most; western edge actually Mountain)
    if (n >= 350 && n <= 369) return 'America/Chicago';         // AL
    if (n >= 386 && n <= 397) return 'America/Chicago';         // MS
    if (n >= 370 && n <= 385) return 'America/Chicago';         // TN (most are Central)

    // Eastern
    if (n >= 1   && n <= 199) return 'America/New_York';        // Northeast (MA/NH/RI/CT/VT/ME/NY/NJ/PA/PR)
    if (n >= 200 && n <= 268) return 'America/New_York';        // DC/MD/VA/WV
    if (n >= 270 && n <= 289) return 'America/New_York';        // NC
    if (n >= 290 && n <= 299) return 'America/New_York';        // SC
    if (n >= 300 && n <= 319) return 'America/New_York';        // GA
    if (n >= 320 && n <= 349) return 'America/New_York';        // FL (most; western Panhandle is Central — minority)
    if (n >= 400 && n <= 427) return 'America/New_York';        // KY (most)
    if (n >= 430 && n <= 459) return 'America/New_York';        // OH
    if (n >= 460 && n <= 479) return 'America/Indiana/Indianapolis'; // IN (most observe Eastern)
    if (n >= 480 && n <= 499) return 'America/Detroit';         // MI

    return null;
}

// Compute the timezone offset (in minutes east of UTC) that applies to the
// given UTC instant in the given IANA zone. Used iteratively to convert a
// wall-clock-in-zone to a UTC epoch (handles DST). Algorithm:
//   1. Treat (year,month,day,hour,minute) as if it were UTC -> guess epoch.
//   2. Format that epoch in the target zone and read the offset.
//   3. Subtract offset to get the true UTC epoch for the wall clock.
function tzOffsetMinutes(utcEpochMs, timeZone) {
    // Use the en-US 'longOffset' formatter to read the offset string (e.g.
    // "GMT-07:00") that applies in the zone at that instant.
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'longOffset',
        hour: 'numeric'
    });
    const parts = fmt.formatToParts(new Date(utcEpochMs));
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (!tzPart) return 0;
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzPart.value);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const h = parseInt(m[2], 10);
    const mn = parseInt(m[3] || '0', 10);
    return sign * (h * 60 + mn);
}

// Convert a wall-clock-in-zone to a UTC epoch ms. DST-safe via two passes:
// the first pass guesses with the UTC offset of the naive timestamp; the
// second pass corrects using the offset that actually applies at the guessed
// instant. One re-correction is enough for any IANA zone.
function wallClockInZoneToEpoch(year, month, day, hour, minute, timeZone) {
    const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
    const off1 = tzOffsetMinutes(naive, timeZone);
    const guess = naive - off1 * 60 * 1000;
    const off2 = tzOffsetMinutes(guess, timeZone);
    return naive - off2 * 60 * 1000;
}

// Render an ISO-8601 string with the supplied zone's offset, e.g.
// "2026-06-10T21:30:00-07:00". The wall-clock fields are echoed verbatim.
function formatIsoWithZone(year, month, day, hour, minute, timeZone, epochMs) {
    const off = tzOffsetMinutes(epochMs, timeZone);
    const sign = off >= 0 ? '+' : '-';
    const absOff = Math.abs(off);
    const oh = Math.floor(absOff / 60);
    const om = absOff % 60;
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:00${sign}${pad(oh, 2)}:${pad(om, 2)}`;
}

// Validate one structured date piece. Returns { ok, hour24, errors[] } where
// hour24 is the canonical 0-23 hour computed from hour + optional ampm.
function validateDatePart(label, part) {
    const errors = [];
    if (!part || typeof part !== 'object') {
        errors.push(`${label}:missing`);
        return { ok: false, errors };
    }
    const { year, month, day, hour, minute, ampm } = part;
    if (!Number.isInteger(year) || year < 1970 || year > 9999) errors.push(`${label}.year:invalid`);
    if (!Number.isInteger(month) || month < 1 || month > 12) errors.push(`${label}.month:invalid`);
    if (!Number.isInteger(day) || day < 1 || day > 31) errors.push(`${label}.day:invalid`);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) errors.push(`${label}.minute:invalid`);

    let hour24 = null;
    if (ampm === undefined || ampm === null || ampm === '') {
        // 24-hour mode: hour must be 0..23
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push(`${label}.hour:invalid`);
        else hour24 = hour;
    } else {
        const ap = String(ampm).trim().toUpperCase();
        if (ap !== 'AM' && ap !== 'PM') {
            errors.push(`${label}.ampm:invalid`);
        } else if (!Number.isInteger(hour) || hour < 1 || hour > 12) {
            errors.push(`${label}.hour:invalid_for_ampm`);
        } else {
            hour24 = (hour % 12) + (ap === 'PM' ? 12 : 0);
        }
    }

    // Calendar validity: day-in-month using Date round-trip.
    if (errors.length === 0) {
        const d = new Date(Date.UTC(year, month - 1, day));
        if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
            errors.push(`${label}.day:not_in_month`);
        }
    }

    return { ok: errors.length === 0, errors, hour24 };
}

// New structured resolver. Used by MCP action `resolve_dates` and by
// share_booking when assembling the marketplace payload.
async function resolveEventDates(args = {}) {
    const warnings = [];
    const errors = [];

    // 1. Reject anything that smuggles timezone in rawText only.
    let timezone = typeof args.timezone === 'string' ? args.timezone.trim() : '';
    const zip = typeof args.zip === 'string' ? args.zip.trim() : '';
    if (!timezone) {
        // Zip-to-tz lookup is not supported in this phase. The spec explicitly
        // forbids inventing a zip-to-tz DB.
        if (zip) {
            errors.push('timezone:missing_zip_only_derivation_unsupported');
        } else {
            errors.push('timezone:missing');
        }
    } else if (!isValidIanaTimezone(timezone)) {
        errors.push('timezone:not_iana');
    }

    // 2. Validate structured start/end. rawText is informational only.
    const startV = validateDatePart('start', args.start);
    const endV   = validateDatePart('end',   args.end);
    errors.push(...startV.errors, ...endV.errors);

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    // 3. Compute epoch ms using IANA-zone wall-clock conversion.
    const startEpoch = wallClockInZoneToEpoch(
        args.start.year, args.start.month, args.start.day,
        startV.hour24, args.start.minute, timezone
    );
    const endEpoch = wallClockInZoneToEpoch(
        args.end.year, args.end.month, args.end.day,
        endV.hour24, args.end.minute, timezone
    );

    // 4. Overnight rule: end<=start with a different day field is accepted
    // as overnight; same-day end<=start is rejected.
    if (endEpoch <= startEpoch) {
        const sameDay = args.start.year === args.end.year &&
                        args.start.month === args.end.month &&
                        args.start.day === args.end.day;
        if (sameDay) {
            return { ok: false, errors: ['end:not_after_start_same_day'] };
        }
        warnings.push('overnight_end_before_start');
        // The structured `day` already encodes the next-day intent; if epochs
        // still invert, the caller's day is wrong.
        return { ok: false, errors: ['end:not_after_start_different_day'] };
    }

    return {
        ok: true,
        st: startEpoch,
        et: endEpoch,
        startIso: formatIsoWithZone(args.start.year, args.start.month, args.start.day, startV.hour24, args.start.minute, timezone, startEpoch),
        endIso:   formatIsoWithZone(args.end.year,   args.end.month,   args.end.day,   endV.hour24,   args.end.minute,   timezone, endEpoch),
        timezone,
        zip: zip || null,
        warnings,
        sourceProof: args.sourceProof || null
    };
}


// Normalize/validate every booking's dates on a save patch, IN PLACE. For each
// booking: resolve raw source date text to ISO via resolveEventDatesLegacy (date-
// only events default to 12:00 PM noon, flagged in notes), or validate any caller-
// supplied startDate/endDate as strict ISO/epoch, derive endDate from duration,
// and check end>start. Returns an array of failure descriptors (empty = all clean).
// Pure: orchestrates this module's own primitives, no session/DB/IO of its own.
// The caller owns audit logging of the returned failures.
async function normalizeBookingDatesForSave(patch) {
    if (!Array.isArray(patch.bookings)) return [];
    const failures = [];

    for (const b of patch.bookings) {
        const rawDateText = b.dateText || b.rawDate || b.eventDateText || b.eventDatePlaintext ||
            (!isStrictDateValue(b.startDate) ? b.startDate : null);

        if (rawDateText) {
            const sourceUrl = b.sourceUrl || patch.sourceUrl || patch.url || null;
            if (!sourceUrl) {
                failures.push({ kind: 'booking_date', title: b.title || null, dateText: rawDateText, reason: 'missing_sourceUrl_for_date_resolution' });
                continue;
            }
            const resolved = await resolveEventDatesLegacy({
                text: [rawDateText, b.startTime, b.endTime].filter(Boolean).join(' '),
                sourceUrl,
                defaultDurationHours: b.defaultDurationHours ?? b.duration,
                defaultStartTime: true   // date-only events default to 12:00 PM noon (flagged below)
            });
            if (!resolved.ok) {
                failures.push({ kind: 'booking_date', title: b.title || null, dateText: rawDateText, sourceUrl, reason: resolved.errors.join(',') });
                continue;
            }
            b.startDate = resolved.startIso;
            b.endDate = resolved.endIso;
            if (!b.startTime) b.startTime = resolved.startIso.slice(11, 16);
            if (!b.endTime) b.endTime = resolved.endIso.slice(11, 16);
            if (b.duration === undefined) b.duration = Math.round((resolved.et - resolved.st) / 3600000 * 100) / 100;
            if (resolved.timeDefaulted) {
                // The source gave a date but no clock time; we used noon. Record it
                // on the Booking so enrichment can nail down the real start time.
                const note = '[start time defaulted to 12:00 PM noon — exact time unconfirmed; refine via enrichment]';
                b.notes = b.notes ? `${b.notes}\n${note}` : note;
            }
            continue;
        }

        if (b.startDate && !isStrictDateValue(b.startDate)) {
            failures.push({ kind: 'booking_date', title: b.title || null, dateText: String(b.startDate), reason: 'startDate_not_strict_iso_or_epoch' });
        }
        if (b.endDate && !isStrictDateValue(b.endDate)) {
            failures.push({ kind: 'booking_date', title: b.title || null, dateText: String(b.endDate), reason: 'endDate_not_strict_iso_or_epoch' });
        }
        if (b.startDate && !b.endDate && b.duration !== undefined && isStrictDateValue(b.startDate)) {
            const start = strictDateToDate(b.startDate).getTime();
            const durationHours = Number(b.duration);
            if (Number.isFinite(durationHours) && durationHours > 0 && durationHours <= 24) {
                b.endDate = new Date(start + Math.round(durationHours * 3600000)).toISOString();
            }
        }
        if (b.startDate && b.endDate && isStrictDateValue(b.startDate) && isStrictDateValue(b.endDate)) {
            const start = strictDateToDate(b.startDate).getTime();
            const end = strictDateToDate(b.endDate).getTime();
            if (end <= start) failures.push({ kind: 'booking_date', title: b.title || null, dateText: `${b.startDate}..${b.endDate}`, reason: 'end_not_after_start' });
        }
    }

    return failures;
}


module.exports = { isStrictDateValue, strictDateToDate, resolveEventDatesLegacy, zipToTimezone, wallClockInZoneToEpoch, formatIsoWithZone, resolveEventDates, normalizeBookingDatesForSave };
