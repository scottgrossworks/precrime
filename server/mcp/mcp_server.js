/**
 * PRE-CRIME -- MCP SERVER (3 workflow tools)
 *
 * JSON-RPC server exposing 3 tools: pipeline, find, trades.
 * Collapses 22 CRUD tools into workflow-level operations.
 * Queries deployment SQLite directly via PrismaClient. No HTTP server.
 *
 * See DOCS/MCP_REWRITE.md for design rationale.
 *
 * @version 1.0.0
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Procedural cold/brewing/hot gates and the VALUE_PROP parser live in their own
// pure, unit-tested helper modules (see classification.test.js / value_prop.test.js).
const classification = require('./classification');
const verify = require('./verify');
const valueProp = require('./value_prop');

const PRECRIME_ROOT = path.resolve(__dirname, '..', '..');

// --- CRASH VISIBILITY ---
// Goose surfaces MCP failures as "-32603: Transport closed" with no detail.
// Tee stderr to data/mcp.log and install global handlers so a thrown error
// in any action doesn't kill the transport (and is recoverable post-mortem).
const MCP_LOG_PATH = path.resolve(PRECRIME_ROOT, 'data', 'mcp.log');
function logToDisk(prefix, ...args) {
    try {
        const line = `[${new Date().toISOString()}] ${prefix} ` +
            args.map(a => a instanceof Error ? (a.stack || a.message)
                : (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
        fs.appendFileSync(MCP_LOG_PATH, line);
    } catch (_) { /* logging must never throw */ }
}
const _origConsoleError = console.error.bind(console);
console.error = (...args) => { logToDisk('STDERR', ...args); _origConsoleError(...args); };
process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
});

// DATABASE_URL must be set BEFORE requiring PrismaClient.
// PrismaClient's require() triggers dotenv loading which can set DATABASE_URL
// from a stale .env file. Setting it here first prevents that.
if (process.env.DATABASE_URL) {
    // If env var exists but has a relative path, resolve from project root
    let raw = process.env.DATABASE_URL.replace(/^"/, '').replace(/"$/, '');
    const filePath = raw.replace(/^file:/, '');
    if (!path.isAbsolute(filePath)) {
        const resolved = path.resolve(PRECRIME_ROOT, filePath);
        process.env.DATABASE_URL = 'file:' + resolved;
    }
} else {
    // No env var at all -- default to data/myproject.sqlite
    process.env.DATABASE_URL = 'file:' + path.resolve(PRECRIME_ROOT, 'data', 'myproject.sqlite');
}

// Final safety: verify the resolved DB file actually exists
const resolvedDbPath = process.env.DATABASE_URL.replace(/^file:/, '');
if (!fs.existsSync(resolvedDbPath)) {
    const fallback = path.resolve(PRECRIME_ROOT, 'data', 'myproject.sqlite');
    console.error(`[MCP] WARNING: DB not found at ${resolvedDbPath}`);
    if (fs.existsSync(fallback)) {
        console.error(`[MCP] Falling back to ${fallback}`);
        process.env.DATABASE_URL = 'file:' + fallback;
    } else {
        console.error(`[MCP] FATAL: No database found. Expected: ${resolvedDbPath}`);
        process.exit(1);
    }
}

// Internal config (logging, MCP metadata)
const CONFIG_PATH = path.resolve(__dirname, 'mcp_server_config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (error) {
    console.error(`[MCP] FATAL: mcp_server_config.json not found: ${error.message}`);
    process.exit(1);
}

// Runtime/API config (Subproject 10). Optional file; loader returns defaults
// if absent so the server still boots during the transition.
const { PRECRIME_CONFIG, RUNTIME_CONFIG, VALUE_PROP, SCORING, PROMPTS } = require('./runtime');

if (!process.env.DATABASE_URL || process.env.DATABASE_URL === 'file:' || process.env.DATABASE_URL === 'file:undefined') {
    console.error('[MCP] FATAL: DATABASE_URL is not set or is empty.');
    console.error('[MCP]   databaseFile in precrime_config.json must point to a .sqlite file.');
    console.error('[MCP]   Example: "databaseFile": "data/myproject.sqlite"');
    process.exit(1);
}
const dbPath = process.env.DATABASE_URL.replace(/^file:/, '');
if (!fs.existsSync(dbPath)) {
    console.error(`[MCP] FATAL: Database file not found: ${dbPath}`);
    console.error('[MCP]   Check databaseFile in precrime_config.json and ensure the file exists.');
    process.exit(1);
}
// LLM key check: conductor workers make LLM calls; fail fast rather than
// silently erroring on every task.
(function checkLlmKey() {
    const provider = (PRECRIME_CONFIG.llm && PRECRIME_CONFIG.llm.provider) || 'openrouter';
    const keyMap = {
        openai:     process.env.OPENAI_API_KEY,
        anthropic:  process.env.ANTHROPIC_API_KEY,
        openrouter: process.env.OPENROUTER_API_KEY,
    };
    const key = keyMap[provider.toLowerCase()];
    if (key === undefined) {
        console.error(`[MCP] FATAL: Unknown llm.provider "${provider}" in precrime_config.json.`);
        console.error('[MCP]   Expected one of: openai, anthropic, openrouter.');
        process.exit(1);
    }
    if (!key) {
        console.error(`[MCP] FATAL: apiKeys.${provider} is empty in precrime_config.json.`);
        console.error(`[MCP]   The MCP server cannot make LLM calls without a key.`);
        console.error(`[MCP]   Fill in apiKeys.${provider} and restart.`);
        process.exit(1);
    }
    if (!process.env.TAVILY_API_KEY) {
        console.error('[MCP] FATAL: apiKeys.tavily is empty in precrime_config.json.');
        console.error('[MCP]   Tavily is required for source discovery and URL scraping.');
        process.exit(1);
    }
})();

// Prisma singleton lives in db.js (one instance shared with conductor.js).
// DATABASE_URL is already set above -- db.js picks it up at require() time.
const { prisma } = require('./db');
// Markdown is the single source of truth for scrape sources. The store owns the
// per-channel files + an ephemeral in-memory index and is the sole writer.
const { createSourceStore } = require('./sourceStore');
const sourceStore = createSourceStore({ root: PRECRIME_ROOT });
const { startConductor, armConductor } = require('./conductor');
const dates = require('./dates');
const { isStrictDateValue, strictDateToDate, resolveEventDatesLegacy, zipToTimezone, wallClockInZoneToEpoch, formatIsoWithZone, resolveEventDates } = dates;
const { looksLikeJson, createSuccessResponse, createErrorResponse, sendJsonRpcResponse, safeJson } = require('./responses');
console.error(`[MCP] Database: ${dbPath}`);

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

/**
 * Resolve the absolute path for log file
 * Ensures logs are written to server root directory
 */
function getLogFilePath() {
    const configuredPath = config.logging?.file || './mcp_server.log';
    return path.resolve(__dirname, configuredPath);
}

const LOG_FILE_PATH = getLogFilePath();

// Ensure log directory exists
try {
    fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });
} catch (error) {
    // Directory may already exist
}

/**
 * Write log entry to file with timestamp
 * @param {string} level - Log level (debug, info, warn, error)
 * @param {string} message - Message to log
 */
function writeLogEntry(level, message) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    try {
        fs.appendFileSync(LOG_FILE_PATH, entry);
    } catch (error) {
        console.error('Failed to write log file:', error.message);
    }

    // Only show warnings and errors on stderr to avoid cluttering client UI
    if (level === 'error' || level === 'warn') {
        console.error(entry.trim());
    }
}

// Convenient logging functions
const logDebug = (message) => writeLogEntry('debug', message);
const logInfo = (message) => writeLogEntry('info', message);
const logWarn = (message) => writeLogEntry('warn', message);
const logError = (message) => writeLogEntry('error', message);

function summarizeToolArgs(args = {}) {
    const summary = {};
    for (const [key, value] of Object.entries(args)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('password')) {
            summary[key] = '[redacted]';
        } else if (Array.isArray(value)) {
            summary[key] = `[array:${value.length}]`;
        } else if (value && typeof value === 'object') {
            summary[key] = `{${Object.keys(value).join(',')}}`;
        } else {
            summary[key] = value;
        }
    }
    return summary;
}


// ============================================================================
// MCP PROTOCOL HANDLERS
// ============================================================================

function handleInitialize(id) {
    logInfo('Handling MCP initialize request');
    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: {
                name: "precrime",
                version: "1.0.0"
            }
        }
    };
}

function handleToolsList(id) {
    logInfo('Handling tools/list request (3 tools)');
    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            tools: [
                {
                    name: 'pipeline',
                    description: [
                        'Pre-Crime workflow operations. One tool, fifteen actions: status, configure, next, save, delete, rescore, resolve_dates, start_session, report_session, audit_session, next_source, mark_source, add_sources, import_sources, work_status.',
                        '',
                        'action="status": Read full system state in one call. Returns { config, stats, completeness, readyDrafts, brewingCount }. completeness is a derived check of whether config has the fields needed for the current defaultBookingAction. Use this at startup and between enrichment rounds.',
                        '',
                        'action="configure": Update Config fields. Pass patch with any Config fields (companyName, companyEmail, businessDescription, activeEntities, defaultTrade, marketplaceEnabled, leadCaptureEnabled, leedzEmail, leedzSession, llmApiKey, llmProvider, llmModel, llmBaseUrl, llmAnthropicVersion, llmMaxTokens, factletStaleDays, defaultBookingAction). Returns updated config.',
                        '',
                        'action="next": Atomically claim the next work item and return it fully hydrated. Pass entity="client" (default) or entity="booking". For clients: returns the client record with all linked factlets and bookings in one payload. The lastQueueCheck is stamped before return so no other agent claims it. Pass optional criteria to filter (company, name, draftStatus). Returns null if queue is empty. Response is automatically trimmed for context efficiency: dossier tail-clipped to last 2000 chars (or override via dossierLimit), factlets capped to 8 most recent (or override via factletLimit). Pass 0 to disable a cap. _clipped metadata is included if anything was trimmed.',
                        '',
                        'action="save": Atomically persist client work in a single transaction. Two modes: (1) UPDATE existing client - pass id and patch with any of: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. (2) CREATE new client - omit id, patch must include name OR company. Company-only sparse records are allowed when relevant; enrichment fills person/email later. Optional fields: email, phone, website, segment, source, factlets[], bookings[]. Optionally pass session_id (returned by start_session) to log this save against an open workflow session. After persisting, refreshes the client enrichment signal AND re-classifies every booking under that client to cold / brewing / hot via the procedural gates (server/mcp/classification.js) plus the LLM product-market-fit judge. See DOCS/CLASSIFICATION.md.',
                        '',
                        'action="delete": Permanently remove a record. Pass target ("booking" | "client" | "factlet") and id. For target="client", any attached bookings and factlet links are removed too (cascade). Returns { deleted: true, target, id, cascadedBookings, cascadedFactlets }. Use this when the user says "delete this booking", "remove this client", "drop this factlet", or any imperative removal.',
                        '',
                        'action="rescore": Re-classify every booking to cold / brewing / hot (procedural gates + LLM judge). Use after editing DOCS/CLASSIFICATION.md policy or DOCS/SCORING.json knobs. Pass scope="all" (default), scope="hot" to sanity-check the current hot queue, or scope=<clientId> to limit to one client. Returns counts: rescored, changed, before/after status distribution.',
                        '',
                        'action="resolve_dates": STRUCTURED-ONLY. Server-side date validation + tz-aware epoch math. Required: start { year, month, day, hour, minute, ampm? }, end { year, month, day, hour, minute, ampm? }, timezone (IANA, e.g. "America/Los_Angeles"). Optional: zip (echoed only -- zip-to-tz derivation NOT supported), rawText (informational evidence only -- timezone smuggled inside rawText is REJECTED), sourceProof. The LLM is forbidden from computing epoch ms; it must only extract the structured fields. Returns { ok, st, et, startIso, endIso, timezone, zip, warnings } on success, or { ok:false, errors:[fieldName:reason] } on failure.',
                        '',
                        'action="share_booking": ONLY normal path to marketplace posting. Required: bookingId, mode ("draft" | "post"). FORBIDDEN inputs: st, et (LLM-supplied epochs are rejected by name). Loads the Booking + Client, rescores via judgeAffected, requires status hot, then converts the Booking\'s already-verified wall-clock dates (set at enrichment) to a tz-correct epoch -- no re-resolution. In "draft" mode returns the addLeed payload + humanReadable verification block. In "post" mode posts to Leedz and records leedId/sharedAt.',
                        '',
                        'action="start_session": Open a workflow session and receive a server-issued session_id. Pass workflow (string, e.g. "convention-leeds") and optional target_count (e.g. 5) and metadata (object). The session_id MUST be passed to subsequent save calls in this workflow so the server can log each save. Use this BEFORE any save calls when you intend to summarize results — the report_session call will return the truth.',
                        '',
                        'action="report_session": Close a session and return the SERVER-COMPUTED truth: { session_id, workflow, requested, actually_saved, failed, saved_clients[], failures[], duration_ms }. THIS IS THE ONLY SANCTIONED SUMMARY OF SESSION RESULTS. Echo its output verbatim. DO NOT write your own "N clients created" prose — the server is the single source of truth. Pass session_id (required).',
                        '',
                        'action="audit_session": Show what the agent ACTUALLY did this session — saves, failures, shares, raw event log from the server. THIS IS THE TOOL TO USE when the user says "show the audit", "what did you do", "what did you save", "show your work", "audit", "show me what happened", or any progress check. Returns the unfakeable server-side event record, not the agent\'s memory. session_id is OPTIONAL — if omitted, audits the most recent session automatically. NEVER substitute action=status for an audit request — status returns config snapshots, not the work record.',
                        '',
                        'action="next_source": Atomically claim the oldest unscraped or stale source URL from the queue. Pass optional channel ("directory"|"rss"|"fb"|"ig"|"reddit"|"x"|"blog"|"website") to filter. Optional maxAgeDays (default 30) -- sources scraped longer ago than this are eligible for re-scrape. Optional session_id stamps the claim. Returns { status: "CLAIMED", id, url, channel, subtype, label, category, discoveredFrom, previouslyScrapedAt } or { status: "QUEUE_EMPTY", channel } when nothing is available. Stale claims (>10min with no mark_source) are eligible for re-claim. THIS REPLACES reading discovered_directories.md by hand.',
                        '',
                        'action="mark_source": Release the claim and persist the scrape result. REQUIRED url (the URL returned by next_source). Optional scrapedAt (ISO datetime, defaults to now), clientsFound (integer), failedReason (string for failures), session_id (pass the active workflow session_id so report_session can distinguish "scraped, no clients" from "did nothing"). Pair this with every next_source -- if you do not mark, the row stays claimed for 10 minutes then becomes claimable again. THIS REPLACES "echo url ^| scraped:date >> discovered_directories.md".',
                        '',
                        'action="add_sources": Bulk-insert new source URLs discovered during scraping. REQUIRED entries[] -- non-empty array of { url, channel, subtype?, label?, category?, discoveredFrom? }. Channel must be one of the eight allowed values. URLs are normalized to canonical form (handle/tag inputs like "@account" or "r/sub" become full URLs). Returns { added, duplicates, invalid[] }. Dedup is on URL. THIS REPLACES every "echo line >> *_sources.md" shell command in every harvester and source-discovery skill.',
                        '',
                        'action="import_sources": DEPRECATED. Markdown is the single source of truth: the server reads data/sources/<channel>.md into an in-memory index at startup, so there is no separate import step. This action just re-reads those files and returns the live per-channel counts. There is no Source table.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['status', 'configure', 'get_config', 'get_task', 'next', 'save', 'delete', 'rescore', 'resolve_dates', 'share_booking', 'dismiss_booking', 'start_session', 'report_session', 'audit_session', 'next_source', 'mark_source', 'add_sources', 'import_sources', 'work_status', 'judge_affected', 'plan_tasks', 'claim_task', 'complete_task', 'tasks', 'recycler'],
                                description: 'Which pipeline operation to run.'
                            },
                            text: {
                                type: 'string',
                                description: 'For action=resolve_dates: DEPRECATED. The structured-only path is authoritative; text is ignored except as evidence echo.'
                            },
                            sourceUrl: {
                                type: 'string',
                                description: 'For action=resolve_dates: optional source URL kept only for provenance. No longer used for date math.'
                            },
                            defaultDurationHours: {
                                type: 'number',
                                description: 'DEPRECATED. Structured resolve_dates requires explicit end fields.'
                            },
                            rawText: {
                                type: 'string',
                                description: 'For action=resolve_dates: informational raw evidence text. NEVER used to derive timezone or epoch -- structured fields are required.'
                            },
                            start: {
                                type: 'object',
                                description: 'For action=resolve_dates: { year, month (1-12), day, hour, minute, ampm? }. Required.',
                                properties: {
                                    year:   { type: 'integer' },
                                    month:  { type: 'integer' },
                                    day:    { type: 'integer' },
                                    hour:   { type: 'integer' },
                                    minute: { type: 'integer' },
                                    ampm:   { type: 'string', enum: ['AM', 'PM', 'am', 'pm'] }
                                }
                            },
                            end: {
                                type: 'object',
                                description: 'For action=resolve_dates: { year, month, day, hour, minute, ampm? }. Required. Overnight events must supply the next-day date.',
                                properties: {
                                    year:   { type: 'integer' },
                                    month:  { type: 'integer' },
                                    day:    { type: 'integer' },
                                    hour:   { type: 'integer' },
                                    minute: { type: 'integer' },
                                    ampm:   { type: 'string', enum: ['AM', 'PM', 'am', 'pm'] }
                                }
                            },
                            timezone: {
                                type: 'string',
                                description: 'For action=resolve_dates: IANA timezone, e.g. "America/Los_Angeles". Required. Timezone smuggled inside rawText is rejected.'
                            },
                            zip: {
                                type: 'string',
                                description: 'For action=resolve_dates: 5-digit zip. Echoed only -- no zip-to-tz derivation.'
                            },
                            sourceProof: {
                                type: 'string',
                                description: 'For action=resolve_dates / share_booking: provenance string (email id, URL, snippet).'
                            },
                            bookingId: {
                                type: 'string',
                                description: 'For action=share_booking: Booking.id to share.'
                            },
                            mode: {
                                type: 'string',
                                enum: ['draft', 'post'],
                                description: 'For action=share_booking: "draft" returns the payload + humanReadable; "post" posts to Leedz.'
                            },
                            titleDraft: {
                                type: 'string',
                                description: 'Optional share_booking prose override for payload.ti only. No emails, phones, epochs, or unsupported date/time claims.'
                            },
                            dtDraft: {
                                type: 'string',
                                description: 'Optional share_booking prose override for payload.dt only. Vendor-facing event prose; additional useful contact info is allowed when evidence-backed. No epochs, payload fields, or unsupported date/time claims.'
                            },
                            rqDraft: {
                                type: 'string',
                                description: 'Optional share_booking prose override for payload.rq only. Requirements/follow-up prose; additional useful contact info is allowed when evidence-backed. No epochs, payload fields, or unsupported date/time claims.'
                            },
                            st: {
                                type: 'number',
                                description: 'FORBIDDEN on share_booking. The LLM is not allowed to supply marketplace epoch ms. Pass structured date pieces and let MCP resolve them.'
                            },
                            et: {
                                type: 'number',
                                description: 'FORBIDDEN on share_booking. The LLM is not allowed to supply marketplace epoch ms. Pass structured date pieces and let MCP resolve them.'
                            },
                            channel: {
                                type: 'string',
                                enum: ['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website'],
                                description: 'For action=next_source: filter to one channel. Omit to claim from any channel.'
                            },
                            maxAgeDays: {
                                type: 'number',
                                description: 'For action=next_source: a previously-scraped source is eligible for re-scrape if its scrapedAt is older than this many days. Default 30.'
                            },
                            url: {
                                type: 'string',
                                description: 'For action=mark_source: the URL returned by next_source.'
                            },
                            scrapedAt: {
                                type: 'string',
                                description: 'For action=mark_source: ISO datetime. Defaults to now if omitted.'
                            },
                            clientsFound: {
                                type: 'number',
                                description: 'For action=mark_source: number of distinct companies/contacts saved from this URL. 0 if scrape failed.'
                            },
                            failedReason: {
                                type: 'string',
                                description: 'For action=mark_source: short error string if scrape failed (e.g., "timeout", "404", "parse error"). Omit on success.'
                            },
                            entries: {
                                type: 'array',
                                description: 'For action=add_sources: array of { url, channel, subtype?, label?, category?, discoveredFrom? }. Channel: directory|rss|fb|ig|reddit|x|blog|website. discoveredFrom is the URL of the source that linked here (recursion lineage).',
                                items: {
                                    type: 'object',
                                    properties: {
                                        url: { type: 'string' },
                                        channel: { type: 'string', enum: ['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website'] },
                                        subtype: { type: 'string' },
                                        label: { type: 'string' },
                                        category: { type: 'string' },
                                        discoveredFrom: { type: 'string' }
                                    },
                                    required: ['url', 'channel']
                                }
                            },
                            workflow: {
                                type: 'string',
                                description: 'For action=start_session only. Name of the workflow being run, e.g. "convention-leeds", "enrichment", "drafting".'
                            },
                            target_count: {
                                type: 'number',
                                description: 'For action=start_session only. Optional declared target (e.g. 5 if you intend to save 5 clients). Used by report_session to compare requested vs actually_saved.'
                            },
                            metadata: {
                                type: 'object',
                                description: 'For action=start_session only. Optional JSON blob of workflow-specific params (e.g. {region:"LA", segment:"convention"}).'
                            },
                            session_id: {
                                type: 'string',
                                description: 'For action=save (optional, links the save to an open session) or action=report_session/audit_session (REQUIRED). Server-issued by start_session. Cannot be self-generated.'
                            },
                            scope: {
                                type: 'string',
                                description: 'For action=rescore only. "all" (default) re-classifies every booking. "hot" sanity-checks only the current hot queue. Or pass a clientId to re-classify one client only. Use after editing DOCS/CLASSIFICATION.md or DOCS/SCORING.json.'
                            },
                            entity: {
                                type: 'string',
                                enum: ['client', 'booking'],
                                description: 'For action=next only. Which entity queue to pull from. Defaults to client.'
                            },
                            criteria: {
                                type: 'object',
                                description: 'For action=next only. Optional filters: { company, name, draftStatus, segment, lastEnrichedBefore }. Pass lastEnrichedBefore as an ISO datetime string (e.g. 30 days ago) to skip recently-enriched clients and prioritize new contacts.',
                                properties: {
                                    company: { type: 'string' },
                                    name: { type: 'string' },
                                    draftStatus: { type: 'string' },
                                    segment: { type: 'string' },
                                    lastEnrichedBefore: { type: 'string', description: 'ISO datetime. Only return clients whose lastEnriched is null or older than this timestamp. Use to skip recently-enriched clients.' }
                                }
                            },
                            dossierLimit: {
                                type: 'number',
                                description: 'For action=next only. Max chars of dossier to return, tail-clipped (most recent kept). Default 2000. Pass 0 to return full dossier.'
                            },
                            factletLimit: {
                                type: 'number',
                                description: 'For action=next only. Max factlets to return (most recent first). Default 8. Pass 0 for all.'
                            },
                            id: {
                                type: 'string',
                                description: 'For action=save: Client ID to update. OMIT this to CREATE a new client (patch.name OR patch.company then required). For action=delete: the ID of the record to delete (booking ID, client ID, or factlet ID — must match target).'
                            },
                            target: {
                                type: 'string',
                                enum: ['booking', 'client', 'factlet'],
                                description: 'For action=delete only. Which kind of record to delete. id must point to a record of this type.'
                            },
                            patch: {
                                type: 'object',
                                description: 'For action=save or action=configure. For save UPDATE: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. For save CREATE (no id): name OR company is required; sparse company-only records are allowed when relevant. Optional: email, phone, website, segment, source, factlets[], bookings[]. For configure: any Config model fields.'
                            },
                            taskId: {
                                type: 'string',
                                description: 'For action=complete_task. The id of the claimed Task being completed.'
                            },
                            status: {
                                type: 'string',
                                description: 'For action=complete_task: "done" | "failed" | "cancelled". For action=tasks: optional status filter.'
                            },
                            output: {
                                type: 'object',
                                description: 'For action=complete_task. Result blob, e.g. { clientIds:[], bookingIds:[], factletIds:[], sourceIds:[], summary, needsJudge }. Pass the object directly, NOT a JSON string.'
                            },
                            error: {
                                type: 'string',
                                description: 'For action=complete_task with status "failed"/"cancelled". Short error code.'
                            },
                            role: {
                                type: 'string',
                                description: 'For action=claim_task. Claimer label, e.g. "worker" | "interactive-orchestrator".'
                            },
                            types: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=claim_task. Optional list of Task types this claimer accepts (e.g. ["APPLY_FACTLET"]). Omit to accept any. Pass the array directly, NOT a JSON string.'
                            },
                            clientIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=judge_affected. Client ids to (re-)judge. Pass the array DIRECTLY (e.g. ["school-013"]), NOT a JSON string and NOT wrapped in another object.'
                            },
                            bookingIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=judge_affected. Booking ids to (re-)judge. Pass the array DIRECTLY, NOT a JSON string.'
                            },
                            reason: {
                                type: 'string',
                                description: 'For action=judge_affected. Optional audit note.'
                            },
                            writeStatus: {
                                type: 'boolean',
                                description: 'For action=judge_affected. Default true; pass false to compute without persisting Booking.status.'
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    name: 'find',
                    description: [
                        'Read-only search across the Pre-Crime database. One tool, four actions.',
                        '',
                        'action="clients": Search clients by name, email, company, segment, draftStatus, warmth range. Default summary=true returns slim records (no dossier/draft/targetUrls). Pass summary=false only when you need full records. Default limit 10. Sorted by dossierScore descending.',
                        '',
                        'action="bookings": Search bookings by status, trade, keyword (checks title, description, notes, location). Returns bookings with slim client stub. Default limit 20. Sorted by createdAt descending.',
                        '',
                        'action="factlets": Get factlets. Pass filters.sinceTimestamp (ISO string) for queue checking, or filters.clientId for a specific client. Returns factlets sorted by createdAt ascending.',
                        '',
                        'action="drafts": Get clients with draftStatus="ready", sorted by dossierScore descending. Pass summary=true for slim records. Default limit 10. Optional filters.minScore for minimum dossierScore.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['clients', 'bookings', 'factlets', 'drafts'],
                                description: 'Which entity type to search.'
                            },
                            filters: {
                                type: 'object',
                                description: 'Action-specific filters. clients: search, name, email, company, segment, draftStatus, warmthScore, minWarmthScore, maxWarmthScore. bookings: status, trade, search. factlets: sinceTimestamp, clientId. drafts: minScore.'
                            },
                            summary: {
                                type: 'boolean',
                                description: 'Default true. When true, returns slim records without heavy text fields (dossier, draft, targetUrls). Pass false only when you need full records.'
                            },
                            limit: {
                                type: 'number',
                                description: 'Max results. Default 10 for clients/drafts, 20 for bookings.'
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    name: 'trades',
                    description: 'Fetch the canonical Leedz marketplace trade names from the Leedz API. Returns a sorted array of trade name strings (e.g. ["bartender", "caricatures", "dj", "photo booth"]). This is the ONLY authoritative source for valid Leedz trades. Never guess from training data. Cached 10 minutes. Serves stale cache on network failure.',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ]
        }
    };
}

