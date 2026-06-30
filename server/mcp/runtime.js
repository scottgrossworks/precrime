// runtime.js -- the single source of in-memory runtime config, extracted from
// mcp_server.js. Loads precrime_config.json (+ hydrates API-key env vars), DOCS/
// SCORING.json, DOCS/VALUE_PROP.md, DOCS/PROMPTS.json, and BUILDS RUNTIME_CONFIG --
// all SYNCHRONOUSLY at require() time, so every importer gets final values (never the
// {trade:''} placeholder). Config is read-only at runtime; nothing reassigns these.
// Server modules import these by name instead of reaching into mcp_server globals.
'use strict';
const fs = require('fs');
const path = require('path');
const valueProp = require('./value_prop');
const PRECRIME_ROOT = path.resolve(__dirname, '..', '..');

const { loadPrecrimeConfig, applyApiKeysToProcessEnv } = require(path.resolve(__dirname, '..', 'config', 'precrime_config.js'));
const PRECRIME_CONFIG = loadPrecrimeConfig();
if (PRECRIME_CONFIG.fallbacks && PRECRIME_CONFIG.fallbacks.length) {
    for (const note of PRECRIME_CONFIG.fallbacks) {
        console.error(`[MCP] precrime_config fallback: ${note}`);
    }
}
// Internal plumbing only: some node libs (openai, anthropic, tavily) read
// process.env.X at import time. Hydrate from config. Not user-facing.
applyApiKeysToProcessEnv(PRECRIME_CONFIG);

const SCORING_POLICY_PATH = path.resolve(PRECRIME_ROOT, 'DOCS', 'SCORING.json');
let SCORING;
try {
    SCORING = JSON.parse(fs.readFileSync(SCORING_POLICY_PATH, 'utf8'));
} catch (e) {
    console.error(`[MCP] FATAL: DOCS/SCORING.json missing or malformed: ${e.message}`);
    process.exit(1);
}

// VALUE_PROP profile -- the user's business, parsed from DOCS/VALUE_PROP.md and fed
// to the LLM judge so it can reason about product-market fit. Warn (not fatal) when
// incomplete, mirroring the TRADE-gate philosophy: a thin VALUE_PROP yields weak
// judgments, but the server should still boot.
const VALUE_PROP_PATH = path.resolve(PRECRIME_ROOT, 'DOCS', 'VALUE_PROP.md');
let VALUE_PROP = { trade: '' };
try {
    VALUE_PROP = valueProp.parse(fs.readFileSync(VALUE_PROP_PATH, 'utf8'));
    const vpCheck = valueProp.validate(VALUE_PROP);
    if (!vpCheck.ok) console.error(`[MCP] VALUE_PROP.md incomplete: missing ${vpCheck.missing.join(', ')}. Fill in DOCS/VALUE_PROP.md.`);
} catch (e) {
    console.error(`[MCP] VALUE_PROP.md missing or unreadable: ${e.message}`);
}

// ============================================================================
// RUNTIME_CONFIG -- in-memory replacement for the retired SQLite Config table.
// ============================================================================
// Built ONCE at startup. Identity (companyName / companyEmail /
// businessDescription / signature / defaultTrade) derives from DOCS/VALUE_PROP.md;
// LLM + recycler settings come from precrime_config.json; the marketplace policy
// defaults and the createLeed session JWT are derived here exactly as the former
// server/sync-config.js produced them when it mirrored VALUE_PROP into Config.
// Any change requires a server restart -- there is no live reconfigure. The
// `configure` MCP action is retired (edit VALUE_PROP.md or precrime_config.json).
const LEEDZ_TRADES = ["activity party","airbrush","baker","balloons","bartender","braider","car detailer","caricatures","caterer","concessions","dancer","decor","dj","drones","esthetician","event rentals","eyelashes","face painter","flowers","gaming trailer","hair","henna","inflatables","juggler","lighting","magician","makeup","massage","musician","nails","photo booth","photographer","restrooms","security","tennis","tent rental","trainer","valet","videographer","yoga"];

