// Run: node --test value_prop.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parse, validate } = require('./value_prop');

const SAMPLE = `## THE PRODUCT

**Trade:** caricatures

**Product Name:** That Drawing Show

**Seller:** Scott Gross

**Email:** drawingshowscott@gmail.com

**Phone:** 310 980 1421

**Website:** http://scottgross.works/drawingshow

**Geography:** Los Angeles Metro Area and nearby Southern California.

**Rate:** Rates start at $175/hr. No deposit required.

---

## THE PITCH

Live caricature art entertainment for parties, schools, corporate events,
conventions, and festivals throughout Southern California.

---

## WHY US

- Longtime Warner Bros. / DC Comics artist.
- 12-15 faces per hour.
- Guests leave with a personalized physical keepsake.

---

## WHO BUYS THIS

### Buyer Roles

- Event planners
- School activity directors

### Audience Segments

- Birthdays
- Proms
- Comic conventions

### Who Is Not A Buyer

- Events outside the Southern California service area.

---

## RELEVANCE SIGNALS

- Event needs live entertainment.
- Event needs a guest takeaway.

### Not Relevant Signals

- Pure catering or venue rental.

---

## SERVICE AREA DETAILS

- Downtown LA: 90012, 90013, 90014
- San Fernando Valley: 91401, 91601

---

## OUTREACH STYLE

### Signature

Scott Gross
Drawing Show with Scott Gross
310 980 1421

### Sample Email

Hi Cynthia,

I'd be delighted to draw caricatures for your party.

---

## FORBIDDEN PHRASES

- Replace your photo booth
- Cartoon guy
`;

test('parses product key/value fields', () => {
    const vp = parse(SAMPLE);
    assert.equal(vp.trade, 'caricatures');
    assert.equal(vp.product, 'That Drawing Show');
    assert.equal(vp.email, 'drawingshowscott@gmail.com');
    assert.match(vp.rate, /\$175\/hr/);
});

test('parses bullet sections', () => {
    const vp = parse(SAMPLE);
    assert.equal(vp.whyUs.length, 3);
    assert.deepEqual(vp.buyerRoles, ['Event planners', 'School activity directors']);
    assert.deepEqual(vp.audienceSegments, ['Birthdays', 'Proms', 'Comic conventions']);
    assert.equal(vp.notBuyer.length, 1);
    assert.equal(vp.forbiddenPhrases.length, 2);
});

test('relevance signals stop before Not Relevant subsection', () => {
    const vp = parse(SAMPLE);
    assert.deepEqual(vp.relevanceSignals, [
        'Event needs live entertainment.',
        'Event needs a guest takeaway.'
    ]);
});

test('collects 5-digit service zips, deduped', () => {
    const vp = parse(SAMPLE);
    assert.deepEqual(vp.serviceZips, ['90012', '90013', '90014', '91401', '91601']);
});

test('pulls signature and sample email blocks', () => {
    const vp = parse(SAMPLE);
    assert.match(vp.signature, /Scott Gross/);
    assert.match(vp.signature, /310 980 1421/);
    assert.match(vp.sampleEmail, /Hi Cynthia/);
});

test('pitch is prose, not bullets', () => {
    const vp = parse(SAMPLE);
    assert.match(vp.pitch, /Live caricature art entertainment/);
    assert.ok(!vp.pitch.includes('-'));
});

test('validate passes a complete profile', () => {
    assert.deepEqual(validate(parse(SAMPLE)), { ok: true, missing: [] });
});

test('validate fails and names missing required fields', () => {
    const vp = parse(SAMPLE);
    vp.trade = '';
    vp.buyerRoles = [];
    const r = validate(vp);
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes('trade'));
    assert.ok(r.missing.includes('buyerRoles'));
});

test('validate flags placeholder text', () => {
    const vp = parse(SAMPLE);
    vp.trade = 'TBD';
    assert.equal(validate(vp).ok, false);
});