// ============================================================================
// SCORING LOGIC (lifted from v1 verbatim)
// ============================================================================

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

async function computeClientScore(clientId, intelOverride) {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return null;

    const staleDays = await getFactletStaleDays();
    // Live Factlet relevance via cheap content/source overlap on the Client's
    // stable identifiers (name / company / website host). No join table.
    const liveFactlets = await findLiveFactletsForClient(client, staleDays);
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
    if (client) await computeClientScore(client.id, null);

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

// ============================================================================
// PIPELINE TOOL HANDLER
// ============================================================================

// Defaults for response trimming (see clipClientForResponse).
const DEFAULT_DOSSIER_LIMIT = 2000;
const DEFAULT_FACTLET_LIMIT = 8;

/**
 * Tail-clip dossier and cap factlet array to keep response payloads tight.
 * The model rarely needs the full historical dossier on every turn — recent
 * entries are usually all that matters. Cutting here saves significant
 * tokens per `next` call, especially after a client has been enriched many
 * times.
 *
 * dossierLimit / factletLimit args, when passed, override the defaults.
 * Pass 0 to disable a cap (return full content). Pass undefined for default.
 */
function clipClientForResponse(client, dossierLimit, factletLimit) {
    if (!client || typeof client !== 'object') return client;

    const dLimit = (dossierLimit === undefined) ? DEFAULT_DOSSIER_LIMIT : Number(dossierLimit);
    const fLimit = (factletLimit === undefined) ? DEFAULT_FACTLET_LIMIT : Number(factletLimit);

    const out = { ...client };
    const meta = {};

    if (dLimit > 0 && typeof out.dossier === 'string' && out.dossier.length > dLimit) {
        const tail = out.dossier.slice(-dLimit);
        // Try to start at a clean line boundary so timestamped entries stay readable
        const nlIdx = tail.indexOf('\n');
        const clipped = (nlIdx > 0 && nlIdx < dLimit - 200) ? tail.slice(nlIdx + 1) : tail;
        out.dossier = `[...older dossier truncated, showing last ${clipped.length} chars]\n${clipped}`;
        meta.dossierFullLength = client.dossier.length;
        meta.dossierTruncated = true;
    }

    if (Array.isArray(out.factlets) && fLimit > 0 && out.factlets.length > fLimit) {
        meta.factletsFullCount = out.factlets.length;
        meta.factletsLimited = true;
        out.factlets = out.factlets.slice(0, fLimit); // already ordered desc by appliedAt
    }

    if (Object.keys(meta).length > 0) out._clipped = meta;
    return out;
}

async function handlePipeline(id, params) {
    const args = params.arguments || {};
    // Defensive default: if the model calls pipeline() with no action or
    // action=undefined, treat it as status. Beats erroring for what is almost
    // always "show me where things stand."
    let action = args.action;
    if (action === undefined || action === null || action === 'undefined' || action === '') {
        action = 'status';
    }

    logInfo(`pipeline action=${action} args=${JSON.stringify(summarizeToolArgs(args))}`);

    // 3-min save-or-terminate watchdog runs on every read-style action.
    // Save itself is the way OUT of termination, so we don't watchdog it.
    const READ_ACTIONS = new Set(['status', 'next', 'rescore']);
    if (READ_ACTIONS.has(action)) {
        const wd = await enforceSessionWatchdog(id);
        if (wd.terminated) return wd.errorResponse;
    }

    switch (action) {
        case 'status':         return await pipelineStatus(id);
        case 'configure':      return await pipelineConfigure(id, args.patch || {});
        case 'get_config':     return await pipelineGetConfig(id, args);
        case 'get_task':       return await pipelineGetTask(id, args);
        case 'next':           return await pipelineNext(id, args.entity || 'client', args.criteria || {}, args.dossierLimit, args.factletLimit);
        case 'save':           return await pipelineSave(id, args.id, args.patch || {}, args.session_id || null, args.judge !== false, args.factletId || null);
        case 'judge_affected': return await pipelineJudgeAffected(id, args);
        case 'plan_tasks':     return await pipelinePlanTasks(id, args);
        case 'claim_task':     return await pipelineClaimTask(id, args);
        case 'complete_task':  return await pipelineCompleteTask(id, args);
        case 'tasks':          return await pipelineTasks(id, args);
        case 'recycler':       return await pipelineRecycler(id, args);
        case 'delete':         return await pipelineDelete(id, args.target, args.id);
        case 'rescore':        return await pipelineRescore(id, args.scope || 'all');
        case 'resolve_dates':  return createSuccessResponse(id, JSON.stringify(await resolveEventDates(args), null, 2));
        case 'share_booking':  return await pipelineShareBooking(id, args);
        case 'dismiss_booking': return await pipelineDismissBooking(id, args);
        case 'start_session':  return await pipelineStartSession(id, args.workflow, args.target_count, args.metadata);
        case 'report_session': return await pipelineReportSession(id, args.session_id, /*close=*/true);
        case 'audit_session':  return await pipelineReportSession(id, args.session_id, /*close=*/false);
        case 'next_source':    return await pipelineNextSource(id, args.channel, args.maxAgeDays, args.session_id);
        case 'mark_source':    return await pipelineMarkSource(id, args.url, args.scrapedAt, args.clientsFound, args.failedReason, args.session_id);
        case 'add_sources':    return await pipelineAddSources(id, args.entries);
        case 'import_sources': return await pipelineImportSources(id);
        case 'work_status':    return await pipelineWorkStatus(id);
        default:
            return createErrorResponse(id, -32602, `Unknown pipeline action: "${action}". Must be: status, configure, get_config, get_task, next, save, delete, rescore, resolve_dates, share_booking, dismiss_booking, start_session, report_session, audit_session, next_source, mark_source, add_sources, import_sources, work_status, judge_affected, plan_tasks, claim_task, complete_task, tasks, recycler.`);
    }
}

// ============================================================================
// SOURCE QUEUE OPERATIONS (Pass 2 -- queue-in-DB, not queue-in-markdown)
// ============================================================================
// pipeline.next_source({channel?, maxAgeDays:30, session_id?})
//   Atomic claim of the oldest unscraped or stale source row. Returns
//   { status: "CLAIMED", id, url, channel, subtype, label, category, ... }
//   or { status: "QUEUE_EMPTY", channel } if nothing to do.
//   Stale claims (>10min old, no mark_source) are eligible for re-claim --
//   work-stealing, no zombie sessions.
//
// pipeline.mark_source({url, scrapedAt?, clientsFound?, failedReason?})
//   Releases the claim and persists the result. scrapedAt defaults to now.
//
// pipeline.add_sources({entries:[{url, channel, subtype?, label?, category?,
//                                 discoveredFrom?}]})
//   Bulk insert with dedup-on-url. Channels: directory|rss|fb|ig|reddit|x|
//   blog|website. URL is normalized to canonical form (handle/tag inputs
//   become real URLs).
//
// pipeline.import_sources()
//   One-time migration. Reads every _sources.md / discovered_directories.md
//   under skills/, parses, and bulk-adds via add_sources logic. Idempotent.
//   Run once at first-deploy or whenever seed files change.
// ============================================================================

const VALID_CHANNELS = new Set(['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website']);

// Channels that need a real browser to render. Tavily / WebFetch on these
// returns navigation chrome and zero useful content. When pipeline.next_source
// is called WITHOUT an explicit channel filter, we exclude these by default --
// agents that misspell or omit `channel` (a common LLM error) won't burn the
// loop on zero-yield browser-only sources. Dedicated harvesters that need
// these channels pass the channel explicitly (e.g., fb-harvester passes
// channel:'fb' when iterating its own queue).
const BROWSER_ONLY_CHANNELS = ['fb', 'ig', 'x'];
const URL_VERIFY_TIMEOUT_MS = 10000;
const URL_VERIFY_TEXT_LIMIT = 500000;
const URL_VERIFY_CHANNELS = new Set(['directory', 'rss', 'blog', 'website']);

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function compactUrlForCompare(value) {
    try {
        const u = new URL(value);
        return {
            host: u.hostname.replace(/^www\./i, '').toLowerCase(),
            path: (u.pathname || '/').replace(/\/+$/, '') || '/'
        };
    } catch (_) {
        return null;
    }
}

function looksLikeHomepageRedirect(originalUrl, finalUrl) {
    const original = compactUrlForCompare(originalUrl);
    const final = compactUrlForCompare(finalUrl);
    if (!original || !final) return false;
    return original.host === final.host && original.path !== '/' && final.path === '/';
}


async function fetchUrlTextForProof(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_VERIFY_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': 'PreCrimeEvidenceVerifier/1.0',
                'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
            }
        });
        const contentType = res.headers.get('content-type') || '';
        const text = contentType.includes('text') || contentType.includes('html') || contentType.includes('json')
            ? (await res.text()).slice(0, URL_VERIFY_TEXT_LIMIT)
            : '';
        return { ok: true, status: res.status, finalUrl: res.url || url, text };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
        clearTimeout(timer);
    }
}

async function verifyEvidenceUrl(url, options = {}) {
    if (!isHttpUrl(url)) return { ok: true, skipped: true };

    const fetched = await fetchUrlTextForProof(url);
    if (!fetched.ok) return { ok: false, reason: `fetch_failed:${fetched.error}` };
    if (fetched.status < 200 || fetched.status >= 300) {
        return { ok: false, reason: `http_status:${fetched.status}` };
    }
    if (looksLikeHomepageRedirect(url, fetched.finalUrl)) {
        return { ok: false, reason: `redirect_to_homepage:${fetched.finalUrl}` };
    }

    const text = (fetched.text || '').toLowerCase();
    const expectedYear = options.expectedYear;
    if (expectedYear && !text.includes(String(expectedYear))) {
        return { ok: false, reason: `missing_year:${expectedYear}` };
    }

    const terms = options.proofTerms || [];
    if (terms.length > 0 && !terms.some(t => text.includes(String(t).toLowerCase()))) {
        return { ok: false, reason: `source_does_not_mention_claim_terms:${terms.slice(0, 5).join(',')}` };
    }

    return { ok: true, status: fetched.status, finalUrl: fetched.finalUrl };
}


function normalizeSourceUrl(input, channel /*, subtype */) {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

    if (channel === 'reddit') {
        const sub = raw.replace(/^r\//i, '').replace(/^\//, '');
        return `https://www.reddit.com/r/${sub}`;
    }
    if (channel === 'ig') {
        if (raw.startsWith('@')) return `https://www.instagram.com/${raw.slice(1)}/`;
        if (raw.startsWith('#')) return `https://www.instagram.com/explore/tags/${raw.slice(1)}/`;
        return `https://www.instagram.com/${raw}/`;
    }
    if (channel === 'x') {
        if (raw.startsWith('@')) return `https://x.com/${raw.slice(1)}`;
        if (raw.startsWith('#')) return `https://x.com/hashtag/${raw.slice(1)}`;
        // keyword form -> wrap in search query
        return `https://x.com/search?q=${encodeURIComponent(raw)}`;
    }
    // Default: assume bare domain, prefix https
    return `https://${raw}`;
}

function inferSubtype(input, channel) {
    const raw = (input || '').trim();
    if (channel === 'ig') return raw.startsWith('#') ? 'hashtag' : 'account';
    if (channel === 'reddit') return 'subreddit';
    if (channel === 'x') {
        if (raw.startsWith('@')) return 'account';
        if (raw.startsWith('#')) return 'hashtag';
        return 'keyword';
    }
    if (channel === 'rss') return 'feed';
    if (channel === 'directory') return 'directory';
    return null;
}

async function pipelineNextSource(id, channel, maxAgeDays, sessionId) {
    // Markdown-backed. Sources are assigned from the in-memory index; scrape-state
    // is ephemeral (every run starts fresh, which is correct for demand-sensing),
    // so maxAgeDays no longer gates re-scrape. Default excludes browser-only
    // channels (fb/ig/x) unless one is explicitly requested.
    if (channel && !VALID_CHANNELS.has(channel)) {
        return createErrorResponse(id, -32602,
            `next_source: invalid channel "${channel}". Must be one of: ${[...VALID_CHANNELS].join(', ')}.`);
    }
    try {
        const claim = sourceStore.nextSource(channel);
        if (claim.status !== 'CLAIMED') {
            return createSuccessResponse(id, JSON.stringify({
                status: 'QUEUE_EMPTY',
                channel: channel || 'any',
                hint: 'Call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task, or seed via pipeline.add_sources, then retry.'
            }));
        }
        return createSuccessResponse(id, JSON.stringify({
            status: 'CLAIMED',
            id: claim.url,            // markdown store has no row id; the URL is the key
            url: claim.url,
            channel: claim.channel,
            subtype: claim.subtype,
            label: claim.label,
            category: claim.category
        }));
    } catch (err) {
        return createErrorResponse(id, -32603, `next_source failed: ${err.message}`);
    }
}

async function pipelineMarkSource(id, url, scrapedAt, clientsFound, failedReason, sessionId) {
    if (!url) {
        return createErrorResponse(id, -32602, 'mark_source requires url (the URL returned by next_source).');
    }

    try {
        const markedAt = scrapedAt ? new Date(scrapedAt) : new Date();
        const cf = typeof clientsFound === 'number' ? clientsFound : 0;
        const result = sourceStore.markSource(url, { clientsFound: cf, failedReason: failedReason || null });
        if (result.status === 'NOT_FOUND') {
            return createErrorResponse(id, -32602, `mark_source: no source with url "${url}".`);
        }

        // Log to session so report_session can distinguish "agent did nothing"
        // from "agent scraped but URLs yielded no clients".
        await logSessionEvent(sessionId, 'source_marked', {
            url,
            clientsFound: cf,
            failed: !!failedReason
        });

        return createSuccessResponse(id, JSON.stringify({
            marked: true,
            url,
            scrapedAt: markedAt.toISOString(),
            clientsFound: cf,
            failedReason: failedReason || null
        }));
    } catch (err) {
        return createErrorResponse(id, -32603, `mark_source failed: ${err.message}`);
    }
}

async function pipelineAddSources(id, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return createErrorResponse(id, -32602,
            'add_sources requires entries[] (non-empty array of {url, channel, subtype?, label?, category?, discoveredFrom?}).');
    }

    const results = { added: 0, duplicates: 0, invalid: [] };

    // Validate + verify per entry here (so we keep the per-entry invalid[] reasons
    // and URL verification), then hand the survivors to the store, which is the
    // sole writer to the markdown files and owns dedup.
    const verified = [];
    for (const e of entries) {
        if (!e || !e.url || !e.channel) {
            results.invalid.push({ entry: e, reason: 'missing url or channel' });
            continue;
        }
        if (!VALID_CHANNELS.has(e.channel)) {
            results.invalid.push({ entry: e, reason: `invalid channel "${e.channel}"` });
            continue;
        }
        const url = normalizeSourceUrl(e.url, e.channel);
        if (!url) {
            results.invalid.push({ entry: e, reason: 'url normalized to empty' });
            continue;
        }
        if (URL_VERIFY_CHANNELS.has(e.channel)) {
            const verification = await verifyEvidenceUrl(url);
            if (!verification.ok) {
                results.invalid.push({ entry: e, url, reason: `url_verification_failed:${verification.reason}` });
                continue;
            }
        }
        verified.push({
            url,
            channel: e.channel,
            subtype: e.subtype || inferSubtype(e.url, e.channel),
            label: e.label || null,
            category: e.category || null
        });
    }

    try {
        const stored = sourceStore.addSources(verified);
        results.added += stored.added;
        results.duplicates += stored.duplicates;
        // stored.invalid should be 0 (entries were pre-validated); fold defensively.
        if (stored.invalid) results.invalid.push({ reason: `store_rejected:${stored.invalid}` });
    } catch (err) {
        return createErrorResponse(id, -32603, `add_sources failed: ${err.message}`);
    }

    return createSuccessResponse(id, JSON.stringify(results));
}

async function pipelineImportSources(id) {
    // DEPRECATED. Markdown is now the runtime source of truth: the store reads
    // every channel file at startup, so there is no separate "import" step. Kept
    // as a shim that re-reads the files and returns the live counts, so any
    // caller still wired to import_sources keeps working instead of erroring.
    const counts = sourceStore.load();
    return createSuccessResponse(id, JSON.stringify({
        deprecated: true,
        note: 'Sources load from markdown at startup; import_sources just re-reads the files.',
        loaded: counts
    }, null, 2));
}

/**
 * Delete a record by id and target type.
 *
 * target='booking'  -> deletes one Booking row.
 * target='factlet'  -> deletes one Factlet row. Factlets are standalone in the
 *                     new architecture (no join table); content/source overlap
 *                     drives client relevance at scoring time.
 * target='client'   -> deletes the Client row and its attached Bookings.
 *                     Factlets are broadcast-scoped and never auto-deleted with
 *                     a Client; the recycler handles factlet staleness.
 *
 * Returns { deleted: true, target, id, cascadedBookings }.
 * Returns -32602 if target is missing/unknown or the record doesn't exist.
 */
async function pipelineDelete(id, target, recordId) {
    if (!target) {
        return createErrorResponse(id, -32602, `delete requires target ("booking" | "client" | "factlet").`);
    }
    if (!recordId) {
        return createErrorResponse(id, -32602, `delete requires id (the record to remove).`);
    }

    try {
        if (target === 'booking') {
            const existing = await prisma.booking.findUnique({ where: { id: recordId } });
            if (!existing) {
                return createErrorResponse(id, -32602, `delete: no booking with id "${recordId}".`);
            }
            await prisma.booking.delete({ where: { id: recordId } });
            return createSuccessResponse(id, JSON.stringify({
                deleted: true, target: 'booking', id: recordId,
                cascadedBookings: 0, cascadedFactlets: 0
            }));
        }

        if (target === 'factlet') {
            const existing = await prisma.factlet.findUnique({ where: { id: recordId } });
            if (!existing) {
                return createErrorResponse(id, -32602, `delete: no factlet with id "${recordId}".`);
            }
            await prisma.factlet.delete({ where: { id: recordId } });
            return createSuccessResponse(id, JSON.stringify({
                deleted: true, target: 'factlet', id: recordId,
                cascadedBookings: 0
            }));
        }

        if (target === 'client') {
            const existing = await prisma.client.findUnique({ where: { id: recordId } });
            if (!existing) {
                return createErrorResponse(id, -32602, `delete: no client with id "${recordId}".`);
            }
            const bookingResult = await prisma.booking.deleteMany({ where: { clientId: recordId } });
            await prisma.client.delete({ where: { id: recordId } });
            return createSuccessResponse(id, JSON.stringify({
                deleted: true, target: 'client', id: recordId,
                cascadedBookings: bookingResult.count
            }));
        }

        return createErrorResponse(id, -32602, `delete: unknown target "${target}". Must be: booking, client, factlet.`);
    } catch (err) {
        return createErrorResponse(id, -32603, `delete failed: ${err.message}`);
    }
}

/**
 * Re-score every non-terminal booking against DOCS/SCORING.json
 * and write status back. Use after editing SCORING constants or gates.
 *
 * scope:
 *   "all"        -> every booking
 *   "hot"        -> only bookings currently flagged hot (sanity-check the queue)
 *   "<clientId>" -> only that client's bookings
 *
 * Returns a summary: count of bookings touched, before/after status counts.
 */
async function pipelineRescore(id, scope) {
    let where = {};
    if (scope === 'hot') {
        where = { status: 'hot' };
    } else if (scope && scope !== 'all') {
        // Treat as clientId
        where = { clientId: scope };
    }

    const bookings = await prisma.booking.findMany({ where, select: { id: true, status: true } });

    // Snapshot counters: before/after status distribution + single changed total.
    const before = {};
    const after  = {};
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    let changed = 0;
    const errors = [];

    for (const b of bookings) {
        bump(before, b.status || 'unknown');
        try {
            const score = await computeBookingTargetScore(b.id);
            if (!score || !score.status) { errors.push({ id: b.id, msg: 'score returned null' }); bump(after, b.status || 'unknown'); continue; }
            if (score.status !== b.status) {
                await prisma.booking.update({ where: { id: b.id }, data: { status: score.status } });
                changed++;
            }
            bump(after, score.status);
        } catch (e) {
            errors.push({ id: b.id, msg: e.message });
            bump(after, b.status || 'unknown');
        }
    }

    return createSuccessResponse(id, JSON.stringify({
        rescored: bookings.length,
        changed,
        before,
        after,
        errors
    }, null, 2));
}

