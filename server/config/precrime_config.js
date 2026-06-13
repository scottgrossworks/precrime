// precrime_config.js -- loader for the runtime/API config file.
//
// Reads C:\Users\Admin\Desktop\WKG\PRECRIME\precrime_config.json (or the
// override path in process.env.PRECRIME_CONFIG_PATH), validates required
// runtime fields, fills missing fields from canonical defaults.
//
// This loader handles RUNTIME config only:
//   deploymentName, databaseFile, defaultMode, timezone,
//   apiKeys, llm, tasks.limits, recycler, paths.
//
// Product/sales truth (company, email, pitch, trade, buyers, geography)
// lives in DOCS/VALUE_PROP.md. It is never read from precrime_config.json.
//
// The loader does NOT read .env. It does NOT import dotenv. It does NOT
// read process.env for application config. If a third-party library needs
// process.env.X at import time, the calling startup code is responsible
// for setting process.env.X from the config value as one-line plumbing.
//
// Subsystem configs that intentionally stay separate:
//   - server\mcp\gmail_mcp_config.json (Gmail OAuth plumbing)
//   - rss\... reddit\... ig\... source lists (source-specific)
//   - server\mcp\mcp_server_config.json (MCP protocol metadata + logging)

'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
    deploymentName: 'MyProject',
    databaseFile:   'data/myproject.sqlite',
    defaultMode:    'interactive',
    apiKeys: {
        openai:         '',
        anthropic:      '',
        openrouter:     '',
        tavily:         '',
        scrapecreators: '',   // last30days social scrapers (IG/TikTok/Threads/Pinterest) -> SCRAPECREATORS_API_KEY
        xai:            ''     // X/Twitter via xAI -> XAI_API_KEY
    },
    llm: {
        provider: 'openai',
        model:    '',
        baseUrl:  ''
    },
    tasks: {
        limits: {
            DISCOVER_SOURCES: 1,
            SCRAPE_SOURCE:    5,
            APPLY_FACTLET:    5,
            ENRICH_CLIENT:    10,
            JUDGE_AFFECTED:   5,
            SHOW_HOT_LEEDZ:   1,
            SHARE_BOOKING:    3
        },
        // Session-wide work budget: max total Tasks of each type that one
        // Session may CREATE across the whole run (any status counts). Distinct
        // from `limits`, which caps how many open (ready/claimed) Tasks of a
        // type may exist at one moment. When a budget is reached, leftover
        // Sources / Clients / Factlets / Bookings stay in SQLite for the next
        // Session; nothing is deleted.
        sessionBudgets: {
            DISCOVER_SOURCES: 1,
            SCRAPE_SOURCE:    25,
            APPLY_FACTLET:    50,
            ENRICH_CLIENT:    50,
            JUDGE_AFFECTED:   50,
            SHOW_HOT_LEEDZ:   1,
            SHARE_BOOKING:    10
        }
    },
    recycler: {
        factletStaleDays:    180,
        taskRetentionDays:   30,
        claimTimeoutMinutes: 10
    },
    paths: {
        valueProp:     'DOCS/VALUE_PROP.md',
        rssConfig:     'rss/rss-scorer-mcp/rss_config.json',
        redditConfig:  'reddit/reddit_config.json',
        igConfig:      'ig/ig_config.json',
        gmailConfig:   'server/mcp/gmail_mcp_config.json'
    }
});

let cache = null;

function resolveConfigPath(opts) {
    if (opts && opts.path) return opts.path;
    if (process.env.PRECRIME_CONFIG_PATH) return process.env.PRECRIME_CONFIG_PATH;
    // server\config\precrime_config.js -> project root
    return path.resolve(__dirname, '..', '..', 'precrime_config.json');
}

