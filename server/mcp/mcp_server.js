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

const readline = require('readline');
const fs = require('fs');
const path = require('path');

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

const { PrismaClient } = require('@prisma/client');

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

const dbPath = process.env.DATABASE_URL.replace(/^file:/, '');
const prisma = new PrismaClient();
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
// JSON-RPC RESPONSE UTILITIES
// ============================================================================

/**
 * Check if text looks like JSON (starts with { or [)
 */
function looksLikeJson(text) {
    const trimmed = text.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Create successful JSON-RPC response
 */
function createSuccessResponse(id, text) {
    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            content: [{
                type: 'text',
                text: text
            }]
        }
    };
}

/**
 * Create JSON-RPC error response
 */
function createErrorResponse(id, code, message) {
    return {
        jsonrpc: '2.0',
        id: id,
        error: {
            code: code,
            message: message
        }
    };
}

/**
 * Send JSON-RPC response to stdout
 */
function sendJsonRpcResponse(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
}

/**
 * JSON.stringify with BigInt safety. Prisma returns BigInt for Int64 fields
 * (e.g. sharedAt). Standard JSON.stringify throws on BigInt.
 */
function safeJson(obj) {
    return JSON.stringify(obj, (key, val) => typeof val === 'bigint' ? Number(val) : val, 2);
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
                        'action="configure": Update Config fields. Pass patch with any Config fields (companyName, companyEmail, businessDescription, activeEntities, defaultTrade, marketplaceEnabled, leadCaptureEnabled, leedzEmail, leedzSession, llmApiKey, llmProvider, llmBaseUrl, llmAnthropicVersion, llmMaxTokens, factletStaleDays, defaultBookingAction). Returns updated config.',
                        '',
                        'action="next": Atomically claim the next work item and return it fully hydrated. Pass entity="client" (default) or entity="booking". For clients: returns the client record with all linked factlets and bookings in one payload. The lastQueueCheck is stamped before return so no other agent claims it. Pass optional criteria to filter (company, name, draftStatus). Returns null if queue is empty. Response is automatically trimmed for context efficiency: dossier tail-clipped to last 2000 chars (or override via dossierLimit), factlets capped to 8 most recent (or override via factletLimit). Pass 0 to disable a cap. _clipped metadata is included if anything was trimmed.',
                        '',
                        'action="save": Atomically persist client work in a single transaction. Two modes: (1) UPDATE existing client - pass id and patch with any of: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. (2) CREATE new client - omit id, patch must include name OR company. Company-only sparse records are allowed when relevant; enrichment fills person/email later. Optional fields: email, phone, website, segment, source, factlets[], bookings[]. Optionally pass session_id (returned by start_session) to log this save against an open workflow session. After persisting, runs score_target on the client AND re-scores every booking under that client, writing leed_ready status back only when the canonical DOCS/SCORING.json gate passes.',
                        '',
                        'action="delete": Permanently remove a record. Pass target ("booking" | "client" | "factlet") and id. For target="client", any attached bookings and factlet links are removed too (cascade). Returns { deleted: true, target, id, cascadedBookings, cascadedFactlets }. Use this when the user says "delete this booking", "remove this client", "drop this factlet", or any imperative removal.',
                        '',
                        'action="rescore": Re-evaluate every non-terminal booking against DOCS/SCORING.json and update status field (leed_ready or new) accordingly. Use after editing DOCS/SCORING.json gates or constants. Pass scope="all" (default), scope="leed_ready" to sanity-check the current queue, or scope=<clientId> to limit to one client. Returns counts: rescored, promoted, demoted, unchanged.',
                        '',
                        'action="resolve_dates": STRUCTURED-ONLY. Server-side date validation + tz-aware epoch math. Required: start { year, month, day, hour, minute, ampm? }, end { year, month, day, hour, minute, ampm? }, timezone (IANA, e.g. "America/Los_Angeles"). Optional: zip (echoed only -- zip-to-tz derivation NOT supported), rawText (informational evidence only -- timezone smuggled inside rawText is REJECTED), sourceProof. The LLM is forbidden from computing epoch ms; it must only extract the structured fields. Returns { ok, st, et, startIso, endIso, timezone, zip, warnings } on success, or { ok:false, errors:[fieldName:reason] } on failure.',
                        '',
                        'action="share_booking": ONLY normal path to marketplace posting. Required: bookingId, mode ("draft" | "post"). FORBIDDEN inputs: st, et (LLM-supplied epochs are rejected by name). Loads the Booking + Client, rescores via judgeAffected, requires status leed_ready, then calls resolve_dates internally with the Booking\'s structured date provenance. In "draft" mode returns the addLeed payload + humanReadable verification block. In "post" mode posts to Leedz and records leedId/sharedAt.',
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
                        'action="import_sources": One-time migration. Reads every seed file (skills/source-discovery/discovered_directories.md, skills/*-factlet-harvester/*_sources.md) and bulk-loads them into the Source table. Idempotent (dedup on URL). Run once at first deploy of Pass 2, or whenever a seed file is hand-edited and you want it picked up. Returns per-channel counts.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['status', 'configure', 'get_config', 'next', 'save', 'delete', 'rescore', 'resolve_dates', 'share_booking', 'start_session', 'report_session', 'audit_session', 'next_source', 'mark_source', 'add_sources', 'import_sources', 'work_status', 'judge_affected', 'plan_tasks', 'claim_task', 'complete_task', 'tasks', 'recycler'],
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
                                description: 'For action=rescore only. "all" (default) re-scores every non-terminal booking. "leed_ready" sanity-checks only the current ready queue. Or pass a clientId to re-score one client only. Use after editing DOCS/SCORING.json.'
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

function computeBookingScore(booking, client) {
    const b = {};
    const bookingPolicy = SCORING.booking || {};
    const weights = bookingPolicy.scoreWeights || {};
    const datePolicy = bookingPolicy.date || {};
    const locationPolicy = bookingPolicy.location || {};
    const contactPolicy = bookingPolicy.contact || {};

    b.trade = booking.trade ? (bookingPolicy.trade?.present ?? weights.trade ?? 20) : (bookingPolicy.trade?.missing ?? 0);

    // Date: 0, 5, 10, or 20
    if (booking.startDate) {
        if (!booking.endDate) {
            b.date = 20;
        } else {
            const start = new Date(booking.startDate);
            const end   = new Date(booking.endDate);
            const spanDays = (end - start) / (1000 * 60 * 60 * 24);
            if (spanDays <= (datePolicy.tightWindowMaxDays ?? 7))       b.date = datePolicy.tightWindow ?? weights.date ?? 20;
            else if (spanDays <= (datePolicy.roughWindowMaxDays ?? 30)) b.date = datePolicy.roughWindow ?? 10;
            else                                                        b.date = datePolicy.ongoing ?? 5;
        }
    } else {
        b.date = datePolicy.missing ?? 0;
    }

    // Location: 0, 5, 10, 15, or 20
    const loc    = (booking.location || '').trim();
    const hasZip = !!(booking.zip && booking.zip.trim());
    const patterns = locationPolicy.patterns || {};
    const tiers = locationPolicy.tiers || {};
    const CAMPUS_VAGUE = new RegExp(patterns.campusVague || '\\b(campus|university|college|complex|fairgrounds|convention center|park)\\b', 'i');
    const HAS_VENUE    = new RegExp(patterns.venue || '\\b(hall|arena|stadium|ballroom|theater|theatre|auditorium|pavilion|lawn|plaza|center|centre|gym|library|room|building|bldg)\\b', 'i');
    const HAS_STREET   = new RegExp(patterns.street || '\\d+\\s+\\w+\\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|way|ln|lane|ct|court|pl|place)\\b', 'i');

    if (loc && hasZip) {
        const hasStreet = HAS_STREET.test(loc);
        const hasVenue  = HAS_VENUE.test(loc);
        const isVague   = CAMPUS_VAGUE.test(loc) && !hasVenue;
        if (hasStreet && hasVenue)       b.location = tiers.streetAndVenue ?? weights.location ?? 20;
        else if (hasStreet && !isVague)  b.location = tiers.cleanStreet ?? 15;
        else if (hasVenue)               b.location = tiers.namedVenue ?? 15;
        else if (hasStreet && isVague)   b.location = tiers.streetInVague ?? 10;
        else if (isVague)                b.location = tiers.vagueOnly ?? 10;
        else                             b.location = tiers.bareCity ?? 5;
    } else if (hasZip || loc) {
        b.location = tiers.partial ?? 5;
    } else {
        b.location = tiers.none ?? 0;
    }

    // Contact: 0, 10, 15, or 20
    const hasName      = !!(client?.name && client.name.trim());
    const email        = (client?.email || '').trim();
    const generic      = email ? isGenericEmail(email) : false;
    const hasNamedEmail = email && !generic;
    if (hasName && hasNamedEmail) b.contact = contactPolicy.nameAndNamedEmail ?? weights.contact ?? 20;
    else if (hasNamedEmail)       b.contact = contactPolicy.namedEmailOnly ?? 15;
    else if (hasName)             b.contact = contactPolicy.nameOnly ?? 10;
    else                          b.contact = contactPolicy.none ?? 0;

    // Description: 0 or 10
    const desc      = (booking.description || '').trim();
    const wordCount = desc ? desc.split(/\s+/).length : 0;
    b.description = wordCount >= (bookingPolicy.description?.minWords ?? 10) ? (bookingPolicy.description?.points ?? weights.description ?? 10) : 0;

    // Time: 0 or 10
    const hasTime     = !!(booking.startTime && booking.startTime.trim());
    const hasDuration = !!(booking.duration && booking.duration > 0);
    b.time = (hasTime || hasDuration) ? (bookingPolicy.time?.points ?? weights.time ?? 10) : 0;

    const total = b.trade + b.date + b.location + b.contact + b.description + b.time;

    // Data-only readiness is advisory. computeBookingTargetScore re-runs the
    // canonical DOCS/SCORING.json leedReady gate with factlets and API fields.
    const dataReady =
        total >= (bookingPolicy.minimumForLeedReady ?? 90) &&
        b.trade >= (bookingPolicy.trade?.present ?? weights.trade ?? 20) &&
        b.date >= (datePolicy.singleDay ?? weights.date ?? 20) &&
        b.location >= (locationPolicy.tiers?.cleanStreet ?? 15) &&
        b.contact >= (contactPolicy.nameAndNamedEmail ?? weights.contact ?? 20) &&
        b.description >= (bookingPolicy.description?.points ?? weights.description ?? 10);
    // Backward-compat alias used by legacy callers. This is NOT authoritative.
    const shareReady = dataReady;

    // Contact quality label
    let contactQuality;
    if (b.contact === 20)      contactQuality = 'named_email_and_name';
    else if (b.contact === 15) contactQuality = 'named_email';
    else if (b.contact === 10) contactQuality = 'name_only';
    else if (generic)          contactQuality = 'generic_email';
    else                       contactQuality = 'none';

    // Recommended next action
    let action = null;
    if (!shareReady) {
        if (b.trade === 0) {
            action = 'CLASSIFY: Assign a trade category before sharing. addLeed requires tn.';
        } else if (b.contact === 0 && generic) {
            action = `ENRICH: ${email} is a generic inbox. Find a named contact via website, LinkedIn, or Facebook.`;
        } else if (b.contact === 0) {
            action = 'ENRICH: No contact found. Search for a named person at this organization.';
        } else if (b.location < 15) {
            action = 'ENRICH: Location is not specific enough to share. A vendor needs a real venue address they can show up to. Find the specific hall, lawn, or room.';
        } else if (b.date < 20) {
            if (!booking.startDate) {
                action = 'ENRICH: No event date. Search or send probe email to confirm timing.';
            } else {
                action = 'ENRICH: Date range is too broad to be a single bookable event. Find specific event dates or sessions.';
            }
        } else if (b.time === 0) {
            action = 'ENRICH: No start time or duration. A vendor needs hours to quote a price.';
        } else if (b.description === 0) {
            action = 'ENRICH: No description. Scrape event page or add context about the opportunity.';
        } else {
            action = 'OUTREACH: Send probe email to confirm missing details.';
        }
    }

    return { total, breakdown: b, shareReady, contactQuality, action };
}

// =============================================================================
// SCORING POLICY LOADED FROM DOCS/SCORING.json AT STARTUP
// =============================================================================
// Single source of truth. Edit DOCS/SCORING.json (constants, gates, weights),
// restart the server. Nothing in this JS file hardcodes a scoring number.
const SCORING_POLICY_PATH = path.resolve(PRECRIME_ROOT, 'DOCS', 'SCORING.json');
let SCORING;
try {
    SCORING = JSON.parse(fs.readFileSync(SCORING_POLICY_PATH, 'utf8'));
} catch (e) {
    console.error(`[MCP] FATAL: DOCS/SCORING.json missing or malformed: ${e.message}`);
    process.exit(1);
}

const SIGNAL_POINTS = SCORING.client.signalPoints;
const FACTLET_THRESHOLD = SCORING.factlet.threshold;
const FACTLET_POINTS_PER = SCORING.factlet.pointsPerFreshFactlet;
const DRAFT_THRESHOLD_CLIENT = SCORING.client.draftThreshold;
GENERIC_EMAIL_PREFIXES = new Set(SCORING.booking.genericEmailPrefixes || []);

/**
 * Generic gate evaluator. Reads a gate definition from SCORING.gates and
 * tests every rule against the provided context.  Returns true only if EVERY
 * rule passes.  This is the only place gate logic exists -- if the result
 * is wrong, edit DOCS/SCORING.json (the data), not this function.
 *
 * @param {object} gate - { all: [{field, op, value}, ...] }
 * @param {object} ctx  - field name -> value
 * @returns {boolean}
 */
function evaluateGate(gate, ctx) {
    if (!gate || !Array.isArray(gate.all)) return false;
    for (const rule of gate.all) {
        const v = ctx[rule.field];
        let pass;
        switch (rule.op) {
            case '===':     pass = v === rule.value; break;
            case '>=':      pass = typeof v === 'number' && v >= rule.value; break;
            case '<=':      pass = typeof v === 'number' && v <= rule.value; break;
            case 'present': pass = v !== null && v !== undefined && v !== ''; break;
            case 'matches': pass = typeof v === 'string' && new RegExp(rule.value).test(v); break;
            case 'directEmail': pass = typeof v === 'string' && v.includes('@') && !isGenericEmail(v); break;
            case 'afterField': {
                const other = ctx[rule.value];
                pass = v !== null && v !== undefined && other !== null && other !== undefined && Number(v) > Number(other);
                break;
            }
            default:        pass = false;
        }
        if (!pass) return false;
    }
    return true;
}

async function getFactletStaleDays() {
    const cfg = await prisma.config.findFirst();
    return (cfg && cfg.factletStaleDays) || 180;
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

function computeFactletStats(factletRows, staleDays) {
    const now = Date.now();
    let score = 0;
    let freshCount = 0;
    for (const f of factletRows) {
        if (!f || !f.createdAt) continue;
        const ageDays = (now - new Date(f.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        const weight = Math.max(0, 1 - ageDays / staleDays);
        if (weight > 0) freshCount++;
        score += weight;
    }
    return { score, count: factletRows.length, freshCount };
}

async function computeClientScore(clientId, intelOverride) {
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return null;

    const staleDays = await getFactletStaleDays();
    // Live Factlet relevance via cheap content/source overlap on the Client's
    // stable identifiers (name / company / website host). No join table.
    const liveFactlets = await findLiveFactletsForClient(client, staleDays);
    const fs = computeFactletStats(liveFactlets, staleDays);

    const hasName         = !!(client.name && client.name.trim());
    const email           = (client.email || '').trim();
    const generic         = email ? isGenericEmail(email) : false;
    const hasDirectEmail  = !!(email && !generic);
    const contactGate     = hasName && hasDirectEmail;

    const intelScore    = (intelOverride !== null && intelOverride !== undefined) ? intelOverride : (client.intelScore || 0);
    const dossierScore  = intelScore + Math.round(fs.score * FACTLET_POINTS_PER);
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

/**
 * Demand signal detection. The core PRECRIME act (see FOUNDATION.md).
 * Returns { present, type, reason }.
 *   - explicit: a demand verb pattern matches the booking text
 *   - inferred: enough fresh relevant factlets stacked (Prom Pattern proxy)
 *   - llm_inferred: LLM judged the text expresses demand for the trade
 *   - none: neither
 * Never stored. Recomputed every score from current evidence.
 *
 * LLM fallback fires only when:
 *   - procedural (regex + factlet count) returned none
 *   - booking has substantive text (>= MIN_LLM_WORDS) AND a trade
 *   - Config.llmApiKey is set
 * Results cached in-memory for 5 minutes keyed by hash of (trade + text)
 * so repeated saves/rescores of the same booking do not re-query.
 */
const MIN_LLM_WORDS = 30;
const LLM_CACHE_TTL_MS = 5 * 60 * 1000;
const _llmCache = new Map();   // key -> { value, expires }

function _llmCacheGet(key) {
    const hit = _llmCache.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) { _llmCache.delete(key); return null; }
    return hit.value;
}
function _llmCacheSet(key, value) {
    _llmCache.set(key, { value, expires: Date.now() + LLM_CACHE_TTL_MS });
}

async function _llmJudgeDemand(trade, text, cfg) {
    if (!cfg || !cfg.llmApiKey) return null;
    const provider = (cfg.llmProvider || 'anthropic').toLowerCase();
    const prompt = `Trade: ${trade}\nBooking text:\n"""${text.slice(0, 2000)}"""\n\nDoes this text describe a specific buyer who needs or will imminently need a ${trade} for a specific event? Answer with one word: YES or NO.`;
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
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 8,
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            if (!res.ok) { console.error(`[demand-llm] http ${res.status}`); return null; }
            const j = await res.json();
            const out = (j.content && j.content[0] && j.content[0].text || '').trim().toUpperCase();
            return out.startsWith('YES');
        }
        // generic openai-compatible
        const res = await fetch((cfg.llmBaseUrl || 'https://api.openai.com') + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': `Bearer ${cfg.llmApiKey}` },
            body: JSON.stringify({
                model: cfg.llmModel || 'gpt-4o-mini',
                max_tokens: 8,
                messages: [{ role: 'user', content: prompt }]
            })
        });
        if (!res.ok) { console.error(`[demand-llm] http ${res.status}`); return null; }
        const j = await res.json();
        const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim().toUpperCase();
        return out.startsWith('YES');
    } catch (e) {
        console.error('[demand-llm] error:', e.message);
        return null;
    }
}

async function detectDemandSignal(booking, freshRelevantFactletCount, cfg) {
    const ds = SCORING.demandSignal || {};
    const text = [booking.title, booking.description, booking.notes]
        .filter(Boolean).join(' ');
    const lower = text.toLowerCase();
    if (lower) {
        for (const pat of ds.explicitPatterns || []) {
            try {
                if (new RegExp(pat, 'i').test(lower)) {
                    return { present: true, type: 'explicit', reason: `matched /${pat}/` };
                }
            } catch (_) { /* skip malformed pattern */ }
        }
    }
    const threshold = ds.factletsForInferred ?? 3;
    if (freshRelevantFactletCount >= threshold) {
        return { present: true, type: 'inferred', reason: `${freshRelevantFactletCount} fresh relevant factlets >= ${threshold}` };
    }
    // LLM fallback
    const trade = booking.trade;
    if (trade && text && text.split(/\s+/).length >= MIN_LLM_WORDS && cfg && cfg.llmApiKey) {
        const key = `${trade}::${text.slice(0, 4000)}`;
        let verdict = _llmCacheGet(key);
        if (verdict === null) {
            verdict = await _llmJudgeDemand(trade, text, cfg);
            if (verdict !== null) _llmCacheSet(key, verdict);
        }
        if (verdict === true) {
            return { present: true, type: 'llm_inferred', reason: `LLM judged text expresses demand for ${trade}` };
        }
    }
    return { present: false, type: 'none', reason: null };
}

async function computeBookingTargetScore(bookingId) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { client: true }
    });
    if (!booking) return null;

    // startDate passed = event passed. Reset to brewing for next cycle.
    // leedId bookings are owned by the marketplace; never reset.
    if (booking.startDate && new Date(booking.startDate).getTime() < Date.now() && !booking.leedId) {
        await prisma.booking.update({
            where: { id: bookingId },
            data: { status: 'brewing', bookingScore: 0 }
        });
        return {
            targetType: 'booking',
            targetId:   bookingId,
            total:      0,
            status:     'brewing',
            shareReady: false,
            action:     'DATE_PASSED_RESET: startDate is past. Reset to brewing.'
        };
    }

    const client = booking.client;
    const staleDays = await getFactletStaleDays();

    const data = computeBookingScore(booking, client);
    // Live Factlet relevance via content/source overlap on the Client's stable
    // identifiers. There is no join table; Factlet rows stand alone.
    const liveFactlets = client ? await findLiveFactletsForClient(client, staleDays) : [];
    const fs = computeFactletStats(liveFactlets, staleDays);
    const factletMultiplier = Math.min(1.0, fs.score / FACTLET_THRESHOLD);

    // Score = booking completeness only. Factlets feed demand-signal detection
    // (see detectDemandSignal), NOT score suppression. The leedReady gate already
    // requires demandSignal === true, so the old multiplier double-counted factlets.
    const total = data.total;

    // Demand signal — the core PRECRIME act. Recomputed every score, never stored.
    const cfg = await prisma.config.findFirst();
    const demand = await detectDemandSignal(booking, fs.freshCount, cfg);

    // Authoritative status decision: evaluate gates against canonical DOCS/SCORING.json.
    // This is the only place that assigns booking status.
    const fullCtx = {
        score:                total,
        dataScore:            data.total,
        trade:                data.breakdown.trade,
        date:                 data.breakdown.date,
        location:             data.breakdown.location,
        contact:              data.breakdown.contact,
        tn:                   booking.trade || '',
        ti:                   booking.title || booking.description || '',
        lc:                   booking.location || '',
        zp:                   booking.zip || '',
        st:                   booking.startDate ? new Date(booking.startDate).getTime() : null,
        et:                   booking.endDate ? new Date(booking.endDate).getTime() : null,
        cn:                   client?.name || '',
        em:                   client?.email || '',
        dt:                   booking.description || booking.notes || '',
        pr:                   0,
        sh:                   '*',
        sourceUrl:            booking.sourceUrl || '',
        hasZip:               !!(booking.zip && String(booking.zip).trim()),
        hasTime:              !!((booking.startTime && booking.startTime.trim()) || (booking.duration && booking.duration > 0)),
        factletMultiplier,
        freshRelevantFactlets: fs.freshCount,
        demandSignal:         demand.present
    };
    const gates = SCORING.booking.gates || {};
    let leedReady    = evaluateGate(gates.leedReady, fullCtx);
    const outreachReady = evaluateGate(gates.outreachReady, fullCtx);

    // Override: an already-posted leed (leedId set) is proven leedworthy.
    // Bypass demand re-evaluation so it stays leed_ready after a re-tag.
    if (!leedReady && booking.leedId) {
        leedReady = true;
    }

    // Highest passing gate wins. brewing is the fallback.
    let status;
    if (leedReady)         status = 'leed_ready';
    else if (outreachReady) status = 'outreach_ready';
    else                    status = 'brewing';

    // hot is a derived flag: leed_ready AND startDate within hotDaysOut window.
    const hotDaysOut = (SCORING.demandSignal && SCORING.demandSignal.hotDaysOut) ?? 14;
    let hot = false;
    if (leedReady && booking.startDate) {
        const daysOut = (new Date(booking.startDate).getTime() - Date.now()) / 86400000;
        hot = daysOut >= 0 && daysOut <= hotDaysOut;
    }

    // Back-compat alias used by legacy callers.
    const shareReady = leedReady;

    const draftReady = evaluateGate(SCORING.booking.gates.draftReady, {
        shareReadyDataOnly: data.shareReady,
        contactGate: data.breakdown.contact === 20,
        dossierScore: total,
        factletMultiplier
    });

    await prisma.booking.update({
        where: { id: bookingId },
        data: {
            bookingScore:   total,
            factletScore:   Math.round(fs.score),
            contactQuality: data.contactQuality
        }
    });

    let action = data.action;
    if (status === 'outreach_ready' && !demand.present) {
        action = `ENRICH_FOR_DEMAND: Booking is outreach_ready. To promote to leed_ready, find a demand signal: either explicit request in the source text, or ${SCORING.demandSignal.factletsForInferred} fresh relevant factlets stacking the Prom Pattern (decision-maker, event, precedent purchase, vocal customer, thematic fit).`;
    } else if (status === 'leed_ready' && demand.type === 'inferred' && factletMultiplier < 1.0) {
        action = `ENRICH_FACTLETS: leed_ready on inferred demand. Strengthen with more fresh relevant factlets (have ${fs.freshCount}, threshold ${FACTLET_THRESHOLD}).`;
    }

    return {
        targetType: 'booking',
        targetId:   bookingId,
        total,
        status,
        hot,
        shareReady,
        draftReady,
        demandSignal: demand,
        components: {
            dataScore:         data.total,
            dataBreakdown:     data.breakdown,
            leedGate:          fullCtx,
            factletScore:      Math.round(fs.score * 100) / 100,
            factletCount:      fs.count,
            factletFreshCount: fs.freshCount,
            factletMultiplier: Math.round(factletMultiplier * 100) / 100,
            factletStaleDays:  staleDays,
            contactQuality:    data.contactQuality
        },
        action
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
        case 'next':           return await pipelineNext(id, args.entity || 'client', args.criteria || {}, args.dossierLimit, args.factletLimit);
        case 'save':           return await pipelineSave(id, args.id, args.patch || {}, args.session_id || null, args.judge !== false);
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
        case 'start_session':  return await pipelineStartSession(id, args.workflow, args.target_count, args.metadata);
        case 'report_session': return await pipelineReportSession(id, args.session_id, /*close=*/true);
        case 'audit_session':  return await pipelineReportSession(id, args.session_id, /*close=*/false);
        case 'next_source':    return await pipelineNextSource(id, args.channel, args.maxAgeDays, args.session_id);
        case 'mark_source':    return await pipelineMarkSource(id, args.url, args.scrapedAt, args.clientsFound, args.failedReason, args.session_id);
        case 'add_sources':    return await pipelineAddSources(id, args.entries);
        case 'import_sources': return await pipelineImportSources(id);
        case 'work_status':    return await pipelineWorkStatus(id);
        default:
            return createErrorResponse(id, -32602, `Unknown pipeline action: "${action}". Must be: status, configure, get_config, next, save, delete, rescore, resolve_dates, share_booking, start_session, report_session, audit_session, next_source, mark_source, add_sources, import_sources, work_status, judge_affected, plan_tasks, claim_task, complete_task, tasks, recycler.`);
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
const MONTHS = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sept: 9, sep: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12
};
const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

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

