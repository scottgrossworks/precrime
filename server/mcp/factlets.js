// ============================================================================
// factlets.js -- the in-process JUDGE CORE (scoring + promote-gate).
//
// Factlet freshness/demand scoring, client + booking target scoring, the single
// LLM promote-gate (judgeLeed/_llmComplete), and VALUE_PROP demand-term matching.
// Pure-ish: requires db/runtime/classification directly, no injected deps. The
// orchestration that drives these (judgeAffected, computeNearHotBookings) stays
// in mcp_server.js and calls this module by the same exported names.
// ============================================================================

const { prisma } = require('./db');
const { RUNTIME_CONFIG, VALUE_PROP, SCORING, PROMPTS } = require('./runtime');
const classification = require('./classification');

let GENERIC_EMAIL_PREFIXES = new Set();

function isGenericEmail(email) {
    if (!email) return false;
    const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    return GENERIC_EMAIL_PREFIXES.has(prefix);
}


// =============================================================================
// SCORING POLICY LOADED FROM DOCS/SCORING.json AT STARTUP
// =============================================================================
// Single source of truth. Edit DOCS/SCORING.json (constants, gates, weights),
// restart the server. Nothing in this JS file hardcodes a scoring number.

const FACTLET_THRESHOLD = SCORING.factlet.threshold;
const FACTLET_POINTS_PER = SCORING.factlet.pointsPerFreshFactlet;
const DRAFT_THRESHOLD_CLIENT = SCORING.client.draftThreshold;
GENERIC_EMAIL_PREFIXES = new Set(SCORING.booking.genericEmailPrefixes || []);



function getFactletStaleDays() {
    return RUNTIME_CONFIG.factletStaleDays;
}

// Find live (non-stale) Factlet rows directly relevant to this Client via cheap
// content/source string overlap. There is no join table; Factlet is standalone.
// Relevance signals (any one is sufficient):
//   - Client name appears in factlet content or source
//   - Client company appears in factlet content or source
//   - Client website host appears in factlet content or source
// Filtering is case-insensitive and trims tokens shorter than 4 chars to avoid
// matching generic words.
async function findLiveFactletsForClient(client, staleDays) {
    if (!client) return [];
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    const tokens = [];
    function addTok(s) {
        if (!s) return;
        const t = String(s).trim();
        if (t.length < 4) return;
        tokens.push(t.toLowerCase());
    }
    addTok(client.name);
    addTok(client.company);
    if (client.website) {
        try {
            const u = new URL(client.website.startsWith('http') ? client.website : 'https://' + client.website);
            addTok(u.hostname.replace(/^www\./, ''));
        } catch (_) { /* ignore unparseable */ }
    }
    if (tokens.length === 0) return [];

    // Pull only fresh Factlets to bound the scan.
    const fresh = await prisma.factlet.findMany({
        where: { createdAt: { gte: cutoff } },
        orderBy: { createdAt: 'desc' },
        take: 500
    });
    return fresh.filter(f => {
        const hay = ((f.content || '') + ' ' + (f.source || '')).toLowerCase();
        return tokens.some(tok => hay.includes(tok));
    });
}

const VALUE_PROP_TOKEN_STOPWORDS = new Set([
    'about', 'after', 'again', 'against', 'also', 'and', 'because', 'before',
    'being', 'between', 'business', 'client', 'clients', 'company', 'could',
    'event', 'events', 'from', 'have', 'into', 'local', 'market', 'offer',
    'party', 'people', 'service', 'services', 'that', 'their', 'them', 'there',
    'these', 'they', 'this', 'through', 'vendor', 'vendors', 'were', 'what',
    'when', 'where', 'which', 'with', 'would', 'your'
]);

