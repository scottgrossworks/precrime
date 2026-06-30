#!/usr/bin/env node
// bootstrap_config.js -- reads precrime_config.json and emits `set NAME=value`
// lines on stdout for .bat scripts to consume via:
//
//   for /f "usebackq delims=" %%v in (`node "%~dp0scripts\bootstrap_config.js"`) do %%v
//
// Output is Windows .bat syntax. Each line is one `set` statement (no quoting),
// suitable for `for /f` consumption.
//
// Variables emitted (runtime knobs only; never product/sales identity):
//   PRECRIME_DEPLOYMENT_NAME
//   PRECRIME_DATABASE_FILE
//   PRECRIME_DEFAULT_MODE
//   PRECRIME_LLM_PROVIDER
//   PRECRIME_LLM_MODEL
//   PRECRIME_LLM_BASE_URL
//   OPENAI_API_KEY          (only if non-empty in config)
//   ANTHROPIC_API_KEY       (only if non-empty in config)
//   OPENROUTER_API_KEY      (only if non-empty in config)
//   TAVILY_API_KEY          (only if non-empty in config)
//   SCRAPECREATORS_API_KEY  (only if non-empty; consumed by the last30days skill)
//   XAI_API_KEY             (only if non-empty; X/Twitter via last30days)
//
// Timezone is intentionally NOT emitted: share_booking derives the IANA zone
// from Booking.zip at leed creation time. Users do not configure a timezone.
//
// Refuses to emit anything when precrime_config.json is missing -- the .bat
// caller is expected to verify presence first and bail with a clear error.
//
// Does NOT read .env. Does NOT import dotenv.
'use strict';

const fs   = require('fs');
const path = require('path');
const { loadPrecrimeConfig } = require(path.resolve(__dirname, '..', 'server', 'config', 'precrime_config.js'));

const ROOT = path.resolve(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'precrime_config.json');

if (!fs.existsSync(CFG_PATH)) {
    process.stderr.write(`[bootstrap_config] FATAL: ${CFG_PATH} not found.\n`);
    process.stderr.write('[bootstrap_config] Copy precrime_config.sample.json to precrime_config.json and edit it.\n');
    process.exit(1);
}

const cfg = loadPrecrimeConfig({ refresh: true });

function emit(name, val) {
    if (val === undefined || val === null || val === '') return;
    const s = String(val).replace(/[\r\n]+/g, ' ');
    process.stdout.write(`set ${name}=${s}\n`);
}

emit('PRECRIME_DEPLOYMENT_NAME', cfg.deploymentName);
emit('PRECRIME_DATABASE_FILE',   cfg.databaseFile);
emit('PRECRIME_DEFAULT_MODE',    cfg.defaultMode);
emit('PRECRIME_LLM_PROVIDER',    cfg.llm && cfg.llm.provider);
emit('PRECRIME_LLM_MODEL',       cfg.llm && cfg.llm.model);
emit('PRECRIME_LLM_BASE_URL',    cfg.llm && cfg.llm.baseUrl);

// API keys: emit only when the user has filled them in precrime_config.json.
// Names match what node libs expect at import time; this is internal plumbing.
if (cfg.apiKeys) {
    emit('OPENAI_API_KEY',         cfg.apiKeys.openai);
    emit('ANTHROPIC_API_KEY',      cfg.apiKeys.anthropic);
    emit('OPENROUTER_API_KEY',     cfg.apiKeys.openrouter);
    emit('TAVILY_API_KEY',         cfg.apiKeys.tavily);
    // last30days reads these from os.environ (its highest-priority source), so the
    // launcher env IS the config -- no last30days .env file needed.
    emit('SCRAPECREATORS_API_KEY', cfg.apiKeys.scrapecreators);
    emit('XAI_API_KEY',            cfg.apiKeys.xai);
    // X via the free Bird backend uses browser session cookies, not the xAI key.
    emit('AUTH_TOKEN',             cfg.apiKeys.auth_token);
    emit('CT0',                    cfg.apiKeys.ct0);
    // last30days only queries sources named here. Default enables all; keyless
    // sources (reddit/youtube/hackernews) run free, keyed ones use the keys above.
    emit('INCLUDE_SOURCES', (cfg.last30days && cfg.last30days.includeSources)
        || 'reddit,youtube,hackernews,instagram,tiktok,x,threads');
}