function mergeDefaults(raw, fallbacks) {
    const out = {};

    function pick(key, defVal, label) {
        if (raw[key] === undefined || raw[key] === null) {
            fallbacks.push(`${label || key}: missing, using default`);
            out[key] = defVal;
        } else {
            out[key] = raw[key];
        }
    }

    pick('deploymentName', DEFAULTS.deploymentName);
    pick('databaseFile',   DEFAULTS.databaseFile);
    pick('defaultMode',    DEFAULTS.defaultMode);

    out.apiKeys = Object.assign({}, DEFAULTS.apiKeys, raw.apiKeys || {});
    out.llm     = Object.assign({}, DEFAULTS.llm,     raw.llm     || {});

    out.tasks = {
        limits: Object.assign({},
            DEFAULTS.tasks.limits,
            (raw.tasks && raw.tasks.limits) || {}),
        // Partial overrides preserved: missing keys fall back to defaults.
        sessionBudgets: Object.assign({},
            DEFAULTS.tasks.sessionBudgets,
            (raw.tasks && raw.tasks.sessionBudgets) || {})
    };

    out.recycler = Object.assign({}, DEFAULTS.recycler, raw.recycler || {});
    out.paths    = Object.assign({}, DEFAULTS.paths,    raw.paths    || {});

    if (!raw.apiKeys)  fallbacks.push('apiKeys: missing block, using defaults');
    if (!raw.llm)      fallbacks.push('llm: missing block, using defaults');
    if (!raw.tasks || !raw.tasks.limits)         fallbacks.push('tasks.limits: missing, using defaults');
    if (!raw.tasks || !raw.tasks.sessionBudgets) fallbacks.push('tasks.sessionBudgets: missing, using defaults');
    if (!raw.recycler) fallbacks.push('recycler: missing block, using defaults');
    if (!raw.paths)    fallbacks.push('paths: missing block, using defaults');

    return out;
}

// Forbidden keys: product/sales truth that must not appear in precrime_config.json.
// Asserted at load so misconfigured deployments surface immediately.
const FORBIDDEN_KEYS = [
    'companyName',
    'companyEmail',
    'businessDescription',
    'defaultTrade',
    'leedzEmail',
    'leedzSession',  // auto-generated by sync-config.js from VALUE_PROP email; never user-config
    'pitch',
    'buyers',
    'geography',
    'pricing',
    'outreachExamples',
    'marketplaceEnabled',
    'leadCaptureEnabled',
    'signature',
    'timezone'   // removed in the zip-derived-timezone repair; share_booking derives from Booking.zip
];

function assertNoValuePropFields(raw, fallbacks) {
    if (!raw || typeof raw !== 'object') return;
    for (const k of FORBIDDEN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(raw, k)) {
            fallbacks.push(
                `precrime_config.json contains forbidden VALUE_PROP field "${k}". ` +
                `Move it to DOCS/VALUE_PROP.md. Ignoring.`
            );
            delete raw[k];
        }
    }
}

/**
 * Load and validate precrime_config.json.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.refresh] - force re-read, bypass cache
 * @param {string}  [opts.path]    - explicit path override (highest priority)
 * @returns {Readonly<object>} frozen config object with shape:
 *   { ...fields, _source: string, fallbacks: string[] }
 */
function loadPrecrimeConfig(opts) {
    opts = opts || {};
    if (cache && !opts.refresh && !opts.path) return cache;

    const cfgPath  = resolveConfigPath(opts);
    const fallbacks = [];
    let raw = {};
    let source = cfgPath;

    if (!fs.existsSync(cfgPath)) {
        fallbacks.push(`precrime_config.json not found at ${cfgPath}, using defaults`);
        source = '(defaults)';
    } else {
        try {
            const text = fs.readFileSync(cfgPath, 'utf8');
            raw = JSON.parse(text);
            if (raw && typeof raw === 'object') delete raw._comment;
        } catch (e) {
            fallbacks.push(`precrime_config.json parse error (${e.message}), using defaults`);
            raw = {};
            source = `(defaults, parse error from ${cfgPath})`;
        }
    }

    assertNoValuePropFields(raw, fallbacks);

    const merged = mergeDefaults(raw, fallbacks);
    merged._source = source;
    merged.fallbacks = fallbacks;

    const frozen = Object.freeze(merged);
    if (!opts.path) cache = frozen;
    return frozen;
}

/**
 * Internal plumbing: set process.env.X from precrime_config.json values for
 * libraries that demand env vars at import time. Not user-facing. Not documented
 * as a workflow. Call once at server startup if a downstream lib requires it.
 *
 * @param {object} cfg - loaded config (must already be loaded)
 */
function applyApiKeysToProcessEnv(cfg) {
    if (!cfg || !cfg.apiKeys) return;
    const map = {
        OPENAI_API_KEY:         cfg.apiKeys.openai,
        ANTHROPIC_API_KEY:      cfg.apiKeys.anthropic,
        OPENROUTER_API_KEY:     cfg.apiKeys.openrouter,
        TAVILY_API_KEY:         cfg.apiKeys.tavily,
        SCRAPECREATORS_API_KEY: cfg.apiKeys.scrapecreators,
        XAI_API_KEY:            cfg.apiKeys.xai
    };
    for (const [name, val] of Object.entries(map)) {
        if (val && !process.env[name]) process.env[name] = val;
    }
}

module.exports = { loadPrecrimeConfig, applyApiKeysToProcessEnv, DEFAULTS, FORBIDDEN_KEYS };