function normalizeDemandText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function collectValuePropDemandTerms(booking, cfg) {
    const phrases = new Set();
    const tokens = new Set();

    function addPhrase(value) {
        const normalized = normalizeDemandText(value);
        if (!normalized || normalized.length < 4) return;
        phrases.add(normalized);
        for (const tok of normalized.split(/\s+/)) {
            if (tok.length >= 4 && !VALUE_PROP_TOKEN_STOPWORDS.has(tok)) tokens.add(tok);
        }
    }

    addPhrase(booking?.trade);
    addPhrase(cfg?.defaultTrade);

    const description = normalizeDemandText(cfg?.businessDescription);
    if (description) {
        for (const tok of description.split(/\s+/)) {
            if (tok.length >= 5 && !VALUE_PROP_TOKEN_STOPWORDS.has(tok)) tokens.add(tok);
        }
    }

    return { phrases: Array.from(phrases), tokens: Array.from(tokens) };
}

function factletMentionsValueProp(factlet, booking, cfg) {
    const terms = collectValuePropDemandTerms(booking, cfg);
    if (terms.phrases.length === 0 && terms.tokens.length === 0) return false;

    const hay = normalizeDemandText(`${factlet?.content || ''} ${factlet?.source || ''}`);
    if (!hay) return false;

    if (terms.phrases.some(phrase => hay.includes(phrase))) return true;

    let hits = 0;
    for (const tok of terms.tokens) {
        if (hay.includes(tok)) hits++;
        if (hits >= 2) return true;
    }
    return false;
}

function computeFactletStats(factletRows, staleDays, opts = {}) {
    const now = Date.now();
    let score = 0;
    let freshCount = 0;
    let demandScore = 0;
    let demandFreshCount = 0;
    const demandFactletIds = [];
    for (const f of factletRows) {
        if (!f || !f.createdAt) continue;
        const ageDays = (now - new Date(f.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        const weight = Math.max(0, 1 - ageDays / staleDays);
        if (weight > 0) freshCount++;
        score += weight;

        if (weight > 0 && factletMentionsValueProp(f, opts.booking || null, opts.config || null)) {
            demandFreshCount++;
            demandScore += weight;
            if (f.id) demandFactletIds.push(f.id);
        }
    }
    return { score, count: factletRows.length, freshCount, demandScore, demandFreshCount, demandFactletIds };
}

function computeFactletPointScore(stats) {
    const demandPoints = SCORING.factlet.pointsPerDemandFactlet || (FACTLET_POINTS_PER * 3);
    const demandBonus = Math.max(0, demandPoints - FACTLET_POINTS_PER);
    return Math.round((stats.score * FACTLET_POINTS_PER) + (stats.demandScore * demandBonus));
}

async function computeClientScore(clientId, intelOverride, opts = {}) {
    // opts.client / opts.liveFactlets let a caller that ALREADY loaded this client and
    // its live factlets (computeBookingTargetScore) skip the duplicate findUnique +
    // factlet findMany. Standalone callers pass no opts -> full fetch. Behavior-identical:
    // nothing mutates the client row or factlet set between the caller's load and here.
    const client = opts.client || await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return null;

    const staleDays = await getFactletStaleDays();
    // Live Factlet relevance via cheap content/source overlap on the Client's
    // stable identifiers (name / company / website host). No join table.
    const liveFactlets = opts.liveFactlets || await findLiveFactletsForClient(client, staleDays);
    const cfg = RUNTIME_CONFIG;
    const fs = computeFactletStats(liveFactlets, staleDays, { config: cfg });

    const hasName         = !!(client.name && client.name.trim());
    const email           = (client.email || '').trim();
    const generic         = email ? isGenericEmail(email) : false;
    const hasDirectEmail  = !!(email && !generic);
    const contactGate     = hasName && hasDirectEmail;

    const intelScore    = (intelOverride !== null && intelOverride !== undefined) ? intelOverride : (client.intelScore || 0);
    const dossierScore  = intelScore + computeFactletPointScore(fs);
    const draftReady    = contactGate && dossierScore >= DRAFT_THRESHOLD_CLIENT;

    const updateData = { dossierScore, contactGate };
    if (intelOverride !== null && intelOverride !== undefined) updateData.intelScore = intelOverride;
    await prisma.client.update({
        where: { id: clientId },
        data:  updateData
    });

    let action = null;
    if (!draftReady) {
        if (!hasName)      action = 'CHASE_CONTACT: no named person.';
        else if (!email)   action = 'CHASE_CONTACT: no email.';
        else if (generic)  action = `CHASE_CONTACT: ${email} is a generic inbox. Find ${client.name}'s direct email.`;
        else               action = `THIN_DOSSIER: dossierScore ${dossierScore} < ${DRAFT_THRESHOLD_CLIENT}. Need more fresh relevant factlets.`;
    }

    return {
        targetType: 'client',
        targetId:   clientId,
        total:      dossierScore,
        shareReady: false,
        draftReady,
        components: {
            contactGate,
            intelScore,
            factletScore:      Math.round(fs.score * 100) / 100,
            factletCount:      fs.count,
            factletFreshCount: fs.freshCount,
            factletStaleDays:  staleDays,
            dossierScore,
            contactEmail:      email,
            contactGeneric:    generic
        },
        action
    };
}


// Generic one-shot LLM completion. Provider, base URL, and model are all
// configurable (Config.llmProvider / llmBaseUrl / llmModel) so deployments can
// point at OpenRouter and trial cheap models. Returns the text, or null on failure.
async function _llmComplete(prompt, cfg, maxTokens = 64) {
    if (!cfg || !cfg.llmApiKey) return null;
    const provider = (cfg.llmProvider || 'anthropic').toLowerCase();
    try {
        if (provider === 'anthropic') {
            const res = await fetch((cfg.llmBaseUrl || 'https://api.anthropic.com') + '/v1/messages', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': cfg.llmApiKey,
                    'anthropic-version': cfg.llmAnthropicVersion || '2023-06-01'
                },
                body: JSON.stringify({
                    model: cfg.llmModel || 'claude-haiku-4-5-20251001',
                    max_tokens: maxTokens,
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            if (!res.ok) { console.error(`[judge-llm] http ${res.status}`); return null; }
            const j = await res.json();
            return (j.content && j.content[0] && j.content[0].text || '').trim();
        }
        // openai-compatible (openai, openrouter, local). Append /v1/chat/completions
        // unless the configured base already ends in /v1 (avoids a double /v1).
        const base = (cfg.llmBaseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        const url = /\/v1$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
        const headers = { 'content-type': 'application/json', 'authorization': `Bearer ${cfg.llmApiKey}` };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'https://www.theleedz.com';
            headers['X-Title'] = 'PRECRIME';
        }
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: cfg.llmModel || 'gpt-4o-mini',
                max_tokens: maxTokens,
                messages: [{ role: 'user', content: prompt }]
            })
        });
        if (!res.ok) { console.error(`[judge-llm] http ${res.status}`); return null; }
        const j = await res.json();
        return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    } catch (e) {
        console.error('[judge-llm] error:', e.message);
        return null;
    }
}

