// Run: node --test classification.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classify, isGenericEmail, classifyEventClass } = require('./classification');

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
const opts = { now: NOW, futureMinHours: 12 };

test('all prerequisites met -> hot_eligible', () => {
    const r = classify(hotClient(), hotBooking(), opts);
    assert.equal(r.state, 'hot_eligible');
    assert.deepEqual(r.missing, []);
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

// ---- classifyEventClass: direct | container -------------------------------

test('classifyEventClass: trade-show / expo / convention -> container', () => {
    assert.equal(classifyEventClass({ title: 'LA Auto Show 2026', description: 'Major consumer auto show at LACC' }), 'container');
    assert.equal(classifyEventClass({ title: 'LA Comic Con 2026', description: 'Pop culture and cosplay convention' }), 'container');
    assert.equal(classifyEventClass({ title: 'ADLM 2026 Clinical Lab Expo', description: 'Clinical lab medicine expo' }), 'container');
    assert.equal(classifyEventClass({ title: 'Long Beach Expo Collectibles Show 2026', description: 'coins and memorabilia', location: 'Long Beach Convention Center' }), 'container');
    assert.equal(classifyEventClass({ title: 'Spring Job Fair', description: 'employers recruiting' }), 'container');
});

test('classifyEventClass: festivals / fairs -> container', () => {
    assert.equal(classifyEventClass({ title: 'Gloria Molina Grand Park Summer Block Party' }), 'container');
    assert.equal(classifyEventClass({ title: 'FoodieLand Food Festival', description: 'Large food festival' }), 'container');
    assert.equal(classifyEventClass({ title: 'Downtown Street Fair', description: 'vendors and music' }), 'container');
    assert.equal(classifyEventClass({ title: 'Cinco de Mayo Fiesta' }), 'container');
});

test('classifyEventClass: tournaments / championships -> container (vendors + crowd, same as a trade show)', () => {
    // A tournament at a convention center has the same vendors/crowd a trade show does.
    assert.equal(classifyEventClass({ title: 'IBJJF World Championship 2026', description: 'jiu-jitsu tournament', location: 'Long Beach Convention Center' }), 'container');
    assert.equal(classifyEventClass({ title: 'California Invitational Taekwondo Championship', location: 'Los Angeles Convention Center' }), 'container');
    assert.equal(classifyEventClass({ title: 'LA Marathon 2026' }), 'container');
    assert.equal(classifyEventClass({ title: 'SoCal Cup: The Showcase (Volleyball)' }), 'container');
});

test('classifyEventClass: direct is the default (single private host)', () => {
    assert.equal(classifyEventClass({ title: 'Acme Corp holiday party', description: 'private company event' }), 'direct');
    assert.equal(classifyEventClass({ title: 'Smith wedding reception' }), 'direct');
    assert.equal(classifyEventClass({ title: 'Mateo 5th birthday party' }), 'direct');
});

test('classifyEventClass: empty/null is direct, never throws', () => {
    assert.equal(classifyEventClass(null), 'direct');
    assert.equal(classifyEventClass({}), 'direct');
    assert.equal(classifyEventClass({ title: '', description: '', location: '' }), 'direct');
});
