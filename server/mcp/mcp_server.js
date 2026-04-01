/**
 * BLOOMLEEDZ - MCP SERVER (Direct Prisma)
 *
 * JSON-RPC server for Claude Desktop. Queries bloomleedz.sqlite
 * directly via PrismaClient. No HTTP server required.
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
                            llmMaxTokens: { type: 'number' }
                        }
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