// The headless objective picks the LLM bar. Interactive (no single objective)
// uses the lower outreach bar so the user sees every candidate.
function bookingActionToMode(defaultBookingAction) {
    return defaultBookingAction === 'leedz_api' ? 'marketplace' : 'outreach';
}

// The ONLY LLM call in classification: the promote-gate from a procedurally
// hot-eligible booking to hot. Judges product-market fit between VALUE_PROP and
// the Client.dossier + Booking. Prompt comes from DOCS/PROMPTS.json. Returns
// { state: 'hot' | 'brewing', reason }. Defaults to brewing: if we cannot get a
// confident hot, keep enriching.
async function judgeLeed(vp, dossier, booking, mode, cfg) {
    if (!cfg || !cfg.llmApiKey) return { state: 'brewing', reason: 'no_llm_key' };
    const modeGuidance = (PROMPTS.judgeMode && (PROMPTS.judgeMode[mode] || PROMPTS.judgeMode.outreach)) || '';
    const isoDate = booking.startDate ? new Date(booking.startDate).toISOString().slice(0, 10) : '';
    const bookingLine = `title ${booking.title || ''} | date ${isoDate} | location ${booking.location || ''} | trade ${booking.trade || ''} | notes ${String(booking.notes || '').slice(0, 500)}`;
    const prompt = (PROMPTS.judge && Array.isArray(PROMPTS.judge.lines) ? PROMPTS.judge.lines.join('\n') : '')
        .replace('{valueProp}', JSON.stringify(vp, null, 2))
        .replace('{dossier}', String(dossier || '(empty dossier)').slice(0, 6000))
        .replace('{bookingLine}', bookingLine)
        .replace('{modeGuidance}', modeGuidance);

    const out = await _llmComplete(prompt, cfg);
    if (out === null) return { state: 'brewing', reason: 'judge_unavailable' };
    const word = out.trim().toLowerCase();
    if (word.startsWith('hot')) return { state: 'hot', reason: out.trim().slice(0, 200) };
    return { state: 'brewing', reason: out.trim().slice(0, 200) || 'judge_not_hot' };
}

