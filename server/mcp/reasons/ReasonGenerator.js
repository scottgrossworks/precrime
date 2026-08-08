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

// Prompt text lives in REASON_PROMPT.json (same folder) so it can be tuned
// without touching code -- same pattern as DOCS/PROMPTS.json for the judge.
const REASON_PROMPT = require('./REASON_PROMPT.json');

function buildPrompt() {
    const vp = VALUE_PROP || {};
    const slice = {
        trade: vp.trade || '',
        audienceSegments: vp.audienceSegments || [],
        geography: vp.geography || ''
    };
    return (Array.isArray(REASON_PROMPT.lines) ? REASON_PROMPT.lines : []).join('\n')
        .replace(/\{trade\}/g, slice.trade)
        .replace(/\{today\}/g, new Date().toISOString().slice(0, 10))
        .replace(/\{vendor\}/g, JSON.stringify(slice))
        .replace(/\{maxReasons\}/g, String(MAX_REASONS_PER_RUN));
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