async function pipelineStatus(id) {
    // Config -- in-memory runtime config (see buildRuntimeConfig)
    const cfg = RUNTIME_CONFIG;

    // Stats (same queries as v1 handleGetStats)
    const [totalClients, totalFactlets, brewing, ready, sent,
           contactGatePass, contactGateFail,
           dossierHigh, dossierMid, dossierLow, dossierNone,
           totalBookings, bookingsCold, bookingsBrewing, bookingsHot, bookingsShared] = await Promise.all([
        prisma.client.count(),
        prisma.factlet.count(),
        prisma.client.count({ where: { draftStatus: 'brewing' } }),
        prisma.client.count({ where: { draftStatus: 'ready' } }),
        prisma.client.count({ where: { draftStatus: 'sent' } }),
        prisma.client.count({ where: { contactGate: true } }),
        prisma.client.count({ where: { contactGate: false } }),
        prisma.client.count({ where: { dossierScore: { gte: 10 } } }),
        prisma.client.count({ where: { dossierScore: { gte: 5, lt: 10 } } }),
        prisma.client.count({ where: { AND: [{ dossierScore: { not: null } }, { dossierScore: { lt: 5 } }] } }),
        prisma.client.count({ where: { dossierScore: null } }),
        prisma.booking.count(),
        prisma.booking.count({ where: { status: 'cold' } }),
        prisma.booking.count({ where: { status: 'brewing' } }),
        prisma.booking.count({ where: { status: 'hot' } }),
        prisma.booking.count({ where: { shared: true } })
    ]);

    // Ready drafts (top 5, summary)
    const readyDrafts = await prisma.client.findMany({
        where: { draftStatus: 'ready' },
        orderBy: { dossierScore: 'desc' },
        take: 5,
        select: {
            id: true, name: true, company: true, segment: true,
            email: true, dossierScore: true, contactGate: true,
            warmthScore: true, draftStatus: true, lastEnriched: true
        }
    });

    // Completeness: check if config has the fields needed for current mode
    const completeness = {};
    if (cfg) {
        completeness.hasCompanyName = !!(cfg.companyName && cfg.companyName.trim());
        completeness.hasCompanyEmail = !!(cfg.companyEmail && cfg.companyEmail.trim());
        completeness.hasBusinessDescription = !!(cfg.businessDescription && cfg.businessDescription.trim());
        completeness.hasActiveEntities = !!(cfg.activeEntities && cfg.activeEntities.trim());
        completeness.hasDefaultTrade = !!(cfg.defaultTrade && cfg.defaultTrade.trim());
        if (cfg.marketplaceEnabled) {
            completeness.hasLeedzEmail = !!(cfg.leedzEmail && cfg.leedzEmail.trim());
            completeness.hasLeedzSession = !!(cfg.leedzSession && cfg.leedzSession.trim());
        }
        completeness.ready = completeness.hasCompanyName
            && completeness.hasCompanyEmail
            && completeness.hasBusinessDescription;
    }

    // Redact runtime secrets from the status payload (llmApiKey / leedzSession).
    const { llmApiKey, leedzSession, ...safeCfg } = cfg;
    return createSuccessResponse(id, JSON.stringify({
        config: safeCfg,
        stats: {
            totalClients, totalFactlets,
            drafts: { brewing, ready, sent },
            contactGate: { pass: contactGatePass, fail: contactGateFail },
            dossierScores: { high: dossierHigh, mid: dossierMid, low: dossierLow, unscored: dossierNone },
            bookings: {
                total: totalBookings,
                cold: bookingsCold,
                brewing: bookingsBrewing,
                hot: bookingsHot,
                shared: bookingsShared
            }
        },
        completeness,
        readyDrafts,
        brewingCount: brewing
    }, null, 2));
}

async function pipelineWorkStatus(id) {
    const STALE_HOURS = 24;
    const staleThreshold = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
    const CHANNELS = ['directory', 'rss', 'fb', 'reddit', 'ig', 'x', 'blog', 'website'];

    // Source counts by channel, from the markdown-backed store (in-memory).
    // Scrape-state is ephemeral, so there is no cross-run "stale" bucket.
    const storeByChannel = sourceStore.counts().byChannel;
    const sources = {};
    for (const ch of CHANNELS) {
        const c = storeByChannel[ch] || { ready: 0, claimed: 0 };
        sources[ch] = { ready: c.ready || 0, claimed: c.claimed || 0, stale: 0 };
    }

    // Client counts
    const [thin, needsEnrichment, readyDrafts] = await Promise.all([
        prisma.client.count({ where: { dossierScore: null } }),
        prisma.client.count({ where: { draftStatus: 'brewing' } }),
        prisma.client.count({ where: { draftStatus: 'ready' } })
    ]);

    // Booking counts
    const [hotBookings, brewingBookings] = await Promise.all([
        prisma.booking.count({ where: { status: 'hot' } }),
        prisma.booking.count({ where: { status: 'brewing' } })
    ]);

    // Recommendation
    const totalReady = Object.values(sources).reduce((s, c) => s + c.ready, 0);
    let recommendation;
    if (hotBookings > 0 || readyDrafts > 0) {
        recommendation = 'present';
    } else if (thin > 0 || needsEnrichment > 0) {
        recommendation = 'enrich';
    } else if (totalReady > 0) {
        recommendation = 'process_sources';
    } else if (Object.values(sources).every(c => c.ready === 0 && c.claimed === 0)) {
        recommendation = totalReady === 0 && thin === 0 && needsEnrichment === 0
            ? 'done' : 'discover_sources';
    } else {
        recommendation = 'discover_sources';
    }

    return createSuccessResponse(id, JSON.stringify({
        sources,
        clients: { thin, needs_enrichment: needsEnrichment, ready_drafts: readyDrafts },
        bookings: { hot: hotBookings, brewing: brewingBookings },
        recommendation
    }, null, 2));
}

async function pipelineConfigure(id, _patch) {
    // Retired. Config is an in-memory struct built at startup from
    // DOCS/VALUE_PROP.md + precrime_config.json; there is no runtime-writable
    // Config table. Identity/trade/signature live in VALUE_PROP.md; LLM/runtime
    // settings live in precrime_config.json. Either change takes effect on restart.
    return createErrorResponse(id, -32601,
        'configure is retired: config is read-only at runtime. Edit DOCS/VALUE_PROP.md ' +
        '(identity, trade, signature) or precrime_config.json (LLM, runtime), then restart the server.');
}

// get_config returns ONE Config field by key. Allowlist-only -- never returns
// runtime API secrets (llmApiKey, leedzSession). Skills (especially outreach
// drafting) call this for the mandatory mirror of VALUE_PROP identity rather
// than paraphrasing from the markdown.
const GET_CONFIG_ALLOWED_KEYS = Object.freeze([
    'signature',
    'companyName',
    'companyEmail',
    'businessDescription',
    'defaultTrade',
    'leedzEmail',
    'defaultBookingAction'
]);
async function pipelineGetConfig(id, args) {
    const key = args && typeof args.key === 'string' ? args.key.trim() : '';
    // No key: return full VALUE_PROP profile for workers (apply-factlet, enrichment).
    // Secrets (llmApiKey, leedzSession) are never included.
    if (!key) {
        const cfg = RUNTIME_CONFIG;
        return createSuccessResponse(id, JSON.stringify({
            trade:            VALUE_PROP.trade            || cfg.defaultTrade || '',
            product:          VALUE_PROP.product          || '',
            seller:           VALUE_PROP.seller           || cfg.companyName  || '',
            email:            VALUE_PROP.email            || cfg.companyEmail || '',
            geography:        VALUE_PROP.geography        || '',
            serviceZips:      VALUE_PROP.serviceZips      || [],
            pitch:            VALUE_PROP.pitch            || cfg.businessDescription || '',
            whyUs:            VALUE_PROP.whyUs            || [],
            buyerRoles:       VALUE_PROP.buyerRoles       || [],
            audienceSegments: VALUE_PROP.audienceSegments || [],
            notBuyer:         VALUE_PROP.notBuyer         || [],
            relevanceSignals: VALUE_PROP.relevanceSignals || [],
            forbiddenPhrases: VALUE_PROP.forbiddenPhrases || [],
            signature:        VALUE_PROP.signature        || cfg.signature   || '',
            companyName:      cfg.companyName   || '',
            companyEmail:     cfg.companyEmail  || '',
            defaultTrade:     cfg.defaultTrade  || '',
            businessDescription: cfg.businessDescription || '',
            source: 'runtime_config'
        }, null, 2));
    }
    if (!GET_CONFIG_ALLOWED_KEYS.includes(key)) {
        return createErrorResponse(id, -32602,
            `get_config: unknown or forbidden key "${key}". get_config never returns runtime API secrets. ` +
            `Allowed keys: ${GET_CONFIG_ALLOWED_KEYS.join(', ')}.`);
    }
    const cfg = RUNTIME_CONFIG;
    const value = cfg[key];
    return createSuccessResponse(id, JSON.stringify({
        key,
        value: (value === undefined ? null : value),
        present: !(value === null || value === undefined || value === ''),
        source: 'runtime_config'
    }, null, 2));
}

async function pipelineNext(id, entity, criteria, dossierLimit, factletLimit) {
    if (entity === 'booking') {
        return await pipelineNextBooking(id, criteria, dossierLimit, factletLimit);
    }
    return await pipelineNextClient(id, criteria, dossierLimit, factletLimit);
}

async function pipelineNextClient(id, criteria, dossierLimit, factletLimit) {
    const where = {};
    if (criteria.company)     where.company     = { contains: criteria.company };
    if (criteria.name)        where.name        = { contains: criteria.name };
    if (criteria.draftStatus) where.draftStatus = criteria.draftStatus;
    if (criteria.segment)     where.segment     = { contains: criteria.segment };

    // lastEnrichedBefore: skip clients enriched more recently than this ISO timestamp.
    // Used by the enrichment agent to avoid re-processing fresh clients and force
    // the queue to advance to new contacts added by the seeder/harvesters.
    // e.g. pass lastEnrichedBefore = 30 days ago to skip recently-enriched records.
    if (criteria.lastEnrichedBefore) {
        where.OR = [
            { lastEnriched: null },                                      // never enriched
            { lastEnriched: { lt: new Date(criteria.lastEnrichedBefore) } } // older than threshold
        ];
    }

    // Atomic claim + hydrate in one transaction
    const result = await prisma.$transaction(async (tx) => {
        // Find oldest lastQueueCheck (nulls first in SQLite ASC).
        // Clients with null lastQueueCheck (never touched) sort first, ensuring
        // new contacts from the seeder are always processed before re-enriching old ones.
        const client = await tx.client.findFirst({
            where,
            orderBy: { lastQueueCheck: 'asc' }
        });

        if (!client) return null;

        // Stamp before returning
        const stamped = await tx.client.update({
            where: { id: client.id },
            data: { lastQueueCheck: new Date() }
        });

        // Hydrate: relevant live factlets (overlap-based, no join table) + bookings.
        const staleDays = await getFactletStaleDays();
        const factlets = await findLiveFactletsForClient(stamped, staleDays);
        const bookings = await tx.booking.findMany({
            where: { clientId: client.id },
            orderBy: { createdAt: 'desc' }
        });

        return { ...stamped, factlets, bookings };
    });

    return createSuccessResponse(id, safeJson(clipClientForResponse(result, dossierLimit, factletLimit)));
}

async function pipelineNextBooking(id, criteria, dossierLimit, factletLimit) {
    const where = {};
    if (criteria.status) where.status = criteria.status;
    if (criteria.trade)  where.trade  = criteria.trade;

    const result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findFirst({
            where,
            orderBy: { createdAt: 'asc' }
        });

        if (!booking) return null;

        // Hydrate with client + client factlets
        const client = await tx.client.findUnique({
            where: { id: booking.clientId }
        });

        // Live Factlets relevant to this Client via overlap (no join table).
        const staleDays = await getFactletStaleDays();
        const factlets = client ? await findLiveFactletsForClient(client, staleDays) : [];

        return { ...booking, client: { ...client, factlets } };
    });

    // Clip the embedded client (dossier + factlets), not the booking itself
    if (result && result.client) {
        result.client = clipClientForResponse(result.client, dossierLimit, factletLimit);
    }
    return createSuccessResponse(id, safeJson(result));
}

async function normalizeBookingDatesForSave(sessionId, patch) {
    if (!Array.isArray(patch.bookings)) return [];
    const failures = [];

    for (const b of patch.bookings) {
        const rawDateText = b.dateText || b.rawDate || b.eventDateText || b.eventDatePlaintext ||
            (!isStrictDateValue(b.startDate) ? b.startDate : null);

        if (rawDateText) {
            const sourceUrl = b.sourceUrl || patch.sourceUrl || patch.url || null;
            if (!sourceUrl) {
                failures.push({ kind: 'booking_date', title: b.title || null, dateText: rawDateText, reason: 'missing_sourceUrl_for_date_resolution' });
                continue;
            }
            const resolved = await resolveEventDatesLegacy({
                text: [rawDateText, b.startTime, b.endTime].filter(Boolean).join(' '),
                sourceUrl,
                defaultDurationHours: b.defaultDurationHours ?? b.duration,
                defaultStartTime: true   // date-only events default to 12:00 PM noon (flagged below)
            });
            if (!resolved.ok) {
                failures.push({ kind: 'booking_date', title: b.title || null, dateText: rawDateText, sourceUrl, reason: resolved.errors.join(',') });
                continue;
            }
            b.startDate = resolved.startIso;
            b.endDate = resolved.endIso;
            if (!b.startTime) b.startTime = resolved.startIso.slice(11, 16);
            if (!b.endTime) b.endTime = resolved.endIso.slice(11, 16);
            if (b.duration === undefined) b.duration = Math.round((resolved.et - resolved.st) / 3600000 * 100) / 100;
            if (resolved.timeDefaulted) {
                // The source gave a date but no clock time; we used noon. Record it
                // on the Booking so enrichment can nail down the real start time.
                const note = '[start time defaulted to 12:00 PM noon — exact time unconfirmed; refine via enrichment]';
                b.notes = b.notes ? `${b.notes}\n${note}` : note;
            }
            continue;
        }

        if (b.startDate && !isStrictDateValue(b.startDate)) {
            failures.push({ kind: 'booking_date', title: b.title || null, dateText: String(b.startDate), reason: 'startDate_not_strict_iso_or_epoch' });
        }
        if (b.endDate && !isStrictDateValue(b.endDate)) {
            failures.push({ kind: 'booking_date', title: b.title || null, dateText: String(b.endDate), reason: 'endDate_not_strict_iso_or_epoch' });
        }
        if (b.startDate && !b.endDate && b.duration !== undefined && isStrictDateValue(b.startDate)) {
            const start = strictDateToDate(b.startDate).getTime();
            const durationHours = Number(b.duration);
            if (Number.isFinite(durationHours) && durationHours > 0 && durationHours <= 24) {
                b.endDate = new Date(start + Math.round(durationHours * 3600000)).toISOString();
            }
        }
        if (b.startDate && b.endDate && isStrictDateValue(b.startDate) && isStrictDateValue(b.endDate)) {
            const start = strictDateToDate(b.startDate).getTime();
            const end = strictDateToDate(b.endDate).getTime();
            if (end <= start) failures.push({ kind: 'booking_date', title: b.title || null, dateText: `${b.startDate}..${b.endDate}`, reason: 'end_not_after_start' });
        }
    }

    if (failures.length > 0) {
        await logSessionEvent(sessionId, 'save_rejected_bad_booking_date', { failures });
    }
    return failures;
}

// Seed a stub dossier at Client creation from whatever we already know, so a new
// Client is never an empty shell that can't be matched (the factlet matcher reads the
// dossier) or enriched (enrichment-agent appends to it). If there is genuinely nothing
// to say, the client is a weak lead and stays dormant by design — but we never DISCARD
// content we had at creation time.
function buildStubDossier(patch) {
    const who = patch.name || patch.company || 'Unknown client';
    const facts = [];
    if (patch.company && patch.company !== who) facts.push(patch.company);
    if (patch.segment)     facts.push(`segment: ${patch.segment}`);
    if (patch.website)     facts.push(patch.website);
    if (patch.email)       facts.push(patch.email);
    if (patch.clientNotes) facts.push(patch.clientNotes);
    const today = new Date().toISOString().slice(0, 10);
    const src = patch.source ? ` Source: ${patch.source}.` : '';
    return `[PERMANENT] ${who}${facts.length ? ' — ' + facts.join('; ') : ''}.` +
        `\n[${today}] [background] Client created from initial discovery.${src}`;
}

