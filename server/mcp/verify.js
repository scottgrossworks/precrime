// verify.js -- procedural anti-hallucination checks. Pure: no DB, no LLM, no I/O.
//
// The factlet-apply worker (LLM) proposes structured facts it read in a factlet
// -- a direct email, a phone, a zip, an event date. Before the server writes any
// of those to a Client/Booking, these functions confirm the value actually
// appears in the factlet's SOURCE TEXT. Anything not verbatim-verifiable is
// dropped, so the worker cannot fabricate contact/date data to force a hot leed.
// This is the design-mandate "LLM proposes, procedural code verifies" gate, run
// at enrichment time (when we still hold the source material) -- not at share.

const norm   = (s) => String(s == null ? '' : s).toLowerCase();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const wordRe = (v) => new RegExp('(^|\\D)' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\D|$)');

// Email: the exact address appears in the text (case-insensitive).
function verifyEmail(value, text) {
    const v = norm(value).trim();
    return !!v && v.includes('@') && norm(text).includes(v);
}

// Phone: the value's last 7-10 digits appear as a contiguous run in the text's
// digit stream (tolerates formatting / country-code differences).
function verifyPhone(value, text) {
    const d = digits(value);
    if (d.length < 7) return false;
    const needle = d.length >= 10 ? d.slice(-10) : d;
    return digits(text).includes(needle);
}

// Zip: the 5-digit zip appears in the text as its own number.
function verifyZip(value, text) {
    const z = digits(value).slice(0, 5);
    return z.length === 5 && wordRe(z).test(String(text || ''));
}

// Date: the day number AND the month (name or number) both appear in the text.
// Lenient on format, strict enough to reject a fabricated date. parts = {month,day}.
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function verifyDateParts(parts, text) {
    if (!parts || !parts.day || !parts.month) return false;
    const t = norm(text);
    const mName = MONTHS[Number(parts.month) - 1] || '\0';
    const dayOk = wordRe(String(parts.day)).test(t);
    const monOk = t.includes(mName) || wordRe(String(parts.month)).test(t);
    return dayOk && monOk;
}

// Time: the hour appears in the text, with an am/pm or a clock colon nearby to
// confirm it's a time (not a random number). parts = { hour, ampm? }.
function verifyTimeParts(parts, text) {
    if (!parts || parts.hour == null) return false;
    const t = norm(text);
    const hourOk = wordRe(String(parts.hour)).test(t);
    const clockish = /\b(a\.?m\.?|p\.?m\.?)\b/.test(t) || /\d:\d/.test(t);
    return hourOk && clockish;
}

// Verify a proposed booking date/time against the factlet, then convert to a
// strict ISO startDate + a startTime string. Returns { startDate, startTime } only
// when month + day + hour all appear verbatim in the text; otherwise null. Year is
// trusted (sources rarely print it); the classification future-date gate rejects a
// stale year anyway. parts = { year?, month, day, hour, minute?, ampm? }.
function resolveVerifiedBookingDate(parts, text) {
    if (!verifyDateParts(parts, text) || !verifyTimeParts(parts, text)) return null;
    const year  = Number(parts.year) || new Date().getUTCFullYear();
    const month = Number(parts.month), day = Number(parts.day);
    let hour = Number(parts.hour) || 0;
    const minute = Number(parts.minute) || 0;
    const ampm = parts.ampm ? String(parts.ampm).toLowerCase() : null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (isNaN(d.getTime())) return null;
    const startTime = ((hour % 12) || 12) + ':' + String(minute).padStart(2, '0') + ' ' + (hour < 12 ? 'AM' : 'PM');
    return { startDate: d.toISOString(), startTime };
}

// Strip structured fields from a save patch that cannot be verified verbatim in
// `text`. Returns { patch, dropped[] }. Dossier / name / company / notes are left
// alone (covered by existing save gates). Used by pipelineSave when the caller
// cites the source factlet via factletId.
function filterVerifiedPatch(patch, text) {
    const dropped = [];
    const out = Object.assign({}, patch);
    if (out.email !== undefined && !verifyEmail(out.email, text)) { dropped.push('email'); delete out.email; }
    if (out.phone !== undefined && !verifyPhone(out.phone, text)) { dropped.push('phone'); delete out.phone; }
    if (out.zip   !== undefined && !verifyZip(out.zip, text))     { dropped.push('zip');   delete out.zip;   }
    if (Array.isArray(out.bookings)) {
        out.bookings = out.bookings.map((b) => {
            if (!b || typeof b !== 'object') return b;
            const nb = Object.assign({}, b);
            if (nb.zip !== undefined && !verifyZip(nb.zip, text)) { dropped.push('booking.zip'); delete nb.zip; }
            if (nb.startDateParts !== undefined) {
                const r = resolveVerifiedBookingDate(nb.startDateParts, text);
                if (r) { nb.startDate = r.startDate; nb.startTime = r.startTime; }
                else { dropped.push('booking.startDate'); }
                delete nb.startDateParts;
            }
            return nb;
        });
    }
    return { patch: out, dropped };
}

module.exports = { verifyEmail, verifyPhone, verifyZip, verifyDateParts, verifyTimeParts, resolveVerifiedBookingDate, filterVerifiedPatch };