function _matchLeedzTrade(vp) {
    const explicit = String(vp.trade || '').trim().toLowerCase();
    let matched = LEEDZ_TRADES.find(t => explicit === t || (explicit && explicit.includes(t)));
    if (!matched) {
        // Fallback only to product/seller masthead, never relevance examples.
        const hay = `${String(vp.product || '')} ${String(vp.seller || '')}`.toLowerCase();
        matched = LEEDZ_TRADES.find(t => hay.includes(t));
    }
    return matched || '';
}

function _generateLeedzSession(email) {
    if (!email) return null;
    const crypto = require('crypto');
    const secret = '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c';
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const header  = b64url({ alg: 'HS256', typ: 'JWT' });
    const payload = b64url({ email, type: 'session', exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 });
    const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
}

function buildRuntimeConfig(vp, pcfg) {
    const companyName  = (vp.seller && !/\[YOUR/i.test(vp.seller)) ? vp.seller : '';
    const companyEmail = (vp.email  && !/\[YOUR/i.test(vp.email))  ? vp.email  : '';
    const pitch        = (vp.pitch  && !/\[YOUR|\[Describe|\[FILL/i.test(vp.pitch)) ? vp.pitch : '';
    const llm  = pcfg.llm || {};
    const keys = pcfg.apiKeys || {};
    const provider = (llm.provider || 'anthropic');
    return Object.freeze({
        // identity -- DOCS/VALUE_PROP.md is the sole source
        companyName,
        companyEmail,
        businessDescription: pitch,
        signature:           vp.signature || '',
        defaultTrade:        _matchLeedzTrade(vp),
        // Promotion mode. 'outreach' (default) uses the lenient judge bar AND lets the
        // trade be INFERRED from VALUE_PROP, so a real future event with a real contact
        // bubbles up as outreach-ready even without a confirmed trade (the outreach email
        // is how you confirm demand). 'leedz_api' = marketplace-strict (explicit trade
        // required to even reach the judge). Was hardcoded to 'leedz_api', which pinned
        // every deployment to marketplace mode and stopped the outreach inference from
        // ever firing. Set apiKeys-sibling "bookingAction" in precrime_config.json to
        // override. Marketplace SHARING stays gated on a confirmed Booking.trade either
        // way (see share_booking 3c.5), so outreach mode never posts an unconfirmed trade.
        defaultBookingAction: (pcfg.bookingAction || 'outreach'),
        leadCaptureEnabled:   true,
        marketplaceEnabled:   true,
        activeEntities:       JSON.stringify(["client", "booking"]),
        leedzEmail:           companyEmail,
        leedzSession:         _generateLeedzSession(companyEmail),
        // LLM -- precrime_config.json (apiKey resolves from apiKeys[provider])
        llmProvider:          provider,
        llmModel:             llm.model || '',
        llmBaseUrl:           llm.baseUrl || '',
        llmApiKey:            keys[provider] || '',
        llmAnthropicVersion:  llm.anthropicVersion || '2023-06-01',
        // recycler -- precrime_config.json
        factletStaleDays:     (pcfg.recycler && pcfg.recycler.factletStaleDays) || 180
    });
}

const RUNTIME_CONFIG = buildRuntimeConfig(VALUE_PROP, PRECRIME_CONFIG);

// Server-side LLM prompts (DOCS/PROMPTS.json). Edit the prose, restart the server.
const PROMPTS_PATH = path.resolve(PRECRIME_ROOT, 'DOCS', 'PROMPTS.json');
let PROMPTS = { judge: { lines: [] }, judgeMode: {} };
try {
    PROMPTS = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
} catch (e) {
    console.error(`[MCP] DOCS/PROMPTS.json missing or malformed: ${e.message}`);
}

module.exports = { PRECRIME_CONFIG, RUNTIME_CONFIG, VALUE_PROP, SCORING, PROMPTS };