async function pipelineSave(id, clientId, patch, sessionId, judge, factletId) {
    // judge defaults to true for legacy callers. New Task-based workers MUST
    // pass judge:false and let the Planner schedule a JUDGE_AFFECTED Task.
    if (judge === undefined) judge = true;
    let existing = null;
    let isCreate = false;

    // Validate sessionId if provided — fail fast on a forged id rather than
    // accepting it silently. The model cannot invent a session_id; it must
    // come from a prior start_session call.
    if (sessionId) {
        const sess = await prisma.session.findUnique({ where: { id: sessionId } });
        if (!sess) {
            // Invalid session_id — ignore it, proceed without session logging
            sessionId = null;
        } else if (sess.status !== 'active') {
            // Session already closed — ignore it, proceed without session logging
            sessionId = null;
        }
    }

    // Log the attempt before any validation. report_session uses save_attempt
    // events to distinguish "agent never tried" from "agent tried, got rejected".
    await logSessionEvent(sessionId, 'save_attempt', {
        hasId: !!clientId,
        hasName: !!(patch && patch.name),
        hasCompany: !!(patch && patch.company),
        patchKeys: patch ? Object.keys(patch) : []
    });

    // Empty patches are HARD-REJECTED. A successful no-op gives the agent no
    // signal it's looping uselessly; we want a real error so the procedure
    // forces it to either fill the patch or skip save() entirely.
    if (!patch || Object.keys(patch).length === 0) {
        if (sessionId) {
            try {
                await prisma.sessionEvent.create({
                    data: {
                        sessionId,
                        action: 'save_rejected_empty_patch',
                        payload: JSON.stringify({ hasId: !!clientId })
                    }
                });
            } catch (_) { /* session may be stale; silent */ }
        }
        return createErrorResponse(id, -32602,
            'Empty patch rejected. pipeline.save requires patch.name or patch.company. ' +
            'If the scrape yielded zero contacts, do NOT call save -- call pipeline.mark_source({url, clientsFound: 0}) and move on.'
        );
    }

    // HARD GATE: generic email. sales@, info@, contact@, etc. are never a valid
    // direct contact. The system refuses to save them. The agent must run
    // skills/client-finder.md to find the decision-maker's direct email first.
    // The save is rejected outright so the agent cannot "claim" the client with
    // a junk email and move on.
    if (patch.email && typeof patch.email === 'string' && patch.email.includes('@') && isGenericEmail(patch.email)) {
        if (sessionId) {
            try {
                await prisma.sessionEvent.create({
                    data: {
                        sessionId,
                        action: 'save_rejected_generic_email',
                        payload: JSON.stringify({ email: patch.email, name: patch.name, company: patch.company })
                    }
                });
            } catch (_) { /* */ }
        }
        return createErrorResponse(id, -32602,
            `Generic email rejected: ${patch.email}. Generic inboxes (sales@, info@, contact@, etc.) are never a valid direct contact. ` +
            `Run skills/client-finder.md to find the decision-maker's direct email, then retry save. ` +
            `OR save without the email field to capture the client shell (company + source) for later enrichment.`
        );
    }

    // ANTI-HALLUCINATION (verify.js): when the worker cites the source factlet,
    // strip any structured field (email / phone / zip) that does NOT appear
    // verbatim in that factlet's text. The worker cannot fabricate contact data
    // to clear the hot-leed gate; only real, source-backed values are written.
    if (factletId) {
        try {
            const f = await prisma.factlet.findUnique({ where: { id: factletId }, select: { content: true } });
            const { patch: filtered, dropped } = verify.filterVerifiedPatch(patch, (f && f.content) || '');
            if (dropped.length) {
                await logSessionEvent(sessionId, 'save_dropped_unverified', { factletId, dropped });
                patch = filtered;
            }
        } catch (_) { /* factlet gone -- fall through with patch unchanged */ }
    }

    // Also reject the "all blank values" case.
    const hasUsableValue = Object.entries(patch).some(([_k, v]) => {
        if (v === null || v === undefined) return false;
        if (typeof v === 'string' && v.trim() === '') return false;
        return true;
    });
    if (!hasUsableValue) {
        if (sessionId) {
            try {
                await prisma.sessionEvent.create({
                    data: {
                        sessionId,
                        action: 'save_rejected_blank_values',
                        payload: JSON.stringify({ patchKeys: Object.keys(patch) })
                    }
                });
            } catch (_) { /* */ }
        }
        return createErrorResponse(id, -32602,
            'Patch had keys but all values were null/empty. pipeline.save requires at least one non-empty field. Proceed to mark_source.'
        );
    }

    const badIdentityValues = ['name', 'company'].filter((field) => {
        const v = patch[field];
        if (typeof v !== 'string') return false;
        const s = v.trim().toLowerCase();
        return (
            /^<[^>]+>$/.test(s) ||
            ['unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'company', 'name', 'vendor', 'business'].includes(s)
        );
    });
    if (badIdentityValues.length > 0) {
        await logSessionEvent(sessionId, 'save_rejected_placeholder_identity', {
            fields: badIdentityValues,
            attemptedPatch: patch
        });
        return createErrorResponse(id, -32602,
            `Patch has placeholder identity field(s): ${badIdentityValues.join(', ')}. ` +
            'Save a real person or company, or skip save and mark_source with a reason.'
        );
    }

    if (!clientId && !patch.name && !patch.company && patch.content && patch.source) {
        const sourceUrl = patch.sourceUrl || patch.url || (isHttpUrl(patch.source) ? patch.source : null);
        // No live re-fetch on save. Proof is captured ONCE when a worker first reads
        // the page (scrape path / resolve_dates) and trusted thereafter. The old
        // save-time verifyEvidenceUrl rejected RFP/PDF/aggregator pages and blocked
        // promotion (the leed-ready Catch-22). See DOCS/CLASSIFICATION.md.

        const factlet = await prisma.factlet.create({
            data: { content: patch.content, source: sourceUrl || patch.source }
        });
        await logSessionEvent(sessionId, 'save_success', {
            factletId: factlet.id,
            name: 'factlet',
            isCreate: true,
            score: null
        });
        return createSuccessResponse(id, JSON.stringify({
            saved: true,
            factletId: factlet.id,
            session_id: sessionId || null
        }, null, 2));
    }

    // Live-URL re-verification on save removed (the leed-ready Catch-22): proof is
    // captured once at fetch (scrape / resolve_dates) and trusted thereafter. See
    // DOCS/CLASSIFICATION.md. Non-network date normalization below stays.

    const dateFailures = await normalizeBookingDatesForSave(sessionId, patch);
    if (dateFailures.length > 0) {
        await logSessionEvent(sessionId, 'save_failed', {
            error: 'bad_booking_date',
            name: patch.company || patch.name || null,
            source: patch.source || patch.sourceUrl || patch.url || null,
            failures: dateFailures
        });
        return createErrorResponse(id, -32602,
            'Booking date rejected before save. The LLM must provide raw source date text and let MCP resolve st/et. ' +
            JSON.stringify({ failures: dateFailures }, null, 2)
        );
    }

    if (clientId) {
        existing = await prisma.client.findUnique({ where: { id: clientId } });
        if (!existing) {
            await logSessionEvent(sessionId, 'save_failed', { id: clientId, error: 'client_not_found' });
            return createErrorResponse(id, -32602, `Client not found: ${clientId}`);
        }
        // HARD GATE: a Client at draftStatus="sent" has already received outreach.
        // Refuse to flip back to "ready" / "brewing" / null without explicit
        // patch.force=true. Prevents an ENRICH_CLIENT worker from resurrecting a
        // sent client and causing a duplicate email on the next outreach pass.
        // To intentionally re-engage, pass { force: true } in the same save.
        if (existing.draftStatus === 'sent'
            && patch.draftStatus !== undefined
            && patch.draftStatus !== 'sent'
            && patch.force !== true) {
            await logSessionEvent(sessionId, 'save_rejected_sent_resurrection', {
                clientId,
                attemptedDraftStatus: patch.draftStatus
            });
            return createErrorResponse(id, -32602,
                `Client ${clientId} is draftStatus="sent" (already emailed). ` +
                `Refusing to set draftStatus="${patch.draftStatus}" without patch.force=true. ` +
                `Pass { force: true } in the save call to deliberately re-engage.`
            );
        }
    } else {
        // No id = create new client. Requires patch.name OR patch.company.
        // Company-only records are allowed but will score low (contactGate=false)
        // until enrichment finds a real person name.
        if (!patch.name && !patch.company) {
            await logSessionEvent(sessionId, 'save_failed', { error: 'missing_name_and_company', attemptedPatch: patch });
            return createErrorResponse(id, -32602, 'save without id requires patch.name or patch.company to create a new client.');
        }
        if (!patch.name) patch.name = patch.company;

        // Server-side dedup: before creating, check for an exact company name match
        // (case-insensitive, trimmed). This is the last line of defense against
        // duplicates — the skill-level dedup check may miss when company names have
        // slight variations (casing, punctuation). If a match is found, treat this
        // as an update to the existing client rather than a new create.
        if (patch.company) {
            const dupRows = await prisma.$queryRaw`
                SELECT id, name, company FROM "Client"
                WHERE LOWER(TRIM(company)) = LOWER(TRIM(${patch.company}))
                LIMIT 1
            `;
            if (dupRows.length > 0) {
                const dup = dupRows[0];
                clientId = dup.id;
                existing = await prisma.client.findUnique({ where: { id: clientId } });
                await logSessionEvent(sessionId, 'dedup_hit', {
                    company: patch.company,
                    existingId: clientId,
                    existingName: dup.name
                });
                // isCreate stays false — fall through to the update path below
            }
        }

        if (!clientId) {
            isCreate = true;
            try {
                const created = await prisma.client.create({
                    data: {
                        name: patch.name,
                        email: patch.email || null,
                        phone: patch.phone || null,
                        company: patch.company || null,
                        website: patch.website || null,
                        segment: patch.segment || null,
                        clientNotes: patch.clientNotes || null,
                        source: patch.source || null,
                        // Born with content, never an empty shell: use a supplied dossier or
                        // a stub built from what we know. Survives the follow-up update below
                        // (which only touches dossier when patch.dossier/dossierAppend is set).
                        dossier: patch.dossier || buildStubDossier(patch)
                    }
                });
                clientId = created.id;
                existing = created;
            } catch (err) {
                await logSessionEvent(sessionId, 'save_failed', { name: patch.name, error: err.message, attemptedPatch: patch });
                return createErrorResponse(id, -32602, `client.create failed: ${err.message}`);
            }
        }
    }

    await prisma.$transaction(async (tx) => {
        // Build client update data
        const clientData = {};
        const clientFields = [
            'name', 'email', 'phone', 'company', 'website', 'clientNotes',
            'segment', 'draft', 'draftStatus', 'targetUrls'
        ];
        for (const field of clientFields) {
            if (patch[field] !== undefined) {
                clientData[field] = patch[field];
            }
        }

        // dossierAppend: timestamp + append to existing dossier
        if (patch.dossierAppend) {
            const timestamp = new Date().toISOString().slice(0, 10);
            const existingDossier = existing.dossier || '';
            const separator = existingDossier ? '\n\n' : '';
            clientData.dossier = existingDossier + separator + `[${timestamp}] ${patch.dossierAppend}`;
        }

        // Direct dossier overwrite (use dossierAppend instead when possible)
        if (patch.dossier !== undefined && patch.dossierAppend === undefined) {
            clientData.dossier = patch.dossier;
        }

        if (patch.intelScore !== undefined) {
            clientData.intelScore = parseInt(patch.intelScore, 10);
        }

        if (patch.sentAt) {
            clientData.sentAt = new Date(patch.sentAt);
        }

        if (patch.warmthScore !== undefined) {
            clientData.warmthScore = parseFloat(patch.warmthScore);
        }

        clientData.lastEnriched = new Date();

        if (Object.keys(clientData).length > 0) {
            await tx.client.update({ where: { id: clientId }, data: clientData });
        }

        // Create factlets only. Factlet is standalone in this architecture;
        // there is no join table. Client.dossier (timestamped prose) is the
        // durable per-client record; APPLY_FACTLET workers and JUDGE_AFFECTED
        // scoring read live Factlet rows directly via content/source overlap.
        if (Array.isArray(patch.factlets)) {
            for (const f of patch.factlets) {
                const factletSource = f.sourceUrl || f.url || f.source;
                if (!f.content || !factletSource) continue;
                await tx.factlet.create({
                    data: { content: f.content, source: factletSource }
                });
            }
        }

        // Upsert bookings
        if (Array.isArray(patch.bookings)) {
            for (const b of patch.bookings) {
                const bookingData = { clientId };
                const bookingFields = [
                    'title', 'description', 'notes', 'location', 'startTime', 'endTime',
                    'source', 'sourceUrl', 'trade', 'zip', 'sharedTo', 'leedId'
                ];
                for (const f of bookingFields) {
                    if (b[f] !== undefined) bookingData[f] = b[f];
                }

                // Booking.status is owned by the server Judge. A worker save may only
                // DEMOTE a booking to 'cold' or 'brewing' (e.g. returning a shared or
                // skipped leed out of the hot queue). It may NEVER promote to 'hot' --
                // only computeBookingTargetScore / judgeAffected set 'hot'. Any other
                // worker-supplied status (hot, shared, junk) is ignored so a worker
                // cannot fabricate a hot lead. See DOCS/CLASSIFICATION.md.
                if (b.status !== undefined) {
                    if (b.status === 'cold' || b.status === 'brewing') {
                        bookingData.status = b.status;
                    } else {
                        console.error(`[save] ignored worker-supplied Booking.status='${b.status}'` +
                            ` (id=${b.id || 'new'}) -- workers may only demote to cold/brewing; the Judge owns 'hot'.`);
                    }
                }

                if (b.duration !== undefined)   bookingData.duration   = parseFloat(b.duration);
                if (b.hourlyRate !== undefined)  bookingData.hourlyRate  = parseFloat(b.hourlyRate);
                if (b.flatRate !== undefined)    bookingData.flatRate    = parseFloat(b.flatRate);
                if (b.totalAmount !== undefined) bookingData.totalAmount = parseFloat(b.totalAmount);
                if (b.leedPrice !== undefined)   bookingData.leedPrice   = parseInt(b.leedPrice, 10);
                if (b.startDate) bookingData.startDate = new Date(b.startDate);
                if (b.endDate)   bookingData.endDate   = new Date(b.endDate);
                if (b.shared !== undefined) bookingData.shared = !!b.shared;
                if (b.sharedAt !== undefined) bookingData.sharedAt = BigInt(b.sharedAt);

                if (b.id) {
                    // Update existing booking. Use updateMany, NOT update: a worker —
                    // especially a weak model — can pass a stale or hallucinated booking
                    // id, and update() THROWS "Record to update not found", which rolls
                    // back the ENTIRE save (dossier text, zip, date — every bit of
                    // enrichment in this same call is lost). updateMany skips a missing
                    // id (count 0) instead of throwing, so the rest of the save persists.
                    const { clientId: _cid, ...updateData } = bookingData;
                    const upd = await tx.booking.updateMany({ where: { id: b.id }, data: updateData });
                    if (upd.count === 0) {
                        console.error(`[save] booking id='${b.id}' not found — update skipped` +
                            ` (worker passed a stale/hallucinated id); rest of the patch still saved.`);
                    }
                } else {
                    // Create new booking
                    await tx.booking.create({ data: bookingData });
                }
            }
        }

        // Auto-mirror: any Booking just flipped to status="shared" via an email
        // path (email_share or email_user) also marks the parent Client as
        // outreach-sent so ENRICH_CLIENT and the drafter cannot re-queue it for
        // another email. Marketplace shares (sharedTo="leedz_api") do NOT trigger
        // this mirror -- a marketplace post is per-Booking and leaves the Client
        // free to receive direct outreach for other Bookings. Idempotent: skips
        // if Client.draftStatus is already "sent".
        const EMAIL_SHARE_PATHS = new Set(['email_share', 'email_user']);
        const emailShared = Array.isArray(patch.bookings) && patch.bookings.some(b =>
            b.status === 'shared' && EMAIL_SHARE_PATHS.has(b.sharedTo)
        );
        if (emailShared && existing && existing.draftStatus !== 'sent') {
            await tx.client.update({
                where: { id: clientId },
                data:  { draftStatus: 'sent', sentAt: new Date() }
            });
            await logSessionEvent(sessionId, 'client_auto_marked_sent', {
                clientId,
                reason: 'booking_status_shared_via_email_path'
            });
        }
    });

    // Collect affected booking ids for either Judge invocation or Task output.
    const touchedBookings = await prisma.booking.findMany({
        where: { clientId },
        select: { id: true }
    });
    const affectedBookingIds = touchedBookings.map(b => b.id);
    const affectedClientIds  = [clientId];

    let scoreResult = null;
    let judged      = null;

    if (judge) {
        // Legacy compatibility path: pipeline.save(judge:true) routes through
        // the same judgeAffected helper that the new JUDGE_AFFECTED Task uses.
        // No copied scoring block lives here.
        const intelOverride = (patch.intelScore !== undefined) ? parseInt(patch.intelScore, 10) : null;
        judged = await judgeAffected({
            clientIds:   affectedClientIds,
            bookingIds:  affectedBookingIds,
            reason:      'pipeline.save(legacy)',
            writeStatus: true,
            intelOverride
        });
        scoreResult = judged.clientScore || null;
    }

    await logSessionEvent(sessionId, 'save_success', {
        clientId,
        name: existing?.name || patch.name || null,
        isCreate,
        score: typeof scoreResult === 'number' ? scoreResult : (scoreResult?.total ?? null),
        judged: !!judge
    });

    return createSuccessResponse(id, JSON.stringify({
        saved: true,
        clientId,
        score: scoreResult,
        judged: !!judge,
        affectedClientIds,
        affectedBookingIds,
        session_id: sessionId || null
    }, null, 2));
}

// ============================================================================
// JUDGE -- the single scoring implementation
// ============================================================================
// One scoring helper, called from two places:
//   - legacy: pipeline.save(judge:true)
//   - new   : JUDGE_AFFECTED Task / pipeline.judge_affected
// computeBookingTargetScore() remains the marketplace/outreach authority.
// ============================================================================

async function judgeAffected({ clientIds, bookingIds, reason, writeStatus, intelOverride }) {
    if (writeStatus === undefined) writeStatus = true;

    const bookingIdSet = new Set(Array.isArray(bookingIds) ? bookingIds.filter(Boolean) : []);
    if (Array.isArray(clientIds) && clientIds.length > 0) {
        const rows = await prisma.booking.findMany({
            where: { clientId: { in: clientIds.filter(Boolean) } },
            select: { id: true }
        });
        for (const r of rows) bookingIdSet.add(r.id);
    }

    const bookings = await prisma.booking.findMany({
        where: { id: { in: Array.from(bookingIdSet) } },
        select: { id: true, status: true, clientId: true }
    });

    const changed = [];
    const errors  = [];
    for (const b of bookings) {
        try {
            const score = await computeBookingTargetScore(b.id);
            if (!score || !score.status) continue;
            if (score.status !== b.status) {
                if (writeStatus) {
                    await prisma.booking.update({ where: { id: b.id }, data: { status: score.status } });
                }
                changed.push({ bookingId: b.id, from: b.status, to: score.status });
            }
        } catch (e) {
            errors.push({ bookingId: b.id, error: e.message });
        }
    }

    // Re-score clients last so dossier/client score reflects post-judge state.
    const clientScores = [];
    let lastScore = null;
    const uniqueClientIds = Array.from(new Set((clientIds || []).filter(Boolean)));
    for (const cid of uniqueClientIds) {
        try {
            const s = await computeClientScore(cid, intelOverride == null ? null : intelOverride);
            clientScores.push({ clientId: cid, score: s });
            lastScore = s;
        } catch (e) {
            errors.push({ clientId: cid, error: e.message });
        }
    }

    return {
        reason: reason || null,
        affectedBookingIds: Array.from(bookingIdSet),
        affectedClientIds:  uniqueClientIds,
        changed,
        clientScores,
        clientScore: lastScore,
        errors,
        wroteStatus: !!writeStatus
    };
}

// dismiss_booking -- the user's permanent SKIP. A hot leed the user rejects must
// never resurface. Mark it acted-on (shared=true, sharedTo="dismissed") and cold:
// the classification cold-gate (booking.shared) keeps it cold through every future
// rescore, and the hot query (shared:false) excludes it. Distinct from a real
// marketplace share by sharedTo="dismissed".
async function pipelineDismissBooking(id, args) {
    const bookingId = args.bookingId;
    if (!bookingId) {
        return createErrorResponse(id, -32602, 'dismiss_booking requires bookingId.');
    }
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
        return createErrorResponse(id, -32602, `dismiss_booking: booking "${bookingId}" not found.`);
    }
    await prisma.booking.update({
        where: { id: bookingId },
        data: { shared: true, sharedTo: 'dismissed', sharedAt: BigInt(Date.now()), status: 'cold' }
    });
    return createSuccessResponse(id, JSON.stringify({
        dismissed: true, bookingId,
        note: 'Permanently skipped. This booking will not be presented as hot again.'
    }, null, 2));
}

async function pipelineJudgeAffected(id, args) {
    const clientIds  = Array.isArray(args.clientIds)  ? args.clientIds  : [];
    const bookingIds = Array.isArray(args.bookingIds) ? args.bookingIds : [];
    if (clientIds.length === 0 && bookingIds.length === 0) {
        return createErrorResponse(id, -32602, 'judge_affected requires clientIds[] or bookingIds[].');
    }
    const result = await judgeAffected({
        clientIds,
        bookingIds,
        reason:      args.reason || 'judge_affected',
        writeStatus: args.writeStatus !== false
    });
    await logSessionEvent(args.session_id || null, 'judge_affected', {
        changed: result.changed.length,
        clientIds: result.affectedClientIds,
        bookingIds: result.affectedBookingIds
    });
    return createSuccessResponse(id, JSON.stringify(result, null, 2));
}

// ============================================================================
// SHARE BOOKING -- the only sanctioned marketplace posting path (Phase 5)
// ============================================================================
// The whole share_booking path (gates, draft validation, payload build, Leedz
// POST) lives in share.js. judgeAffected (the in-process Judge) + VALID_OBJECTIVES
// are injected; VALID_OBJECTIVES is passed as a thunk because it is a const
// declared further down this file than this wire-up point. See share.js.
const { pipelineShareBooking } = require('./share').createShareHandlers({
    judgeAffected,
    getValidObjectives: () => VALID_OBJECTIVES,
});

// ============================================================================
// TASK PLANNER -- procedural state machine for the new architecture
// ============================================================================

// Per-Task-type planner limits. Hardcoded defaults preserved as fallback;
// precrime_config.json taskLimits overrides on a per-key basis (Subproject 10).
const _TASK_TYPE_LIMITS_DEFAULT = {
    DISCOVER_SOURCES: 1,
    SCRAPE_SOURCE:    5,
    APPLY_FACTLET:    5,
    DRILL_DOWN:       3,   // concurrent near-hot drill-downs (reserved slice)
    LAST_30_DAYS:     4,   // last30days seeder -- the search is deterministic Python (no LLM), so cap by CPU/RAM, not cost. Run several in parallel.
    FIND_CLIENT_SOURCES: 5,
    ENRICH_CLIENT:    10,
    JUDGE_AFFECTED:   25,  // in-process + cheap; let the proactive sweep (Stage 2b) drain eligible bookings fast
    SHOW_HOT_LEEDZ:   1,
    SHARE_BOOKING:    3,
    DRAFT_OUTREACH:   5
};
const _CFG_TASK_LIMITS = (PRECRIME_CONFIG && PRECRIME_CONFIG.tasks && PRECRIME_CONFIG.tasks.limits) || {};
const TASK_TYPE_LIMITS = Object.assign({}, _TASK_TYPE_LIMITS_DEFAULT, _CFG_TASK_LIMITS);

// Session budgets: maximum TOTAL Tasks of each type that one Session may
// create across the whole run (any status counts -- not just open). Distinct
// from TASK_TYPE_LIMITS, which is a concurrency cap on ready+claimed Tasks.
// Budget-exhausted inputs (Sources, Clients, Factlets, Bookings) stay in
// SQLite for the next Session; nothing is deleted.
const _TASK_SESSION_BUDGETS_DEFAULT = {
    DISCOVER_SOURCES: 1,
    SCRAPE_SOURCE:    25,
    APPLY_FACTLET:    50,
    DRILL_DOWN:       30,   // total near-hot drill-downs per session
    LAST_30_DAYS:     12,   // total last30days seeds per session (cheap search; let it run)
    FIND_CLIENT_SOURCES: 25,
    ENRICH_CLIENT:    50,
    JUDGE_AFFECTED:   150,  // proactive sweep can queue every eligible booking in one session
    SHOW_HOT_LEEDZ:   1,
    SHARE_BOOKING:    10,
    DRAFT_OUTREACH:   25
};

// ----------------------------------------------------------------------------
// Objective hierarchy. Mode = how the agent is being driven (interactive vs
// headless); Objective = what end state Tasks should aim for. The Planner uses
// objective to gate SHARE_BOOKING (marketplace path) and DRAFT_OUTREACH
// (outreach path) independently. See templates/GOOSE.md for the contract.
// ----------------------------------------------------------------------------
const VALID_OBJECTIVES = new Set(['marketplace', 'share', 'outreach', 'hybrid']);

function normalizeObjective(rawObjective, mode) {
    if (rawObjective !== undefined && rawObjective !== null && rawObjective !== '') {
        let obj = String(rawObjective).toLowerCase();
        if (obj === 'share') obj = 'marketplace';   // 'share' is the user-facing alias
        if (!VALID_OBJECTIVES.has(obj)) {
            const err = new Error(`plan_tasks: invalid objective "${rawObjective}". Expected one of: share, outreach, hybrid.`);
            err.code = -32602;
            throw err;
        }
        return obj;
    }
    if (mode === 'headless') return 'marketplace';
    return 'hybrid';   // workflow, hot_only, anything else
}
const _CFG_SESSION_BUDGETS = (PRECRIME_CONFIG && PRECRIME_CONFIG.tasks && PRECRIME_CONFIG.tasks.sessionBudgets) || {};
const TASK_SESSION_BUDGETS = Object.assign({}, _TASK_SESSION_BUDGETS_DEFAULT, _CFG_SESSION_BUDGETS);

const TASK_TYPES = new Set(Object.keys(_TASK_TYPE_LIMITS_DEFAULT));
const _CFG_CLAIM_TIMEOUT = PRECRIME_CONFIG && PRECRIME_CONFIG.recycler && PRECRIME_CONFIG.recycler.claimTimeoutMinutes;
const CLAIM_TIMEOUT_MINUTES = Number.isFinite(_CFG_CLAIM_TIMEOUT) ? _CFG_CLAIM_TIMEOUT : 10;
const _CFG_WORKFLOW_STRATEGY = (PRECRIME_CONFIG && PRECRIME_CONFIG.tasks && PRECRIME_CONFIG.tasks.workflowStrategy) || {};
const FACTLET_BACKLOG_DISCOVERY_PAUSE = Number.isFinite(_CFG_WORKFLOW_STRATEGY.factletBacklogDiscoveryPause)
    ? _CFG_WORKFLOW_STRATEGY.factletBacklogDiscoveryPause
    : 25;
const TASK_TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
// Claim order mirrors the business loop (DOCS/WHAT_I_LEARNED.md):
//   judge first   -- we must know if hot work already exists before doing
//                    anything else
//   hot action    -- once judged hot, the workflow interrupts and presents
//                    / shares / drafts
//   apply         -- consume known evidence (Factlets) before spending search
//                    effort improving Clients
//   enrich        -- improve one Client after judging current evidence
//   scrape / discover -- LAST: they create more input, must not run while the
//                    existing input pile is unprocessed
//
// Worker skills that pass `types:[...]` override this priority for THAT one
// claim only (e.g. apply-factlet.md claims types:["APPLY_FACTLET"]).
const TASK_CLAIM_PRIORITY = [
    'JUDGE_AFFECTED',
    'SHOW_HOT_LEEDZ',
    'SHARE_BOOKING',
    'DRAFT_OUTREACH',
    'APPLY_FACTLET',
    'FIND_CLIENT_SOURCES',
    'ENRICH_CLIENT',
    'SCRAPE_SOURCE',
    'DISCOVER_SOURCES'
];

function taskRowToPacket(row) {
    if (!row) return null;
    return {
        id:         row.id,
        type:       row.type,
        status:     row.status,
        sessionId:  row.sessionId,
        targetType: row.targetType,
        targetId:   row.targetId,
        input:      row.input ? safeJsonParse(row.input) : null,
        output:     row.output ? safeJsonParse(row.output) : null,
        error:      row.error,
        claimedAt:  row.claimedAt,
        claimedBy:  row.claimedBy,
        createdAt:  row.createdAt,
        updatedAt:  row.updatedAt,
        finishedAt: row.finishedAt
    };
}

function safeJsonParse(s) {
    try { return JSON.parse(s); } catch { return null; }
}

// Client.targetUrls carries the enrichment source-summary queue produced by the
// FIND_CLIENT_SOURCES worker: entries shaped { url, summary, consumed }. An
// entry with `consumed === false` is a pending source summary for ENRICH_CLIENT
// to fold into the dossier. Legacy targetUrls entries ({ url, type, label }) have
// no `consumed` property and are ignored here.
function parseClientSourceSummaries(targetUrls) {
    const arr = safeJsonParse(targetUrls);
    return Array.isArray(arr) ? arr : [];
}