function extractYear(value) {
    const m = String(value || '').match(/\b(20\d{2})\b/);
    return m ? m[1] : null;
}

function isStrictDateValue(value) {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value === 'number') return value > 1700000000000 && value < 2200000000000;
    const s = String(value || '').trim();
    if (!s) return false;
    if (/^\d{13}$/.test(s)) return true;
    return /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z)?)?$/.test(s);
}

function strictDateToDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number' || /^\d{13}$/.test(String(value || '').trim())) {
        return new Date(Number(value));
    }
    return new Date(String(value).trim());
}

function cleanDateText(text) {
    return String(text || '')
        .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function daysInMonthUtc(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validYmd(year, month, day) {
    return year >= 2024 && year <= 2035 &&
        month >= 1 && month <= 12 &&
        day >= 1 && day <= daysInMonthUtc(year, month);
}

function parseTimeToken(hourRaw, minRaw, meridiemRaw, fallbackMeridiem) {
    let hour = Number(hourRaw);
    const minute = minRaw === undefined || minRaw === '' ? 0 : Number(minRaw);
    const meridiem = (meridiemRaw || fallbackMeridiem || '').toLowerCase();
    if (hour < 1 || hour > 23 || minute < 0 || minute > 59) return null;
    if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
        if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
    }
    return { hour, minute };
}

function extractTimeRange(text) {
    const s = cleanDateText(text);
    const range = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|to|until|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (range) {
        const endMeridiem = range[6].replace(/\./g, '').toLowerCase();
        const startMeridiem = range[3] ? range[3].replace(/\./g, '').toLowerCase() : endMeridiem;
        const start = parseTimeToken(range[1], range[2], startMeridiem);
        const end = parseTimeToken(range[4], range[5], endMeridiem);
        if (start && end) return { start, end, evidence: range[0] };
    }

    const single = s.match(/\b(?:at|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (single) {
        const start = parseTimeToken(single[1], single[2], single[3].replace(/\./g, '').toLowerCase());
        if (start) return { start, end: null, evidence: single[0] };
    }

    return null;
}

function extractDateParts(text) {
    const s = cleanDateText(text);
    const yearMatch = s.match(/\b(20\d{2})\b/);
    if (!yearMatch) return { error: 'missing_year' };
    const year = Number(yearMatch[1]);

    let m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s*,?\\s*${year}\\b`, 'i'));
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        const startDay = Number(m[2]);
        const endDay = Number(m[3]);
        if (validYmd(year, month, startDay) && validYmd(year, month, endDay) && endDay >= startDay) {
            return { year, startMonth: month, startDay, endMonth: month, endDay, evidence: m[0] };
        }
    }

    m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*,?\\s*${year}\\s*-\\s*(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*,?\\s*${year}\\b`, 'i'));
    if (m) {
        const startMonth = MONTHS[m[1].toLowerCase()];
        const startDay = Number(m[2]);
        const endMonth = MONTHS[m[3].toLowerCase()];
        const endDay = Number(m[4]);
        if (validYmd(year, startMonth, startDay) && validYmd(year, endMonth, endDay)) {
            return { year, startMonth, startDay, endMonth, endDay, evidence: m[0] };
        }
    }

    m = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})\\s*,?\\s*${year}\\b`, 'i'));
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        const day = Number(m[2]);
        if (validYmd(year, month, day)) {
            return { year, startMonth: month, startDay: day, endMonth: month, endDay: day, evidence: m[0] };
        }
    }

    m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
    if (m) {
        const month = Number(m[1]);
        const day = Number(m[2]);
        const numericYear = Number(m[3]);
        if (validYmd(numericYear, month, day)) {
            return { year: numericYear, startMonth: month, startDay: day, endMonth: month, endDay: day, evidence: m[0] };
        }
    }

    return { error: 'no_supported_date_pattern' };
}

function leedzWallClockEpoch(year, month, day, hour, minute) {
    return Date.UTC(year, month - 1, day, hour, minute, 0);
}

function monthNamesForProof(month) {
    const full = Object.keys(MONTHS).find(k => MONTHS[k] === month && k.length > 3) || '';
    const short = Object.keys(MONTHS).find(k => MONTHS[k] === month && k.length === 3) || '';
    return [full, short].filter(Boolean);
}

async function verifyResolvedDateSource(sourceUrl, resolved) {
    if (!sourceUrl) return { ok: true, skipped: true };
    const fetched = await fetchUrlTextForProof(sourceUrl);
    if (!fetched.ok) return { ok: false, reason: `fetch_failed:${fetched.error}` };
    if (fetched.status < 200 || fetched.status >= 300) return { ok: false, reason: `http_status:${fetched.status}` };
    if (looksLikeHomepageRedirect(sourceUrl, fetched.finalUrl)) return { ok: false, reason: `redirect_to_homepage:${fetched.finalUrl}` };

    const text = (fetched.text || '').toLowerCase();
    const year = String(resolved.year);
    if (!text.includes(year)) return { ok: false, reason: `source_missing_year:${year}` };

    const startMonths = monthNamesForProof(resolved.startMonth).map(v => v.toLowerCase());
    const hasStartMonth = startMonths.some(v => text.includes(v));
    const hasStartDay = new RegExp(`\\b${resolved.startDay}\\b`).test(text);
    const startNumeric = new RegExp(`\\b0?${resolved.startMonth}[\\/\\-\\.]0?${resolved.startDay}(?:[\\/\\-.]${resolved.year})?\\b`).test(text);
    if ((!hasStartMonth || !hasStartDay) && !startNumeric) {
        return { ok: false, reason: `source_missing_start_date:${resolved.startMonth}/${resolved.startDay}/${resolved.year}` };
    }

    if (resolved.endDay !== resolved.startDay || resolved.endMonth !== resolved.startMonth) {
        const endMonths = monthNamesForProof(resolved.endMonth).map(v => v.toLowerCase());
        const hasEndMonth = endMonths.some(v => text.includes(v)) || resolved.endMonth === resolved.startMonth;
        const hasEndDay = new RegExp(`\\b${resolved.endDay}\\b`).test(text);
        const endNumeric = new RegExp(`\\b0?${resolved.endMonth}[\\/\\-\\.]0?${resolved.endDay}(?:[\\/\\-.]${resolved.year})?\\b`).test(text);
        if ((!hasEndMonth || !hasEndDay) && !endNumeric) {
            return { ok: false, reason: `source_missing_end_date:${resolved.endMonth}/${resolved.endDay}/${resolved.year}` };
        }
    }

    return { ok: true, status: fetched.status, finalUrl: fetched.finalUrl };
}

// Legacy text-only date resolver. Internal-only. Still used by
// normalizeBookingDatesForSave to keep older legacy save callers working.
// The MCP `resolve_dates` action no longer exposes this path -- see
// resolveEventDatesStructured below for the structured, tz-aware replacement.
async function resolveEventDatesLegacy(args = {}) {
    const text = cleanDateText(args.text || args.dateText || args.rawDate || '');
    if (!text) return { ok: false, errors: ['missing_text'] };

    const date = extractDateParts(text);
    if (date.error) return { ok: false, errors: [date.error] };

    const times = extractTimeRange(text);
    const durationHours = args.defaultDurationHours === undefined ? null : Number(args.defaultDurationHours);
    if (!times || !times.start) return { ok: false, errors: ['missing_start_time'] };

    let endTime = times.end;
    let explicitDuration = false;
    if (!endTime && Number.isFinite(durationHours) && durationHours > 0 && durationHours <= 24) {
        explicitDuration = true;
    } else if (!endTime) {
        return { ok: false, errors: ['missing_end_time_or_defaultDurationHours'] };
    }

    const st = leedzWallClockEpoch(date.year, date.startMonth, date.startDay, times.start.hour, times.start.minute);
    let et = endTime
        ? leedzWallClockEpoch(date.year, date.endMonth, date.endDay, endTime.hour, endTime.minute)
        : st + Math.round(durationHours * 60 * 60 * 1000);
    if (et <= st && endTime && date.startDay === date.endDay && date.startMonth === date.endMonth) {
        et = leedzWallClockEpoch(date.year, date.endMonth, date.endDay + 1, endTime.hour, endTime.minute);
    }
    if (et <= st) return { ok: false, errors: ['end_not_after_start'] };
    if (st < Date.now()) return { ok: false, errors: ['start_in_past'] };

    const resolved = {
        ok: true,
        st,
        et,
        startIso: new Date(st).toISOString(),
        endIso: new Date(et).toISOString(),
        display: `${new Date(st).toISOString()} to ${new Date(et).toISOString()}`,
        year: date.year,
        startMonth: date.startMonth,
        startDay: date.startDay,
        endMonth: date.endMonth,
        endDay: date.endDay,
        evidence: {
            date: date.evidence,
            time: times.evidence,
            explicitDuration
        }
    };

    const proof = await verifyResolvedDateSource(args.sourceUrl, resolved);
    if (!proof.ok) return { ok: false, errors: [proof.reason], evidence: resolved.evidence };
    resolved.sourceProof = proof;
    return resolved;
}

// ============================================================================
// STRUCTURED DATE RESOLUTION (Phase 5)
// ============================================================================
// LLMs hand-computing st/et caused production bugs. The contract for the
// MCP `resolve_dates` action is now structured-only: the caller passes
// year/month/day/hour/minute/ampm for both start and end, plus an explicit
// IANA timezone (or, in the future, a zip-to-tz map). The server computes
// the offset for that wall-clock instant in that zone via Intl.DateTimeFormat
// and returns canonical epoch ms.
// No text parsing. No timezone smuggled in rawText. No epoch math by the LLM.
// ============================================================================

// IANA tz validation via Intl. Returns true iff Node accepts the zone.
function isValidIanaTimezone(tz) {
    if (typeof tz !== 'string' || !tz.trim()) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (_) {
        return false;
    }
}

// Deterministic US ZIP -> IANA timezone resolver.
// Used by share_booking to derive the marketplace event timezone from
// Booking.zip at leed creation time. There is no user-configurable timezone.
//
// Coverage is by 3-digit ZIP prefix range. Boundaries are approximate at zone
// edges (parts of FL panhandle, TN/KY/IN/MI splits, west TX, OR/ID border)
// because zone lines do not follow ZIP3 ranges cleanly. The dominant zone for
// each range wins. Returns an IANA name on a confident hit, null otherwise --
// share_booking then refuses to post with error:"unresolved_location_timezone".
function zipToTimezone(zip) {
    if (zip == null) return null;
    const z = String(zip).trim().slice(0, 5);
    if (!/^\d{5}$/.test(z)) return null;
    const n = parseInt(z.slice(0, 3), 10);

    // Pacific
    if (n >= 900 && n <= 961) return 'America/Los_Angeles';     // CA
    if (n >= 970 && n <= 979) return 'America/Los_Angeles';     // OR
    if (n >= 980 && n <= 994) return 'America/Los_Angeles';     // WA
    if (n >= 889 && n <= 898) return 'America/Los_Angeles';     // NV (Pacific)
    // Alaska + Hawaii
    if (n >= 967 && n <= 968) return 'Pacific/Honolulu';        // HI (no DST)
    if (n >= 995 && n <= 999) return 'America/Anchorage';       // AK

    // Mountain
    if (n >= 800 && n <= 831) return 'America/Denver';          // CO / WY
    if (n >= 832 && n <= 838) return 'America/Denver';          // ID (most)
    if (n >= 840 && n <= 847) return 'America/Denver';          // UT
    if (n >= 850 && n <= 865) return 'America/Phoenix';         // AZ (no DST)
    if (n >= 870 && n <= 884) return 'America/Denver';          // NM
    if (n >= 590 && n <= 599) return 'America/Denver';          // MT

    // Central
    if (n >= 500 && n <= 528) return 'America/Chicago';         // IA
    if (n >= 530 && n <= 549) return 'America/Chicago';         // WI
    if (n >= 550 && n <= 567) return 'America/Chicago';         // MN
    if (n >= 570 && n <= 577) return 'America/Chicago';         // SD
    if (n >= 580 && n <= 588) return 'America/Chicago';         // ND
    if (n >= 600 && n <= 629) return 'America/Chicago';         // IL
    if (n >= 630 && n <= 658) return 'America/Chicago';         // MO
    if (n >= 660 && n <= 679) return 'America/Chicago';         // KS
    if (n >= 680 && n <= 693) return 'America/Chicago';         // NE
    if (n >= 700 && n <= 714) return 'America/Chicago';         // LA
    if (n >= 716 && n <= 729) return 'America/Chicago';         // AR
    if (n >= 730 && n <= 749) return 'America/Chicago';         // OK
    if (n >= 750 && n <= 799) return 'America/Chicago';         // TX (most; western edge actually Mountain)
    if (n >= 350 && n <= 369) return 'America/Chicago';         // AL
    if (n >= 386 && n <= 397) return 'America/Chicago';         // MS
    if (n >= 370 && n <= 385) return 'America/Chicago';         // TN (most are Central)

    // Eastern
    if (n >= 1   && n <= 199) return 'America/New_York';        // Northeast (MA/NH/RI/CT/VT/ME/NY/NJ/PA/PR)
    if (n >= 200 && n <= 268) return 'America/New_York';        // DC/MD/VA/WV
    if (n >= 270 && n <= 289) return 'America/New_York';        // NC
    if (n >= 290 && n <= 299) return 'America/New_York';        // SC
    if (n >= 300 && n <= 319) return 'America/New_York';        // GA
    if (n >= 320 && n <= 349) return 'America/New_York';        // FL (most; western Panhandle is Central — minority)
    if (n >= 400 && n <= 427) return 'America/New_York';        // KY (most)
    if (n >= 430 && n <= 459) return 'America/New_York';        // OH
    if (n >= 460 && n <= 479) return 'America/Indiana/Indianapolis'; // IN (most observe Eastern)
    if (n >= 480 && n <= 499) return 'America/Detroit';         // MI

    return null;
}

// Compute the timezone offset (in minutes east of UTC) that applies to the
// given UTC instant in the given IANA zone. Used iteratively to convert a
// wall-clock-in-zone to a UTC epoch (handles DST). Algorithm:
//   1. Treat (year,month,day,hour,minute) as if it were UTC -> guess epoch.
//   2. Format that epoch in the target zone and read the offset.
//   3. Subtract offset to get the true UTC epoch for the wall clock.
function tzOffsetMinutes(utcEpochMs, timeZone) {
    // Use the en-US 'longOffset' formatter to read the offset string (e.g.
    // "GMT-07:00") that applies in the zone at that instant.
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'longOffset',
        hour: 'numeric'
    });
    const parts = fmt.formatToParts(new Date(utcEpochMs));
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (!tzPart) return 0;
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzPart.value);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    const h = parseInt(m[2], 10);
    const mn = parseInt(m[3] || '0', 10);
    return sign * (h * 60 + mn);
}

// Convert a wall-clock-in-zone to a UTC epoch ms. DST-safe via two passes:
// the first pass guesses with the UTC offset of the naive timestamp; the
// second pass corrects using the offset that actually applies at the guessed
// instant. One re-correction is enough for any IANA zone.
function wallClockInZoneToEpoch(year, month, day, hour, minute, timeZone) {
    const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
    const off1 = tzOffsetMinutes(naive, timeZone);
    const guess = naive - off1 * 60 * 1000;
    const off2 = tzOffsetMinutes(guess, timeZone);
    return naive - off2 * 60 * 1000;
}

// Render an ISO-8601 string with the supplied zone's offset, e.g.
// "2026-06-10T21:30:00-07:00". The wall-clock fields are echoed verbatim.
function formatIsoWithZone(year, month, day, hour, minute, timeZone, epochMs) {
    const off = tzOffsetMinutes(epochMs, timeZone);
    const sign = off >= 0 ? '+' : '-';
    const absOff = Math.abs(off);
    const oh = Math.floor(absOff / 60);
    const om = absOff % 60;
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:00${sign}${pad(oh, 2)}:${pad(om, 2)}`;
}

