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
                        'Pre-Crime workflow operations. One tool, five actions.',
                        '',
                        'action="status": Read full system state in one call. Returns { config, stats, completeness, readyDrafts, brewingCount }. completeness is a derived check of whether config has the fields needed for the current defaultBookingAction. Use this at startup and between enrichment rounds.',
                        '',
                        'action="configure": Update Config fields. Pass patch with any Config fields (companyName, companyEmail, businessDescription, activeEntities, defaultTrade, marketplaceEnabled, leadCaptureEnabled, leedzEmail, leedzSession, llmApiKey, llmProvider, llmBaseUrl, llmAnthropicVersion, llmMaxTokens, factletStaleDays, defaultBookingAction). Returns updated config.',
                        '',
                        'action="next": Atomically claim the next work item and return it fully hydrated. Pass entity="client" (default) or entity="booking". For clients: returns the client record with all linked factlets and bookings in one payload. The lastQueueCheck is stamped before return so no other agent claims it. Pass optional criteria to filter (company, name, draftStatus). Returns null if queue is empty. Response is automatically trimmed for context efficiency: dossier tail-clipped to last 2000 chars (or override via dossierLimit), factlets capped to 8 most recent (or override via factletLimit). Pass 0 to disable a cap. _clipped metadata is included if anything was trimmed.',
                        '',
                        'action="save": Atomically persist client work in a single transaction. Two modes: (1) UPDATE existing client - pass id and patch with any of: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. (2) CREATE new client - omit id, patch must include name (required), plus optional email, phone, company, website, segment, source, factlets[], bookings[]. After persisting, runs score_target on the client AND re-scores every booking under that client, writing leed_ready status back when shareReady passes the gate in scoring_config.json.\n\naction="rescore": Re-evaluate every non-terminal booking against the current scoring_config.json and update status field (leed_ready or new) accordingly. Use after editing scoring_config.json gates or constants. Pass scope="all" (default), scope="leed_ready" to sanity-check the current queue, or scope=<clientId> to limit to one client. Returns counts: rescored, promoted, demoted, unchanged.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['status', 'configure', 'next', 'save', 'rescore'],
                                description: 'Which pipeline operation to run.'
                            },
                            scope: {
                                type: 'string',
                                description: 'For action=rescore only. "all" (default) re-scores every non-terminal booking. "leed_ready" sanity-checks only the current ready queue. Or pass a clientId to re-score one client only. Use after editing scoring_config.json.'
                            },
                            entity: {
                                type: 'string',
                                enum: ['client', 'booking'],
                                description: 'For action=next only. Which entity queue to pull from. Defaults to client.'
                            },
                            criteria: {
                                type: 'object',
                                description: 'For action=next only. Optional filters: { company, name, draftStatus }.',
                                properties: {
                                    company: { type: 'string' },
                                    name: { type: 'string' },
                                    draftStatus: { type: 'string' }
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
                                description: 'For action=save. Client ID to update. OMIT this to CREATE a new client (in which case patch.name is required).'
                            },
                            patch: {
                                type: 'object',
                                description: 'For action=save or action=configure. For save UPDATE: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. For save CREATE (no id): name (REQUIRED), plus optional email, phone, company, website, segment, source, factlets[], bookings[]. For configure: any Config model fields.'
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

const GENERIC_EMAIL_PREFIXES = new Set([
    'info', 'contact', 'hello', 'support', 'admin', 'office',
    'general', 'mail', 'help', 'team', 'webmaster', 'bookings',
    'events', 'enquiries', 'inquiries', 'noreply', 'noreply',
    'sales', 'marketing', 'pr', 'media', 'press', 'news',
    'reception', 'management', 'operations', 'service', 'services',
    'customerservice', 'customercare', 'care', 'feedback', 'staff'
]);

function isGenericEmail(email) {
    if (!email) return false;
    const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    return GENERIC_EMAIL_PREFIXES.has(prefix);
}

function computeBookingScore(booking, client) {
    const b = {};

    // Trade: 0 or 20
    b.trade = booking.trade ? 20 : 0;

    // Date: 0, 5, 10, or 20
    if (booking.startDate) {
        if (!booking.endDate) {
            b.date = 20;
        } else {
            const start = new Date(booking.startDate);
            const end   = new Date(booking.endDate);
            const spanDays = (end - start) / (1000 * 60 * 60 * 24);
            if (spanDays <= 7)       b.date = 20;
            else if (spanDays <= 30) b.date = 10;
            else                     b.date = 5;
        }
    } else {
        b.date = 0;
    }

    // Location: 0, 5, 10, 15, or 20
    const loc    = (booking.location || '').trim();
    const hasZip = !!(booking.zip && booking.zip.trim());
    const CAMPUS_VAGUE = /\b(campus|university|college|complex|fairgrounds|convention center|park)\b/i;
    const HAS_VENUE    = /\b(hall|arena|stadium|ballroom|theater|theatre|auditorium|pavilion|lawn|plaza|center|centre|gym|library|room|building|bldg)\b/i;
    const HAS_STREET   = /\d+\s+\w+\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|way|ln|lane|ct|court|pl|place)\b/i;

    if (loc && hasZip) {
        const hasStreet = HAS_STREET.test(loc);
        const hasVenue  = HAS_VENUE.test(loc);
        const isVague   = CAMPUS_VAGUE.test(loc) && !hasVenue;
        if (hasStreet && hasVenue)       b.location = 20;
        else if (hasStreet && !isVague)  b.location = 15;
        else if (hasVenue)               b.location = 15;
        else if (hasStreet && isVague)   b.location = 10;
        else if (isVague)                b.location = 10;
        else                             b.location = 5;
    } else if (hasZip || loc) {
        b.location = 5;
    } else {
        b.location = 0;
    }

    // Contact: 0, 10, 15, or 20
    const hasName      = !!(client?.name && client.name.trim());
    const email        = (client?.email || '').trim();
    const generic      = email ? isGenericEmail(email) : false;
    const hasNamedEmail = email && !generic;
    if (hasName && hasNamedEmail) b.contact = 20;
    else if (hasNamedEmail)       b.contact = 15;
    else if (hasName)             b.contact = 10;
    else                          b.contact = 0;

    // Description: 0 or 10
    const desc      = (booking.description || '').trim();
    const wordCount = desc ? desc.split(/\s+/).length : 0;
    b.description = wordCount >= 10 ? 10 : 0;

    // Time: 0 or 10
    const hasTime     = !!(booking.startTime && booking.startTime.trim());
    const hasDuration = !!(booking.duration && booking.duration > 0);
    b.time = (hasTime || hasDuration) ? 10 : 0;

    const total = b.trade + b.date + b.location + b.contact + b.description + b.time;

    // shareReady is gated by scoring_config.json -> booking.gates.shareReady.
    // Note: factletMultiplier is set to 1.0 here because computeBookingScore is
    // the data-only score. The booking-target layer (computeBookingTargetScore)
    // re-runs the gate with the real factletMultiplier and is the authoritative
    // share-ready check. Returning a "shareReadyDataOnly" flag lets the upstream
    // know data-side gates passed without falsely claiming demand-signal yet.
    const dataOnlyCtx = {
        total,
        trade:    b.trade,
        date:     b.date,
        location: b.location,
        contact:  b.contact,
        hasZip,
        factletMultiplier: 1.0   // data-only check; upstream replaces this
    };
    const shareReadyDataOnly = evaluateGate(SCORING.booking.gates.shareReady, dataOnlyCtx);
    // Backward-compat alias used by legacy callers:
    const shareReady = shareReadyDataOnly;

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
// SCORING POLICY LOADED FROM scoring_config.json AT STARTUP
// =============================================================================
// Single source of truth. Edit scoring_config.json (constants, gates, weights),
// restart the server. Nothing in this JS file hardcodes a scoring number.
const SCORING_CONFIG_PATH = path.resolve(__dirname, 'scoring_config.json');
let SCORING;
try {
    SCORING = JSON.parse(fs.readFileSync(SCORING_CONFIG_PATH, 'utf8'));
} catch (e) {
    console.error(`[MCP] FATAL: scoring_config.json missing or malformed: ${e.message}`);
    process.exit(1);
}

const SIGNAL_POINTS = SCORING.client.signalPoints;
const FACTLET_THRESHOLD = SCORING.factlet.threshold;
const FACTLET_POINTS_PER = SCORING.factlet.pointsPerFreshFactlet;
const DRAFT_THRESHOLD_CLIENT = SCORING.client.draftThreshold;

/**
 * Generic gate evaluator. Reads a gate definition from SCORING.gates and
 * tests every rule against the provided context.  Returns true only if EVERY
 * rule passes.  This is the only place gate logic exists -- if the result
 * is wrong, edit scoring_config.json (the data), not this function.
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

function computeFactletStats(clientFactlets, staleDays) {
    const now = Date.now();
    let score = 0;
    let freshCount = 0;
    for (const cf of clientFactlets) {
        const createdAt = cf.factlet && cf.factlet.createdAt;
        if (!createdAt) continue;
        const ageDays = (now - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
        const weight = Math.max(0, 1 - ageDays / staleDays);
        if (weight > 0) freshCount++;
        score += weight;
    }
    return { score, count: clientFactlets.length, freshCount };
}

async function computeClientScore(clientId, intelOverride) {
    const client = await prisma.client.findUnique({
        where: { id: clientId },
        include: {
            factlets: {
                where: { relevance: true },  // gate per DOCS/SCORING.md: only relevant factlets feed factletScore
                include: { factlet: { select: { id: true, createdAt: true } } }
            }
        }
    });
    if (!client) return null;

    const staleDays = await getFactletStaleDays();
    const fs = computeFactletStats(client.factlets || [], staleDays);

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

async function computeBookingTargetScore(bookingId) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
            client: {
                include: {
                    factlets: {
                        where: { relevance: true },  // gate per DOCS/SCORING.md
                        include: { factlet: { select: { id: true, createdAt: true } } }
                    }
                }
            }
        }
    });
    if (!booking) return null;

    const client = booking.client;
    const staleDays = await getFactletStaleDays();

    const data = computeBookingScore(booking, client);
    const fs = computeFactletStats(client.factlets || [], staleDays);
    const factletMultiplier = Math.min(1.0, fs.score / FACTLET_THRESHOLD);

    const total = Math.round(data.total * factletMultiplier);

    // Authoritative shareReady: re-evaluate the gate with the REAL factletMultiplier.
    // This is the only place that calls scoring_config.json's gate against live data.
    const fullCtx = {
        total:             data.total,
        trade:             data.breakdown.trade,
        date:              data.breakdown.date,
        location:          data.breakdown.location,
        contact:           data.breakdown.contact,
        hasZip:            !!(booking.zip && String(booking.zip).trim()),
        factletMultiplier
    };
    const shareReady = evaluateGate(SCORING.booking.gates.shareReady, fullCtx);
    const draftReady = evaluateGate(SCORING.booking.gates.draftReady, {
        shareReadyDataOnly: data.shareReady,
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
    if (data.shareReady && factletMultiplier < 1.0) {
        action = `ENRICH_FACTLETS: Booking data complete but only ${fs.freshCount} fresh relevant factlet(s) (need ${FACTLET_THRESHOLD}). Find more recent intel connecting this client to VALUE_PROP.`;
    }

    return {
        targetType: 'booking',
        targetId:   bookingId,
        total,
        shareReady,
        draftReady,
        components: {
            dataScore:         data.total,
            dataBreakdown:     data.breakdown,
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

    switch (action) {
        case 'status':    return await pipelineStatus(id);
        case 'configure': return await pipelineConfigure(id, args.patch || {});
        case 'next':      return await pipelineNext(id, args.entity || 'client', args.criteria || {}, args.dossierLimit, args.factletLimit);
        case 'save':      return await pipelineSave(id, args.id, args.patch || {});
        case 'rescore':   return await pipelineRescore(id, args.scope || 'all');
        default:
            return createErrorResponse(id, -32602, `Unknown pipeline action: "${action}". Must be: status, configure, next, save, rescore.`);
    }
}

/**
 * Re-score every non-terminal booking against the current scoring_config.json
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

    let promoted = 0;   // new -> leed_ready
    let demoted  = 0;   // leed_ready -> new
    let unchanged = 0;
    const errors = [];

    for (const b of bookings) {
        try {
            const score = await computeBookingTargetScore(b.id);
            if (!score) { errors.push({ id: b.id, msg: 'score returned null' }); continue; }
            const newStatus = score.shareReady ? 'leed_ready' : 'new';
            if (newStatus === b.status) {
                unchanged++;
            } else {
                await prisma.booking.update({ where: { id: b.id }, data: { status: newStatus } });
                if (newStatus === 'leed_ready') promoted++;
                else                            demoted++;
            }
        } catch (e) {
            errors.push({ id: b.id, msg: e.message });
        }
    }

    return createSuccessResponse(id, JSON.stringify({
        rescored: bookings.length,
        promoted,
        demoted,
        unchanged,
        errors
    }, null, 2));
}

async function pipelineStatus(id) {
    // Config
    const cfg = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });

    // Stats (same queries as v1 handleGetStats)
    const [totalClients, totalFactlets, totalLinkedFactlets, brewing, ready, sent,
           contactGatePass, contactGateFail,
           dossierHigh, dossierMid, dossierLow, dossierNone,
           totalBookings, newBookings, leedReady, taken, shared,
           scoreHigh, scoreMid, scoreLow, scoreNone] = await Promise.all([
        prisma.client.count(),
        prisma.factlet.count(),
        prisma.clientFactlet.count(),
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
        prisma.booking.count({ where: { status: 'new' } }),
        prisma.booking.count({ where: { status: 'leed_ready' } }),
        prisma.booking.count({ where: { status: 'taken' } }),
        prisma.booking.count({ where: { status: 'shared' } }),
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
            totalClients, totalFactlets, totalLinkedFactlets,
            drafts: { brewing, ready, sent },
            contactGate: { pass: contactGatePass, fail: contactGateFail },
            dossierScores: { high: dossierHigh, mid: dossierMid, low: dossierLow, unscored: dossierNone },
            bookings: {
                total: totalBookings, new: newBookings, leed_ready: leedReady, taken, shared,
                scores: { share_ready: scoreHigh, needs_work: scoreMid, incomplete: scoreLow, unscored: scoreNone }
            }
        },
        completeness,
        readyDrafts,
        brewingCount: brewing
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

    // Atomic claim + hydrate in one transaction
    const result = await prisma.$transaction(async (tx) => {
        // Find oldest lastQueueCheck (nulls first in SQLite ASC)
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

        // Hydrate: factlets + bookings
        const factlets = await tx.clientFactlet.findMany({
            where: { clientId: client.id },
            include: { factlet: { select: { id: true, content: true, source: true, createdAt: true } } },
            orderBy: { appliedAt: 'desc' }
        });

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

        const factlets = client ? await tx.clientFactlet.findMany({
            where: { clientId: client.id },
            include: { factlet: { select: { id: true, content: true, source: true, createdAt: true } } },
            orderBy: { appliedAt: 'desc' }
        }) : [];

        return { ...booking, client: { ...client, factlets } };
    });

    // Clip the embedded client (dossier + factlets), not the booking itself
    if (result && result.client) {
        result.client = clipClientForResponse(result.client, dossierLimit, factletLimit);
    }
    return createSuccessResponse(id, safeJson(result));
}

async function pipelineSave(id, clientId, patch) {
    let existing = null;
    let isCreate = false;

    if (clientId) {
        existing = await prisma.client.findUnique({ where: { id: clientId } });
        if (!existing) {
            return createErrorResponse(id, -32602, `Client not found: ${clientId}`);
        }
    } else {
        // No id = create new client. Requires patch.name.
        if (!patch.name) {
            return createErrorResponse(id, -32602, 'save without id requires patch.name to create a new client.');
        }
        isCreate = true;
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

        // Create and link factlets
        if (Array.isArray(patch.factlets)) {
            for (const f of patch.factlets) {
                if (!f.content || !f.source) continue;

                const factlet = await tx.factlet.create({
                    data: { content: f.content, source: f.source }
                });

                const signalType = f.signalType || 'context';
                const points = SIGNAL_POINTS[signalType] || 1;

                await tx.clientFactlet.upsert({
                    where: { clientId_factletId: { clientId, factletId: factlet.id } },
                    create: { clientId, factletId: factlet.id, signalType, points },
                    update: { signalType, points }
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

    // Re-score every booking just saved and write status back.
    // computeBookingTargetScore is the single source of truth for leed_ready.
    const touchedBookings = await prisma.booking.findMany({
        where: { clientId },
        select: { id: true, status: true }
    });
    for (const b of touchedBookings) {
        // Skip terminal states
        if (b.status === 'shared' || b.status === 'taken' || b.status === 'expired') continue;
        const score = await computeBookingTargetScore(b.id);
        if (score) {
            const newStatus = score.shareReady ? 'leed_ready' : 'new';
            if (newStatus !== b.status) {
                await prisma.booking.update({ where: { id: b.id }, data: { status: newStatus } });
            }
        }
    }

    // Score after transaction completes (scoring reads back from DB)
    const intelOverride = (patch.intelScore !== undefined) ? parseInt(patch.intelScore, 10) : null;
    const scoreResult = await computeClientScore(clientId, intelOverride);

    return createSuccessResponse(id, JSON.stringify({
        saved: true,
        clientId,
        score: scoreResult
    }, null, 2));
}

// ============================================================================
// FIND TOOL HANDLER
// ============================================================================

async function handleFind(id, params) {
    const args = params.arguments || {};
    const action = args.action;

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
        if (filters.company) where.company = { contains: filters.company };
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

    // If clientId is provided, return linked factlets for that client
    if (filters.clientId) {
        const links = await prisma.clientFactlet.findMany({
            where: { clientId: filters.clientId },
            include: { factlet: { select: { id: true, content: true, source: true, createdAt: true } } },
            orderBy: { appliedAt: 'desc' }
        });
        return createSuccessResponse(id, JSON.stringify(links, null, 2));
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

function startMcpServer() {
    console.error(`[MCP] Starting Pre-Crime MCP server (3 tools)...`);
    console.error(`[MCP] Database: ${dbPath}`);

    logInfo('Starting Pre-Crime MCP server (3 tools)...');
    logInfo(`Database: ${dbPath}`);

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