// Server-side candidate-client filter for one Factlet. Mirrors (in reverse) the
// Returns client ids that should receive an APPLY_FACTLET task for this factlet.
// Path A: factlet names a specific client (identity match on name/company/website).
// Path B: factlet is about the VALUE_PROP trade AND the client's booking context
//         has topical overlap with the factlet's specific content.
//         Clients with no bookings are always included (uncharted, no context to check).
//         Clients with bookings are included only when >=2 factlet-specific tokens
//         (non-VALUE_PROP, non-stopword, length>=5) appear in their booking context.
//         If the factlet has no specific tokens (pure market signal), all clients qualify.
// Returns { ids, broad }. `broad` = a pure market-signal factlet that applies to ~every
// client (mentions the trade but nothing client-specific). The planner prunes ONLY broad
// dateless factlets to live clients; identity/profile-specific matches reach a client even
// when it is dead, which is how a relevant factlet RE-INVIGORATES a dormant client.
async function candidateClientIdsForFactlet(factlet) {
    if (!factlet) return { ids: [], broad: false };
    const hay = `${factlet.content || ''} ${factlet.source || ''}`.toLowerCase();
    if (!hay.trim()) return { ids: [], broad: false };

    // Single query: load clients with enough booking context for both paths.
    const clients = await prisma.client.findMany({
        select: {
            id: true,
            name: true,
            company: true,
            website: true,
            segment: true,
            clientNotes: true,
            dossier: true,
            lastEnriched: true,
            bookings: {
                select: { title: true, description: true, trade: true, location: true }
            }
        }
    });

    // Path A -- identity match: factlet literally names this client.
    const identityMatched = [];
    for (const c of clients) {
        const toks = [];
        const add = (s) => { const t = String(s || '').trim().toLowerCase(); if (t.length >= 4) toks.push(t); };
        add(c.name);
        add(c.company);
        if (c.website) {
            try { add(new URL(c.website).hostname.replace(/^www\./, '')); }
            catch { add(c.website); }
        }
        if (toks.some(t => hay.includes(t))) identityMatched.push(c);
    }
    if (identityMatched.length > 0) {
        return { ids: identityMatched.map(c => c.id), broad: false };
    }

    // Path B -- VALUE_PROP factlet: gate on whether factlet mentions the trade,
    // then filter per-client by topical overlap with their booking history.
    if (!factletMentionsValueProp(factlet, null, RUNTIME_CONFIG)) return { ids: [], broad: false };

    // Build the set of VALUE_PROP tokens so we can exclude them from the
    // specificity check -- those confirm the factlet is about the trade but
    // don't tell us WHICH clients it's relevant to.
    const vpTerms = collectValuePropDemandTerms(null, RUNTIME_CONFIG);
    const vpTokenSet = new Set([
        ...vpTerms.tokens,
        ...[...vpTerms.phrases].flatMap(p => p.split(/\s+/))
    ]);

    // Factlet-specific tokens: what the factlet is about BEYOND the trade.
    // These are the signals we use to match against client booking context.
    const factletNorm = normalizeDemandText(`${factlet.content} ${factlet.source}`);
    const specificTokens = factletNorm.split(/\s+/).filter(t =>
        t.length >= 5 && !vpTokenSet.has(t) && !VALUE_PROP_TOKEN_STOPWORDS.has(t)
    );

    const byLeastRecentlyEnriched = (a, b) =>
        (a.lastEnriched ? new Date(a.lastEnriched).getTime() : 0) -
        (b.lastEnriched ? new Date(b.lastEnriched).getTime() : 0);

    // No specific tokens: pure market-signal factlet, applies to every client. BROAD.
    if (specificTokens.length === 0) {
        return { ids: [...clients].sort(byLeastRecentlyEnriched).map(c => c.id), broad: true };
    }

    // Specific factlet: match each client on its PROFILE (who they are — segment, notes,
    // dossier, name/company) AND its booking history. Profile matching is what lets a
    // dormant, bookingless client be re-invigorated by a relevant factlet — e.g. "prom
    // season" matches a school-activities-coordinator client by its profile, not by a
    // booking it doesn't have. A client with no matchable text is skipped (not blanket
    // included), so a truly specific factlet stays specific instead of hitting everyone.
    const relevant = clients.filter(client => {
        const ctx = normalizeDemandText([
            client.name, client.company, client.segment, client.clientNotes, client.dossier,
            ...client.bookings.map(b => `${b.title || ''} ${b.description || ''} ${b.trade || ''} ${b.location || ''}`)
        ].filter(Boolean).join(' '));
        if (!ctx) return false;
        let hits = 0;
        for (const tok of specificTokens) {
            if (ctx.includes(tok)) hits++;
            if (hits >= 2) return true;
        }
        return false;
    });

    return { ids: relevant.sort(byLeastRecentlyEnriched).map(c => c.id), broad: false };
}

async function getTerminalAppliedFactletIds() {
    const rows = await prisma.task.findMany({
        where: {
            type: 'APPLY_FACTLET',
            targetType: 'Factlet',
            targetId: { not: null },
            status: { in: TASK_TERMINAL_STATUSES }
        },
        select: { targetId: true }
    });
    return new Set(rows.map(r => r.targetId).filter(Boolean));
}

// Near-hot detection for the active drill-down stage. For each LIVE booking
// (future-dated, not yet shared), compute the hot prerequisites it is still
// missing via classify(). "near-hot" reflects the real FIELD gaps -- a dated
// booking is its own demand signal, independent of accumulated factlets. Returns
// bookings ranked by closeness (fewest missing) then urgency (soonest event);
// hot_eligible bookings (nothing missing) are excluded.
async function computeNearHotBookings() {
    const now = Date.now();
    const futureMinHours = (SCORING.classification && SCORING.classification.futureMinHours) ?? 12;
    const opts = {
        futureMinHours,
        mode: bookingActionToMode(RUNTIME_CONFIG && RUNTIME_CONFIG.defaultBookingAction),
        defaultTrade: (VALUE_PROP && VALUE_PROP.trade) || (RUNTIME_CONFIG && RUNTIME_CONFIG.defaultTrade) || '',
        genericEmailPrefixes: (SCORING.booking && SCORING.booking.genericEmailPrefixes) || [],
        orgNameTokens: (SCORING.classification && SCORING.classification.orgNameTokens) || []
    };
    const bookings = await prisma.booking.findMany({
        where: {
            status: { in: ['cold', 'brewing'] },
            startDate: { gt: new Date() },
            shared: false
        },
        include: { client: true }
    });
    const ranked = [];
    for (const b of bookings) {
        let proc;
        try { proc = classification.classify(b.client, b, opts); } catch (_) { continue; }
        const missing = (proc && proc.missing) || [];
        if (proc && proc.state === 'hot_eligible') continue; // nothing missing
        if (!missing.length) continue;
        const daysToEvent = Math.max(0, Math.round((new Date(b.startDate).getTime() - now) / 86400000));
        ranked.push({
            bookingId: b.id, clientId: b.clientId,
            missing, missingCount: missing.length,
            startDate: b.startDate, daysToEvent
        });
    }
    // Closeness first (fewest missing), then urgency (soonest event).
    ranked.sort((a, b) => (a.missingCount - b.missingCount) || (a.daysToEvent - b.daysToEvent));
    return ranked;
}

async function computeWorkflowIntakeState() {
    const staleDays = await getFactletStaleDays();
    const factletCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    // Claimable sources come from the markdown-backed store (ready = unscraped
    // & unclaimed this run), not the DB.
    const claimableSources = Object.values(sourceStore.counts().byChannel)
        .reduce((s, c) => s + (c.ready || 0), 0);
    const [liveFactlets, terminalAppliedFactletIds] = await Promise.all([
        prisma.factlet.findMany({
            where: { createdAt: { gte: factletCutoff } },
            orderBy: { createdAt: 'desc' },
            select: { id: true }
        }),
        getTerminalAppliedFactletIds()
    ]);
    const unprocessedFactletIds = liveFactlets
        .map(f => f.id)
        .filter(fid => !terminalAppliedFactletIds.has(fid));
    const strategy = unprocessedFactletIds.length >= FACTLET_BACKLOG_DISCOVERY_PAUSE
        ? 'consume_factlets'
        : 'discover_sources';
    return {
        strategy,
        factletCutoff,
        factletStaleDays: staleDays,
        liveFactletCount: liveFactlets.length,
        unprocessedFactletCount: unprocessedFactletIds.length,
        unprocessedFactletIds,
        terminalAppliedFactletIds,
        claimableSourceCount: claimableSources,
        factletBacklogDiscoveryPause: FACTLET_BACKLOG_DISCOVERY_PAUSE
    };
}

// Normalize affected-id keys from a Task output blob. Canonical keys are
// `clientIds` and `bookingIds` (matches Phase 3 worker skills and design doc).
// Legacy keys `affectedClientIds` and `affectedBookingIds` are still accepted
// so older completed Tasks keep triggering JUDGE_AFFECTED. Returns deduped
// arrays; non-array / missing values are treated as empty.
function extractAffectedIds(out) {
    const pick = (...arrs) => {
        const seen = new Set();
        const result = [];
        for (const a of arrs) {
            if (!Array.isArray(a)) continue;
            for (const v of a) {
                if (v == null) continue;
                if (seen.has(v)) continue;
                seen.add(v);
                result.push(v);
            }
        }
        return result;
    };
    if (!out || typeof out !== 'object') return { clientIds: [], bookingIds: [] };
    return {
        clientIds:  pick(out.clientIds,  out.affectedClientIds),
        bookingIds: pick(out.bookingIds, out.affectedBookingIds)
    };
}

async function reclaimStaleTasks() {
    // claimed Tasks older than the timeout become ready again.
    const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MINUTES * 60 * 1000);
    const stale = await prisma.task.findMany({
        where: { status: 'claimed', claimedAt: { lt: cutoff } },
        select: { id: true }
    });
    if (stale.length === 0) return 0;
    await prisma.task.updateMany({
        where: { id: { in: stale.map(t => t.id) } },
        data: { status: 'ready', claimedAt: null, claimedBy: null }
    });
    return stale.length;
}

// A factlet "carries booking info" when its text has a concrete date signal (year,
// month+day, or numeric date). Such a factlet can attach/justify a FUTURE booking,
// so the pruning below lets it reach clients that aren't live yet. A dateless tidbit
// does not — it only enriches clients that already have a future booking.
function factletHasEventSignal(factlet) {
    const t = `${(factlet && factlet.content) || ''} ${(factlet && factlet.source) || ''}`.toLowerCase();
    if (!t.trim()) return false;
    return /\b20\d{2}\b/.test(t)                                                              // a year
        || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/.test(t) // month + day
        || /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(t);                                        // 6/26 or 6/26/2026
}

// Expire bookings whose event date has passed. An event leed is perishable: once the
// date is gone the booking is dead weight — it must not be scored, enriched, or counted
// as a live future booking. Demotes past cold/brewing bookings to 'expired' (idempotent;
// leaves hot/shared/expired and undated bookings untouched). Returns the count.
async function expirePastBookings() {
    const r = await prisma.booking.updateMany({
        where: { status: { in: ['cold', 'brewing'] }, startDate: { lt: new Date() } },
        data: { status: 'expired' }
    });
    return r.count;
}

async function cleanupOpenTasksOnStartup() {
    const now = new Date();
    const sessions = await prisma.session.updateMany({
        where: { status: 'active' },
        data: {
            status: 'abandoned',
            finishedAt: now
        }
    });
    const result = await prisma.task.updateMany({
        where: { status: { in: ['ready', 'claimed'] } },
        data: {
            status: 'cancelled',
            claimedAt: null,
            claimedBy: null,
            finishedAt: now,
            error: 'startup_cleanup_open_task'
        }
    });
    if (result.count > 0) {
        logInfo(`Startup recycler cancelled ${result.count} open Task(s) from previous runs.`);
    }
    if (sessions.count > 0) {
        logInfo(`Startup recycler abandoned ${sessions.count} active Session(s) from previous runs.`);
    }
    return { cancelledTasks: result.count, abandonedSessions: sessions.count };
}

// Ensure a Planner Session exists for this run. If session_id was passed and is
// still active, reuse it. Otherwise reuse the most recent active Session whose
// workflow matches this planner mode, or open a new one. The Planner is now the
// authoritative source of session lifecycle for Task-based runs; the older
// start_session / report_session path remains for legacy callers.
async function ensurePlannerSession(mode, providedSessionId) {
    if (providedSessionId) {
        const s = await prisma.session.findUnique({ where: { id: providedSessionId } });
        if (!s) {
            const err = new Error(`plan_tasks: session_id "${providedSessionId}" not found`);
            err.code = -32602;
            throw err;
        }
        if (s.status !== 'active') {
            const err = new Error(`plan_tasks: session "${providedSessionId}" is ${s.status}, not active`);
            err.code = -32602;
            throw err;
        }
        return s;
    }
    const active = await prisma.session.findFirst({
        where: { status: 'active', workflow: mode },
        orderBy: { startedAt: 'desc' }
    });
    if (active) return active;
    const sid = 'ses_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return await prisma.session.create({
        data: { id: sid, workflow: mode, status: 'active', startedAt: new Date() }
    });
}

