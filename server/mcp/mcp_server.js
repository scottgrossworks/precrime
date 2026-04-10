/**
 * PRE-CRIME — MCP SERVER (Direct Prisma)
 *
 * JSON-RPC server for Claude Desktop. Queries deployment SQLite
 * directly via PrismaClient. No HTTP server required.
 *
 * 20 tools: 12 original (+ create_client) + 4 booking + share_booking + 3 scoring (link_factlet, get_client_factlets, score_client)
 *
 * @version 2.0.0
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

// The Leedz marketplace MCP endpoint
const LEEDZ_MCP_URL = 'https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/mcp';

// Load config
const CONFIG_PATH = path.resolve(__dirname, 'mcp_server_config.json');
console.error(`[MCP] Loading config from: ${CONFIG_PATH}`);

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.error(`[MCP] Config loaded successfully`);
} catch (error) {
    console.error(`[MCP] FATAL: Failed to load config: ${error.message}`);
    process.exit(1);
}

// Initialize Prisma with database path from config
const dbPath = path.resolve(__dirname, '..', config.database.path);
process.env.DATABASE_URL = `file:${dbPath}`;
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
 * Used by isJsonRpcLine() in request processing
 */
function looksLikeJson(text) {
    const trimmed = text.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Create successful JSON-RPC response
 * @param {string} id - Request ID
 * @param {string} text - Response text to send
 * @returns {Object} JSON-RPC response object
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
 * @param {string} id - Request ID
 * @param {number} code - Error code
 * @param {string} message - Error message
 * @returns {Object} JSON-RPC error response
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
 * @param {Object} response - Response object to send
 */
function sendJsonRpcResponse(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
}

/**
 * JSON.stringify with BigInt safety. Prisma returns BigInt for Int64 fields
 * (e.g. sharedAt). Standard JSON.stringify throws on BigInt — convert to Number.
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
                name: config.mcp.name,
                version: config.mcp.version
            }
        }
    };
}

function handleToolsList(id) {
    logInfo('Handling tools/list request');
    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            tools: [
                {
                    name: 'get_client',
                    description: 'Get a single client by ID',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Client ID' }
                        },
                        required: ['id']
                    }
                },
                {
                    name: 'create_client',
                    description: 'Create a new client record. Requires at least name or company. Sets draftStatus to "brewing" by default. Returns the created client with its ID.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Contact person name' },
                            email: { type: 'string', description: 'Email address' },
                            phone: { type: 'string', description: 'Phone number' },
                            company: { type: 'string', description: 'Company or organization name' },
                            website: { type: 'string', description: 'Website URL' },
                            clientNotes: { type: 'string' },
                            segment: { type: 'string', description: 'Audience segment' },
                            dossier: { type: 'string', description: 'Initial dossier notes' },
                            targetUrls: { type: 'string', description: 'JSON array of URLs: [{url, type, label}]' },
                            draftStatus: { type: 'string', description: 'Default: brewing' },
                            source: { type: 'string', description: 'How this client was found (e.g., "seeder:directory", "harvester:reddit")' }
                        }
                    }
                },
                {
                    name: 'search_clients',
                    description: 'Search clients by name, email, company, or keyword. Filter by draftStatus, warmthScore, and/or segment. Returns lightweight summary records by default (no dossier/draft/targetUrls). Pass summary=false ONLY when you need full records for one specific client.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            search: { type: 'string', description: 'Search across name, email, company' },
                            name: { type: 'string', description: 'Filter by name (partial match)' },
                            email: { type: 'string', description: 'Filter by email (exact match)' },
                            company: { type: 'string', description: 'Filter by company (partial match)' },
                            segment: { type: 'string', description: 'Filter by segment (partial match)' },
                            draftStatus: { type: 'string', description: 'Filter by draft status: brewing, ready, sent' },
                            warmthScore: { type: 'number', description: 'Exact warmthScore match (e.g. 10)' },
                            minWarmthScore: { type: 'number', description: 'Minimum warmthScore (inclusive)' },
                            maxWarmthScore: { type: 'number', description: 'Maximum warmthScore (inclusive)' },
                            limit: { type: 'number', description: 'Max results (default 10)' },
                            summary: { type: 'boolean', description: 'DEFAULT TRUE. Returns lightweight records (no dossier/draft/targetUrls). Pass false ONLY when you need full records — but prefer get_client(id) for single full records instead.' }
                        }
                    }
                },
                {
                    name: 'update_client',
                    description: 'Update a client record. Use for dossier, draft, draftStatus, warmthScore, clientNotes, etc.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Client ID (required)' },
                            name: { type: 'string' },
                            email: { type: 'string' },
                            phone: { type: 'string' },
                            company: { type: 'string' },
                            website: { type: 'string' },
                            clientNotes: { type: 'string' },
                            dossier: { type: 'string' },
                            targetUrls: { type: 'string', description: 'JSON array of discovered URLs: [{url, type, label}]' },
                            draft: { type: 'string' },
                            draftStatus: { type: 'string' },
                            warmthScore: { type: 'number' },
                            lastEnriched: { type: 'string', description: 'ISO datetime' },
                            lastQueueCheck: { type: 'string', description: 'ISO datetime' }
                        },
                        required: ['id']
                    }
                },
                {
                    name: 'get_ready_drafts',
                    description: 'Get clients with draftStatus = "ready", sorted by warmthScore descending',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            limit: { type: 'number', description: 'Max results (default 10)' },
                            summary: { type: 'boolean', description: 'If true, return lightweight records only (no dossier, draft, targetUrls). Use for browsing the list before fetching individual records.' }
                        }
                    }
                },
                {
                    name: 'get_stats',
                    description: 'Get system stats: total clients, clients by draftStatus, factlet count',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'create_factlet',
                    description: 'Saves a mission-relevant news item to the global broadcast queue',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: 'The 2-3 sentence summary of the news' },
                            source: { type: 'string', description: 'The URL of the original article' }
                        },
                        required: ['content', 'source']
                    }
                },
                {
                    name: 'get_new_factlets',
                    description: 'Get factlets newer than a given timestamp (for queue checking)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            since: { type: 'string', description: 'ISO datetime -- return factlets created after this time' }
                        },
                        required: ['since']
                    }
                },
                {
                    name: 'delete_factlet',
                    description: 'Remove a factlet from the queue',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Factlet ID' }
                        },
                        required: ['id']
                    }
                },
                {
                    name: 'get_next_client',
                    description: 'Fetch the next client needing enrichment — oldest lastQueueCheck (nulls first). Atomically stamps lastQueueCheck=now before returning so no other agent claims the same record. Pass optional criteria to target a subset (e.g. company="Christian School"). Returns null if no matching records exist.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            company: { type: 'string', description: 'Filter by company keyword (partial match)' },
                            name: { type: 'string', description: 'Filter by name keyword (partial match)' },
                            draftStatus: { type: 'string', description: 'Filter by draft status: brewing, ready, sent' }
                        }
                    }
                },
                {
                    name: 'get_config',
                    description: 'Get current system configuration',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'update_config',
                    description: 'Update system configuration',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            companyName: { type: 'string' },
                            companyEmail: { type: 'string' },
                            businessDescription: { type: 'string' },
                            llmApiKey: { type: 'string' },
                            llmProvider: { type: 'string' },
                            llmBaseUrl: { type: 'string' },
                            llmAnthropicVersion: { type: 'string' },
                            llmMaxTokens: { type: 'number' },
                            activeEntities: { type: 'string', description: 'JSON array: ["client"] or ["client", "booking"]' },
                            defaultTrade: { type: 'string', description: 'Default trade name (e.g., "DJ")' },
                            marketplaceEnabled: { type: 'boolean' },
                            leadCaptureEnabled: { type: 'boolean' },
                            leedzEmail: { type: 'string', description: 'The Leedz marketplace account email' },
                            leedzSession: { type: 'string', description: 'Pre-generated HS256 JWT for createLeed calls' }
                        }
                    }
                },
                {
                    name: 'create_booking',
                    description: 'Create a Booking for a Client. If trade + startDate + (location OR zip) are all present, status auto-sets to "leed_ready".',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            clientId: { type: 'string', description: 'Client ID (required)' },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            notes: { type: 'string' },
                            location: { type: 'string' },
                            startDate: { type: 'string', description: 'ISO datetime' },
                            endDate: { type: 'string', description: 'ISO datetime' },
                            startTime: { type: 'string' },
                            endTime: { type: 'string' },
                            duration: { type: 'number' },
                            hourlyRate: { type: 'number' },
                            flatRate: { type: 'number' },
                            totalAmount: { type: 'number' },
                            status: { type: 'string', description: 'new | leed_ready | taken | shared | expired' },
                            source: { type: 'string', description: 'e.g., "reddit:r/weddingplanning"' },
                            sourceUrl: { type: 'string' },
                            trade: { type: 'string', description: 'Leedz trade name (e.g., "DJ")' },
                            zip: { type: 'string' },
                            leedPrice: { type: 'number', description: 'Price in cents for marketplace listing' }
                        },
                        required: ['clientId']
                    }
                },
                {
                    name: 'update_booking',
                    description: 'Update a Booking record by ID',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Booking ID (required)' },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            notes: { type: 'string' },
                            location: { type: 'string' },
                            startDate: { type: 'string', description: 'ISO datetime' },
                            endDate: { type: 'string', description: 'ISO datetime' },
                            startTime: { type: 'string' },
                            endTime: { type: 'string' },
                            duration: { type: 'number' },
                            hourlyRate: { type: 'number' },
                            flatRate: { type: 'number' },
                            totalAmount: { type: 'number' },
                            status: { type: 'string', description: 'new | leed_ready | taken | shared | expired' },
                            source: { type: 'string' },
                            sourceUrl: { type: 'string' },
                            trade: { type: 'string' },
                            zip: { type: 'string' },
                            shared: { type: 'boolean' },
                            sharedAt: { type: 'number', description: 'Epoch ms' },
                            leedPrice: { type: 'number' },
                            squarePaymentUrl: { type: 'string' },
                            leedId: { type: 'string', description: 'The Leedz marketplace ID after posting' }
                        },
                        required: ['id']
                    }
                },
                {
                    name: 'get_bookings',
                    description: 'Get Bookings, optionally filtered by status, trade, and/or keyword search. Search checks title, description, notes, and location fields. Returns booking fields + slim client stub.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            search: { type: 'string', description: 'Keyword search across title, description, notes, and location fields' },
                            status: { type: 'string', description: 'Filter by status: new, leed_ready, taken, shared, expired' },
                            trade: { type: 'string', description: 'Filter by trade name' },
                            limit: { type: 'number', description: 'Max results (default 20)' }
                        }
                    }
                },
                {
                    name: 'get_client_bookings',
                    description: 'Get all Bookings for a specific Client',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            clientId: { type: 'string', description: 'Client ID (required)' }
                        },
                        required: ['clientId']
                    }
                },
                {
                    name: 'score_booking',
                    description: 'Compute a 0-100 readiness score for a Booking. Five categories: trade (0/20), date (0/20), location (0/10/20), contact (0/10/15/20 — generic emails like info@ score 0), description (0/10/20). Share threshold: total >= 70 AND contact >= 10. Writes bookingScore + contactQuality to DB and returns full breakdown + recommended action.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Booking ID' }
                        },
                        required: ['id']
                    }
                },
                {
                    name: 'share_booking',
                    description: 'Post a leed_ready Booking to The Leedz marketplace. Fetches Booking + Client from DB, calls createLeed API (trade auto-lowercased), updates Booking with leedId and status=shared. Requires marketplaceEnabled=true and leedzSession in Config.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Booking ID' }
                        },
                        required: ['id']
                    }
                },
                {
                    name: 'link_factlet',
                    description: 'Associate a factlet with a client. Classifies the factlet as pain/occasion/context for THIS client and assigns points (pain=2, occasion=2, context=1). Idempotent — calling again for the same client+factlet pair updates signalType/points.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            clientId: { type: 'string', description: 'Client ID' },
                            factletId: { type: 'string', description: 'Factlet ID' },
                            signalType: { type: 'string', description: 'pain | occasion | context' }
                        },
                        required: ['clientId', 'factletId', 'signalType']
                    }
                },
                {
                    name: 'get_client_factlets',
                    description: 'Get all factlets linked to a client, with their signalType, points, and full factlet content. Use at start of enrichment to hydrate factlet context.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            clientId: { type: 'string', description: 'Client ID' }
                        },
                        required: ['clientId']
                    }
                },
                {
                    name: 'score_client',
                    description: 'Procedural client scoring (no LLM). Computes contactGate (binary: named person + direct email), factletScore (sum of linked factlet points), dossierScore (intelScore + factletScore), and canDraft (contactGate AND dossierScore >= 5). Writes scores back to DB. Pass intelScore (D2+D3) after scraping.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            clientId: { type: 'string', description: 'Client ID' },
                            intelScore: { type: 'number', description: 'Intel depth + direct signals score (D2+D3, max 7). Set by enrichment agent after scraping.' }
                        },
                        required: ['clientId']
                    }
                }
            ]
        }
    };
}

// ============================================================================
// LEEDZ MARKETPLACE HTTP HELPER
// ============================================================================

function postToLeedzMcp(payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const url = new URL(LEEDZ_MCP_URL);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Invalid JSON from Leedz MCP: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ============================================================================
// TOOL HANDLERS — DIRECT PRISMA
// ============================================================================

// Reference: prisma_sqlite_db.js getClient() lines 107-114
async function handleGetClient(id, params) {
    const clientId = params.arguments?.id;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing client ID');

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return createErrorResponse(id, -32602, `Client not found: ${clientId}`);

    return createSuccessResponse(id, JSON.stringify(client, null, 2));
}

async function handleCreateClient(id, params) {
    const args = params.arguments || {};
    if (!args.name && !args.company) {
        return createErrorResponse(id, -32602, 'At least one of name or company is required');
    }

    const data = {};
    const allowedFields = [
        'name', 'email', 'phone', 'company', 'website', 'clientNotes',
        'segment', 'dossier', 'targetUrls', 'draftStatus', 'source'
    ];
    for (const field of allowedFields) {
        if (args[field] !== undefined) {
            data[field] = args[field];
        }
    }
    if (!data.draftStatus) data.draftStatus = 'brewing';

    const client = await prisma.client.create({ data });
    return createSuccessResponse(id, JSON.stringify(client, null, 2));
}

// Reference: prisma_sqlite_db.js getClients() lines 116-196
async function handleSearchClients(id, params) {
    const args = params.arguments || {};
    let where = {};
    const limit = args.limit || 10;

    if (args.search) {
        where.OR = [
            { name: { contains: args.search } },
            { email: { contains: args.search } },
            { company: { contains: args.search } }
        ];
    } else {
        if (args.name) where.name = { contains: args.name };
        if (args.email) where.email = args.email;
        if (args.company) where.company = { contains: args.company };
        if (args.segment) where.segment = { contains: args.segment };
    }

    if (args.draftStatus) where.draftStatus = args.draftStatus;

    if (args.warmthScore !== undefined) {
        where.warmthScore = parseInt(args.warmthScore, 10);
    } else if (args.minWarmthScore !== undefined || args.maxWarmthScore !== undefined) {
        where.warmthScore = {};
        if (args.minWarmthScore !== undefined) where.warmthScore.gte = parseInt(args.minWarmthScore, 10);
        if (args.maxWarmthScore !== undefined) where.warmthScore.lte = parseInt(args.maxWarmthScore, 10);
    }

    const queryOpts = { where, take: limit, orderBy: { dossierScore: 'desc' } };

    // Default to summary mode — full records with dossier/draft/targetUrls are too large
    // for MCP response limits. Pass summary=false ONLY when you need the full record.
    const useSummary = args.summary !== false;
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

// Reference: prisma_sqlite_db.js updateClient() lines 198-238
async function handleUpdateClient(id, params) {
    const args = params.arguments || {};
    const clientId = args.id;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing client ID');

    const allowedFields = [
        'name', 'email', 'phone', 'company', 'website', 'clientNotes',
        'dossier', 'targetUrls', 'draft', 'draftStatus', 'warmthScore',
        'dossierScore', 'contactGate', 'intelScore',
        'lastEnriched', 'lastQueueCheck'
    ];

    const data = {};
    for (const field of allowedFields) {
        if (args[field] !== undefined) {
            if (field === 'lastEnriched' || field === 'lastQueueCheck') {
                data[field] = new Date(args[field]);
            } else if (field === 'warmthScore') {
                data[field] = parseFloat(args[field]);
            } else if (field === 'dossierScore' || field === 'intelScore') {
                data[field] = parseInt(args[field], 10);
            } else if (field === 'contactGate') {
                data[field] = !!args[field];
            } else {
                data[field] = args[field];
            }
        }
    }

    const updated = await prisma.client.update({ where: { id: clientId }, data });
    return createSuccessResponse(id, JSON.stringify(updated, null, 2));
}

async function handleGetReadyDrafts(id, params) {
    const args = params.arguments || {};
    const limit = args.limit || 10;
    const queryOpts = {
        where: { draftStatus: 'ready' },
        orderBy: { dossierScore: 'desc' },
        take: limit
    };
    if (args.summary) {
        queryOpts.select = {
            id: true, name: true, company: true, segment: true,
            email: true, dossierScore: true, contactGate: true,
            warmthScore: true, draftStatus: true, lastEnriched: true
        };
    }
    const clients = await prisma.client.findMany(queryOpts);
    return createSuccessResponse(id, JSON.stringify(clients, null, 2));
}

// Reference: prisma_sqlite_db.js getSystemStats() lines 624-641
async function handleGetStats(id, params) {
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
    return createSuccessResponse(id, JSON.stringify({
        totalClients, totalFactlets, totalLinkedFactlets,
        drafts: { brewing, ready, sent },
        contactGate: { pass: contactGatePass, fail: contactGateFail },
        dossierScores: { high: dossierHigh, mid: dossierMid, low: dossierLow, unscored: dossierNone },
        bookings: {
            total: totalBookings, new: newBookings, leed_ready: leedReady, taken, shared,
            scores: { share_ready: scoreHigh, needs_work: scoreMid, incomplete: scoreLow, unscored: scoreNone }
        }
    }, null, 2));
}

async function handleCreateFactlet(id, params) {
    const args = params.arguments || {};
    if (!args.content) return createErrorResponse(id, -32602, 'Missing factlet content');
    if (!args.source)  return createErrorResponse(id, -32602, 'Missing factlet source URL');

    const factlet = await prisma.factlet.create({
        data: { content: args.content, source: args.source }
    });
    return createSuccessResponse(id, JSON.stringify(factlet, null, 2));
}

async function handleGetNewFactlets(id, params) {
    const since = params.arguments?.since;
    if (!since) return createErrorResponse(id, -32602, 'Missing "since" timestamp');

    const factlets = await prisma.factlet.findMany({
        where: { createdAt: { gt: new Date(since) } },
        orderBy: { createdAt: 'asc' }
    });
    return createSuccessResponse(id, JSON.stringify(factlets, null, 2));
}

async function handleDeleteFactlet(id, params) {
    const factletId = params.arguments?.id;
    if (!factletId) return createErrorResponse(id, -32602, 'Missing factlet ID');

    await prisma.factlet.delete({ where: { id: factletId } });
    return createSuccessResponse(id, `Factlet ${factletId} deleted`);
}

// Atomic fetch-and-mark: finds oldest-touched client, stamps lastQueueCheck=now,
// returns the record. The stamp happens BEFORE return so concurrent agents cannot
// claim the same record. Claude's stateless memory is never trusted as the cursor —
// the DB timestamp IS the bookmark.
async function handleGetNextClient(id, params) {
    const args = params.arguments || {};
    const where = {};
    if (args.company)     where.company     = { contains: args.company };
    if (args.name)        where.name        = { contains: args.name };
    if (args.draftStatus) where.draftStatus = args.draftStatus;

    // NULL lastQueueCheck sorts first in SQLite ASC — never-touched records come first
    const client = await prisma.client.findFirst({
        where,
        orderBy: { lastQueueCheck: 'asc' }
    });

    if (!client) return createSuccessResponse(id, JSON.stringify(null));

    // Stamp before returning — this is what prevents re-processing
    const stamped = await prisma.client.update({
        where: { id: client.id },
        data: { lastQueueCheck: new Date() }
    });

    return createSuccessResponse(id, JSON.stringify(stamped, null, 2));
}

async function handleGetConfig(id, params) {
    const cfg = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });
    return createSuccessResponse(id, JSON.stringify(cfg, null, 2));
}

// Reference: prisma_sqlite_db.js upsertConfig() lines 594-622
async function handleUpdateConfig(id, params) {
    const args = params.arguments || {};
    const existing = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });

    let cfg;
    if (existing) {
        cfg = await prisma.config.update({ where: { id: existing.id }, data: args });
    } else {
        cfg = await prisma.config.create({ data: args });
    }
    return createSuccessResponse(id, JSON.stringify(cfg, null, 2));
}

// ============================================================================
// BOOKING TOOL HANDLERS
// ============================================================================

async function handleCreateBooking(id, params) {
    const args = params.arguments || {};
    if (!args.clientId) return createErrorResponse(id, -32602, 'Missing clientId');

    const data = { clientId: args.clientId };
    const fields = [
        'title', 'description', 'notes', 'location', 'startTime', 'endTime',
        'source', 'sourceUrl', 'trade', 'zip', 'sharedTo', 'squarePaymentUrl', 'leedId'
    ];
    for (const f of fields) { if (args[f] !== undefined) data[f] = args[f]; }

    // Numeric fields
    if (args.duration !== undefined)   data.duration   = parseFloat(args.duration);
    if (args.hourlyRate !== undefined)  data.hourlyRate  = parseFloat(args.hourlyRate);
    if (args.flatRate !== undefined)    data.flatRate    = parseFloat(args.flatRate);
    if (args.totalAmount !== undefined) data.totalAmount = parseFloat(args.totalAmount);
    if (args.leedPrice !== undefined)   data.leedPrice   = parseInt(args.leedPrice, 10);

    // Date fields
    if (args.startDate) data.startDate = new Date(args.startDate);
    if (args.endDate)   data.endDate   = new Date(args.endDate);

    // Boolean
    if (args.shared !== undefined) data.shared = !!args.shared;

    // Status defaults to 'new' via schema — check Booking Action Criterion
    if (args.status) {
        data.status = args.status;
    } else if (data.trade && data.startDate && (data.location || data.zip)) {
        data.status = 'leed_ready';
    }

    const booking = await prisma.booking.create({ data });
    return createSuccessResponse(id, safeJson(booking));
}

async function handleUpdateBooking(id, params) {
    const args = params.arguments || {};
    if (!args.id) return createErrorResponse(id, -32602, 'Missing booking ID');

    const allowedFields = [
        'title', 'description', 'notes', 'location', 'startTime', 'endTime',
        'status', 'source', 'sourceUrl', 'trade', 'zip', 'sharedTo',
        'squarePaymentUrl', 'leedId'
    ];
    const data = {};
    for (const f of allowedFields) { if (args[f] !== undefined) data[f] = args[f]; }

    if (args.duration !== undefined)   data.duration   = parseFloat(args.duration);
    if (args.hourlyRate !== undefined)  data.hourlyRate  = parseFloat(args.hourlyRate);
    if (args.flatRate !== undefined)    data.flatRate    = parseFloat(args.flatRate);
    if (args.totalAmount !== undefined) data.totalAmount = parseFloat(args.totalAmount);
    if (args.leedPrice !== undefined)   data.leedPrice   = parseInt(args.leedPrice, 10);
    if (args.startDate) data.startDate = new Date(args.startDate);
    if (args.endDate)   data.endDate   = new Date(args.endDate);
    if (args.shared !== undefined) data.shared = !!args.shared;
    if (args.sharedAt !== undefined) data.sharedAt = BigInt(args.sharedAt);

    // Auto-promote to leed_ready if fields complete and status not explicitly set
    if (!data.status) {
        const existing = await prisma.booking.findUnique({ where: { id: args.id } });
        const merged = { ...existing, ...data };
        if (merged.trade && merged.startDate && (merged.location || merged.zip)) {
            data.status = 'leed_ready';
        }
    }

    const booking = await prisma.booking.update({ where: { id: args.id }, data });
    return createSuccessResponse(id, safeJson(booking));
}

async function handleGetBookings(id, params) {
    const args = params.arguments || {};
    const where = {};
    if (args.status) where.status = args.status;
    if (args.trade)  where.trade  = args.trade;
    const limit = args.limit || 20;

    // Keyword search across title, description, notes, location
    if (args.search) {
        where.OR = [
            { title:       { contains: args.search } },
            { description: { contains: args.search } },
            { notes:       { contains: args.search } },
            { location:    { contains: args.search } }
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

// ============================================================================
// CLIENT SCORING — PROCEDURAL, NO LLM
// ============================================================================

const SIGNAL_POINTS = { pain: 2, occasion: 2, context: 1 };
const DRAFT_THRESHOLD = 5;

async function handleLinkFactlet(id, params) {
    const args = params.arguments || {};
    const { clientId, factletId, signalType } = args;
    if (!clientId)   return createErrorResponse(id, -32602, 'Missing clientId');
    if (!factletId)  return createErrorResponse(id, -32602, 'Missing factletId');
    if (!signalType) return createErrorResponse(id, -32602, 'Missing signalType');

    const validTypes = ['pain', 'occasion', 'context'];
    if (!validTypes.includes(signalType)) {
        return createErrorResponse(id, -32602, `Invalid signalType "${signalType}". Must be: ${validTypes.join(', ')}`);
    }

    const points = SIGNAL_POINTS[signalType];

    // Upsert — idempotent on clientId+factletId unique constraint
    const link = await prisma.clientFactlet.upsert({
        where: { clientId_factletId: { clientId, factletId } },
        create: { clientId, factletId, signalType, points },
        update: { signalType, points },
        include: { factlet: { select: { content: true, source: true } } }
    });

    return createSuccessResponse(id, JSON.stringify(link, null, 2));
}

async function handleGetClientFactlets(id, params) {
    const clientId = params.arguments?.clientId;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing clientId');

    const links = await prisma.clientFactlet.findMany({
        where: { clientId },
        include: { factlet: { select: { id: true, content: true, source: true, createdAt: true } } },
        orderBy: { appliedAt: 'desc' }
    });

    return createSuccessResponse(id, JSON.stringify(links, null, 2));
}

async function handleScoreClient(id, params) {
    const args = params.arguments || {};
    const clientId = args.clientId;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing clientId');

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return createErrorResponse(id, -32602, `Client not found: ${clientId}`);

    // --- Contact Gate ---
    const hasName = !!(client.name && client.name.trim());
    const email = (client.email || '').trim();
    const generic = email ? isGenericEmail(email) : false;
    const hasDirectEmail = !!(email && !generic);
    const contactGate = hasName && hasDirectEmail;

    // --- Factlet Score (D4) ---
    const factletAgg = await prisma.clientFactlet.aggregate({
        where: { clientId },
        _sum: { points: true },
        _count: true
    });
    const factletScore = factletAgg._sum.points || 0;
    const factletCount = factletAgg._count || 0;

    // --- Intel Score (D2+D3) ---
    // Use provided param if present, otherwise use stored value
    const intelScore = (args.intelScore !== undefined)
        ? parseInt(args.intelScore, 10)
        : (client.intelScore || 0);

    // --- Dossier Score ---
    const dossierScore = intelScore + factletScore;

    // --- Draft Eligibility ---
    const canDraft = contactGate && (dossierScore >= DRAFT_THRESHOLD);

    // --- Recommended action ---
    let action = null;
    if (!canDraft) {
        if (!hasName) {
            action = 'CHASE_CONTACT: No named person. Find a decision-maker via website, LinkedIn, or staff directory.';
        } else if (!email) {
            action = 'CHASE_CONTACT: No email at all. Search for direct email via LinkedIn, staff directory, domain patterns.';
        } else if (generic) {
            action = `CHASE_CONTACT: ${email} is a generic inbox. Find ${client.name}'s direct email.`;
        } else if (dossierScore < DRAFT_THRESHOLD) {
            action = `THIN_DOSSIER: dossierScore ${dossierScore} < ${DRAFT_THRESHOLD}. Need more signals or factlets.`;
        }
    }

    // --- Write back to DB ---
    const updateData = { dossierScore, contactGate };
    if (args.intelScore !== undefined) {
        updateData.intelScore = intelScore;
    }
    await prisma.client.update({ where: { id: clientId }, data: updateData });

    const emailNote = email
        ? (generic ? ` (generic — gate fails)` : '')
        : ' (no email)';

    return createSuccessResponse(id, JSON.stringify({
        clientId,
        contactGate,
        dossierScore,
        factletScore,
        factletCount,
        intelScore,
        canDraft,
        breakdown: {
            contact: `${contactGate ? 'PASS' : 'FAIL'} — ${client.name || 'NO NAME'} / ${email || 'no email'}${emailNote}`,
            intel:   `${intelScore}/7 — D2+D3 from scraping`,
            factlets: `${factletScore} pts from ${factletCount} linked factlets`,
            total:   `${dossierScore} (threshold: ${DRAFT_THRESHOLD})`
        },
        action
    }, null, 2));
}

// ============================================================================
// BOOKING SCORE — PROCEDURAL, NO LLM
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

    // Date: 0 or 20
    b.date = booking.startDate ? 20 : 0;

    // Location: 0, 10, or 20
    const hasLoc = !!(booking.location && booking.location.trim());
    const hasZip = !!(booking.zip && booking.zip.trim());
    if (hasLoc && hasZip)      b.location = 20;
    else if (hasZip || hasLoc) b.location = 10;
    else                       b.location = 0;

    // Contact: 0, 10, 15, or 20 — generic email always scores 0
    const hasName      = !!(client?.name && client.name.trim());
    const email        = (client?.email || '').trim();
    const generic      = email ? isGenericEmail(email) : false;
    const hasNamedEmail = email && !generic;
    if (hasName && hasNamedEmail) b.contact = 20;
    else if (hasNamedEmail)       b.contact = 15;
    else if (hasName)             b.contact = 10;
    else                          b.contact = 0;  // no contact OR generic email only

    // Description: 0, 10, or 20
    const desc      = (booking.description || '').trim();
    const wordCount = desc ? desc.split(/\s+/).length : 0;
    if (wordCount >= 20)   b.description = 20;
    else if (wordCount > 0) b.description = 10;
    else                    b.description = 0;

    const total = b.trade + b.date + b.location + b.contact + b.description;

    // Hard gates: total >= 70 AND contact >= 10 (must have a real person)
    const shareReady = total >= 70 && b.contact >= 10;

    // Contact quality label
    let contactQuality;
    if (b.contact === 20)      contactQuality = 'named_email_and_name';
    else if (b.contact === 15) contactQuality = 'named_email';
    else if (b.contact === 10) contactQuality = 'name_only';
    else if (generic)          contactQuality = 'generic_email';
    else                       contactQuality = 'none';

    // Recommended next action if not share-ready
    let action = null;
    if (!shareReady) {
        if (b.contact === 0 && generic) {
            action = `ENRICH: ${email} is a generic inbox. Find a named contact via website, LinkedIn, or Facebook.`;
        } else if (b.contact === 0) {
            action = 'ENRICH: No contact found. Search for a named person at this organization.';
        } else if (!booking.trade) {
            action = 'CLASSIFY: Assign a trade category before sharing.';
        } else if (!booking.startDate) {
            action = 'ENRICH: No event date. Search or send probe email to confirm timing.';
        } else if (b.location < 20) {
            action = 'ENRICH: Partial location. Search for venue address and zip.';
        } else if (b.description < 20) {
            action = 'ENRICH: Thin description. Scrape more context or send probe email.';
        } else {
            action = 'OUTREACH: Send probe email to confirm missing details.';
        }
    }

    return { total, breakdown: b, shareReady, contactQuality, action };
}

async function handleScoreBooking(id, params) {
    const bookingId = params.arguments?.id;
    if (!bookingId) return createErrorResponse(id, -32602, 'Missing booking ID');

    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { client: { select: { id: true, name: true, email: true } } }
    });
    if (!booking) return createErrorResponse(id, -32602, `Booking not found: ${bookingId}`);

    const { total, breakdown: b, shareReady, contactQuality, action } = computeBookingScore(booking, booking.client);

    // Write score back to DB
    await prisma.booking.update({
        where: { id: bookingId },
        data: { bookingScore: total, contactQuality }
    });

    const dateStr   = booking.startDate ? new Date(booking.startDate).toISOString().split('T')[0] : 'MISSING';
    const locStr    = [booking.location, booking.zip].filter(Boolean).join(', ') || 'MISSING';
    const emailNote = booking.client?.email
        ? (contactQuality === 'generic_email' ? ` (generic — scores 0)` : '')
        : '';

    return createSuccessResponse(id, JSON.stringify({
        id:             bookingId,
        score:          total,
        shareReady,
        contactQuality,
        breakdown: {
            trade:       `${b.trade}/20  — ${booking.trade || 'MISSING'}`,
            date:        `${b.date}/20  — ${dateStr}`,
            location:    `${b.location}/20 — ${locStr}`,
            contact:     `${b.contact}/20 — ${booking.client?.email || 'no email'}${emailNote}`,
            description: `${b.description}/20 — ${(booking.description||'').split(/\s+/).filter(Boolean).length} words`,
        },
        action
    }, null, 2));
}

async function handleShareBooking(id, params) {
    const bookingId = params.arguments?.id;
    if (!bookingId) return createErrorResponse(id, -32602, 'Missing booking ID');

    // Config: need leedzSession + marketplaceEnabled
    const cfg = await prisma.config.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!cfg?.marketplaceEnabled) return createErrorResponse(id, -32602, 'marketplaceEnabled is false in Config');
    if (!cfg?.leedzSession)       return createErrorResponse(id, -32602, 'leedzSession not set in Config — run init wizard Step 5a');

    // Fetch booking + client
    const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { client: true } });
    if (!booking)           return createErrorResponse(id, -32602, `Booking not found: ${bookingId}`);
    if (!booking.trade)     return createErrorResponse(id, -32602, 'Booking missing trade');
    if (!booking.startDate) return createErrorResponse(id, -32602, 'Booking missing startDate');
    if (!booking.zip)       return createErrorResponse(id, -32602, 'Booking missing zip');

    // Build createLeed params
    const tn = booking.trade.toLowerCase();
    const ti = (booking.title || `${tn} needed — ${booking.location || booking.zip}`).substring(0, 200);
    const st = new Date(booking.startDate).getTime();

    // lc must end with zip
    let lc = (booking.location || '').trim();
    if (lc && !lc.endsWith(booking.zip)) lc = `${lc} ${booking.zip}`;

    const args = { session: cfg.leedzSession, tn, ti, zp: booking.zip, st, pr: booking.leedPrice || 0, sh: '*' };
    if (booking.endDate)       args.et = new Date(booking.endDate).getTime();
    if (lc)                    args.lc = lc.substring(0, 300);
    if (booking.description)   args.dt = booking.description.substring(0, 1000);
    if (booking.notes)         args.rq = booking.notes.substring(0, 1000);
    if (booking.client?.name)  args.cn = booking.client.name;
    if (booking.client?.email) args.em = booking.client.email;
    if (booking.client?.phone) args.ph = booking.client.phone;

    logInfo(`share_booking: bookingId=${bookingId} tn=${tn} zp=${booking.zip} st=${st}`);

    // POST to The Leedz MCP
    let rpcResponse;
    try {
        rpcResponse = await postToLeedzMcp({
            jsonrpc: '2.0', id: '1', method: 'tools/call',
            params: { name: 'createLeed', arguments: args }
        });
    } catch (err) {
        logError(`share_booking HTTP error: ${err.message}`);
        return createErrorResponse(id, -32603, `Leedz MCP request failed: ${err.message}`);
    }

    if (rpcResponse.error) {
        logError(`share_booking RPC error: ${JSON.stringify(rpcResponse.error)}`);
        return createErrorResponse(id, -32603, `createLeed failed: ${rpcResponse.error.message}`);
    }

    // Parse leed result from content[0].text
    let leedResult;
    try {
        leedResult = JSON.parse(rpcResponse.result?.content?.[0]?.text);
    } catch (e) {
        return createErrorResponse(id, -32603, `Unexpected createLeed response format`);
    }
    if (!leedResult?.id) return createErrorResponse(id, -32603, `createLeed returned no ID: ${JSON.stringify(leedResult)}`);

    // Update booking: mark shared
    const updated = await prisma.booking.update({
        where: { id: bookingId },
        data: { leedId: leedResult.id, status: 'shared', shared: true, sharedTo: 'leedz_api', sharedAt: BigInt(Date.now()) }
    });

    logInfo(`share_booking success: leedId=${leedResult.id} bookingId=${bookingId}`);
    return createSuccessResponse(id, safeJson({ leedId: leedResult.id, booking: updated }));
}

async function handleGetClientBookings(id, params) {
    const clientId = params.arguments?.clientId;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing clientId');

    const bookings = await prisma.booking.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' }
    });
    return createSuccessResponse(id, safeJson(bookings));
}

// ==============================================================================
// TOOL CALL ROUTER
// ==============================================================================

async function handleToolCall(id, params) {
    try {
        switch (params.name) {
            case 'get_client':          return await handleGetClient(id, params);
            case 'create_client':       return await handleCreateClient(id, params);
            case 'search_clients':      return await handleSearchClients(id, params);
            case 'update_client':       return await handleUpdateClient(id, params);
            case 'get_ready_drafts':    return await handleGetReadyDrafts(id, params);
            case 'get_stats':           return await handleGetStats(id, params);
            case 'create_factlet':      return await handleCreateFactlet(id, params);
            case 'get_new_factlets':    return await handleGetNewFactlets(id, params);
            case 'delete_factlet':      return await handleDeleteFactlet(id, params);
            case 'get_next_client':     return await handleGetNextClient(id, params);
            case 'get_config':          return await handleGetConfig(id, params);
            case 'update_config':       return await handleUpdateConfig(id, params);
            case 'create_booking':      return await handleCreateBooking(id, params);
            case 'update_booking':      return await handleUpdateBooking(id, params);
            case 'get_bookings':        return await handleGetBookings(id, params);
            case 'get_client_bookings': return await handleGetClientBookings(id, params);
            case 'score_booking':       return await handleScoreBooking(id, params);
            case 'share_booking':       return await handleShareBooking(id, params);
            case 'link_factlet':        return await handleLinkFactlet(id, params);
            case 'get_client_factlets': return await handleGetClientFactlets(id, params);
            case 'score_client':        return await handleScoreClient(id, params);
            default:
                return createErrorResponse(id, -32601, `Unknown tool: ${params.name}`);
        }
    } catch (error) {
        logError(`Tool call error: ${error.message}`);
        return createErrorResponse(id, -32603, `Error: ${error.message}`);
    }
}

// ==============================================================================
// REQUEST PROCESSING
// ==============================================================================

function handlePromptsList(id) {
    logInfo('Handling prompts/list request');
    return {
        jsonrpc: '2.0',
        id: id,
        result: { prompts: [] }
    };
}

function handleResourcesList(id) {
    logInfo('Handling resources/list request');
    return {
        jsonrpc: '2.0',
        id: id,
        result: { resources: [] }
    };
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

// ==============================================================================
// SERVER LIFECYCLE
// ==============================================================================

function startMcpServer() {
    console.error(`[MCP] Starting Pre-Crime MCP server...`);
    console.error(`[MCP] Database: ${dbPath}`);

    logInfo('Starting Pre-Crime MCP server...');
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