// CHEAP per-exhibitor fit gate for container expansion (call (a) of the two-tier drill).
// Before spending an EXPENSIVE DRILL_DOWN worker researching a scraped exhibitor, ask the
// LLM one short question: would THIS company plausibly buy VALUE_PROP at THIS show? ~24
// tokens out. Not-fit exhibitors are dismissed so zero research is wasted on them. Defaults
// to fit=false on any failure -- never spend the expensive drill on an unverified company.
// Returns { fit: boolean, reason: string }.
// Two-tier container gate, call (a): would THIS vendor/company plausibly buy VALUE_PROP
// at THIS event? Cheap in-process LLM (~24 tokens) so the EXPENSIVE spawned DRILL_DOWN
// worker (call (b)) only runs for a YES. Returns { fit, reason, decided }: `decided` is
// TRUE only when the LLM actually answered -- infra failures (no key / llm down / no
// company) return decided:false so callers can fail-closed on SPEND without dismissing
// the booking as a genuine no-fit.
async function judgeContainerFit(vp, company, show, cfg) {
    if (!cfg || !cfg.llmApiKey) return { fit: false, reason: 'no_llm_key', decided: false };
    if (!company) return { fit: false, reason: 'no_company', decided: false };
    const prompt = [
        'You gate B2B sales leads for this seller/product:',
        JSON.stringify(vp, null, 2).slice(0, 2500),
        '',
        `Multi-vendor event: "${show || '(event)'}".`,
        `One participant/exhibitor at it: "${company}".`,
        "Would THIS company plausibly HIRE or BUY the seller's product for their presence at THIS event? Judge product-market fit only.",
        'Answer with exactly YES or NO, then a short reason (<=8 words).'
    ].join('\n');
    const out = await _llmComplete(prompt, cfg, 24);
    if (out === null) return { fit: false, reason: 'fit_unavailable', decided: false };
    const word = out.trim().toLowerCase();
    // A DECIDED verdict requires the model to actually answer yes/no. An empty or ambiguous
    // completion is NOT a confident NO — a flaky/terse model response must never permanently
    // dismiss a booking. Only yes/no counts as decided; anything else is undecided, so the
    // caller skips the drill this round WITHOUT dismissing (fail-closed on spend, not on data).
    if (word.startsWith('yes')) return { fit: true,  reason: out.trim().slice(0, 120), decided: true };
    if (word.startsWith('no'))  return { fit: false, reason: out.trim().slice(0, 120), decided: true };
    return { fit: false, reason: word ? ('unclear: ' + out.trim().slice(0, 100)) : 'empty_response', decided: false };
}

// Planner-facing convenience: gate a container-spawned vendor booking using the loaded
// VALUE_PROP + RUNTIME_CONFIG, so callers don't thread the LLM plumbing (mirrors how
// computeBookingTargetScore owns its own cfg). Keeps every LLM detail inside factlets.js.
async function gateContainerVendor(company, show) {
    return judgeContainerFit(VALUE_PROP, company, show, RUNTIME_CONFIG);
}