// Conductor self-feed bridge. The conductor loop calls this when its queue is
// idle. We invoke the planner with NO session_id, so ensurePlannerSession reuses
// the active session (continuing the orchestrator's run) or — once a session's
// budget exhausts and it auto-closes — opens a FRESH session with a fresh budget.
// The planner's own strategy state machine handles the phase transition: it emits
// APPLY_FACTLET while the factlet backlog is high, then switches to client
// enrichment + source discovery once the backlog drops below the pause threshold.
// Returns a compact summary the conductor uses to decide whether to keep going.
async function conductorReplan() {
    const mode = (process.env.PRECRIME_MODE === 'headless') ? 'headless' : 'workflow';
    const objective = process.env.PRECRIME_OBJECTIVE || 'hybrid';
    let data = null;
    try {
        const resp = await pipelinePlanTasks('conductor-replan', { mode, objective });
        const text = resp && resp.result && resp.result.content && resp.result.content[0] && resp.result.content[0].text;
        data = text ? JSON.parse(text) : null;
    } catch (e) {
        logError(`conductorReplan failed: ${e.message}`);
        return { createdTotal: 0, backlogRemaining: null, strategy: null, sessionClosed: false, closeReason: 'replan_error' };
    }
    if (!data) {
        return { createdTotal: 0, backlogRemaining: null, strategy: null, sessionClosed: false, closeReason: 'parse_error' };
    }
    const createdTotal = Object.values(data.counts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const ws = data.workflowStrategy || null;
    return {
        createdTotal,
        backlogRemaining: ws ? ws.unprocessedFactletCount : null,
        strategy:         ws ? ws.strategy : null,
        sessionClosed:    !!data.sessionClosed,
        closeReason:      data.closeReason || null
    };
}

// In-process task executor. The conductor calls this for IN_PROCESS_TYPES
// (JUDGE_AFFECTED, SHOW_HOT_LEEDZ) instead of spawning a worker. JUDGE_AFFECTED is
// the hot-leedz maker: it runs judgeAffected() over the affected clients/bookings
// and promotes qualifying bookings to status=hot. Completing it (status=done)
// auto-stamps the source task as judged (see pipelineCompleteTask), so the planner
// stops re-creating it. SHOW_HOT_LEEDZ is a no-op presenter in autonomous mode —
// the hot bookings persist and are visible via status / report_session / the
// show-hot-leedz menu option — so we just mark it done with a summary so it does
// not keep re-gating the planner. Uses the server's configured LLM (e.g. openrouter
// → gemini-flash), NOT a spawned worker.
async function runInProcessTask(task) {
    const input = task.input ? safeJsonParse(task.input) : {};
    if (task.type === 'JUDGE_AFFECTED') {
        const clientIds  = Array.isArray(input && input.clientIds)  ? input.clientIds  : [];
        const bookingIds = Array.isArray(input && input.bookingIds) ? input.bookingIds : [];
        let changed = 0;
        if (clientIds.length || bookingIds.length) {
            const result = await judgeAffected({ clientIds, bookingIds, reason: 'judge_affected_task', writeStatus: true });
            changed = (result && Array.isArray(result.changed)) ? result.changed.length : 0;
        }
        await pipelineCompleteTask('inproc-judge', {
            taskId: task.id, status: 'done',
            output: { clientIds, bookingIds, changed, summary: `judged ${clientIds.length} client(s) / ${bookingIds.length} booking(s); ${changed} booking status change(s)` }
        });
        return { type: task.type, changed };
    }
    if (task.type === 'SHOW_HOT_LEEDZ') {
        const hotCount = await prisma.booking.count({
            where: { status: 'hot', shared: false, startDate: { gte: new Date() } }
        });
        await pipelineCompleteTask('inproc-showhot', {
            taskId: task.id, status: 'done',
            output: { hotCount, summary: `${hotCount} hot booking(s) ready to present (query via status / show-hot-leedz)` }
        });
        return { type: task.type, hotCount };
    }
    // Unknown in-process type — fail it so it cannot loop forever.
    await pipelineCompleteTask('inproc-unknown', { taskId: task.id, status: 'failed', error: `no in-process handler for ${task.type}` });
    return { type: task.type, error: 'no_handler' };
}

async function pipelinePlanTasks(id, args) {
    const mode = args.mode || 'workflow';     // 'workflow' | 'hot_only' | 'headless'

    // ARM the conductor on the orchestrator's first real workflow/headless plan
    // — this is the RUN_WORKFLOW signal. Before this, the conductor sits dormant
    // (no claim, no spawn, no self-feed), so nothing runs until the user chooses
    // to start. 'hot_only' (SHOW_HOT_LEEDZ) does NOT arm the full loop. The
    // conductor's own self-feed replan (id 'conductor-replan') never re-arms.
    if (id !== 'conductor-replan' && (mode === 'workflow' || mode === 'headless')) {
        armConductor();
    }

    // Objective ('marketplace' | 'outreach' | 'hybrid') gates SHARE_BOOKING
    // and DRAFT_OUTREACH independently. Defaults: headless->marketplace,
    // anything else->hybrid. See VALID_OBJECTIVES + normalizeObjective above.
    let objective;
    try {
        objective = normalizeObjective(args.objective, mode);
    } catch (e) {
        return createErrorResponse(id, e.code || -32602, e.message || String(e));
    }
    const wantsMarketplace = (objective === 'marketplace' || objective === 'hybrid');
    const wantsOutreach    = (objective === 'outreach'    || objective === 'hybrid');

    // Planner owns Session lifecycle. Reuse or open as needed.
    let session;
    try {
        session = await ensurePlannerSession(mode, args.session_id || null);
    } catch (e) {
        return createErrorResponse(id, e.code || -32603, e.message || String(e));
    }
    const sessionId = session.id;

    // Persist the resolved objective into Session.metadata so downstream actions
    // (notably share_booking) can defense-in-depth refuse calls that disagree
    // with the active objective. Latest plan_tasks wins; legacy sessions with
    // no recorded objective are treated as permissive by share_booking.
    try {
        let meta = {};
        if (session.metadata) {
            try { meta = JSON.parse(session.metadata) || {}; } catch (_) { meta = {}; }
        }
        if (meta.objective !== objective) {
            meta.objective = objective;
            await prisma.session.update({
                where: { id: sessionId },
                data:  { metadata: JSON.stringify(meta) }
            });
        }
    } catch (e) {
        logInfo(`plan_tasks: could not stamp objective on session ${sessionId}: ${e.message}`);
    }

    // Recycle stale claims before planning so limits reflect true ready state.
    const reclaimed = await reclaimStaleTasks();
    // Expire past-date bookings so they drop out of the live/future-booking set.
    await expirePastBookings();

    const counts = {};
    const created = [];
    const workflowState = (mode === 'workflow' || mode === 'headless')
        ? await computeWorkflowIntakeState()
        : null;
    const shouldPlanDiscovery = !workflowState || workflowState.strategy !== 'consume_factlets';
    const shouldPlanClientEnrichment = !workflowState || workflowState.strategy !== 'consume_factlets';

    // Total Tasks of each type already created in THIS Session (any status).
    // Drives the session-budget gate. Refreshed once at planning start; the
    // budget-aware createTask increments it in-memory as we go.
    const sessionCreatedSoFar = {};
    const _grouped = await prisma.task.groupBy({
        by: ['type'],
        where: { sessionId },
        _count: { _all: true }
    });
    for (const g of _grouped) sessionCreatedSoFar[g.type] = g._count._all;

    async function countReady(type) {
        return prisma.task.count({ where: { type, status: { in: ['ready', 'claimed'] } } });
    }

    // How many more Tasks of `type` may be created RIGHT NOW, gated by BOTH
    // tasks.limits (concurrency cap on open Tasks) AND tasks.sessionBudgets
    // (total-creation cap for this Session). Returns the effective max plus
    // diagnostics for inclusion in the response.
    async function createBudget(type) {
        const lim = TASK_TYPE_LIMITS[type] ?? 0;
        const bud = TASK_SESSION_BUDGETS[type] ?? 0;
        const openHave = await countReady(type);
        const sessHave = sessionCreatedSoFar[type] || 0;
        const limRem = Math.max(0, lim - openHave);
        const budRem = Math.max(0, bud - sessHave);
        return { eff: Math.min(limRem, budRem), limRem, budRem, openHave, sessHave, limit: lim, budget: bud };
    }

    // Budget-aware Task creator. Refuses (returns null) when either the open
    // limit or the session budget for `type` is reached. The per-section loops
    // also call createBudget(type) to size their candidate windows, so this
    // double-check is a safety net.
    async function createTask(type, fields) {
        const ck = await createBudget(type);
        if (ck.eff <= 0) return null;
        const row = await prisma.task.create({
            data: {
                type,
                status:     'ready',
                sessionId:  sessionId,
                targetType: fields.targetType || 'none',
                targetId:   fields.targetId   || null,
                input:      fields.input ? JSON.stringify(fields.input) : null
            }
        });
        created.push({ id: row.id, type, targetType: row.targetType, targetId: row.targetId });
        counts[type] = (counts[type] || 0) + 1;
        sessionCreatedSoFar[type] = (sessionCreatedSoFar[type] || 0) + 1;
        return row;
    }

    if (mode === 'hot_only' || args.objective === 'SHOW_HOT_LEEDZ') {
        const ck = await createBudget('SHOW_HOT_LEEDZ');
        const hotExists = await prisma.booking.count({
            where: {
                status: 'hot',
                shared: false,
                startDate: { gte: new Date() }
            }
        });
        let explanation;
        if (hotExists === 0) {
            explanation = 'Hot-only mode: no hot bookings -- nothing to present.';
        } else if (ck.eff <= 0 && ck.budRem === 0) {
            explanation = 'Hot-only mode: SHOW_HOT_LEEDZ session budget exhausted.';
        } else if (ck.eff <= 0) {
            explanation = 'Hot-only mode: SHOW_HOT_LEEDZ task already pending (limit).';
        } else {
            await createTask('SHOW_HOT_LEEDZ', { targetType: 'none' });
            explanation = `Hot-only mode: scheduled SHOW_HOT_LEEDZ for ${hotExists} hot booking(s).`;
        }
        const sum = computeBudgetSummary(sessionCreatedSoFar);
        const closed = await maybeCloseSession();
        return createSuccessResponse(id, JSON.stringify({
            mode, objective, session_id: sessionId, reclaimed, counts, created,
            hotBookingCount: hotExists,
            limits: TASK_TYPE_LIMITS,
            sessionBudgets: TASK_SESSION_BUDGETS,
            budgetUsage:    sum.budgetUsage,
            budgetExhausted: sum.budgetExhausted,
            sessionClosed:  closed.sessionClosed,
            closeReason:    closed.closeReason,
            explanation
        }, null, 2));
    }

    // Stage-gated workflow planning. See DOCS/WHAT_I_LEARNED.md for the
    // invariant: "consume evidence -> judge -> if hot interrupt and act ->
    // else enrich -> else scrape/discover". Each gate suppresses lower stages
    // for THIS plan_tasks call so the LLM cannot pull stale work past a hot
    // interrupt or before judging the latest evidence.
    if (mode === 'workflow' || mode === 'headless') {
        const suppressed = new Set();   // task types skipped this pass

        // Current-demand hygiene: drop stale factlets before planning so the
        // backlog reflects only LIVE demand and never re-animates old news.
        try {
            const _p = await pruneStaleFactlets();
            if (_p.deleted) logInfo(`Planner pruned ${_p.deleted} stale factlet(s) before planning.`);
        } catch (e) {
            logInfo(`Planner factlet prune skipped: ${e.message}`);
        }

        // ---------- Stage 2: JUDGE_AFFECTED for done worker output ----------
        // If any completed worker Task carries affected ids but has not been
        // judged yet, judge it first. While judge work is created OR already
        // open, skip every lower stage: hot interrupt depends on judged state,
        // and creating more workers / discovery before judging produces noise.
        const judgeAlreadyOpen = await countReady('JUDGE_AFFECTED');
        const doneTasks = await prisma.task.findMany({
            where: {
                status: 'done',
                type:   { in: ['SCRAPE_SOURCE', 'ENRICH_CLIENT', 'APPLY_FACTLET'] }
            },
            orderBy: { finishedAt: 'desc' },
            take: 50
        });
        const judgeNeededInputs = [];
        for (const t of doneTasks) {
            const out = t.output ? safeJsonParse(t.output) : null;
            if (!out || out.judgedAt) continue;
            const { clientIds: cIds, bookingIds: bIds } = extractAffectedIds(out);
            if (cIds.length === 0 && bIds.length === 0) continue;
            judgeNeededInputs.push({ sourceTaskId: t.id, clientIds: cIds, bookingIds: bIds });
        }

        // ---------- Stage 2b: PROACTIVE judge of eligible-but-unjudged bookings ----------
        // The reactive scan above only judges a booking a worker JUST touched. A
        // booking that became hot-eligible some OTHER way -- a noon-default start
        // time, a manual backfill, an enrichment that updated the client but not the
        // booking id -- would never be (re)judged and would sit cold forever despite
        // meeting every gate. THIS is the hole behind "lots of eligible bookings, 0
        // hot". Sweep future-dated, non-hot bookings that already clear the procedural
        // gates (trade + zip + venue + a contact-gated client) and queue them for the
        // same judge. Dedup by a judged-watermark: a booking is skipped if a finished
        // JUDGE_AFFECTED already covered it AT OR AFTER its last change (updatedAt), so
        // we judge each eligible booking once per change -- not on a loop. Bounded by
        // the JUDGE_AFFECTED budget via the shared create loop below.
        try {
            const eligible = await prisma.booking.findMany({
                where: {
                    status:    { not: 'hot' },
                    startDate: { gt: new Date() },
                    startTime: { not: null },
                    trade:     { not: null },
                    zip:       { not: null },
                    location:  { not: null },
                    client:    { contactGate: true }
                },
                orderBy: { updatedAt: 'desc' },
                take: 200,
                select: { id: true, updatedAt: true }
            });
            if (eligible.length > 0) {
                // Build bookingId -> latest finished-judge time from recent judge tasks.
                const doneJudge = await prisma.task.findMany({
                    where: { type: 'JUDGE_AFFECTED', status: 'done', NOT: { finishedAt: null } },
                    orderBy: { finishedAt: 'desc' }, take: 1000,
                    select: { input: true, finishedAt: true }
                });
                const lastJudged = new Map();
                for (const j of doneJudge) {
                    const inp = j.input ? safeJsonParse(j.input) : null;
                    const bids = inp && Array.isArray(inp.bookingIds) ? inp.bookingIds : [];
                    for (const bid of bids) {
                        if (!lastJudged.has(bid) || lastJudged.get(bid) < j.finishedAt) lastJudged.set(bid, j.finishedAt);
                    }
                }
                const alreadyQueued = new Set(judgeNeededInputs.flatMap(j => j.bookingIds || []));
                for (const b of eligible) {
                    if (alreadyQueued.has(b.id)) continue;
                    const lj = lastJudged.get(b.id);
                    if (lj && lj >= b.updatedAt) continue; // judged since last change -> skip
                    judgeNeededInputs.push({ sourceTaskId: 'proactive_eligible', clientIds: [], bookingIds: [b.id] });
                }
            }
        } catch (e) {
            logInfo(`Proactive judge sweep skipped: ${e.message}`);
        }

        let judgePlanned = 0;
        if (judgeNeededInputs.length > 0) {
            const ckJudge = await createBudget('JUDGE_AFFECTED');
            const slots = Math.min(ckJudge.eff, judgeNeededInputs.length);
            for (let i = 0; i < slots; i++) {
                const row = await createTask('JUDGE_AFFECTED', {
                    targetType: 'none',
                    input: judgeNeededInputs[i]
                });
                if (!row) break;
                judgePlanned++;
            }
        }
        if (judgePlanned > 0 || judgeAlreadyOpen > 0) {
            // Spec (DOCS/WHAT_I_LEARNED.md, "Exact Code Changes Required" #4
            // and the funnel-invariant Mental Model): after a higher-priority
            // gate creates or already has open Tasks, skip every lower
            // gate for THIS plan_tasks call. Judge sits at the top of the
            // funnel: hot interrupt depends on judged state, and creating
            // more worker / discovery Tasks before judging current evidence
            // produces noise. Strictly block every stage below.
            suppressed.add('SHOW_HOT_LEEDZ');
            suppressed.add('SHARE_BOOKING');
            suppressed.add('DRAFT_OUTREACH');
            suppressed.add('APPLY_FACTLET');
            suppressed.add('ENRICH_CLIENT');
            suppressed.add('SCRAPE_SOURCE');
            suppressed.add('DISCOVER_SOURCES');
        }

        // ---------- Stage 3: Hot Interrupt ----------
        // A hot lead interrupts the workflow. Once judged hot, interactive
        // workflow presents (SHOW_HOT_LEEDZ); headless creates SHARE_BOOKING
        // and/or DRAFT_OUTREACH per objective. Hot work suppresses enrich /
        // scrape / discover for this pass.
        let hotPlanned = 0;
        let hotExists = 0;
        let hotActionOpen = 0;
        const hotStageReachable = !suppressed.has('SHOW_HOT_LEEDZ')
            && !suppressed.has('SHARE_BOOKING')
            && !suppressed.has('DRAFT_OUTREACH');
        if (hotStageReachable) {
            hotExists = await prisma.booking.count({
                where: {
                    status: 'hot',
                    shared: false,
                    startDate: { gte: new Date() }
                }
            });
            hotActionOpen = await prisma.task.count({
                where: {
                    status: { in: ['ready', 'claimed'] },
                    type:   { in: ['SHOW_HOT_LEEDZ', 'SHARE_BOOKING', 'DRAFT_OUTREACH'] }
                }
            });
            if (hotExists > 0) {
                if (mode === 'workflow') {
                    // Interactive workflow -> SHOW_HOT_LEEDZ presenter only.
                    // SHARE_BOOKING / DRAFT_OUTREACH stay user-driven in
                    // interactive mode (init-wizard sends user through the
                    // presenter); planner does not auto-schedule them here.
                    const ckHot = await createBudget('SHOW_HOT_LEEDZ');
                    if (ckHot.eff > 0) {
                        const row = await createTask('SHOW_HOT_LEEDZ', { targetType: 'none' });
                        if (row) hotPlanned++;
                    }
                } else {
                    // Headless: marketplace -> SHARE_BOOKING for hot
                    // future unshared Bookings; outreach -> DRAFT_OUTREACH
                    // for qualified Clients. Hybrid does both.
                    if (wantsMarketplace) {
                        const ckShare = await createBudget('SHARE_BOOKING');
                        if (ckShare.eff > 0) {
                            const plannedB = await prisma.task.findMany({
                                where: {
                                    type: 'SHARE_BOOKING',
                                    targetType: 'Booking',
                                    OR: [
                                        { sessionId },
                                        { status: { in: ['ready', 'claimed'] } }
                                    ]
                                },
                                select: { targetId: true }
                            });
                            const skipB = new Set(plannedB.map(p => p.targetId).filter(Boolean));
                            // share-ready hard gates: hot status, future date, zip
                            // for timezone resolution, description present, and
                            // client must have a real named contact + direct
                            // non-generic email (contactGate). Phone preferred
                            // but checked at share_booking time, not here.
                            const candidates = await prisma.booking.findMany({
                                where: {
                                    status: 'hot',
                                    shared: false,
                                    startDate: { gte: new Date() },
                                    zip: { not: null },
                                    description: { not: null },
                                    client: { contactGate: true }
                                },
                                select: { id: true },
                                take: ckShare.eff + skipB.size
                            });
                            let made = 0;
                            for (const b of candidates) {
                                if (made >= ckShare.eff) break;
                                if (skipB.has(b.id)) continue;
                                const row = await createTask('SHARE_BOOKING', { targetType: 'Booking', targetId: b.id });
                                if (!row) break;
                                made++;
                            }
                            hotPlanned += made;
                        }
                    }
                    if (wantsOutreach) {
                        const ckDraft = await createBudget('DRAFT_OUTREACH');
                        if (ckDraft.eff > 0) {
                            const plannedD = await prisma.task.findMany({
                                where: {
                                    type: 'DRAFT_OUTREACH',
                                    targetType: 'Booking',
                                    OR: [
                                        { sessionId },
                                        { status: { in: ['ready', 'claimed'] } }
                                    ]
                                },
                                select: { targetId: true }
                            });
                            const skipD = new Set(plannedD.map(p => p.targetId).filter(Boolean));
                            // outreach-ready relaxed gates: hot OR brewing (strong
                            // signal but not marketplace-perfect), future event date,
                            // client must have any direct email (address found via
                            // email is why we're writing). Zip NOT required -- finding
                            // the exact venue is often the purpose of the email.
                            const candidates = await prisma.booking.findMany({
                                where: {
                                    status: { in: ['hot', 'brewing'] },
                                    shared: false,
                                    startDate: { gte: new Date() },
                                    client: { email: { not: null } }
                                },
                                orderBy: [{ startDate: 'asc' }],
                                select: { id: true },
                                take: ckDraft.eff + skipD.size
                            });
                            let made = 0;
                            for (const b of candidates) {
                                if (made >= ckDraft.eff) break;
                                if (skipD.has(b.id)) continue;
                                const row = await createTask('DRAFT_OUTREACH', {
                                    targetType: 'Booking',
                                    targetId:   b.id,
                                    input: { targetType: 'Booking', targetId: b.id }
                                });
                                if (!row) break;
                                made++;
                            }
                            hotPlanned += made;
                        }
                    }
                }
            }
            // Spec ("Exact Code Changes Required" #4 + funnel invariant):
            // once hot work was planned, is already open, OR hot Bookings
            // exist, skip every lower stage. Apply must also pause -- it
            // creates more judge-needed output that would compete with the
            // hot action we just scheduled.
            if (hotPlanned > 0 || hotActionOpen > 0 || hotExists > 0) {
                suppressed.add('APPLY_FACTLET');
                suppressed.add('ENRICH_CLIENT');
                suppressed.add('SCRAPE_SOURCE');
                suppressed.add('DISCOVER_SOURCES');
            }
        }

        // ---------- Stage 4: APPLY_FACTLET ----------
        // Consume known evidence. Spec ("Exact Code Changes Required" #4 +
        // funnel invariant): when apply was created OR already open, skip
        // every lower stage including ENRICH_CLIENT -- factlets are known
        // evidence and must be consumed before spending search effort on
        // Client improvement.
        // PER-TARGET DEDUP: same Factlet gets at most one APPLY_FACTLET in
        // this session AND no concurrent APPLY_FACTLET for the same Factlet
        // may exist anywhere.
        if (!suppressed.has('APPLY_FACTLET')) {
            const applyAlreadyOpen = await countReady('APPLY_FACTLET');
            const ckApply = await createBudget('APPLY_FACTLET');
            let applyPlanned = 0;
            if (ckApply.eff > 0) {
                const plannedF = await prisma.task.findMany({
                    where: {
                        type: 'APPLY_FACTLET',
                        targetType: 'Factlet',
                        OR: [
                            { sessionId },
                            { status: { in: ['ready', 'claimed'] } }
                        ]
                    },
                    select: { targetId: true }
                });
                // Factlet-level dedup: a Factlet that already has ANY APPLY_FACTLET
                // task is skipped. Because all of a Factlet's (factlet, client) pairs
                // are created in ONE atomic pass below, factlet-level dedup is enough
                // -- a Factlet is never left half-applied across passes.
                const skipF = new Set(plannedF.map(p => p.targetId).filter(Boolean));
                // Use all live factlets. Pair-level dedup below skips (factlet,client)
                // pairs that already have a task, so partially-applied factlets resume
                // where they left off across plan passes rather than being skipped.
                const staleCutoff = new Date(Date.now() - getFactletStaleDays() * 86400000);
                const allLiveFactletIds = (await prisma.factlet.findMany({
                    where: { createdAt: { gte: staleCutoff } },
                    orderBy: { createdAt: 'desc' },
                    select: { id: true }
                })).map(f => f.id);
                // BACKLOG-ADVANCE: process NEVER-APPLIED factlets first. The per-call
                // budget is tiny (concurrency 5), so a newest-first scan kept spending
                // it re-serving extra (factlet,client) pairs of already-applied factlets
                // and never reached the untouched ones -- the distinct-applied count
                // (and thus the backlog) stayed frozen. Partition: zero-terminal-task
                // factlets ahead of already-applied ones so each pass advances the
                // backlog; extra pairs of applied factlets are only served once the
                // never-applied set is exhausted.
                const appliedSet = (workflowState && workflowState.terminalAppliedFactletIds) || new Set();
                const orderedFactletIds = allLiveFactletIds.filter(id => !appliedSet.has(id))
                    .concat(allLiveFactletIds.filter(id => appliedSet.has(id)));
                // LIVENESS PRUNE — clients that can still go hot this round are those with a
                // FUTURE booking. A dateless factlet (no booking info) is applied ONLY to those;
                // an event-bearing factlet (factletHasEventSignal) bypasses the prune since it can
                // attach a new future booking. This collapses the per-factlet candidate set —
                // including the market-signal "applies to EVERY client" case — to the live few,
                // which is the bulk of the APPLY_FACTLET burn. (Keep the full DB; prune the WORK.)
                const liveClientIds = new Set(
                    (await prisma.booking.findMany({
                        where: { startDate: { gt: new Date() }, status: { in: ['cold', 'brewing', 'hot'] } },
                        select: { clientId: true }, distinct: ['clientId']
                    })).map(b => b.clientId).filter(Boolean)
                );
                for (const factletId of orderedFactletIds) {
                    if (skipF.has(factletId)) continue; // active task exists -- don't double-plan
                    const factlet = await prisma.factlet.findUnique({ where: { id: factletId } });
                    if (!factlet) continue;
                    // Server pre-filters candidate clients (token/name/host overlap):
                    // each APPLY_FACTLET worker gets exactly ONE (factlet, client) pair
                    // = one small LLM call.
                    const matched = await candidateClientIdsForFactlet(factlet);
                    let candidateIds = matched.ids;
                    // Liveness prune ONLY a BROAD market-signal factlet (applies to ~every
                    // client) to live clients — and only when it carries no date (a dated
                    // broad factlet can still attach a booking). A factlet that SPECIFICALLY
                    // references a client (by name, or by matching its profile/bookings)
                    // reaches that client even when DEAD — that is how a relevant factlet
                    // (e.g. "prom season" → an LA school activities coordinator) RE-INVIGORATES
                    // a dormant client. If a broad prune empties the list, the factlet falls to
                    // one sweep task below → still reaches terminal, so the backlog drains.
                    if (matched.broad && !factletHasEventSignal(factlet)) {
                        candidateIds = candidateIds.filter(cid => liveClientIds.has(cid));
                    }
                    // Pair-level dedup: skip (factlet, client) pairs that already have
                    // any task (any status). This lets budget-limited passes resume on
                    // the same factlet next plan cycle without re-creating work.
                    if (candidateIds.length > 0) {
                        const existing = await prisma.task.findMany({
                            where: { type: 'APPLY_FACTLET', targetType: 'Factlet', targetId: factletId },
                            select: { input: true }
                        });
                        const served = new Set(existing.map(t => t.input && t.input.clientId).filter(Boolean));
                        candidateIds = candidateIds.filter(cid => !served.has(cid));
                        if (candidateIds.length === 0) continue; // all clients already served
                    }
                    const pairs = candidateIds.length ? candidateIds : [null];
                    let plannedAny = false;
                    for (const cid of pairs) {
                        if ((await createBudget('APPLY_FACTLET')).eff <= 0) break;
                        const row = await createTask('APPLY_FACTLET', {
                            targetType: 'Factlet',
                            targetId:   factletId,
                            input: cid ? { clientId: cid } : { clientId: null, reason: 'no_candidate_clients' }
                        });
                        if (!row) break;
                        plannedAny = true;
                    }
                    if (plannedAny) applyPlanned++;
                    if ((await createBudget('APPLY_FACTLET')).eff <= 0) break;
                }
            }
            if (applyPlanned > 0 || applyAlreadyOpen > 0) {
                suppressed.add('ENRICH_CLIENT');
                suppressed.add('SCRAPE_SOURCE');
                suppressed.add('DISCOVER_SOURCES');
            }
            // Backlog: consume_factlets strategy also pauses ENRICH this pass.
            if (workflowState && workflowState.strategy === 'consume_factlets') {
                suppressed.add('ENRICH_CLIENT');
                suppressed.add('SCRAPE_SOURCE');
                suppressed.add('DISCOVER_SOURCES');
            }
        }

        // ---------- Stage 4.5: DRILL_DOWN -- actively close near-hot bookings ----------
        // Rank LIVE bookings by closeness (fewest missing hot prerequisites) then
        // urgency (soonest event); schedule a research-only DRILL_DOWN that hunts a
        // booking's SPECIFIC missing fields. Effort is tiered to closeness -- a booking
        // one field from hot gets more attempts than one missing three. This stage does
        // NOT suppress scrape/discovery: foundational input stages must keep running
        // (docs/solutions/logic-errors/planner-priority-inversion-starves-source-stages.md).
        if (!suppressed.has('DRILL_DOWN')) {
            const ckDrillTop = await createBudget('DRILL_DOWN');
            if (ckDrillTop.eff > 0) {
                let nearHot = [];
                try { nearHot = await computeNearHotBookings(); }
                catch (e) { logInfo(`near-hot compute skipped: ${e.message}`); }
                // Finish-one-leed mode: concentrate the budget on the single top booking.
                if (args.focus === 'one_leed' && nearHot.length) nearHot = [nearHot[0]];
                // Prior terminal DRILL_DOWN count per booking (tiered-cap decay).
                const drillCounts = new Map();
                const priorDrills = await prisma.task.groupBy({
                    by: ['targetId'],
                    where: { type: 'DRILL_DOWN', targetType: 'Booking', status: { in: TASK_TERMINAL_STATUSES } },
                    _count: { targetId: true }
                });
                for (const r of priorDrills) if (r.targetId) drillCounts.set(r.targetId, r._count.targetId);
                // Skip bookings already mid-drill (this session or open).
                const openDrill = await prisma.task.findMany({
                    where: { type: 'DRILL_DOWN', targetType: 'Booking',
                        OR: [{ sessionId }, { status: { in: ['ready', 'claimed'] } }] },
                    select: { targetId: true }
                });
                const skipB = new Set(openDrill.map(t => t.targetId).filter(Boolean));
                // Tiered attempt cap by closeness: closer bookings earn more tries.
                const capFor = (n) => n <= 1 ? 6 : (n <= 2 ? 3 : 1);
                for (const nh of nearHot) {
                    if ((await createBudget('DRILL_DOWN')).eff <= 0) break;
                    if (skipB.has(nh.bookingId)) continue;
                    if ((drillCounts.get(nh.bookingId) || 0) >= capFor(nh.missingCount)) continue;
                    const row = await createTask('DRILL_DOWN', {
                        targetType: 'Booking', targetId: nh.bookingId,
                        input: { clientId: nh.clientId, missing: nh.missing, startDate: nh.startDate }
                    });
                    if (!row) break;
                }
            }

            // Also drill BARE clients (e.g. discovery / social-discovery-refresh
            // output): a client with NO contact AND no future booking cannot become a
            // leed on its own. Try a research DRILL_DOWN to find a decision-maker
            // contact + a bookable upcoming event. One attempt per client (skip any
            // already drilled), newest first so fresh discoveries go first. Shares the
            // DRILL_DOWN budget -- near-hot bookings above are served first.
            if ((await createBudget('DRILL_DOWN')).eff > 0) {
                const drilledClients = new Set((await prisma.task.findMany({
                    where: { type: 'DRILL_DOWN', targetType: 'Client' },
                    select: { targetId: true }
                })).map(t => t.targetId).filter(Boolean));
                const bareClients = await prisma.client.findMany({
                    where: {
                        contactGate: false,
                        draftStatus: { not: 'sent' },
                        bookings: { none: { startDate: { gt: new Date() } } }
                    },
                    orderBy: { createdAt: 'desc' },
                    take: 50,
                    select: { id: true }
                });
                for (const c of bareClients) {
                    if ((await createBudget('DRILL_DOWN')).eff <= 0) break;
                    if (drilledClients.has(c.id)) continue;
                    const row = await createTask('DRILL_DOWN', {
                        targetType: 'Client', targetId: c.id,
                        input: { clientId: c.id, missing: ['client_email', 'booking'] }
                    });
                    if (!row) break;
                }
            }
        }

        // ---------- Stage 5: client enrichment (FIND_CLIENT_SOURCES -> ENRICH_CLIENT) ----------
        // Enrichment mirrors discovery's two-stage shape:
        //   FIND_CLIENT_SOURCES (producer): a stale Client with no pending source
        //     summaries gets a Tavily search -> stores { url, summary, consumed:false }
        //     entries on Client.targetUrls.
        //   ENRICH_CLIENT (consumer): each unconsumed summary becomes one small
        //     synthesis Task -> the worker folds that one summary into the dossier
        //     and marks the entry consumed.
        // Both are gated together (consume_factlets pauses enrichment) and both
        // suppress lower scrape/discovery stages when scheduled. Client-level dedup
        // + atomic per-client ENRICH creation (all of a client's unconsumed summaries
        // enqueued in one pass) prevents partial coverage, same as APPLY_FACTLET.
        if (!suppressed.has('ENRICH_CLIENT') && shouldPlanClientEnrichment) {
            const enrichOpen = await countReady('ENRICH_CLIENT');
            const findOpen   = await countReady('FIND_CLIENT_SOURCES');
            // Clients already mid-enrichment (open or this-session FIND/ENRICH) are skipped.
            const busy = await prisma.task.findMany({
                where: {
                    type: { in: ['ENRICH_CLIENT', 'FIND_CLIENT_SOURCES'] },
                    targetType: 'Client',
                    OR: [ { sessionId }, { status: { in: ['ready', 'claimed'] } } ]
                },
                select: { targetId: true }
            });
            const skipC = new Set(busy.map(t => t.targetId).filter(Boolean));
            const ckEnrichTop = await createBudget('ENRICH_CLIENT');
            const ckFindTop   = await createBudget('FIND_CLIENT_SOURCES');
            const windowSize = Math.max(ckEnrichTop.eff, ckFindTop.eff) + skipC.size;
            const planCap = Math.max(ckEnrichTop.eff, ckFindTop.eff);
            let clientWorkPlanned = 0;

            // Completed FIND_CLIENT_SOURCES passes per client — one cap so an unfindable
            // contact (or a thin client) can't draw new searches forever.
            const findPasses = await prisma.task.groupBy({
                by: ['targetId'],
                where: { type: 'FIND_CLIENT_SOURCES', targetType: 'Client', status: 'done' },
                _count: { targetId: true }
            });
            const findPassCount = new Map(
                findPasses.filter(r => r.targetId).map(r => [r.targetId, r._count.targetId])
            );
            const MAX_FIND_PASSES = 3;

            // Enrich ONLY LIVE clients — those with a FUTURE booking. Dead clients (no
            // future booking) are never enriched: that IS the pruning, and it removes the
            // need for a separate deprecation rule. Priority falls out of the data: a live
            // client missing a direct contact (contactGate=false) gets a contact_email FIND
            // (the near-hot chase — one field from hot); a client with pending source
            // summaries gets ENRICH; otherwise a general FIND. Keep the full DB; prune the WORK.
            if (windowSize > 0) {
                const liveClients = await prisma.client.findMany({
                    where: {
                        bookings: { some: {
                            startDate: { gt: new Date() },
                            status: { in: ['cold', 'brewing', 'hot'] }
                        } }
                    },
                    orderBy: [{ lastEnriched: 'asc' }],   // stalest live client first
                    take: planCap + skipC.size + 20,
                    select: { id: true, contactGate: true, targetUrls: true }
                });
                for (const c of liveClients) {
                    if (clientWorkPlanned >= planCap) break;
                    if (skipC.has(c.id)) continue;
                    // Stop re-chasing un-promotable live clients: once a client has used
                    // its full FIND budget (MAX_FIND_PASSES passes) and still hasn't
                    // promoted, more enrichment + re-judging just burns budget on the same
                    // dead-end every run (the classic "12 stuck trade-show contacts" loop).
                    // Skip it; its FIND history is retained ~taskRetentionDays, so it gets
                    // a fresh window later in case a real decision-maker contact appears.
                    if ((findPassCount.get(c.id) || 0) >= MAX_FIND_PASSES) continue;
                    const unconsumed = parseClientSourceSummaries(c.targetUrls)
                        .filter(e => e && e.url && e.consumed === false);
                    if (unconsumed.length) {
                        // Consumer: one ENRICH per unconsumed summary, atomic per client. Always
                        // allowed (consuming work already paid for) regardless of the FIND cap.
                        if ((await createBudget('ENRICH_CLIENT')).eff < unconsumed.length) continue;
                        for (const e of unconsumed) {
                            const row = await createTask('ENRICH_CLIENT', {
                                targetType: 'Client', targetId: c.id,
                                input: { url: e.url, summary: e.summary || '' }
                            });
                            if (!row) break;
                        }
                        clientWorkPlanned++;
                    } else if ((findPassCount.get(c.id) || 0) < MAX_FIND_PASSES) {
                        // Producer: find sources. No contact yet → aim at the decision-maker
                        // email (the near-hot chase); otherwise a general source search.
                        if ((await createBudget('FIND_CLIENT_SOURCES')).eff <= 0) continue;
                        const input = c.contactGate === false ? { focus: 'contact_email' } : {};
                        const row = await createTask('FIND_CLIENT_SOURCES', { targetType: 'Client', targetId: c.id, input });
                        if (row) clientWorkPlanned++;
                    }
                }
            }
            // Client enrichment does NOT suppress scraping/discovery. Scraping fresh
            // sources is the funnel's fuel and must run ALONGSIDE enrichment, not wait
            // behind it -- otherwise a handful of un-promotable live clients (or a few
            // stuck-claimed enrich tasks) starve SCRAPE_SOURCE/DISCOVER_SOURCES for the
            // whole session, and no new demand ever enters. The Judge/Apply stages above
            // still gate scrape correctly (don't scrape before judging existing evidence).
        }

        // ---------- Stage 6: SCRAPE_SOURCE ----------
        // Scrape existing Sources only when no hot / judge / apply / enrich
        // backlog is gating us. PER-TARGET DEDUP same as other workers.
        if (!suppressed.has('SCRAPE_SOURCE') && shouldPlanDiscovery) {
            const ckScrape = await createBudget('SCRAPE_SOURCE');
            let scrapePlanned = 0;
            const scrapeOpen = await countReady('SCRAPE_SOURCE');
            if (ckScrape.eff > 0) {
                const planned = await prisma.task.findMany({
                    where: {
                        type: 'SCRAPE_SOURCE',
                        targetType: 'Source',
                        OR: [
                            { sessionId },
                            { status: { in: ['ready', 'claimed'] } }
                        ]
                    },
                    select: { targetId: true }
                });
                const skipUrls = planned.map(p => p.targetId).filter(Boolean);
                // fb/ig cannot render via Tavily (url-loop) in ANY mode -- they need
                // an interactive browser. Excluding them ALWAYS stops the Planner from
                // emitting SCRAPE_SOURCE Tasks that only fail ("FB not viable") and churn
                // every replan. (Earlier this was headless-only, so interactive runs
                // leaked fb/ig scrape tasks -- the source of the FB failure spam.) x
                // stays: it has a Tavily site:x.com fallback that works headless. Social
                // demand (ig/tiktok/threads/x) comes through LAST_30_DAYS, not scraping.
                // Sources come from the markdown-backed store (the URL is the key).
                const sources = sourceStore.readySources({
                    limit: ckScrape.eff,
                    excludeChannels: ['fb', 'ig'],
                    excludeUrls: skipUrls
                });
                for (const s of sources) {
                    if (scrapePlanned >= ckScrape.eff) break;
                    const row = await createTask('SCRAPE_SOURCE', {
                        targetType: 'Source',
                        targetId:   s.url,
                        input: { url: s.url, channel: s.channel }
                    });
                    if (!row) break;
                    scrapePlanned++;
                }
            }
            // Claimable Sources still pending -> hold off on DISCOVER_SOURCES.
            if (scrapePlanned > 0 || scrapeOpen > 0
                || (workflowState && workflowState.claimableSourceCount > 0)) {
                suppressed.add('DISCOVER_SOURCES');
            }
        }

        // ---------- Stage 7: DISCOVER_SOURCES ----------
        // Discovery is LAST because it creates more input. Only fires when the
        // funnel is empty: no hot work, no judge work, no apply / enrich /
        // scrape backlog, and no claimable Sources waiting.
        if (!suppressed.has('DISCOVER_SOURCES') && shouldPlanDiscovery) {
            const ckDisc = await createBudget('DISCOVER_SOURCES');
            if (ckDisc.eff > 0) {
                await createTask('DISCOVER_SOURCES', { targetType: 'none' });
            }
        }

        // ---------- Stage 8: LAST_30_DAYS -- last30days seeder ----------
        // Topic-driven demand sensing: runs the last30days CLI on VALUE_PROP buyer
        // occasions and ingests high-score dated-event candidates as Clients +
        // Factlets + Bookings + Sources (the event+contact pairing scraping rarely
        // gets). The search itself is deterministic Python (no LLM), so it is cheap
        // to run wide -- capped by CPU/RAM (TASK_TYPE_LIMITS.LAST_30_DAYS), not cost.
        // Fires when the funnel needs fresh input; spawns a batch up to the limit so
        // several run in parallel instead of one-at-a-time.
        if (shouldPlanDiscovery) {
            const want = TASK_TYPE_LIMITS.LAST_30_DAYS || 1;
            for (let i = 0; i < want; i++) {
                if ((await createBudget('LAST_30_DAYS')).eff <= 0) break;
                if (!(await createTask('LAST_30_DAYS', { targetType: 'none' }))) break;
            }
        }
    }

    const sum = computeBudgetSummary(sessionCreatedSoFar);
    const closed = await maybeCloseSession();

    const explanationParts = [
        `Planned ${created.length} task(s) in session ${sessionId}`,
        `${reclaimed} stale claim(s) recycled`
    ];
    if (workflowState) {
        explanationParts.push(
            `strategy=${workflowState.strategy}; unprocessedFactlets=${workflowState.unprocessedFactletCount}; claimableSources=${workflowState.claimableSourceCount}`
        );
    }
    if (sum.budgetExhausted.length > 0) {
        explanationParts.push(`budget exhausted for: ${sum.budgetExhausted.join(', ')}`);
    }
    if (closed.sessionClosed) {
        explanationParts.push(`session closed (${closed.closeReason})`);
    }

    return createSuccessResponse(id, JSON.stringify({
        mode,
        objective,
        session_id:     sessionId,
        reclaimed,
        counts,
        created,
        workflowStrategy: workflowState ? {
            strategy: workflowState.strategy,
            unprocessedFactletCount: workflowState.unprocessedFactletCount,
            liveFactletCount: workflowState.liveFactletCount,
            claimableSourceCount: workflowState.claimableSourceCount,
            factletStaleDays: workflowState.factletStaleDays,
            factletBacklogDiscoveryPause: workflowState.factletBacklogDiscoveryPause
        } : null,
        limits:         TASK_TYPE_LIMITS,
        sessionBudgets: TASK_SESSION_BUDGETS,
        budgetUsage:    sum.budgetUsage,
        budgetExhausted: sum.budgetExhausted,
        sessionClosed:  closed.sessionClosed,
        closeReason:    closed.closeReason,
        explanation:    explanationParts.join('; ') + '.'
    }, null, 2));

    // ---------------- helpers (closures over sessionId / sessionCreatedSoFar) ----------------
    function computeBudgetSummary(_unused) {
        const budgetUsage = {};
        const budgetExhausted = [];
        for (const type of Object.keys(TASK_SESSION_BUDGETS)) {
            const used      = sessionCreatedSoFar[type] || 0;
            const budget    = TASK_SESSION_BUDGETS[type];
            const remaining = Math.max(0, budget - used);
            budgetUsage[type] = { used, budget, remaining };
            if (budget > 0 && remaining === 0) budgetExhausted.push(type);
        }
        return { budgetUsage, budgetExhausted };
    }

    async function maybeCloseSession() {
        // Deterministic close: this plan call created zero new Tasks AND no
        // open (ready/claimed) Task remains for this Session.
        //
        // closeReason is ALWAYS a non-empty string:
        //   - "work_remaining"                              -- session still active
        //   - "budget_exhausted: TYPE_A, TYPE_B"            -- closed; budgets capped these types
        //   - "no_more_work"                                -- closed; nothing to plan, no budget exhausted
        if (created.length > 0) {
            return { sessionClosed: false, closeReason: 'work_remaining' };
        }
        const openInSession = await prisma.task.count({
            where: { sessionId, status: { in: ['ready', 'claimed'] } }
        });
        if (openInSession > 0) {
            return { sessionClosed: false, closeReason: 'work_remaining' };
        }
        const sumNow = computeBudgetSummary();
        const reason = sumNow.budgetExhausted.length > 0
            ? `budget_exhausted: ${sumNow.budgetExhausted.join(', ')}`
            : 'no_more_work';
        await prisma.session.update({
            where: { id: sessionId },
            data:  { status: 'complete', finishedAt: new Date() }
        });
        await prisma.sessionEvent.create({
            data: {
                sessionId,
                action:  'session_closed',
                payload: JSON.stringify({
                    by:               'planner',
                    closeReason:      reason,
                    budgetUsage:      sumNow.budgetUsage,
                    budgetExhausted:  sumNow.budgetExhausted
                })
            }
        }).catch(() => {});
        return { sessionClosed: true, closeReason: reason };
    }
}

async function pipelineClaimTask(id, args) {
    const role      = args.role || 'worker';
    const sessionId = args.session_id || null;
    const types     = Array.isArray(args.types) ? args.types.filter(t => TASK_TYPES.has(t)) : null;

    // Recycle stale claims before claiming.
    await reclaimStaleTasks();

    // Atomic claim: SELECT + UPDATE in a transaction, retry on lost race.
    for (let attempt = 0; attempt < 5; attempt++) {
        const typeOrder = (types && types.length > 0) ? types : TASK_CLAIM_PRIORITY;
        let candidate = null;
        for (const type of typeOrder) {
            const where = { status: 'ready', type };
            if (sessionId) where.sessionId = sessionId;
            candidate = await prisma.task.findFirst({
                where,
                orderBy: [{ createdAt: 'asc' }]
            });
            if (candidate) break;
        }
        if (!candidate) {
            return createSuccessResponse(id, JSON.stringify({ status: 'NO_TASK' }, null, 2));
        }
        // updateMany with the previous status acts as a compare-and-swap.
        const upd = await prisma.task.updateMany({
            where: { id: candidate.id, status: 'ready' },
            data: {
                status:    'claimed',
                claimedAt: new Date(),
                claimedBy: role,
                sessionId: candidate.sessionId || sessionId
            }
        });
        if (upd.count === 1) {
            const row = await prisma.task.findUnique({ where: { id: candidate.id } });
            return createSuccessResponse(id, JSON.stringify({
                status: 'CLAIMED',
                task:   taskRowToPacket(row)
            }, null, 2));
        }
        // lost race; loop
    }
    return createSuccessResponse(id, JSON.stringify({ status: 'CONTENTION' }, null, 2));
}

async function pipelineGetTask(id, args) {
    const taskId = args.taskId || args.id;
    if (!taskId) return createErrorResponse(id, -32602, 'get_task requires taskId.');
    const row = await prisma.task.findUnique({ where: { id: taskId } });
    if (!row) return createErrorResponse(id, -32602, `get_task: task "${taskId}" not found.`);
    return createSuccessResponse(id, JSON.stringify(taskRowToPacket(row), null, 2));
}

async function pipelineCompleteTask(id, args) {
    const taskId = args.taskId || args.id;
    const status = args.status || 'done';
    if (!taskId) return createErrorResponse(id, -32602, 'complete_task requires taskId.');
    if (!['done', 'failed', 'cancelled'].includes(status)) {
        return createErrorResponse(id, -32602, `complete_task status must be done|failed|cancelled (got "${status}").`);
    }
    const row = await prisma.task.findUnique({ where: { id: taskId } });
    if (!row) return createErrorResponse(id, -32602, `Task not found: ${taskId}`);
    if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
        return createErrorResponse(id, -32602, `Task ${taskId} already terminal (${row.status}).`);
    }
    const output = args.output != null ? JSON.stringify(args.output) : row.output;
    const error  = args.error != null ? String(args.error) : row.error;
    const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
            status,
            output,
            error,
            finishedAt: new Date()
        }
    });
    // Stamp the source worker Task as judged so pipelinePlanTasks does not
    // re-spawn JUDGE_AFFECTED for it on subsequent passes. Fires only after a
    // successful JUDGE_AFFECTED that carries input.sourceTaskId. Missing /
    // invalid source output is treated as {} so the marker still lands.
    if (updated.type === 'JUDGE_AFFECTED' && updated.status === 'done') {
        const inp = updated.input ? safeJsonParse(updated.input) : null;
        const srcId = inp && inp.sourceTaskId;
        if (srcId) {
            try {
                const srcRow = await prisma.task.findUnique({ where: { id: srcId } });
                if (srcRow) {
                    let srcOut = srcRow.output ? safeJsonParse(srcRow.output) : null;
                    if (!srcOut || typeof srcOut !== 'object') srcOut = {};
                    srcOut.judgedAt       = new Date().toISOString();
                    srcOut.judgedByTaskId = updated.id;
                    await prisma.task.update({
                        where: { id: srcId },
                        data:  { output: JSON.stringify(srcOut) }
                    });
                }
            } catch (e) {
                logInfo(`complete_task judged-stamp failed for task ${updated.id} -> source ${srcId}: ${e.message}`);
            }
        }
    }
    // Audit trail: log task completion into the linked Session's event log so
    // report_session / audit_session can reconstruct the run from Tasks, not
    // just legacy save events.
    if (updated.sessionId) {
        let outSummary = null;
        try { outSummary = output ? JSON.parse(output)?.summary || null : null; } catch (_) { outSummary = null; }
        try {
            await prisma.sessionEvent.create({
                data: {
                    sessionId: updated.sessionId,
                    action:    'task_completed',
                    payload:   JSON.stringify({
                        taskId:     updated.id,
                        type:       updated.type,
                        status:     updated.status,
                        targetType: updated.targetType,
                        targetId:   updated.targetId,
                        summary:    outSummary,
                        error:      updated.error || null
                    })
                }
            });
        } catch (e) {
            // Audit failures must not break the worker. Log and move on.
            logInfo(`complete_task audit log failed for task ${updated.id}: ${e.message}`);
        }
    }
    return createSuccessResponse(id, JSON.stringify({
        completed: true,
        task:       taskRowToPacket(updated),
        session_id: updated.sessionId || null
    }, null, 2));
}

