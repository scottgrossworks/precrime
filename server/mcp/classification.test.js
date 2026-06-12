// Run: node --test classification.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classify, isGenericEmail } = require('./classification');

const HOUR = 3600 * 1000;
const NOW = 1_750_000_000_000; // fixed reference time
const future = NOW + 30 * 24 * HOUR;
const past = NOW - 24 * HOUR;

// A client + booking that meets every hot prerequisite.
function hotClient() {
    return { name: 'Cynthia Reyes', email: 'cynthia@school.edu', draftStatus: null, sentAt: null };
}
function hotBooking() {
    return {
        location: '1060 W Addison St, Chicago, IL 60613', zip: '60613',
        startDate: new Date(future), startTime: '7:00 PM', trade: 'caricatures',
        title: 'Spring carnival', shared: false, sharedAt: null, leedId: null
    };
}
const opts = { factletCount: 3, now: NOW, futureMinHours: 12 };

test('all prerequisites met -> hot_eligible', () => {
    const r = classify(hotClient(), hotBooking(), opts);
    assert.equal(r.state, 'hot_eligible');
    assert.deepEqual(r.missing, []);
});

test('zero factlets -> cold (no_factlets)', () => {
    const r = classify(hotClient(), hotBooking(), { ...opts, factletCount: 0 });
    assert.equal(r.state, 'cold');
    assert.equal(r.reason, 'no_factlets');
});

test('already shared -> cold (acted_on_shared)', () => {
    const b = { ...hotBooking(), shared: true };
    assert.equal(classify(hotClient(), b, opts).reason, 'acted_on_shared');
});

test('outreach sent -> cold (acted_on_outreach)', () => {
    const c = { ...hotClient(), draftStatus: 'sent' };
    assert.equal(classify(c, hotBooking(), opts).reason, 'acted_on_outreach');
});

test('past event -> cold (event_passed)', () => {
    const b = { ...hotBooking(), startDate: new Date(past) };
    assert.equal(classify(hotClient(), b, opts).reason, 'event_passed');
});

test('generic email -> brewing (client_email_generic)', () => {
    const c = { ...hotClient(), email: 'info@school.edu' };
    const r = classify(c, hotBooking(), { ...opts, genericEmailPrefixes: ['info', 'sales'] });
    assert.equal(r.state, 'brewing');
    assert.ok(r.missing.includes('client_email_generic'));
});

test('missing name -> brewing (client_name)', () => {
    const c = { ...hotClient(), name: '' };
    const r = classify(c, hotBooking(), opts);
    assert.equal(r.state, 'brewing');
    assert.ok(r.missing.includes('client_name'));
});

test('no zip -> brewing (location_with_zip)', () => {
    const b = { ...hotBooking(), zip: '' };
    const r = classify(hotClient(), b, opts);
    assert.equal(r.state, 'brewing');
    assert.ok(r.missing.includes('location_with_zip'));
});

test('no start time -> brewing (start_time)', () => {
    const b = { ...hotBooking(), startTime: '' };
    const r = classify(hotClient(), b, opts);
    assert.ok(r.missing.includes('start_time'));
});

test('start too soon -> brewing (start_date_not_future_enough)', () => {
    const b = { ...hotBooking(), startDate: new Date(NOW + 2 * HOUR) };
    const r = classify(hotClient(), b, opts);
    assert.ok(r.missing.includes('start_date_not_future_enough'));
});

test('isGenericEmail defaults and overrides', () => {
    assert.equal(isGenericEmail('info@x.com'), true);
    assert.equal(isGenericEmail('jane@x.com'), false);
    assert.equal(isGenericEmail('news@x.com', ['news']), true);
});
