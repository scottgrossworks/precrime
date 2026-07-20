// ============================================================================
// value_prop.js -- parse DOCS/VALUE_PROP.md into a summarized JSON the LLM reads
// ============================================================================
// VALUE_PROP.md is the sole source of product identity (DOCS/CLAUDE.md). We
// MANDATE its section structure so this parser is reliable, then hand the LLM a
// compact profile so it can judge product-market fit. Pure: text in, object out.
//
// Mandated sections: THE PRODUCT (key:value), THE PITCH, WHY US, WHO BUYS THIS
// (Buyer Roles / Audience Segments / Who Is Not A Buyer), RELEVANCE SIGNALS,
// SERVICE AREA DETAILS, OUTREACH STYLE (Signature / Sample Email),
// FORBIDDEN PHRASES.
// ============================================================================

function _sections(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const sec = {};
    let h2 = null, h3 = null;
    for (const line of lines) {
        const m2 = line.match(/^##\s+(.+?)\s*$/);   // does not match '### x'
        const m3 = line.match(/^###\s+(.+?)\s*$/);
        if (m3) { h3 = m3[1].trim(); if (h2) sec[h2].sub[h3] = []; continue; }
        if (m2) { h2 = m2[1].trim(); h3 = null; sec[h2] = { intro: [], sub: {} }; continue; }
        if (!h2) continue;
        if (h3) sec[h2].sub[h3].push(line);
        else sec[h2].intro.push(line);
    }
    return sec;
}

function _bullets(lines) {
    return (lines || [])
        .map(l => l.match(/^\s*-\s+(.*\S)\s*$/))
        .filter(Boolean)
        .map(m => m[1].trim());
}

function _keyVals(lines) {
    const out = {};
    for (const l of lines || []) {
        const m = l.match(/^\s*\*\*(.+?):\*\*\s*(.*\S)\s*$/);
        if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
    }
    return out;
}

function _prose(lines) {
    return (lines || [])
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('-') && !l.startsWith('**') && l !== '---')
        .join(' ');
}

function _joinNonEmpty(lines) {
    return (lines || []).map(l => l.replace(/\s+$/, '')).filter(l => l.trim()).join('\n');
}

function parse(md) {
    const sec = _sections(md);
    const product = _keyVals((sec['THE PRODUCT'] || {}).intro);
    const who = (sec['WHO BUYS THIS'] || { sub: {} }).sub;
    const outreach = (sec['OUTREACH STYLE'] || { sub: {} }).sub;
    const areaLines = []
        .concat(((sec['SERVICE AREA DETAILS'] || {}).intro) || [])
        .concat(Object.values((sec['SERVICE AREA DETAILS'] || { sub: {} }).sub).flat());
    const areaText = areaLines.join('\n');
    const serviceZips = Array.from(new Set((areaText.match(/\b\d{5}\b/g) || [])));
    // Service-area zip PREFIXES: the machine-enforceable form of the service area.
    // Written in VALUE_PROP.md as "900xx"-style entries (e.g. "Zip prefixes: 900xx,
    // 913xx, 928xx") and/or derived from the first 3 digits of every listed 5-digit
    // zip. Consumed by the out_of_area gate (classification.js) and pipeline.save:
    // a booking whose zip does not start with one of these prefixes is out of the
    // service area. Empty list = no zip-based geography enforcement.
    const serviceZipPrefixes = Array.from(new Set([
        ...(areaText.match(/\b\d{3}(?=xx\b)/gi) || []),
        ...serviceZips.map(z => z.slice(0, 3))
    ]));

    return {
        trade:            product['trade'] || '',
        product:          product['product name'] || '',
        seller:           product['seller'] || '',
        email:            product['email'] || '',
        phone:            product['phone'] || '',
        website:          product['website'] || '',
        socials:          product['socials'] || '',
        geography:        product['geography'] || '',
        rate:             product['rate'] || '',
        serviceZips,
        serviceZipPrefixes,
        pitch:            _prose((sec['THE PITCH'] || {}).intro),
        whyUs:            _bullets((sec['WHY US'] || {}).intro),
        buyerRoles:       _bullets(who['Buyer Roles']),
        audienceSegments: _bullets(who['Audience Segments']),
        notBuyer:         _bullets(who['Who Is Not A Buyer']),
        relevanceSignals: _bullets((sec['RELEVANCE SIGNALS'] || {}).intro),
        // The '### Not Relevant Signals' sub-section — the fit-gate's negative criteria.
        // Parsed so workers (drill-container fit gate) get it from the packet instead of
        // shell-reading all of VALUE_PROP.md (a whole worker turn, re-billed every turn).
        notRelevantSignals: _bullets(((sec['RELEVANCE SIGNALS'] || { sub: {} }).sub || {})['Not Relevant Signals']),
        // The '### Banned Terms' sub-section — a HARD save-time blocklist (2026-07-13,
        // comic-con incident). Prose rules ("Does NOT work comic-cons") were ignored by
        // scrape workers, so banned categories kept re-entering the DB after the user
        // deleted them. pipeline.save (saveClient.js) refuses any NEW Client or Booking
        // whose identity text contains one of these terms (case-insensitive substring).
        bannedTerms: _bullets(((sec['RELEVANCE SIGNALS'] || { sub: {} }).sub || {})['Banned Terms']),
        forbiddenPhrases: _bullets((sec['FORBIDDEN PHRASES'] || {}).intro),
        signature:        _joinNonEmpty(outreach['Signature']),
        sampleEmail:      _joinNonEmpty(outreach['Sample Email'])
    };
}

// Mandated-field gate, mirrors the TRADE gate in DOCS/CLAUDE.md: fail loud so the
// caller can stop and tell the user to fill VALUE_PROP.md in.
const REQUIRED = ['trade', 'email', 'pitch', 'signature'];
const REQUIRED_LISTS = ['buyerRoles', 'relevanceSignals'];
const PLACEHOLDER = /\b(tbd|todo|fill in|placeholder|your business|xxx)\b/i;

function validate(vp) {
    const missing = [];
    for (const k of REQUIRED) {
        if (!vp[k] || !String(vp[k]).trim() || PLACEHOLDER.test(vp[k])) missing.push(k);
    }
    for (const k of REQUIRED_LISTS) {
        if (!Array.isArray(vp[k]) || vp[k].length === 0) missing.push(k);
    }
    return { ok: missing.length === 0, missing };
}

module.exports = { parse, validate };