// Validate one structured date piece. Returns { ok, hour24, errors[] } where
// hour24 is the canonical 0-23 hour computed from hour + optional ampm.
function validateDatePart(label, part) {
    const errors = [];
    if (!part || typeof part !== 'object') {
        errors.push(`${label}:missing`);
        return { ok: false, errors };
    }
    const { year, month, day, hour, minute, ampm } = part;
    if (!Number.isInteger(year) || year < 1970 || year > 9999) errors.push(`${label}.year:invalid`);
    if (!Number.isInteger(month) || month < 1 || month > 12) errors.push(`${label}.month:invalid`);
    if (!Number.isInteger(day) || day < 1 || day > 31) errors.push(`${label}.day:invalid`);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) errors.push(`${label}.minute:invalid`);

    let hour24 = null;
    if (ampm === undefined || ampm === null || ampm === '') {
        // 24-hour mode: hour must be 0..23
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push(`${label}.hour:invalid`);
        else hour24 = hour;
    } else {
        const ap = String(ampm).trim().toUpperCase();
        if (ap !== 'AM' && ap !== 'PM') {
            errors.push(`${label}.ampm:invalid`);
        } else if (!Number.isInteger(hour) || hour < 1 || hour > 12) {
            errors.push(`${label}.hour:invalid_for_ampm`);
        } else {
            hour24 = (hour % 12) + (ap === 'PM' ? 12 : 0);
        }
    }

    // Calendar validity: day-in-month using Date round-trip.
    if (errors.length === 0) {
        const d = new Date(Date.UTC(year, month - 1, day));
        if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
            errors.push(`${label}.day:not_in_month`);
        }
    }

    return { ok: errors.length === 0, errors, hour24 };
}