async function computeBookingTargetScore(bookingId) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { client: true }
    });
    if (!booking) return null;

    const client = booking.client;
    const cfg = RUNTIME_CONFIG;
    const staleDays = getFactletStaleDays();

    // Live factlets feed the client enrichment/dossier signal below (components +
    // computeClientScore). They no longer gate promotion: classify() decides
    // hot/brewing/cold on fields + event timing only (the stale-factlet veto is gone).
    const liveFactlets = client ? await findLiveFactletsForClient(client, staleDays) : [];
    const fs = computeFactletStats(liveFactlets, staleDays, { booking, config: cfg });

    // Procedural classification first (deterministic, no LLM): cold / brewing /
    // hot_eligible. See DOCS/CLASSIFICATION.md and classification.js.
    const futureMinHours = (SCORING.classification && SCORING.classification.futureMinHours) ?? 12;
    // Mode + default trade drive the objective-aware trade gate: outreach can INFER a
    // missing booking trade from VALUE_PROP; marketplace requires an explicit one.
    const mode = bookingActionToMode(cfg && cfg.defaultBookingAction);
    const defaultTrade = (VALUE_PROP && VALUE_PROP.trade) || (cfg && cfg.defaultTrade) || '';
    const proc = classification.classify(client, booking, {
        futureMinHours, mode, defaultTrade,
        genericEmailPrefixes: (SCORING.booking && SCORING.booking.genericEmailPrefixes) || [],
        orgNameTokens: (SCORING.classification && SCORING.classification.orgNameTokens) || []
    });

    let status = proc.state === 'hot_eligible' ? 'brewing' : proc.state;
    let reason = proc.reason || (proc.missing && proc.missing.length ? `missing: ${proc.missing.join(', ')}` : null);

    // Only a procedurally hot-eligible leed reaches the LLM. judgeLeed is the sole
    // promote-gate to hot, judging product-market fit (mode-aware).
    if (proc.state === 'hot_eligible') {
        const verdict = await judgeLeed(VALUE_PROP, (client && client.dossier) || '', booking, mode, cfg);
        status = verdict.state;          // 'hot' or 'brewing'
        reason = verdict.reason || reason;
    }

    // Keep the client enrichment signal (dossierScore / contactGate) fresh. KTD4:
    // dossierScore is an internal enrichment-priority signal, never a promotion gate.
    if (client) await computeClientScore(client.id, null, { client, liveFactlets });

    await prisma.booking.update({ where: { id: bookingId }, data: { status } });

    return {
        targetType: 'booking',
        targetId:   bookingId,
        status,
        reason,
        components: {
            procedural:        proc,
            factletCount:      fs.count,
            factletFreshCount: fs.freshCount,
            factletStaleDays:  staleDays
        }
    };
}

// Token-free procedural state for a booking: just the deterministic classify() gates
// (real future date, venue+zip, real NAMED non-generic contact, not acted-on), with NO
// LLM call and NO DB write. Returns the procedural verdict
//   { state: 'cold' | 'brewing' | 'hot_eligible', missing[] }.
// Caller passes the already-loaded booking + its client (avoids a fetch). This is the
// cheap half of computeBookingTargetScore -- the procedural rescore uses it to DEMOTE
// hot bookings that no longer pass the gates (legacy/mis-scored cleanup) without paying
// for the LLM promote-judge. It never returns 'hot' (only the LLM promotes hot_eligible).
function classifyBookingProcedural(booking, client) {
    const cfg = RUNTIME_CONFIG;
    const futureMinHours = (SCORING.classification && SCORING.classification.futureMinHours) ?? 12;
    const mode = bookingActionToMode(cfg && cfg.defaultBookingAction);
    const defaultTrade = (VALUE_PROP && VALUE_PROP.trade) || (cfg && cfg.defaultTrade) || '';
    return classification.classify(client, booking, {
        futureMinHours, mode, defaultTrade,
        genericEmailPrefixes: (SCORING.booking && SCORING.booking.genericEmailPrefixes) || [],
        orgNameTokens: (SCORING.classification && SCORING.classification.orgNameTokens) || []
    });
}

module.exports = {
    isGenericEmail,
    getFactletStaleDays,
    findLiveFactletsForClient,
    computeClientScore,
    computeBookingTargetScore,
    judgeContainerFit,
    gateContainerVendor,
    classifyBookingProcedural,
    bookingActionToMode,
    factletMentionsValueProp,
    collectValuePropDemandTerms,
    normalizeDemandText,
    VALUE_PROP_TOKEN_STOPWORDS,
};