async function pipelineTasks(id, args) {
    const where = {};
    if (args.status)     where.status     = args.status;
    if (args.type)       where.type       = args.type;
    if (args.sessionId)  where.sessionId  = args.sessionId;
    if (args.targetType) where.targetType = args.targetType;
    if (args.targetId)   where.targetId   = args.targetId;
    const limit = Math.min(args.limit || 100, 500);
    const rows = await prisma.task.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: limit
    });
    return createSuccessResponse(id, JSON.stringify({
        count: rows.length,
        tasks: rows.map(taskRowToPacket)
    }, null, 2));
}

// ============================================================================
// RECYCLER -- startup/manual cleanup of stale runtime/exhaust data.
// Touches only Task and Factlet rows. Never deletes Clients, Bookings, Sources,
// Sessions, or dossier text. See DOCS/WHAT_I_LEARNED.md subproject 8.
// ============================================================================

// Delete Factlets older than the stale window. PreCrime is about CURRENT demand:
// stale evidence is REMOVED, never re-animated. Shared by startup, the planner
// cycle, and the recycler action so all three agree on one definition of "stale".
// dryRun reports the count without deleting (used by the recycler action).
async function pruneStaleFactlets({ dryRun = false, staleDays } = {}) {
    const days = Number.isFinite(staleDays) ? staleDays : getFactletStaleDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const stale = await prisma.factlet.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true }
    });
    const ids = stale.map(f => f.id);
    if (!dryRun && ids.length > 0) {
        await prisma.factlet.deleteMany({ where: { id: { in: ids } } });
    }
    return { deleted: ids.length, ids, cutoffIso: cutoff.toISOString() };
}

async function pipelineRecycler(id, args) {
    const dryRun              = args.dryRun !== false;  // default true
    // Precedence: explicit args > precrime_config.json > hardcoded defaults.
    const _rec = (PRECRIME_CONFIG && PRECRIME_CONFIG.recycler) || {};
    const _cfgFactletStale  = Number.isFinite(_rec.factletStaleDays)    ? _rec.factletStaleDays    : 180;
    const _cfgTaskRetention = Number.isFinite(_rec.taskRetentionDays)   ? _rec.taskRetentionDays   : 30;
    const _cfgClaimTimeout  = Number.isFinite(_rec.claimTimeoutMinutes) ? _rec.claimTimeoutMinutes : 10;
    const factletStaleDays    = Number.isFinite(args.factletStaleDays)    ? args.factletStaleDays    : _cfgFactletStale;
    const taskRetentionDays   = Number.isFinite(args.taskRetentionDays)   ? args.taskRetentionDays   : _cfgTaskRetention;
    const claimTimeoutMinutes = Number.isFinite(args.claimTimeoutMinutes) ? args.claimTimeoutMinutes : _cfgClaimTimeout;

    const now            = new Date();
    const claimCutoff    = new Date(now.getTime() - claimTimeoutMinutes * 60 * 1000);
    const taskCutoff     = new Date(now.getTime() - taskRetentionDays   * 24 * 60 * 60 * 1000);
    const factletTaskCutoff = new Date(now.getTime() - Math.max(taskRetentionDays, factletStaleDays) * 24 * 60 * 60 * 1000);
    const factletCutoff  = new Date(now.getTime() - factletStaleDays    * 24 * 60 * 60 * 1000);
    const SAMPLE         = 10;
    const warnings       = [];

    // 1. Timed-out claimed Tasks -> ready
    const staleClaims = await prisma.task.findMany({
        where: { status: 'claimed', claimedAt: { lt: claimCutoff } },
        select: { id: true }
    });
    const staleClaimIds = staleClaims.map(t => t.id);
    if (!dryRun && staleClaimIds.length > 0) {
        await prisma.task.updateMany({
            where: { id: { in: staleClaimIds } },
            data:  { status: 'ready', claimedAt: null, claimedBy: null }
        });
    }

    // 2. Old finished Tasks -> delete. Use finishedAt when set, else updatedAt.
    // Never touch ready or claimed Tasks here. (Timed-out claimed were requeued above.)
    const finishedCandidates = await prisma.task.findMany({
        where: {
            status: { in: ['done', 'failed', 'cancelled'] },
            OR: [
                {
                    AND: [
                        { type: { not: 'APPLY_FACTLET' } },
                        {
                            OR: [
                                { finishedAt: { lt: taskCutoff } },
                                { AND: [{ finishedAt: null }, { updatedAt: { lt: taskCutoff } }] }
                            ]
                        }
                    ]
                },
                {
                    AND: [
                        { type: 'APPLY_FACTLET' },
                        {
                            OR: [
                                { finishedAt: { lt: factletTaskCutoff } },
                                { AND: [{ finishedAt: null }, { updatedAt: { lt: factletTaskCutoff } }] }
                            ]
                        }
                    ]
                }
            ]
        },
        select: { id: true }
    });
    const finishedIds = finishedCandidates.map(t => t.id);
    if (!dryRun && finishedIds.length > 0) {
        await prisma.task.deleteMany({ where: { id: { in: finishedIds } } });
    }

    // 3. Stale Factlets -> delete (via shared pruneStaleFactlets so startup,
    // planner, and this action agree on one definition). Dossier text is untouched.
    let staleFactletIds = [];
    try {
        const pruned = await pruneStaleFactlets({ dryRun, staleDays: factletStaleDays });
        staleFactletIds = pruned.ids;
    } catch (e) {
        warnings.push(`factlet delete failed: ${e.message}`);
    }

    return createSuccessResponse(id, JSON.stringify({
        dryRun,
        now: now.toISOString(),
        thresholds: { factletStaleDays, taskRetentionDays, applyFactletTaskRetentionDays: Math.max(taskRetentionDays, factletStaleDays), claimTimeoutMinutes },
        timedOutTasksRequeued: staleClaimIds.length,
        finishedTasksDeleted:  finishedIds.length,
        staleFactletsDeleted:  staleFactletIds.length,
        sample: {
            timedOutTaskIds:  staleClaimIds.slice(0, SAMPLE),
            finishedTaskIds:  finishedIds.slice(0, SAMPLE),
            staleFactletIds:  staleFactletIds.slice(0, SAMPLE)
        },
        warnings
    }, null, 2));
}

// ============================================================================
// SESSION LIFECYCLE — start, report, audit, plus internal logSessionEvent
// ============================================================================
// The accountability layer. Sessions are server-issued, append-only, and
// queried server-side. The model cannot lie about session totals because
// pipeline.report_session generates its own summary from the SessionEvent log.
// ============================================================================

/**
 * Internal — log one event against a session. No-op if sessionId is falsy.
 * Catches and swallows errors so logging never breaks the caller.
 */
async function logSessionEvent(sessionId, action, payloadObj) {
    if (!sessionId) return;
    try {
        await prisma.sessionEvent.create({
            data: {
                sessionId,
                action,
                payload: payloadObj ? JSON.stringify(payloadObj) : null
            }
        });
    } catch (e) {
        logInfo(`logSessionEvent failed (sessionId=${sessionId}, action=${action}): ${e.message}`);
    }
}

/**
 * Build the canonical markdown rendering of a session summary. This is the
 * EXACT string the agent is instructed to paste back to the user — pre-baking
 * the wording removes the temptation for the model to paraphrase.
 *
 * Lines are deliberately bland and stat-focused so the model has nothing to
 * "improve" by rewording.
 */
function buildSummaryMarkdown(s) {
    const lines = [];
    const requestedStr = (s.requested === null || s.requested === undefined) ? 'n/a' : String(s.requested);
    const durationSec = Math.round((s.duration_ms || 0) / 1000);
    let headline;
    if (s.status === 'failed_no_data') {
        headline = `Session FAILED -- no save attempts (agent never called pipeline.save)`;
    } else if (s.status === 'failed_all_rejected') {
        headline = `Session FAILED -- ${s.save_attempts} attempts, all rejected by server`;
    } else if (s.status === 'completed_no_new_evidence') {
        headline = `Session complete -- ${s.task_completions || 0} Task(s), no new saves`;
    } else if (s.actually_saved < (s.requested ?? Infinity)) {
        headline = `Session under target -- saved ${s.actually_saved} of ${requestedStr} requested`;
    } else {
        headline = `Session complete -- saved ${s.actually_saved}`;
    }

    lines.push(`## ${headline}`);
    lines.push('');
    lines.push(`- Workflow: \`${s.workflow}\``);
    lines.push(`- Requested: ${requestedStr}`);
    lines.push(`- Save attempts: ${s.save_attempts ?? 0}`);
    lines.push(`- Actually saved: ${s.actually_saved}`);
    lines.push(`- Failed: ${s.failed}`);
    if (s.task_total !== undefined) lines.push(`- Tasks: ${s.task_completions || 0} completed of ${s.task_total}`);
    lines.push(`- Status: ${s.status}`);
    if (s.reason) lines.push(`- Reason: ${s.reason}`);
    lines.push(`- Duration: ${durationSec}s`);
    lines.push(`- Session: \`${s.session_id}\``);

    if (Array.isArray(s.saved_clients) && s.saved_clients.length > 0) {
        lines.push('');
        lines.push('**Saved clients:**');
        for (const c of s.saved_clients) {
            const name  = c.name || '(no name)';
            const cid   = c.clientId || '(no id)';
            const score = (c.score === null || c.score === undefined) ? '?' : c.score;
            // A score-0 save is a BARE client (no contact, no booking) -- it cannot
            // become a leed without enrichment. Flag it so a partial "saved N" result
            // is not mistaken for progress toward hot leedz.
            const bare = !c.score ? ' — **bare: no contact/booking yet, needs enrichment to become a leed**' : '';
            lines.push(`- ${name} — clientId: \`${cid}\` — score: ${score}${bare}`);
        }
    }

    if (Array.isArray(s.failures) && s.failures.length > 0) {
        lines.push('');
        lines.push('**Failures:**');
        for (const f of s.failures) {
            const name = f.name || f.id || '(unnamed client)';
            const err  = f.error || '(no error message)';
            const src  = f.source ? `  [${f.source}]` : '';
            lines.push(`- ${name} — ${err}${src}`);
            // Per-booking date detail: which event, what date text was bad, why.
            if (Array.isArray(f.failures)) {
                for (const d of f.failures) {
                    const ev   = d.title || '(untitled event)';
                    const dt   = d.dateText ? ` date="${d.dateText}"` : '';
                    const url  = d.sourceUrl ? ` src=${d.sourceUrl}` : '';
                    const why  = d.reason ? ` — ${d.reason}` : '';
                    lines.push(`    · ${ev}${dt}${url}${why}`);
                }
            }
        }
    }

    // Per-task ground truth. The session-level Reason above is an INFERENCE; this
    // block is what each worker actually reported (output.summary or error code).
    // This is how you tell "judged, changed nothing" apart from "scrape crashed"
    // apart from "no candidate clients" -- instead of one blanket guess.
    if (Array.isArray(s.task_history) && s.task_history.length > 0) {
        lines.push('');
        lines.push('**Per-task outcomes:**');
        for (const t of s.task_history) {
            const why = t.reason ? ` — ${t.reason}` : '';
            lines.push(`- ${t.type} [${t.status}]${why}`);
        }
    }

    if (s.status === 'under_target' && s.actually_saved < (s.requested ?? Infinity)) {
        lines.push('');
        lines.push(`_Under target by ${s.requested - s.actually_saved}. Re-run \`start_session\` to continue, or accept the partial result._`);
    }

    return lines.join('\n');
}