// New structured resolver. Used by MCP action `resolve_dates` and by
// share_booking when assembling the marketplace payload.
async function resolveEventDates(args = {}) {
    const warnings = [];
    const errors = [];

    // 1. Reject anything that smuggles timezone in rawText only.
    let timezone = typeof args.timezone === 'string' ? args.timezone.trim() : '';
    const zip = typeof args.zip === 'string' ? args.zip.trim() : '';
    if (!timezone) {
        // Zip-to-tz lookup is not supported in this phase. The spec explicitly
        // forbids inventing a zip-to-tz DB.
        if (zip) {
            errors.push('timezone:missing_zip_only_derivation_unsupported');
        } else {
            errors.push('timezone:missing');
        }
    } else if (!isValidIanaTimezone(timezone)) {
        errors.push('timezone:not_iana');
    }

    // 2. Validate structured start/end. rawText is informational only.
    const startV = validateDatePart('start', args.start);
    const endV   = validateDatePart('end',   args.end);
    errors.push(...startV.errors, ...endV.errors);

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    // 3. Compute epoch ms using IANA-zone wall-clock conversion.
    const startEpoch = wallClockInZoneToEpoch(
        args.start.year, args.start.month, args.start.day,
        startV.hour24, args.start.minute, timezone
    );
    const endEpoch = wallClockInZoneToEpoch(
        args.end.year, args.end.month, args.end.day,
        endV.hour24, args.end.minute, timezone
    );

    // 4. Overnight rule: end<=start with a different day field is accepted
    // as overnight; same-day end<=start is rejected.
    if (endEpoch <= startEpoch) {
        const sameDay = args.start.year === args.end.year &&
                        args.start.month === args.end.month &&
                        args.start.day === args.end.day;
        if (sameDay) {
            return { ok: false, errors: ['end:not_after_start_same_day'] };
        }
        warnings.push('overnight_end_before_start');
        // The structured `day` already encodes the next-day intent; if epochs
        // still invert, the caller's day is wrong.
        return { ok: false, errors: ['end:not_after_start_different_day'] };
    }

    return {
        ok: true,
        st: startEpoch,
        et: endEpoch,
        startIso: formatIsoWithZone(args.start.year, args.start.month, args.start.day, startV.hour24, args.start.minute, timezone, startEpoch),
        endIso:   formatIsoWithZone(args.end.year,   args.end.month,   args.end.day,   endV.hour24,   args.end.minute,   timezone, endEpoch),
        timezone,
        zip: zip || null,
        warnings,
        sourceProof: args.sourceProof || null
    };
}

