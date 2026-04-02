/**
 * PRE-CRIME — MCP SERVER (Direct Prisma)
 *
 * JSON-RPC server for Claude Desktop. Queries deployment SQLite
 * directly via PrismaClient. No HTTP server required.
 *
 * 15 tools: 11 original (client/factlet/config) + 4 booking tools
 *
 * @author Scott Gross
 * @version 2.0.0
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

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
                    name: 'search_clients',
                    description: 'Search clients by name, email, company, or keyword. Also filter by draftStatus.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            search: { type: 'string', description: 'Search across name, email, company' },
                            name: { type: 'string', description: 'Filter by name (partial match)' },
                            email: { type: 'string', description: 'Filter by email (exact match)' },
                            company: { type: 'string', description: 'Filter by company (partial match)' },
                            draftStatus: { type: 'string', description: 'Filter by draft status: brewing, ready, sent' },
                            limit: { type: 'number', description: 'Max results (default 50)' }
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
                            limit: { type: 'number', description: 'Max results (default 10)' }
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
                    description: 'Get Bookings, optionally filtered by status and/or trade',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            status: { type: 'string', description: 'Filter by status: new, leed_ready, taken, shared, expired' },
                            trade: { type: 'string', description: 'Filter by trade name' },
                            limit: { type: 'number', description: 'Max results (default 50)' }
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
                }
            ]
        }
    };
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

// Reference: prisma_sqlite_db.js getClients() lines 116-196
async function handleSearchClients(id, params) {
    const args = params.arguments || {};
    let where = {};
    const limit = args.limit || 50;

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
    }

    if (args.draftStatus) where.draftStatus = args.draftStatus;

    const clients = await prisma.client.findMany({ where, take: limit });
    return createSuccessResponse(id, JSON.stringify(clients, null, 2));
}

// Reference: prisma_sqlite_db.js updateClient() lines 198-238
async function handleUpdateClient(id, params) {
    const args = params.arguments || {};
    const clientId = args.id;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing client ID');

    const allowedFields = [
        'name', 'email', 'phone', 'company', 'website', 'clientNotes',
        'dossier', 'targetUrls', 'draft', 'draftStatus', 'warmthScore', 'lastEnriched', 'lastQueueCheck'
    ];

    const data = {};
    for (const field of allowedFields) {
        if (args[field] !== undefined) {
            if (field === 'lastEnriched' || field === 'lastQueueCheck') {
                data[field] = new Date(args[field]);
            } else if (field === 'warmthScore') {
                data[field] = parseFloat(args[field]);
            } else {
                data[field] = args[field];
            }
        }
    }

    const updated = await prisma.client.update({ where: { id: clientId }, data });
    return createSuccessResponse(id, JSON.stringify(updated, null, 2));
}

async function handleGetReadyDrafts(id, params) {
    const limit = params.arguments?.limit || 10;
    const clients = await prisma.client.findMany({
        where: { draftStatus: 'ready' },
        orderBy: { warmthScore: 'desc' },
        take: limit
    });
    return createSuccessResponse(id, JSON.stringify(clients, null, 2));
}

// Reference: prisma_sqlite_db.js getSystemStats() lines 624-641
async function handleGetStats(id, params) {
    const [totalClients, totalFactlets, brewing, ready, sent] = await Promise.all([
        prisma.client.count(),
        prisma.factlet.count(),
        prisma.client.count({ where: { draftStatus: 'brewing' } }),
        prisma.client.count({ where: { draftStatus: 'ready' } }),
        prisma.client.count({ where: { draftStatus: 'sent' } })
    ]);
    return createSuccessResponse(id, JSON.stringify({
        totalClients, totalFactlets,
        drafts: { brewing, ready, sent }
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
    return createSuccessResponse(id, JSON.stringify(booking, null, 2));
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

    const booking = await prisma.booking.update({ where: { id: args.id }, data });
    return createSuccessResponse(id, JSON.stringify(booking, null, 2));
}

async function handleGetBookings(id, params) {
    const args = params.arguments || {};
    const where = {};
    if (args.status) where.status = args.status;
    if (args.trade)  where.trade  = args.trade;
    const limit = args.limit || 50;

    const bookings = await prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { client: true }
    });
    return createSuccessResponse(id, JSON.stringify(bookings, null, 2));
}

async function handleGetClientBookings(id, params) {
    const clientId = params.arguments?.clientId;
    if (!clientId) return createErrorResponse(id, -32602, 'Missing clientId');

    const bookings = await prisma.booking.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' }
    });
    return createSuccessResponse(id, JSON.stringify(bookings, null, 2));
}

// ==============================================================================
// TOOL CALL ROUTER
// ==============================================================================

async function handleToolCall(id, params) {
    try {
        switch (params.name) {
            case 'get_client':          return await handleGetClient(id, params);
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