/**
 * Watchdog: enforce the 3-min save-or-terminate wall on active sessions.
 *
 * Sweeps any active session older than 180s with 0 save_attempts -- closes
 * it as 'abandoned' and returns an error response refusing the current call.
 * Read-tool handlers (status, next, rescore, find/*) call this at the top.
 * start_session also calls it (ignoring the return) to clean up first.
 *
 * Returns:
 *   { terminated: true, errorResponse }  -- caller MUST return errorResponse
 *   { terminated: false }                 -- proceed normally
 */
async function enforceSessionWatchdog(id) {
    const TERMINATE_AT_SEC      = 180;   // 3 min: zombie threshold (mark abandoned)
    const ERROR_THRESHOLD_SEC   = 600;   // 10 min: above this, silent cleanup -- the
                                          // session predates the current agent and
                                          // erroring its first call is a false positive.

    const activeSessions = await prisma.session.findMany({
        where: { status: 'active' },
        include: { events: true },
        orderBy: { startedAt: 'desc' }
    });

    let freshZombie = null;  // a fresh zombie (3-10 min) likely belongs to the current
                              // agent and is a real in-session stall worth flagging.

    for (const sess of activeSessions) {
        const ageSec = Math.round((Date.now() - sess.startedAt.getTime()) / 1000);
        const attempts = sess.events.filter(e => e.action === 'save_attempt').length;
        const taskEvents = sess.events.filter(e => e.action === 'task_completed').length;
        const taskRows = await prisma.task.count({ where: { sessionId: sess.id } });
        const hasTaskProgress = taskEvents > 0 || taskRows > 0;

        if (attempts > 0 && ageSec >= ERROR_THRESHOLD_SEC) {
            await prisma.session.update({
                where: { id: sess.id },
                data: { status: 'abandoned', finishedAt: new Date() }
            });
            await prisma.sessionEvent.create({
                data: {
                    sessionId: sess.id,
                    action: 'auto_abandoned',
                    payload: JSON.stringify({
                        ageSec,
                        attempts,
                        reason: 'stale_active_session_silent_cleanup'
                    })
                }
            });
            logInfo(`Watchdog: silent cleanup of stale active session ${sess.id} (workflow="${sess.workflow}", attempts ${attempts}, age ${ageSec}s).`);
            continue;
        }

        if (attempts === 0 && !hasTaskProgress && ageSec >= TERMINATE_AT_SEC) {
            const isStale = ageSec >= ERROR_THRESHOLD_SEC;
            await prisma.session.update({
                where: { id: sess.id },
                data: { status: 'abandoned', finishedAt: new Date() }
            });
            await prisma.sessionEvent.create({
                data: {
                    sessionId: sess.id,
                    action: 'auto_abandoned',
                    payload: JSON.stringify({
                        ageSec,
                        reason: isStale ? 'stale_from_previous_run_silent_cleanup' : 'no_saves_within_3min'
                    })
                }
            });
            if (isStale) {
                logInfo(`Watchdog: silent cleanup of stale zombie ${sess.id} (workflow="${sess.workflow}", age ${ageSec}s) -- not erroring current call.`);
            } else if (!freshZombie || ageSec < freshZombie.ageSec) {
                freshZombie = { sess, ageSec };
            }
        }
    }

    if (freshZombie) {
        return {
            terminated: true,
            errorResponse: createErrorResponse(id, -32000,
                `Session ${freshZombie.sess.id} (workflow="${freshZombie.sess.workflow}") auto-terminated at ${freshZombie.ageSec}s with 0 saves. ` +
                `Switch strategy: claim a different source via pipeline.next_source(channel?, maxAgeDays?), or call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task (or seed via pipeline.add_sources). ` +
                `Do NOT re-open the same workflow without changing approach -- that just burns another 3 min.`)
        };
    }

    return { terminated: false };
}

/**
 * Open a new workflow session. Returns the server-issued session_id —
 * the agent must carry this forward to subsequent save calls and to the
 * eventual report_session call.
 *
 * Hard rules enforced here:
 * - target_count is REQUIRED and must be a positive number. No more "n/a requested".
 * - Only one active session per workflow. Refuses overlap.
 * - Refuses to re-open within 60s of an auto-abandoned session for the same
 *   workflow -- forces strategy change after a 3-min wall.
 * - Sweeps stale sessions before checking overlap.
 */
async function pipelineStartSession(id, workflow, targetCount, metadata) {
    if (!workflow || typeof workflow !== 'string') {
        return createErrorResponse(id, -32602, 'start_session requires workflow (string), e.g. "url-loop".');
    }
    if (typeof targetCount !== 'number' || targetCount <= 0) {
        return createErrorResponse(id, -32602,
            'start_session requires target_count (number > 0). E.g. target_count: 10. ' +
            'No more "n/a requested" -- commit to a number.');
    }

    // Sweep stale sessions first so the overlap check is fair.
    await enforceSessionWatchdog(id);

    // Refuse overlap on the same workflow.
    const existing = await prisma.session.findFirst({
        where: { status: 'active', workflow },
        include: { events: true }
    });
    if (existing) {
        const ageSec = Math.round((Date.now() - existing.startedAt.getTime()) / 1000);
        const attempts = existing.events.filter(e => e.action === 'save_attempt').length;
        if (ageSec >= 3600) {
            await prisma.session.update({
                where: { id: existing.id },
                data: { status: 'abandoned', finishedAt: new Date() }
            });
            await prisma.sessionEvent.create({
                data: {
                    sessionId: existing.id,
                    action: 'auto_abandoned',
                    payload: JSON.stringify({
                        ageSec,
                        attempts,
                        reason: 'stale_active_overlap_cleanup'
                    })
                }
            });
        } else {
        return createErrorResponse(id, -32602,
            `Session ${existing.id} for workflow "${workflow}" is already active ` +
            `(${ageSec}s old, ${attempts} save attempts). Close it with report_session, or wait for the 3-min watchdog.`);
        }
    }

    // Refuse rapid re-open after auto-termination on the same workflow.
    const recentAbandoned = await prisma.session.findFirst({
        where: {
            workflow,
            status: 'abandoned',
            startedAt: { gte: new Date(Date.now() - 10 * 60_000) },
            finishedAt: { gte: new Date(Date.now() - 60_000) }
        },
        orderBy: { finishedAt: 'desc' }
    });
    if (recentAbandoned) {
        return createErrorResponse(id, -32602,
            `Workflow "${workflow}" had a session auto-terminated <60s ago (${recentAbandoned.id}). ` +
            `Wait 60s OR change strategy: claim a different source via pipeline.next_source(channel?, maxAgeDays?), or call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task (or seed via pipeline.add_sources). ` +
            `Repeating the same workflow without saves only burns time.`);
    }

    const sid = 'ses_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const session = await prisma.session.create({
        data: {
            id: sid,
            workflow,
            targetCount: (typeof targetCount === 'number' && targetCount > 0) ? targetCount : null,
            metadata: metadata ? JSON.stringify(metadata) : null
        }
    });
    return createSuccessResponse(id, JSON.stringify({
        session_id: session.id,
        workflow: session.workflow,
        target_count: session.targetCount,
        started_at: session.startedAt.toISOString(),
        note: 'Pass this session_id to every save call in this workflow. End with report_session.'
    }, null, 2));
}

/**
 * Aggregate a session's events server-side and return the truth.
 * If close=true (action=report_session), marks the session complete and
 * appends a "report" event so the report itself is auditable.
 * If close=false (action=audit_session), leaves status untouched.
 */
async function pipelineReportSession(id, sessionId, close) {
    let session;
    if (!sessionId) {
        // audit_session with no ID: auto-pick the most recent session.
        // report_session still requires an explicit ID (it closes a session — must be deliberate).
        if (close) {
            return createErrorResponse(id, -32602, `report_session requires session_id.`);
        }
        session = await prisma.session.findFirst({
            orderBy: { startedAt: 'desc' },
            include: { events: { orderBy: { ts: 'asc' } } }
        });
        if (!session) {
            return createErrorResponse(id, -32602, `audit_session: no sessions exist yet. Start one with action=start_session.`);
        }
        sessionId = session.id;
    } else {
        session = await prisma.session.findUnique({
            where: { id: sessionId },
            include: { events: { orderBy: { ts: 'asc' } } }
        });
        if (!session) {
            return createErrorResponse(id, -32602, `session_id "${sessionId}" not found.`);
        }
    }

    const attempts  = session.events.filter(e => e.action === 'save_attempt');
    const successes = session.events.filter(e => e.action === 'save_success');
    const failures  = session.events.filter(e => e.action === 'save_failed');
    const marks     = session.events.filter(e => e.action === 'source_marked');
    const taskDone  = session.events.filter(e => e.action === 'task_completed');

    // Task history -- the new Planner/Worker/Judge path writes a task_completed
    // event for every complete_task call, and the Task rows themselves carry
    // sessionId. Aggregate by type so headless final reports and audit_session
    // can use server-truthful counts instead of LLM-rolled totals.
    const sessionTasks = await prisma.task.findMany({
        where: { sessionId: sessionId },
        orderBy: { createdAt: 'asc' }
    });
    const taskCountsByType = {};
    const taskOutcomesByType = {};   // { TYPE: { done: n, failed: n, cancelled: n, ready: n, claimed: n } }
    for (const t of sessionTasks) {
        taskCountsByType[t.type] = (taskCountsByType[t.type] || 0) + 1;
        if (!taskOutcomesByType[t.type]) taskOutcomesByType[t.type] = {};
        taskOutcomesByType[t.type][t.status] = (taskOutcomesByType[t.type][t.status] || 0) + 1;
    }
    const taskHistory = sessionTasks.map(t => {
        // Per-task ground truth: the worker wrote output.summary (done) or error
        // (failed/cancelled). Surface it so the report says WHY each task saved
        // nothing, instead of leaning only on the inferred session-level reason.
        let outSummary = null;
        try { outSummary = t.output ? (JSON.parse(t.output)?.summary || null) : null; } catch (_) { outSummary = null; }
        return {
            id:         t.id,
            type:       t.type,
            status:     t.status,
            targetType: t.targetType,
            targetId:   t.targetId,
            finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
            error:      t.error || null,
            // One field the reader can scan: failed/cancelled -> error code;
            // done -> the worker's own summary; null only if the worker wrote neither.
            reason:     t.error || outSummary || null
        };
    });

    const savedClients = successes.map(e => {
        try { return JSON.parse(e.payload); } catch { return { raw: e.payload }; }
    });
    const failureList = failures.map(e => {
        try { return JSON.parse(e.payload); } catch { return { raw: e.payload }; }
    });

    // Honest status. Distinguish:
    //   - agent did literally nothing                 -> failed_no_data
    //   - agent scraped sources but URLs yielded zero -> scraped_no_clients (NOT a failure)
    //   - agent tried saves, server rejected all     -> failed_all_rejected
    //   - under target                                -> under_target
    //   - complete                                    -> complete
    // The agent is forbidden from overwriting this.
    let honestStatus;
    let reason = null;
    const terminalTaskCount = sessionTasks.filter(t => ['done', 'failed', 'cancelled'].includes(t.status)).length;
    if (attempts.length === 0 && marks.length === 0 && terminalTaskCount === 0) {
        honestStatus = 'failed_no_data';
        reason = 'no_save_attempts and no_sources_marked -- agent ran the workflow but did nothing';
    } else if (attempts.length === 0 && marks.length === 0 && terminalTaskCount > 0) {
        honestStatus = 'completed_no_new_evidence';
        reason = `${terminalTaskCount} Task(s) reached terminal status with 0 saves -- valid Task workflow result when evidence is duplicate, irrelevant, or judge-only`;
    } else if (attempts.length === 0 && marks.length > 0) {
        honestStatus = 'scraped_no_clients';
        const cf = marks.reduce((s, m) => { try { return s + (JSON.parse(m.payload).clientsFound || 0); } catch { return s; } }, 0);
        reason = `${marks.length} source(s) scraped, ${cf} client(s) extracted, 0 saves -- URLs yielded nothing this round (legitimate null result, keep digging)`;
    } else if (successes.length === 0) {
        honestStatus = 'failed_all_rejected';
        reason = `all ${attempts.length} save attempts rejected by server -- see failures[]`;
    } else if (session.targetCount && successes.length < session.targetCount) {
        honestStatus = 'under_target';
    } else {
        honestStatus = 'complete';
    }

    const summary = {
        session_id: sessionId,
        workflow: session.workflow,
        status: close ? honestStatus : session.status,
        reason,
        requested: session.targetCount,
        save_attempts: attempts.length,
        actually_saved: successes.length,
        failed: failures.length,
        saved_clients: savedClients,
        failures: failureList,
        // Task-based truth (Planner/Worker/Judge architecture):
        task_total:         sessionTasks.length,
        task_counts_by_type: taskCountsByType,
        task_outcomes:      taskOutcomesByType,
        task_completions:   taskDone.length,
        task_history:       taskHistory,
        started_at: session.startedAt.toISOString(),
        duration_ms: Date.now() - session.startedAt.getTime(),
        note: 'This summary is generated by the server from the session event log + Task table. Echo verbatim -- do not paraphrase.'
    };
    summary.summary_markdown = buildSummaryMarkdown(summary);

    if (close) {
        await prisma.session.update({
            where: { id: sessionId },
            data: { status: honestStatus, finishedAt: new Date() }
        });
        await prisma.sessionEvent.create({
            data: { sessionId, action: 'report', payload: JSON.stringify(summary) }
        });
    }

    return createSuccessResponse(id, JSON.stringify(summary, null, 2));
}

// ============================================================================
// FIND TOOL HANDLER
// ============================================================================

// Read-only `find` tool handlers live in find.js. The five mcp_server-local
// helpers below are injected; everything else (prisma, response builders) the
// module pulls in itself. See find.js.
const { handleFind } = require('./find').createFindHandlers({
    logInfo,
    summarizeToolArgs,
    enforceSessionWatchdog,
    getFactletStaleDays,
    findLiveFactletsForClient,
});

// ============================================================================
// TRADES TOOL HANDLER (unchanged from v1)
// ============================================================================

const TRADES_URL = 'https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/getTrades';
const TRADES_CACHE_TTL_MS = 10 * 60 * 1000;
let tradesCache = null;
let tradesCacheAt = 0;

async function handleTrades(id, params) {
    const now = Date.now();
    if (tradesCache && (now - tradesCacheAt) < TRADES_CACHE_TTL_MS) {
        return createSuccessResponse(id, safeJson(tradesCache));
    }
    try {
        const res = await fetch(TRADES_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const trades = Array.isArray(raw)
            ? raw.map(t => t.sk).filter(Boolean).sort()
            : [];
        tradesCache = trades;
        tradesCacheAt = now;
        return createSuccessResponse(id, safeJson(trades));
    } catch (error) {
        logError(`getTrades fetch error: ${error.message}`);
        if (tradesCache) {
            logWarn('Serving stale trades cache due to fetch failure');
            return createSuccessResponse(id, safeJson(tradesCache));
        }
        return createErrorResponse(id, -32603, `getTrades failed and no cache available: ${error.message}`);
    }
}

// ============================================================================
// TOOL CALL ROUTER (3 tools)
// ============================================================================

async function handleToolCall(id, params) {
    try {
        logInfo(`tool call name=${params.name || '[missing]'} args=${JSON.stringify(summarizeToolArgs(params.arguments || {}))}`);
        switch (params.name) {
            case 'pipeline': return await handlePipeline(id, params);
            case 'find':     return await handleFind(id, params);
            case 'trades':   return await handleTrades(id, params);
            default:
                return createErrorResponse(id, -32601, `Unknown tool: ${params.name}`);
        }
    } catch (error) {
        logError(`Tool call error (${params.name}): ${error.message}`);
        return createErrorResponse(id, -32603, `Error: ${error.message}`);
    }
}

// ============================================================================
// REQUEST PROCESSING
// ============================================================================

function handlePromptsList(id) {
    logInfo('Handling prompts/list request');
    return { jsonrpc: '2.0', id: id, result: { prompts: [] } };
}

function handleResourcesList(id) {
    logInfo('Handling resources/list request');
    return { jsonrpc: '2.0', id: id, result: { resources: [] } };
}

async function processJsonRpcRequest(request) {
    const { id, method, params } = request;

    switch (method) {
        case 'initialize':
            return handleInitialize(id);
        case 'tools/list':
            return handleToolsList(id);
        case 'tools/call':
            return await handleToolCall(id, params);
        case 'prompts/list':
            return handlePromptsList(id);
        case 'resources/list':
            return handleResourcesList(id);
        case 'notifications/initialized':
            return null;
        default:
            logWarn(`Unknown method: ${method}`);
            return createErrorResponse(id, -32601, 'Method not found');
    }
}

function isJsonRpcLine(line) {
    const trimmed = line.trim();
    return trimmed && looksLikeJson(trimmed);
}

function shouldRespondToParseError(line) {
    return line.includes('"jsonrpc"') || line.includes('"method"');
}

async function handleInputLine(line) {
    if (!isJsonRpcLine(line)) {
        logDebug(`Ignoring non-JSON input: ${line.substring(0, 50)}...`);
        return;
    }

    try {
        const request = JSON.parse(line.trim());
        const response = await processJsonRpcRequest(request);
        if (response) {
            sendJsonRpcResponse(response);
        }
    } catch (error) {
        if (error instanceof SyntaxError) {
            logWarn(`Invalid JSON received: ${line.substring(0, 100)}...`);
            if (shouldRespondToParseError(line)) {
                sendJsonRpcResponse(createErrorResponse('error', -32700, 'Parse error'));
            }
        } else {
            logError(`Request processing error: ${error.message}`);
            sendJsonRpcResponse(createErrorResponse('error', -32603, 'Internal error'));
        }
    }
}

// ============================================================================
// SERVER LIFECYCLE
// ============================================================================

// ============================================================================
// STARTUP MIGRATIONS
// ============================================================================
// Idempotent CREATE TABLE / CREATE INDEX statements run on every MCP boot.
// This handles deployments whose data/myproject.sqlite predates the Source
// table. blank.sqlite and template.sqlite should also be regenerated via
// `npx prisma db push --force-reset` against an absolute file: path on the
// next build cycle, but the safety net below means a stale DB still works.
// ============================================================================

async function ensureTaskTable() {
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS Task (
                id          TEXT PRIMARY KEY,
                type        TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'ready',
                sessionId   TEXT,
                targetType  TEXT,
                targetId    TEXT,
                input       TEXT,
                output      TEXT,
                error       TEXT,
                claimedAt   DATETIME,
                claimedBy   TEXT,
                createdAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                finishedAt  DATETIME
            )
        `);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Task_status_idx ON Task(status)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Task_type_idx ON Task(type)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Task_sessionId_idx ON Task(sessionId)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Task_target_idx ON Task(targetType, targetId)`);
        logInfo('Task table verified (CREATE IF NOT EXISTS).');
    } catch (err) {
        logError(`ensureTaskTable failed: ${err.message}`);
    }
}

async function startMcpServer() {
    console.error(`[MCP] Starting Pre-Crime MCP server (3 tools)...`);
    console.error(`[MCP] Database: ${dbPath}`);

    logInfo('Starting Pre-Crime MCP server (3 tools)...');
    logInfo(`Database: ${dbPath}`);

    // Run startup migrations before accepting any requests.
    await ensureTaskTable().catch(e => logError(`Startup migration error: ${e.message}`));
    await cleanupOpenTasksOnStartup().catch(e => logError(`Startup recycler error: ${e.message}`));
    await pruneStaleFactlets()
        .then(r => { if (r.deleted) logInfo(`Startup recycler deleted ${r.deleted} stale factlet(s) (older than ${r.cutoffIso}).`); })
        .catch(e => logError(`Startup factlet prune error: ${e.message}`));
    // Load the markdown source files into the in-memory index (single source of truth).
    try {
        const sc = sourceStore.load();
        logInfo(`SourceStore loaded ${sc.total} source(s) from markdown across ${Object.keys(sc.byChannel).length} channel(s).`);
    } catch (e) {
        logError(`SourceStore load error: ${e.message}`);
    }

    const PORT = (PRECRIME_CONFIG.workers && PRECRIME_CONFIG.workers.port) || 5179;
    const HOST = '127.0.0.1';

    // HTTP Streamable MCP transport. Each POST carries one JSON-RPC request;
    // the response is the JSON-RPC result. No SSE -- all tool calls are sync.
    // Workers connect via type:streamable_http url:http://127.0.0.1:5179/mcp.
    const server = http.createServer(async (req, res) => {
        // Preflight for any browser-based MCP clients.
        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id'
            });
            return res.end();
        }

        if (req.method !== 'POST') {
            res.writeHead(405);
            return res.end('Method Not Allowed');
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const request = JSON.parse(body);
                const response = await processJsonRpcRequest(request);

                // Echo or issue Mcp-Session-Id per Streamable HTTP spec.
                const sessionId = req.headers['mcp-session-id'] ||
                    (request.method === 'initialize' ? crypto.randomUUID() : null);
                const headers = { 'Content-Type': 'application/json' };
                if (sessionId) headers['Mcp-Session-Id'] = sessionId;

                if (response) {
                    res.writeHead(200, headers);
                    res.end(safeJson(response));
                } else {
                    // Notification (no response body required).
                    res.writeHead(202, headers);
                    res.end();
                }
            } catch (e) {
                logError(`HTTP handler error: ${e.message}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32700, message: `Parse error: ${e.message}` },
                    id: null
                }));
            }
        });
    });

    server.listen(PORT, HOST, () => {
        console.error(`[MCP] Listening on http://${HOST}:${PORT}/mcp`);
        logInfo(`HTTP transport ready on :${PORT}`);
        // Start the conductor after the port is bound so workers can connect immediately.
        // Inject conductorReplan (self-feed planner) + runInProcessTask (execute
        // JUDGE_AFFECTED / SHOW_HOT_LEEDZ in-process — the hot-leedz path).
        startConductor(PRECRIME_CONFIG, { replan: conductorReplan, runInProcess: runInProcessTask });
    });

    process.on('SIGINT', () => {
        logInfo('Shutting down MCP server...');
        prisma.$disconnect();
        server.close();
        process.exit(0);
    });
}

startMcpServer().catch(err => {
    console.error(`[MCP] FATAL startup error: ${err.message}`);
    process.exit(1);
});