function proofTermsFromText(value) {
    const stop = new Set([
        'about', 'after', 'again', 'event', 'events', 'festival', 'tickets',
        'market', 'vendor', 'vendors', 'with', 'from', 'this', 'that', 'their',
        'there', 'will', 'have', 'city', 'county', 'center', 'centre'
    ]);
    const words = String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .match(/[a-z0-9][a-z0-9'-]{3,}/g) || [];
    return [...new Set(words.filter(w => !stop.has(w)))].slice(0, 12);
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

async function validatePatchEvidenceUrls(sessionId, patch) {
    const failures = [];

    if (Array.isArray(patch.factlets)) {
        for (const f of patch.factlets) {
            const url = f.sourceUrl || f.url || (isHttpUrl(f.source) ? f.source : null);
            if (!url) continue;
            const expectedYear = f.expectedYear || extractYear(f.content);
            const proofTerms = proofTermsFromText(f.content);
            const result = await verifyEvidenceUrl(url, { expectedYear, proofTerms });
            if (!result.ok) failures.push({ kind: 'factlet', url, reason: result.reason });
        }
    }

    if (Array.isArray(patch.bookings)) {
        for (const b of patch.bookings) {
            const url = b.sourceUrl;
            if (!url) continue;
            const expectedYear = extractYear(b.startDate) || extractYear(b.endDate) ||
                extractYear(b.title) || extractYear(b.description);
            const proofTerms = proofTermsFromText([b.title, b.location, b.description].filter(Boolean).join(' '));
            const result = await verifyEvidenceUrl(url, { expectedYear, proofTerms });
            if (!result.ok) failures.push({ kind: 'booking', url, reason: result.reason });
            if (b.startDate && isStrictDateValue(b.startDate)) {
                const start = strictDateToDate(b.startDate);
                const end = b.endDate && isStrictDateValue(b.endDate) ? strictDateToDate(b.endDate) : start;
                const dateProof = await verifyResolvedDateSource(url, {
                    year: start.getUTCFullYear(),
                    startMonth: start.getUTCMonth() + 1,
                    startDay: start.getUTCDate(),
                    endMonth: end.getUTCMonth() + 1,
                    endDay: end.getUTCDate()
                });
                if (!dateProof.ok) failures.push({ kind: 'booking_date', url, reason: dateProof.reason });
            }
        }
    }

    if (failures.length > 0) {
        await logSessionEvent(sessionId, 'save_rejected_bad_url_evidence', { failures });
    }
    return failures;
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
    const ageDays = (typeof maxAgeDays === 'number' && maxAgeDays > 0) ? maxAgeDays : 30;
    const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    const claimTimeout = new Date(Date.now() - 10 * 60 * 1000); // 10-min stale claim

    if (channel && !VALID_CHANNELS.has(channel)) {
        return createErrorResponse(id, -32602,
            `next_source: invalid channel "${channel}". Must be one of: ${[...VALID_CHANNELS].join(', ')}.`);
    }

    try {
        // Find a candidate: unscraped + unclaimed, OR unscraped + stale claim, OR scrapedAt older than cutoff.
        // When channel is not specified, default to excluding browser-only channels
        // (fb / ig / x) -- those need real browsers and burn the loop via Tavily.
        // Agents that explicitly want browser channels pass channel:"fb"/"ig"/"x".
        const channelFilter = channel
            ? { channel }
            : { channel: { notIn: BROWSER_ONLY_CHANNELS } };

        const where = {
            AND: [
                channelFilter,
                {
                    OR: [
                        { scrapedAt: null, claimedAt: null },
                        { scrapedAt: null, claimedAt: { lt: claimTimeout } },
                        { scrapedAt: { lt: cutoff } }
                    ]
                }
            ]
        };

        const candidate = await prisma.source.findFirst({
            where,
            orderBy: [{ scrapedAt: 'asc' }, { discoveredAt: 'asc' }]
        });

        if (!candidate) {
            return createSuccessResponse(id, JSON.stringify({
                status: 'QUEUE_EMPTY',
                channel: channel || 'any',
                hint: 'Call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task, or seed via pipeline.add_sources, then retry.'
            }));
        }

        // Claim it. The unique URL constraint means two agents racing will both see the same row,
        // but only one update will win the natural ordering -- worst case the loser scrapes a
        // freshly-claimed source and add_sources merges as duplicate.
        await prisma.source.update({
            where: { id: candidate.id },
            data: {
                claimedAt: new Date(),
                claimedBy: sessionId || null
            }
        });

        return createSuccessResponse(id, JSON.stringify({
            status: 'CLAIMED',
            id: candidate.id,
            url: candidate.url,
            channel: candidate.channel,
            subtype: candidate.subtype,
            label: candidate.label,
            category: candidate.category,
            discoveredFrom: candidate.discoveredFrom,
            previouslyScrapedAt: candidate.scrapedAt
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
        const result = await prisma.source.updateMany({
            where: { url },
            data: {
                scrapedAt: markedAt,
                clientsFound: typeof clientsFound === 'number' ? clientsFound : 0,
                failedReason: failedReason || null,
                claimedAt: null,
                claimedBy: null
            }
        });
        if (result.count === 0) {
            return createErrorResponse(id, -32602, `mark_source: no source with url "${url}".`);
        }

        // Log to session so report_session can distinguish "agent did nothing"
        // from "agent scraped but URLs yielded no clients".
        await logSessionEvent(sessionId, 'source_marked', {
            url,
            clientsFound: typeof clientsFound === 'number' ? clientsFound : 0,
            failed: !!failedReason
        });

        return createSuccessResponse(id, JSON.stringify({
            marked: true,
            url,
            scrapedAt: markedAt.toISOString(),
            clientsFound: typeof clientsFound === 'number' ? clientsFound : 0,
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
        try {
            await prisma.source.create({
                data: {
                    url,
                    channel: e.channel,
                    subtype: e.subtype || inferSubtype(e.url, e.channel),
                    label: e.label || null,
                    category: e.category || null,
                    discoveredFrom: e.discoveredFrom || null
                }
            });
            results.added++;
        } catch (err) {
            if (err.code === 'P2002') {
                results.duplicates++;
            } else {
                results.invalid.push({ entry: e, reason: err.message });
            }
        }
    }

    return createSuccessResponse(id, JSON.stringify(results));
}

async function pipelineImportSources(id) {
    // Read all known seed files under skills/ and bulk-add to Source table.
    // Idempotent: dedup on URL via add_sources logic.
    const seedFiles = [
        { rel: 'skills/source-discovery/discovered_directories.md', channel: 'directory', format: 'directory' },
        { rel: 'skills/rss-factlet-harvester/rss_sources.md',       channel: 'rss',       format: 'rss' },
        { rel: 'skills/fb-factlet-harvester/fb_sources.md',         channel: 'fb',        format: 'plain' },
        { rel: 'skills/ig-factlet-harvester/ig_sources.md',         channel: 'ig',        format: 'handle' },
        { rel: 'skills/reddit-factlet-harvester/reddit_sources.md', channel: 'reddit',    format: 'handle' },
        { rel: 'skills/x-factlet-harvester/x_sources.md',           channel: 'x',         format: 'handle' }
    ];

    const summary = { byChannel: {}, total_added: 0, total_duplicates: 0, total_invalid: 0 };

    for (const sf of seedFiles) {
        const fullPath = path.resolve(PRECRIME_ROOT, sf.rel);
        if (!fs.existsSync(fullPath)) {
            summary.byChannel[sf.channel] = { missing: true };
            continue;
        }

        const lines = fs.readFileSync(fullPath, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        const entries = [];
        for (const line of lines) {
            if (sf.format === 'directory') {
                const parts = line.split('|').map(p => p.trim());
                if (!parts[0]) continue;
                entries.push({
                    url: parts[0],
                    channel: 'directory',
                    subtype: parts[1] || 'directory',
                    category: parts[1] || null
                });
            } else if (sf.format === 'rss') {
                const parts = line.split('|').map(p => p.trim());
                if (!parts[0]) continue;
                entries.push({
                    url: parts[0],
                    channel: 'rss',
                    subtype: 'feed',
                    label: parts[1] || null,
                    category: parts[2] || null
                });
            } else if (sf.format === 'handle') {
                entries.push({
                    url: line,
                    channel: sf.channel,
                    subtype: inferSubtype(line, sf.channel)
                });
            } else { // plain
                entries.push({ url: line, channel: sf.channel });
            }
        }

        // Reuse add_sources logic by inlining it -- but we want per-file accounting.
        let added = 0, duplicates = 0, invalid = 0;
        for (const e of entries) {
            const url = normalizeSourceUrl(e.url, e.channel);
            if (!url) { invalid++; continue; }
            try {
                await prisma.source.create({
                    data: {
                        url,
                        channel: e.channel,
                        subtype: e.subtype || null,
                        label: e.label || null,
                        category: e.category || null
                    }
                });
                added++;
            } catch (err) {
                if (err.code === 'P2002') duplicates++;
                else invalid++;
            }
        }
        summary.byChannel[sf.channel] = { added, duplicates, invalid, total_lines: lines.length };
        summary.total_added += added;
        summary.total_duplicates += duplicates;
        summary.total_invalid += invalid;
    }

    return createSuccessResponse(id, JSON.stringify(summary, null, 2));
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
 *   "all"        -> every booking not in shared/taken/expired (default)
 *   "leed_ready" -> only bookings currently flagged leed_ready (sanity-check the queue)
 *   "<clientId>" -> only that client's bookings
 *
 * Returns a summary: count of bookings touched, before/after status counts.
 */
async function pipelineRescore(id, scope) {
    let where = { status: { notIn: ['shared', 'taken', 'expired'] } };
    if (scope === 'leed_ready') {
        where = { status: 'leed_ready' };
    } else if (scope && scope !== 'all') {
        // Treat as clientId
        where = { clientId: scope, status: { notIn: ['shared', 'taken', 'expired'] } };
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
    // Config
    const cfg = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });

    // Stats (same queries as v1 handleGetStats)
    const [totalClients, totalFactlets, brewing, ready, sent,
           contactGatePass, contactGateFail,
           dossierHigh, dossierMid, dossierLow, dossierNone,
           totalBookings, bookingsBrewing, bookingsOutreachReady, leedReady, taken, shared, bookingsNewLegacy,
           scoreHigh, scoreMid, scoreLow, scoreNone] = await Promise.all([
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
        prisma.booking.count({ where: { status: 'brewing' } }),
        prisma.booking.count({ where: { status: 'outreach_ready' } }),
        prisma.booking.count({ where: { status: 'leed_ready' } }),
        prisma.booking.count({ where: { status: 'taken' } }),
        prisma.booking.count({ where: { status: 'shared' } }),
        prisma.booking.count({ where: { status: 'new' } }),
        prisma.booking.count({ where: { bookingScore: { gte: 70 } } }),
        prisma.booking.count({ where: { bookingScore: { gte: 50, lt: 70 } } }),
        prisma.booking.count({ where: { AND: [{ bookingScore: { not: null } }, { bookingScore: { lt: 50 } }] } }),
        prisma.booking.count({ where: { bookingScore: null } })
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

    return createSuccessResponse(id, JSON.stringify({
        config: cfg,
        stats: {
            totalClients, totalFactlets,
            drafts: { brewing, ready, sent },
            contactGate: { pass: contactGatePass, fail: contactGateFail },
            dossierScores: { high: dossierHigh, mid: dossierMid, low: dossierLow, unscored: dossierNone },
            bookings: {
                total: totalBookings,
                brewing: bookingsBrewing,
                outreach_ready: bookingsOutreachReady,
                leed_ready: leedReady,
                taken,
                shared,
                legacy_new: bookingsNewLegacy,
                scores: { share_ready: scoreHigh, needs_work: scoreMid, incomplete: scoreLow, unscored: scoreNone }
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

    // Source counts by channel
    const sources = {};
    for (const ch of CHANNELS) {
        const [ready, claimed, stale] = await Promise.all([
            prisma.source.count({ where: { channel: ch, scrapedAt: null, claimedAt: null } }),
            prisma.source.count({ where: { channel: ch, claimedAt: { not: null }, scrapedAt: null } }),
            prisma.source.count({ where: { channel: ch, scrapedAt: { lt: staleThreshold } } })
        ]);
        sources[ch] = { ready, claimed, stale };
    }

    // Client counts
    const [thin, needsEnrichment, readyDrafts] = await Promise.all([
        prisma.client.count({ where: { dossierScore: null } }),
        prisma.client.count({ where: { draftStatus: 'brewing' } }),
        prisma.client.count({ where: { draftStatus: 'ready' } })
    ]);

    // Booking counts
    const [leedReady, bookingsNeedsEnrichment] = await Promise.all([
        prisma.booking.count({ where: { status: 'leed_ready' } }),
        prisma.booking.count({ where: { status: 'needs_enrichment' } })
    ]);

    // Recommendation
    const totalReady = Object.values(sources).reduce((s, c) => s + c.ready, 0);
    let recommendation;
    if (leedReady > 0 || readyDrafts > 0) {
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
        bookings: { leed_ready: leedReady, needs_enrichment: bookingsNeedsEnrichment },
        recommendation
    }, null, 2));
}

async function pipelineConfigure(id, patch) {
    if (!patch || Object.keys(patch).length === 0) {
        return createErrorResponse(id, -32602, 'configure requires a non-empty patch.');
    }

    const existing = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });

    let cfg;
    if (existing) {
        cfg = await prisma.config.update({ where: { id: existing.id }, data: patch });
    } else {
        cfg = await prisma.config.create({ data: patch });
    }
    return createSuccessResponse(id, JSON.stringify(cfg, null, 2));
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
    if (!key) {
        return createErrorResponse(id, -32602,
            `get_config requires a "key" string. Allowed keys: ${GET_CONFIG_ALLOWED_KEYS.join(', ')}.`);
    }
    if (!GET_CONFIG_ALLOWED_KEYS.includes(key)) {
        return createErrorResponse(id, -32602,
            `get_config: unknown or forbidden key "${key}". get_config never returns runtime API secrets. ` +
            `Allowed keys: ${GET_CONFIG_ALLOWED_KEYS.join(', ')}.`);
    }
    const cfg = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!cfg) {
        return createSuccessResponse(id, JSON.stringify({
            key, value: null, present: false, source: 'no_config_row'
        }, null, 2));
    }
    const value = cfg[key];
    return createSuccessResponse(id, JSON.stringify({
        key,
        value: (value === undefined ? null : value),
        present: !(value === null || value === undefined || value === ''),
        source: 'sqlite_config'
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
                failures.push({ kind: 'booking_date', title: b.title || null, reason: 'missing_sourceUrl_for_date_resolution' });
                continue;
            }
            const resolved = await resolveEventDatesLegacy({
                text: [rawDateText, b.startTime, b.endTime].filter(Boolean).join(' '),
                sourceUrl,
                defaultDurationHours: b.defaultDurationHours ?? b.duration
            });
            if (!resolved.ok) {
                failures.push({ kind: 'booking_date', title: b.title || null, sourceUrl, reason: resolved.errors.join(',') });
                continue;
            }
            b.startDate = resolved.startIso;
            b.endDate = resolved.endIso;
            if (!b.startTime) b.startTime = resolved.startIso.slice(11, 16);
            if (!b.endTime) b.endTime = resolved.endIso.slice(11, 16);
            if (b.duration === undefined) b.duration = Math.round((resolved.et - resolved.st) / 3600000 * 100) / 100;
            continue;
        }

        if (b.startDate && !isStrictDateValue(b.startDate)) {
            failures.push({ kind: 'booking_date', title: b.title || null, reason: 'startDate_not_strict_iso_or_epoch' });
        }
        if (b.endDate && !isStrictDateValue(b.endDate)) {
            failures.push({ kind: 'booking_date', title: b.title || null, reason: 'endDate_not_strict_iso_or_epoch' });
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
            if (end <= start) failures.push({ kind: 'booking_date', title: b.title || null, reason: 'end_not_after_start' });
        }
    }

    if (failures.length > 0) {
        await logSessionEvent(sessionId, 'save_rejected_bad_booking_date', { failures });
    }
    return failures;
}

async function pipelineSave(id, clientId, patch, sessionId, judge) {
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
        if (sourceUrl) {
            const expectedYear = patch.expectedYear || extractYear(patch.content);
            const proofTerms = proofTermsFromText(patch.content);
            const verified = await verifyEvidenceUrl(sourceUrl, { expectedYear, proofTerms });
            if (!verified.ok) {
                await logSessionEvent(sessionId, 'save_failed', {
                    error: 'bad_url_evidence',
                    failures: [{ kind: 'factlet', url: sourceUrl, reason: verified.reason }]
                });
                return createErrorResponse(id, -32602,
                    'URL evidence rejected before save. Bad URLs are not stored. ' +
                    JSON.stringify({ failures: [{ kind: 'factlet', url: sourceUrl, reason: verified.reason }] }, null, 2)
                );
            }
        }

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

    const urlFailures = await validatePatchEvidenceUrls(sessionId, patch);
    if (urlFailures.length > 0) {
        await logSessionEvent(sessionId, 'save_failed', {
            error: 'bad_url_evidence',
            failures: urlFailures
        });
        return createErrorResponse(id, -32602,
            'URL evidence rejected before save. Bad URLs are not stored. ' +
            JSON.stringify({ failures: urlFailures }, null, 2)
        );
    }

    const dateFailures = await normalizeBookingDatesForSave(sessionId, patch);
    if (dateFailures.length > 0) {
        await logSessionEvent(sessionId, 'save_failed', {
            error: 'bad_booking_date',
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
                        source: patch.source || null
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
                    'source', 'sourceUrl', 'trade', 'zip', 'sharedTo', 'squarePaymentUrl', 'leedId',
                    'status'
                ];
                for (const f of bookingFields) {
                    if (b[f] !== undefined) bookingData[f] = b[f];
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
                    // Update existing booking
                    const { clientId: _cid, ...updateData } = bookingData;
                    await tx.booking.update({ where: { id: b.id }, data: updateData });
                } else {
                    // Create new booking
                    await tx.booking.create({ data: bookingData });
                }
            }
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
        if (b.status === 'shared' || b.status === 'taken' || b.status === 'expired') continue;
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
// share_booking is the ONLY normal way to push a Booking to the Leedz
// marketplace. The LLM is not allowed to supply st/et. The MCP loads the
// Booking, rescores via Judge, demands status==leed_ready, then resolves
// dates from the Booking's structured provenance via the structured
// resolveEventDates() above. mode:"draft" returns the payload; mode:"post"
// posts to Leedz and persists leedId/sharedAt/status.
// ============================================================================

const LEEDZ_REMOTE_URL = 'https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/mcp';

// Extract structured date pieces from a Booking row. Returns:
//   { ok:true, start, end, timezone, zip } when all required provenance is
//   present, or { ok:false, missing:[fieldName,...] } otherwise.
// The Booking schema (see schema.prisma) currently carries startDate/endDate
// (ISO datetimes), startTime/endTime, and zip. Timezone is not yet a column,
// so it must come from a Config-level default or eventually a Booking column.
// Until a dedicated column exists, callers may pass `timezone` directly on
// the share_booking action OR set Config.leedzDefaultTimezone (future). For
// this phase, we accept Booking.startDate + Booking.endDate as ISO strings
// (already epoch-clean) and treat their wall-clock fields as the structured
// pieces. A timezone must still be supplied explicitly via the action arg
// `timezone` -- we do NOT guess from a stored ISO offset.
function bookingToStructuredDates(booking, fallbackTimezone) {
    const missing = [];
    if (!booking.startDate) missing.push('booking.startDate');
    if (!booking.endDate)   missing.push('booking.endDate');
    if (!fallbackTimezone)  missing.push('timezone');
    if (missing.length > 0) return { ok: false, missing };

    const s = new Date(booking.startDate);
    const e = new Date(booking.endDate);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
        return { ok: false, missing: ['booking.startDate_or_endDate:not_a_date'] };
    }

    // Booking rows store the wall-clock-as-UTC convention written by the
    // legacy save path (leedzWallClockEpoch = Date.UTC). Read those UTC
    // components back as if they were wall-clock in the supplied timezone.
    const part = (d) => ({
        year:   d.getUTCFullYear(),
        month:  d.getUTCMonth() + 1,
        day:    d.getUTCDate(),
        hour:   d.getUTCHours(),
        minute: d.getUTCMinutes()
    });
    return {
        ok: true,
        start: part(s),
        end:   part(e),
        timezone: fallbackTimezone,
        zip: booking.zip || null
    };
}

async function pipelineShareBooking(id, args) {
    // 1. Forbid LLM-supplied epochs by name.
    if (args.st !== undefined) {
        return createErrorResponse(id, -32602,
            'share_booking: forbidden input "st". The LLM is not allowed to supply marketplace epoch ms. ' +
            'Provide structured start/end fields and let MCP compute st/et.');
    }
    if (args.et !== undefined) {
        return createErrorResponse(id, -32602,
            'share_booking: forbidden input "et". The LLM is not allowed to supply marketplace epoch ms. ' +
            'Provide structured start/end fields and let MCP compute st/et.');
    }

    const bookingId = args.bookingId;
    const mode      = args.mode;
    if (!bookingId) return createErrorResponse(id, -32602, 'share_booking: bookingId required.');
    if (mode !== 'draft' && mode !== 'post') {
        return createErrorResponse(id, -32602, 'share_booking: mode must be "draft" or "post".');
    }

    // 2. Load booking + client.
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
        return createErrorResponse(id, -32602, `share_booking: bookingId not found: ${bookingId}`);
    }
    const client = await prisma.client.findUnique({ where: { id: booking.clientId } });
    if (!client) {
        return createErrorResponse(id, -32603, `share_booking: client not found for booking ${bookingId}`);
    }

    // 3. Rescore via the canonical Judge before publishing.
    const judged = await judgeAffected({
        clientIds:   [client.id],
        bookingIds:  [booking.id],
        reason:      'share_booking',
        writeStatus: true
    });
    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });

    if (fresh.status !== 'leed_ready') {
        return createSuccessResponse(id, JSON.stringify({
            mode,
            posted: false,
            error: 'booking_not_leed_ready',
            currentStatus: fresh.status,
            judgedStatus: fresh.status,
            judgedChanged: judged.changed
        }, null, 2));
    }

    // 4. Derive timezone from Booking.zip. No user-supplied timezone path.
    //    Booking.zip is mandatory for marketplace sharing; if missing or unmappable
    //    we refuse to post with a clear non-posting response.
    const cfg = await prisma.config.findFirst();
    if (!fresh.zip || !String(fresh.zip).trim()) {
        return createSuccessResponse(id, JSON.stringify({
            mode,
            posted: false,
            error: 'missing_location_timezone',
            missing: ['booking.zip'],
            hint: 'Booking must carry a 5-digit US zip before sharing. Enrich the Booking with location data and retry.'
        }, null, 2));
    }
    const tz = zipToTimezone(fresh.zip);
    if (!tz) {
        return createSuccessResponse(id, JSON.stringify({
            mode,
            posted: false,
            error: 'unresolved_location_timezone',
            zip: String(fresh.zip),
            hint: 'zipToTimezone() did not recognize this zip. Check the zip is a valid 5-digit US code. Non-US zips are not yet supported.'
        }, null, 2));
    }
    const provenance = bookingToStructuredDates(fresh, tz);
    if (!provenance.ok) {
        return createSuccessResponse(id, JSON.stringify({
            mode,
            posted: false,
            error: 'missing_date_provenance',
            missing: provenance.missing,
            hint: 'Booking must carry startDate and endDate before sharing. Timezone is derived from Booking.zip.'
        }, null, 2));
    }

    const resolved = await resolveEventDates({
        start:    provenance.start,
        end:      provenance.end,
        timezone: provenance.timezone,
        zip:      provenance.zip
    });
    if (!resolved.ok) {
        return createSuccessResponse(id, JSON.stringify({
            mode,
            posted: false,
            error: 'resolve_dates_failed',
            resolveErrors: resolved.errors
        }, null, 2));
    }

    // 5. Build marketplace payload server-side. Mirrors the leed-drafter
    // contract: tn, ti, lc, dt, rq, st, et, zp, cn, em, ph, pr, sh.
    const payload = {
        tn: fresh.trade || '',
        ti: fresh.title || '',
        lc: fresh.location || '',
        dt: fresh.description || fresh.notes || '',
        rq: fresh.notes || '',
        st: resolved.st,
        et: resolved.et,
        zp: fresh.zip || '',
        cn: client.name || '',
        em: client.email || '',
        ph: client.phone || '',
        pr: 0,
        sh: '*'
    };

    const humanReadable = {
        startDisplay: resolved.startIso,
        endDisplay:   resolved.endIso,
        timezone:     resolved.timezone
    };

    if (mode === 'draft') {
        return createSuccessResponse(id, JSON.stringify({
            mode: 'draft',
            bookingId:    fresh.id,
            clientId:     client.id,
            judgedStatus: fresh.status,
            payload,
            humanReadable
        }, null, 2));
    }

    // mode === 'post': actually call the Leedz marketplace endpoint.
    if (!cfg?.leedzSession) {
        return createSuccessResponse(id, JSON.stringify({
            mode: 'post',
            posted: false,
            error: 'leedz_not_configured',
            hint: 'Config.leedzSession is empty. Run configure to set it before sharing.'
        }, null, 2));
    }

    let leedzId = null;
    let postError = null;
    try {
        const envelope = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'createLeed',
                arguments: { ...payload, cr: 'theleedz.com@gmail.com', email: 'false', session: cfg.leedzSession }
            }
        };
        const res = await fetch(LEEDZ_REMOTE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(envelope)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const txt = body?.result?.content?.[0]?.text;
        try { leedzId = JSON.parse(txt)?.leedId || JSON.parse(txt)?.id || null; } catch (_) { leedzId = null; }
    } catch (e) {
        postError = String(e.message || e);
    }

    if (postError) {
        return createSuccessResponse(id, JSON.stringify({
            mode: 'post',
            posted: false,
            error: postError,
            payload,
            humanReadable
        }, null, 2));
    }

    await prisma.booking.update({
        where: { id: fresh.id },
        data: {
            shared:   true,
            sharedTo: 'leedz_api',
            sharedAt: BigInt(Date.now()),
            leedId:   leedzId,
            status:   'shared'
        }
    });

    return createSuccessResponse(id, JSON.stringify({
        mode: 'post',
        posted: true,
        leedzId,
        bookingId: fresh.id,
        clientId:  client.id,
        payload,
        humanReadable
    }, null, 2));
}

// ============================================================================
// TASK PLANNER -- procedural state machine for the new architecture
// ============================================================================

// Per-Task-type planner limits. Hardcoded defaults preserved as fallback;
// precrime_config.json taskLimits overrides on a per-key basis (Subproject 10).
const _TASK_TYPE_LIMITS_DEFAULT = {
    DISCOVER_SOURCES: 1,
    SCRAPE_SOURCE:    5,
    APPLY_FACTLET:    5,
    ENRICH_CLIENT:    10,
    JUDGE_AFFECTED:   5,
    SHOW_HOT_LEEDZ:   1,
    SHARE_BOOKING:    3
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
    ENRICH_CLIENT:    50,
    JUDGE_AFFECTED:   50,
    SHOW_HOT_LEEDZ:   1,
    SHARE_BOOKING:    10
};
const _CFG_SESSION_BUDGETS = (PRECRIME_CONFIG && PRECRIME_CONFIG.tasks && PRECRIME_CONFIG.tasks.sessionBudgets) || {};
const TASK_SESSION_BUDGETS = Object.assign({}, _TASK_SESSION_BUDGETS_DEFAULT, _CFG_SESSION_BUDGETS);

const TASK_TYPES = new Set(Object.keys(_TASK_TYPE_LIMITS_DEFAULT));
const _CFG_CLAIM_TIMEOUT = PRECRIME_CONFIG && PRECRIME_CONFIG.recycler && PRECRIME_CONFIG.recycler.claimTimeoutMinutes;
const CLAIM_TIMEOUT_MINUTES = Number.isFinite(_CFG_CLAIM_TIMEOUT) ? _CFG_CLAIM_TIMEOUT : 10;

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

async function pipelinePlanTasks(id, args) {
    const mode = args.mode || 'workflow';     // 'workflow' | 'hot_only' | 'headless'

    // Planner owns Session lifecycle. Reuse or open as needed.
    let session;
    try {
        session = await ensurePlannerSession(mode, args.session_id || null);
    } catch (e) {
        return createErrorResponse(id, e.code || -32603, e.message || String(e));
    }
    const sessionId = session.id;

    // Recycle stale claims before planning so limits reflect true ready state.
    const reclaimed = await reclaimStaleTasks();

    const counts = {};
    const created = [];

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
            where: { status: { in: ['leed_ready', 'outreach_ready'] } }
        });
        let explanation;
        if (hotExists === 0) {
            explanation = 'Hot-only mode: no leed_ready / outreach_ready bookings -- nothing to present.';
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
            mode, session_id: sessionId, reclaimed, counts, created,
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

    // Headless: schedule SHARE_BOOKING for unshared leed_ready first.
    if (mode === 'headless') {
        const ck = await createBudget('SHARE_BOOKING');
        if (ck.eff > 0) {
            const candidates = await prisma.booking.findMany({
                where: { status: 'leed_ready', shared: false },
                select: { id: true },
                take: ck.eff
            });
            for (const b of candidates) {
                await createTask('SHARE_BOOKING', { targetType: 'Booking', targetId: b.id });
            }
        }
    }

    // Workflow planning (also runs for headless after share scheduling):
    // 1. DISCOVER_SOURCES (Session-bounded -- session budget defaults to 1)
    if (mode === 'workflow' || mode === 'headless') {
        const ckDisc = await createBudget('DISCOVER_SOURCES');
        if (ckDisc.eff > 0) {
            await createTask('DISCOVER_SOURCES', { targetType: 'none' });
        }

        // 2. SCRAPE_SOURCE for claimable Sources
        const ckScrape = await createBudget('SCRAPE_SOURCE');
        if (ckScrape.eff > 0) {
            // Avoid double-planning the same Source: skip ones already targeted by ready/claimed Tasks.
            const planned = await prisma.task.findMany({
                where: { type: 'SCRAPE_SOURCE', status: { in: ['ready', 'claimed'] }, targetType: 'Source' },
                select: { targetId: true }
            });
            const skipIds = new Set(planned.map(p => p.targetId).filter(Boolean));
            const sources = await prisma.source.findMany({
                where: { scrapedAt: null, claimedAt: null },
                orderBy: { discoveredAt: 'asc' },
                take: ckScrape.eff + skipIds.size
            });
            let made = 0;
            for (const s of sources) {
                if (made >= ckScrape.eff) break;
                if (skipIds.has(s.id)) continue;
                const row = await createTask('SCRAPE_SOURCE', {
                    targetType: 'Source',
                    targetId:   s.id,
                    input: { url: s.url, channel: s.channel }
                });
                if (!row) break;   // budget hit mid-loop
                made++;
            }
        }

        // 3. APPLY_FACTLET -- newest Factlets that lack an open Task.
        const ckApply = await createBudget('APPLY_FACTLET');
        if (ckApply.eff > 0) {
            const plannedF = await prisma.task.findMany({
                where: { type: 'APPLY_FACTLET', status: { in: ['ready', 'claimed'] }, targetType: 'Factlet' },
                select: { targetId: true }
            });
            const skipF = new Set(plannedF.map(p => p.targetId).filter(Boolean));
            const factlets = await prisma.factlet.findMany({
                orderBy: { createdAt: 'desc' },
                take: ckApply.eff + skipF.size,
                select: { id: true }
            });
            let made = 0;
            for (const f of factlets) {
                if (made >= ckApply.eff) break;
                if (skipF.has(f.id)) continue;
                const row = await createTask('APPLY_FACTLET', { targetType: 'Factlet', targetId: f.id });
                if (!row) break;
                made++;
            }
        }

        // 4. ENRICH_CLIENT for stale/thin Clients
        const ckEnrich = await createBudget('ENRICH_CLIENT');
        if (ckEnrich.eff > 0) {
            const plannedE = await prisma.task.findMany({
                where: { type: 'ENRICH_CLIENT', status: { in: ['ready', 'claimed'] }, targetType: 'Client' },
                select: { targetId: true }
            });
            const skipE = new Set(plannedE.map(p => p.targetId).filter(Boolean));
            // Stale = lastEnriched null OR oldest. Thin = no email.
            const clients = await prisma.client.findMany({
                orderBy: [{ lastEnriched: 'asc' }],
                take: ckEnrich.eff + skipE.size,
                select: { id: true }
            });
            let made = 0;
            for (const c of clients) {
                if (made >= ckEnrich.eff) break;
                if (skipE.has(c.id)) continue;
                const row = await createTask('ENRICH_CLIENT', { targetType: 'Client', targetId: c.id });
                if (!row) break;
                made++;
            }
        }

        // 5. JUDGE_AFFECTED for done Tasks whose output reports affected ids
        //    but have not yet been judged. We mark them judged via output.judgedAt.
        const ckJudge = await createBudget('JUDGE_AFFECTED');
        if (ckJudge.eff > 0) {
            const doneTasks = await prisma.task.findMany({
                where: {
                    status: 'done',
                    type:   { in: ['SCRAPE_SOURCE', 'ENRICH_CLIENT', 'APPLY_FACTLET'] }
                },
                orderBy: { finishedAt: 'desc' },
                take: 50
            });
            let made = 0;
            for (const t of doneTasks) {
                if (made >= ckJudge.eff) break;
                const out = t.output ? safeJsonParse(t.output) : null;
                if (!out || out.judgedAt) continue;
                const { clientIds: cIds, bookingIds: bIds } = extractAffectedIds(out);
                if (cIds.length === 0 && bIds.length === 0) continue;
                const row = await createTask('JUDGE_AFFECTED', {
                    targetType: 'none',
                    input: { sourceTaskId: t.id, clientIds: cIds, bookingIds: bIds }
                });
                if (!row) break;
                made++;
            }
        }

        // 6. SHOW_HOT_LEEDZ if judged hot items exist
        const hotExists = await prisma.booking.count({
            where: { status: { in: ['leed_ready', 'outreach_ready'] } }
        });
        if (hotExists > 0) {
            const ckHot = await createBudget('SHOW_HOT_LEEDZ');
            if (ckHot.eff > 0) {
                await createTask('SHOW_HOT_LEEDZ', { targetType: 'none' });
            }
        }
    }

    const sum = computeBudgetSummary(sessionCreatedSoFar);
    const closed = await maybeCloseSession();

    const explanationParts = [
        `Planned ${created.length} task(s) in session ${sessionId}`,
        `${reclaimed} stale claim(s) recycled`
    ];
    if (sum.budgetExhausted.length > 0) {
        explanationParts.push(`budget exhausted for: ${sum.budgetExhausted.join(', ')}`);
    }
    if (closed.sessionClosed) {
        explanationParts.push(`session closed (${closed.closeReason})`);
    }

    return createSuccessResponse(id, JSON.stringify({
        mode,
        session_id:     sessionId,
        reclaimed,
        counts,
        created,
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
        if (created.length > 0) return { sessionClosed: false, closeReason: null };
        const openInSession = await prisma.task.count({
            where: { sessionId, status: { in: ['ready', 'claimed'] } }
        });
        if (openInSession > 0) return { sessionClosed: false, closeReason: null };
        await prisma.session.update({
            where: { id: sessionId },
            data:  { status: 'complete', finishedAt: new Date() }
        });
        await prisma.sessionEvent.create({
            data: {
                sessionId,
                action:  'session_closed',
                payload: JSON.stringify({
                    by: 'planner',
                    budgetUsage: computeBudgetSummary().budgetUsage
                })
            }
        }).catch(() => {});
        const reason = (TASK_TYPES.size > 0 &&
                        computeBudgetSummary().budgetExhausted.length > 0)
            ? 'budgets_exhausted_no_open_tasks'
            : 'no_new_tasks_no_open_tasks';
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
        const where = { status: 'ready' };
        if (types && types.length > 0) where.type = { in: types };
        const candidate = await prisma.task.findFirst({
            where,
            orderBy: [{ createdAt: 'asc' }]
        });
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
                { finishedAt: { lt: taskCutoff } },
                { AND: [{ finishedAt: null }, { updatedAt: { lt: taskCutoff } }] }
            ]
        },
        select: { id: true }
    });
    const finishedIds = finishedCandidates.map(t => t.id);
    if (!dryRun && finishedIds.length > 0) {
        await prisma.task.deleteMany({ where: { id: { in: finishedIds } } });
    }

    // 3. Stale Factlets -> delete. Factlet stands alone now (no join table),
    // so we just delete the rows directly. Dossier text is untouched.
    const staleFactlets = await prisma.factlet.findMany({
        where: { createdAt: { lt: factletCutoff } },
        select: { id: true }
    });
    const staleFactletIds = staleFactlets.map(f => f.id);
    if (!dryRun && staleFactletIds.length > 0) {
        try {
            await prisma.factlet.deleteMany({ where: { id: { in: staleFactletIds } } });
        } catch (e) {
            warnings.push(`factlet delete failed: ${e.message}`);
        }
    }

    return createSuccessResponse(id, JSON.stringify({
        dryRun,
        now: now.toISOString(),
        thresholds: { factletStaleDays, taskRetentionDays, claimTimeoutMinutes },
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
            lines.push(`- ${name} — clientId: \`${cid}\` — score: ${score}`);
        }
    }

    if (Array.isArray(s.failures) && s.failures.length > 0) {
        lines.push('');
        lines.push('**Failures:**');
        for (const f of s.failures) {
            const name = f.name || f.id || '(unknown)';
            const err  = f.error || '(no error message)';
            lines.push(`- ${name} — ${err}`);
        }
    }

    if (s.actually_saved < (s.requested ?? Infinity)) {
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

        if (attempts === 0 && ageSec >= TERMINATE_AT_SEC) {
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
    const taskHistory = sessionTasks.map(t => ({
        id:         t.id,
        type:       t.type,
        status:     t.status,
        targetType: t.targetType,
        targetId:   t.targetId,
        finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
        error:      t.error || null
    }));

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
    if (attempts.length === 0 && marks.length === 0) {
        honestStatus = 'failed_no_data';
        reason = 'no_save_attempts and no_sources_marked -- agent ran the workflow but did nothing';
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

async function handleFind(id, params) {
    const args = params.arguments || {};
    const action = args.action;

    logInfo(`find action=${action || '[missing]'} args=${JSON.stringify(summarizeToolArgs(args))}`);

    // 3-min save-or-terminate watchdog -- find is read-only, always check.
    const wd = await enforceSessionWatchdog(id);
    if (wd.terminated) return wd.errorResponse;

    switch (action) {
        case 'clients':  return await findClients(id, args);
        case 'bookings': return await findBookings(id, args);
        case 'factlets': return await findFactlets(id, args);
        case 'drafts':   return await findDrafts(id, args);
        default:
            return createErrorResponse(id, -32602, `Unknown find action: "${action}". Must be: clients, bookings, factlets, drafts.`);
    }
}

async function findClients(id, args) {
    const filters = args.filters || {};
    const limit = args.limit || 10;
    const useSummary = args.summary !== false;
    let where = {};

    if (filters.search) {
        where.OR = [
            { name: { contains: filters.search } },
            { email: { contains: filters.search } },
            { company: { contains: filters.search } }
        ];
    } else {
        if (filters.name)    where.name    = { contains: filters.name };
        if (filters.email)   where.email   = filters.email;
        // filters.company uses fuzzy contains for general search.
        // Pass filters.exactCompany for dedup lookups that need exact (case-insensitive) match.
        if (filters.exactCompany) where.company = filters.exactCompany; // exact, SQLite LIKE is case-insensitive
        else if (filters.company) where.company = { contains: filters.company };
        if (filters.segment) where.segment = { contains: filters.segment };
    }

    if (filters.draftStatus) where.draftStatus = filters.draftStatus;

    if (filters.warmthScore !== undefined) {
        where.warmthScore = parseInt(filters.warmthScore, 10);
    } else if (filters.minWarmthScore !== undefined || filters.maxWarmthScore !== undefined) {
        where.warmthScore = {};
        if (filters.minWarmthScore !== undefined) where.warmthScore.gte = parseInt(filters.minWarmthScore, 10);
        if (filters.maxWarmthScore !== undefined) where.warmthScore.lte = parseInt(filters.maxWarmthScore, 10);
    }

    const queryOpts = { where, take: limit, orderBy: { dossierScore: 'desc' } };

    if (useSummary) {
        queryOpts.select = {
            id: true, name: true, company: true, segment: true,
            email: true, phone: true, website: true,
            dossierScore: true, contactGate: true, intelScore: true,
            warmthScore: true, draftStatus: true, lastEnriched: true, source: true
        };
    }

    const clients = await prisma.client.findMany(queryOpts);
    return createSuccessResponse(id, JSON.stringify(clients, null, 2));
}

async function findBookings(id, args) {
    const filters = args.filters || {};
    const limit = args.limit || 20;
    const where = {};

    if (filters.status) where.status = filters.status;
    if (filters.trade)  where.trade  = filters.trade;

    if (filters.search) {
        where.OR = [
            { title:       { contains: filters.search } },
            { description: { contains: filters.search } },
            { notes:       { contains: filters.search } },
            { location:    { contains: filters.search } }
        ];
    }

    const bookings = await prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
            client: {
                select: { id: true, name: true, company: true, email: true, phone: true, segment: true }
            }
        }
    });
    return createSuccessResponse(id, safeJson(bookings));
}

async function findFactlets(id, args) {
    const filters = args.filters || {};

    // If clientId is provided, return live Factlets relevant to that client via
    // cheap content/source overlap on name / company / website host. No join
    // table -- there is no longer a per-link "applied" pointer to read.
    if (filters.clientId) {
        const client = await prisma.client.findUnique({ where: { id: filters.clientId } });
        if (!client) {
            return createErrorResponse(id, -32602, `findFactlets: no client with id "${filters.clientId}".`);
        }
        const staleDays = await getFactletStaleDays();
        const factlets = await findLiveFactletsForClient(client, staleDays);
        return createSuccessResponse(id, JSON.stringify(factlets, null, 2));
    }

    // Otherwise, global factlet query (queue checking)
    if (!filters.sinceTimestamp) {
        return createErrorResponse(id, -32602, 'factlets action requires filters.sinceTimestamp or filters.clientId.');
    }

    const factlets = await prisma.factlet.findMany({
        where: { createdAt: { gt: new Date(filters.sinceTimestamp) } },
        orderBy: { createdAt: 'asc' }
    });
    return createSuccessResponse(id, JSON.stringify(factlets, null, 2));
}

async function findDrafts(id, args) {
    const limit = args.limit || 10;
    const useSummary = args.summary !== false;
    const filters = args.filters || {};

    const where = { draftStatus: 'ready' };
    if (filters.minScore !== undefined) {
        where.dossierScore = { gte: parseInt(filters.minScore, 10) };
    }

    const queryOpts = {
        where,
        orderBy: { dossierScore: 'desc' },
        take: limit
    };

    if (useSummary) {
        queryOpts.select = {
            id: true, name: true, company: true, segment: true,
            email: true, dossierScore: true, contactGate: true,
            warmthScore: true, draftStatus: true, lastEnriched: true
        };
    }

    const clients = await prisma.client.findMany(queryOpts);
    return createSuccessResponse(id, JSON.stringify(clients, null, 2));
}

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

async function ensureSourceTable() {
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS Source (
                id             TEXT PRIMARY KEY,
                url            TEXT NOT NULL,
                channel        TEXT NOT NULL,
                subtype        TEXT,
                label          TEXT,
                category       TEXT,
                scrapedAt      DATETIME,
                claimedAt      DATETIME,
                claimedBy      TEXT,
                clientsFound   INTEGER NOT NULL DEFAULT 0,
                failedReason   TEXT,
                discoveredAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                discoveredFrom TEXT
            )
        `);
        await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS Source_url_key ON Source(url)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Source_channel_idx ON Source(channel)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Source_scrapedAt_idx ON Source(scrapedAt)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS Source_claimedAt_idx ON Source(claimedAt)`);
        logInfo('Source table verified (CREATE IF NOT EXISTS).');
    } catch (err) {
        logError(`ensureSourceTable failed: ${err.message}`);
        // Don't crash the server; old DBs without Source still work for non-source actions
    }
}

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

function startMcpServer() {
    console.error(`[MCP] Starting Pre-Crime MCP server (3 tools)...`);
    console.error(`[MCP] Database: ${dbPath}`);

    logInfo('Starting Pre-Crime MCP server (3 tools)...');
    logInfo(`Database: ${dbPath}`);

    // Run startup migrations before accepting any requests
    ensureSourceTable().catch(e => logError(`Startup migration error: ${e.message}`));
    ensureTaskTable().catch(e => logError(`Startup migration error: ${e.message}`));

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', handleInputLine);
    process.on('SIGINT', () => {
        logInfo('Shutting down MCP server...');
        prisma.$disconnect();
        rl.close();
        process.exit(0);
    });

    console.error(`[MCP] Server ready - listening for JSON-RPC requests...`);
    logInfo('MCP server ready');
}

startMcpServer();
