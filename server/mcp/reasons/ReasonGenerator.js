// ============================================================================
// ReasonGenerator.js -- RECONTACT REASONS from the LLM's own calendar sense.
//
// FOUNDATION inversion (2026-08-08): the client base is four years of already-
// paid-for intelligence. Instead of looping over 2k clients wondering who to
// contact, we START WITH REASONS and work backwards to affected clients.
// This module emits the reasons; skills/mine-reason.md hunts backwards.
//
// One LLM call per cooldown window (the newest reason Factlet's createdAt is
// the clock -- no counter files, no new bookkeeping). Output rows land in the
// existing Factlet table with source "reason:<kind>" so the whole downstream
// spine (staleness pruning, JUDGE_AFFECTED, status counts) applies unchanged.
// Stage 4 APPLY_FACTLET excludes "reason:" sources -- reasons are hunted by
// MINE_REASON goose workers, never token-grepped.
//
// Reason kinds:
//   seasonal   -- occasion inside the booking window ("Halloween 2026-10-31 is
//                 12 weeks out; family-party buyers book 6-10 weeks ahead")
//   trajectory -- a PAST booking type predicts an upcoming occasion ("wedding
//                 9-24 months ago -> milestone celebrations / showers";
//                 "sweet-16 or quince ~2 years ago -> graduation party")
//   referral   -- recent happy clients worth asking for introductions
// ============================================================================
'use strict';

const { prisma } = require('../db');
const { RUNTIME_CONFIG, VALUE_PROP } = require('../runtime');
const { llmComplete } = require('../factlets');

const REASON_SOURCE_PREFIX = 'reason:';
const REASON_KINDS = new Set(['seasonal', 'trajectory', 'referral']);
const COOLDOWN_HOURS = 20;      // roughly once a day, whatever the restart count
const MAX_REASONS_PER_RUN = 6;

function buildPrompt() {
    const vp = VALUE_PROP || {};
    const today = new Date().toISOString().slice(0, 10);
    const slice = {
        trade: vp.trade || '',
        audienceSegments: vp.audienceSegments || [],
        geography: vp.geography || ''
    };
    return [
        `You generate RECONTACT REASONS for a "${slice.trade}" vendor mining their own CRM of past clients and bookings.`,
        `TODAY: ${today}. Booking window: events 3-14 weeks from today (buyers book that far ahead).`,
        `VENDOR: ${JSON.stringify(slice)}`,
        '',
        `Emit up to ${MAX_REASONS_PER_RUN} reasons as a JSON array ONLY (no prose, no code fence):`,
        '[{"kind":"seasonal|trajectory|referral","reason":"<1-2 sentences: the occasion or pattern and WHY NOW, with explicit calendar dates>","hunt":"<how to find affected clients in a CRM of past bookings: which past event types, months, or date ranges to query>"}]',
        '',
        'Rules:',
        '- seasonal: occasions INSIDE the booking window that this vendor\'s client types celebrate. Include the literal date (e.g. "Halloween is 2026-10-31").',
        '- trajectory: a past booking type that predicts an upcoming occasion (wedding 9-24 months ago -> milestone celebrations; sweet-16/quinceanera ~2 years ago -> graduation party; corporate holiday party last Dec -> this Dec). State the lookback range in months.',
        '- referral: at most ONE -- clients served in the last 90 days worth asking for introductions.',
        '- The hunt line must be concrete enough to translate into date-filtered CRM queries. No web research, no invented names, no marketing fluff.'
    ].join('\n');
}

// Cheap textual dedup so a daily run does not restack the same reason: token
// Jaccard against every LIVE reason already in the table.
function tokens(s) {
    return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3));
}
function similar(a, b) {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.size || !tb.size) return false;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    return hit / (ta.size + tb.size - hit) >= 0.55;
}

function parseReasons(raw) {
    if (!raw) return [];
    const start = raw.indexOf('['), end = raw.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    let arr;
    try { arr = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr
        .filter(r => r && REASON_KINDS.has(r.kind) && r.reason && r.hunt)
        .slice(0, MAX_REASONS_PER_RUN);
}

// Emit new reason Factlets if the cooldown has lapsed. Returns count created
// (0 on cooldown, LLM outage, or full dedup -- never throws).
async function maybeGenerateReasons(staleCutoff, logInfo) {
    const log = logInfo || (() => {});
    try {
        const newest = await prisma.factlet.findFirst({
            where: { source: { startsWith: REASON_SOURCE_PREFIX } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true }
        });
        if (newest && (Date.now() - new Date(newest.createdAt).getTime()) < COOLDOWN_HOURS * 3600000) {
            return 0;
        }
        const raw = await llmComplete(buildPrompt(), RUNTIME_CONFIG, 900, 'reason');
        const proposed = parseReasons(raw);
        if (!proposed.length) {
            if (raw !== null) log('ReasonGenerator: LLM returned no parseable reasons.');
            return 0;
        }
        const live = await prisma.factlet.findMany({
            where: { source: { startsWith: REASON_SOURCE_PREFIX }, createdAt: { gte: staleCutoff } },
            select: { content: true }
        });
        let created = 0;
        for (const r of proposed) {
            const content = `${r.reason} HUNT: ${r.hunt}`;
            if (live.some(f => similar(f.content, content))) continue;
            await prisma.factlet.create({ data: { content, source: `${REASON_SOURCE_PREFIX}${r.kind}` } });
            live.push({ content });
            created++;
        }
        if (created) log(`ReasonGenerator: ${created} new recontact reason(s) emitted.`);
        return created;
    } catch (e) {
        log(`ReasonGenerator error (non-fatal): ${e.message}`);
        return 0;
    }
}

module.exports = { maybeGenerateReasons, REASON_SOURCE_PREFIX };
