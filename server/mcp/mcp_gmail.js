/**
 * ==============================================================================
 * GMAIL MCP SERVER
 * ==============================================================================
 *
 * Model Context Protocol server for Gmail sending functionality.
 * Combines MCP JSON-RPC protocol with HTTP endpoints for OAuth token management.
 *
 * ARCHITECTURE:
 * 1. MCP Protocol: Receives JSON-RPC messages via stdin from Claude Desktop
 * 2. HTTP Server: Accepts OAuth tokens from Chrome extension
 * 3. Gmail API: Sends emails using stored OAuth token
 *
 * @author Scott Gross
 * @version 1.0.0
 */

const readline = require('readline');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==============================================================================
// CONFIGURATION AND GLOBALS
// ==============================================================================

const CONFIG_PATH = path.resolve(__dirname, 'gmail_mcp_config.json');
console.error(`[Gmail MCP] Loading config from: ${CONFIG_PATH}`);

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.error(`[Gmail MCP] Config loaded successfully`);
} catch (error) {
    console.error(`[Gmail MCP] FATAL: Failed to load config: ${error.message}`);
    process.exit(1);
}

// Token storage - expires after 1 hour
let oauthToken = null;
let tokenExpiry = null;

// Token refresh interval - validates token every 45 minutes
let tokenRefreshInterval = null;

// ==============================================================================
// HTTP SERVER (for Chrome extension communication)
// ==============================================================================

/**
 * Create HTTP server for health checks and OAuth token reception
 */
function createHttpServer() {
    const server = http.createServer((req, res) => {
        // Enable CORS for Chrome extension
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        // Handle preflight requests
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // GET /health - Health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
            handleHealthCheck(req, res);
            return;
        }

        // GET /token - Share token with sibling instances
        if (req.method === 'GET' && req.url === '/token') {
            handleTokenRequest(req, res);
            return;
        }

        // POST /gmail-authorize - Receive OAuth token from extension
        if (req.method === 'POST' && req.url === '/gmail-authorize') {
            handleAuthorize(req, res);
            return;
        }

        // 404 for unknown routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    const port = config.http?.port || 3001;

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[Gmail MCP] Port ${port} already in use — another instance owns the HTTP server. MCP stdio will still work.`);
        } else {
            console.error(`[Gmail MCP] HTTP server error: ${err.message}`);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        console.error(`[Gmail MCP] HTTP server listening on http://127.0.0.1:${port}`);
    });

    return server;
}

/**
 * Handle health check requests
 * Returns server status and token validity
 */
function handleHealthCheck(req, res) {
    const hasValidToken = oauthToken && tokenExpiry && Date.now() < tokenExpiry;

    const response = {
        status: 'ok',
        service: 'gmail-mcp',
        version: '1.0.0',
        tokenValid: hasValidToken,
        tokenExpiry: tokenExpiry ? new Date(tokenExpiry).toISOString() : null
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));

    console.error(`[Gmail MCP] Health check - Token valid: ${hasValidToken}`);
}

/**
 * Handle token request from sibling instances
 * Returns the current OAuth token if valid
 */
function handleTokenRequest(req, res) {
    const hasValidToken = oauthToken && tokenExpiry && Date.now() < tokenExpiry;

    if (!hasValidToken) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid token' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: oauthToken, expiry: tokenExpiry }));
    console.error('[Gmail MCP] Token shared with sibling instance');
}

/**
 * Try to fetch token from the primary instance on port 3001
 * Used when this instance lost the port race
 */
async function fetchTokenFromPrimary() {
    const port = config.http?.port || 3001;
    try {
        const response = await axios.get(`http://127.0.0.1:${port}/token`, { timeout: 2000 });
        if (response.data?.token) {
            oauthToken = response.data.token;
            tokenExpiry = response.data.expiry;
            console.error('[Gmail MCP] Token fetched from primary instance');
            return true;
        }
    } catch (error) {
        console.error(`[Gmail MCP] Could not fetch token from primary: ${error.message}`);
    }
    return false;
}

/**
 * Validate token against Gmail API to check if it's actually still valid
 * Chrome tokens can expire before our local timer thinks they should
 * @returns {Promise<boolean>} True if token is valid
 */
async function validateTokenWithGmail() {
    if (!oauthToken) return false;

    try {
        const response = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
            headers: { 'Authorization': `Bearer ${oauthToken}` },
            timeout: 5000
        });
        return response.status === 200;
    } catch (error) {
        console.error(`[Gmail MCP] Token validation failed: ${error.message}`);
        return false;
    }
}

/**
 * Handle OAuth token authorization from Chrome extension
 * Stores token with 1-hour expiry and sets up periodic validation
 */
function handleAuthorize(req, res) {
    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        try {
            const data = JSON.parse(body);

            if (!data.token) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing token' }));
                return;
            }

            // Store token with 1-hour expiry
            oauthToken = data.token;
            tokenExpiry = Date.now() + (60 * 60 * 1000); // 1 hour from now

            // Validate token immediately to confirm it works
            const isValid = await validateTokenWithGmail();
            if (!isValid) {
                oauthToken = null;
                tokenExpiry = null;
                console.error('[Gmail MCP] Token received but failed Gmail API validation');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Token failed Gmail API validation. Try revoking and re-authorizing.' }));
                return;
            }

            console.error(`[Gmail MCP] OAuth token received and validated, expires at ${new Date(tokenExpiry).toISOString()}`);

            // Set up periodic token validation (every 45 minutes)
            // This catches early expiration from Chrome/Google side
            if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
            tokenRefreshInterval = setInterval(async () => {
                if (!oauthToken) {
                    clearInterval(tokenRefreshInterval);
                    return;
                }
                const stillValid = await validateTokenWithGmail();
                if (!stillValid) {
                    console.error('[Gmail MCP] Token expired during periodic check, clearing token');
                    oauthToken = null;
                    tokenExpiry = null;
                    clearInterval(tokenRefreshInterval);
                }
            }, 45 * 60 * 1000); // Check every 45 minutes

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                expiresAt: new Date(tokenExpiry).toISOString(),
                validated: true
            }));

        } catch (error) {
            console.error(`[Gmail MCP] Error parsing authorize request: ${error.message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
    });
}

// ==============================================================================
// MCP PROTOCOL HANDLERS
// ==============================================================================

/**
 * Handle MCP initialization request
 */
function handleInitialize(id) {
    console.error('[Gmail MCP] Handling initialize request');

    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            protocolVersion: "2025-06-18",
            capabilities: {
                tools: {}
            },
            serverInfo: {
                name: "gmail-mcp",
                version: "1.0.0"
            }
        }
    };
}

/**
 * Handle tools list request
 */
function handleToolsList(id) {
    console.error('[Gmail MCP] Handling tools/list request');

    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            tools: [
                {
                    name: 'gmail_send',
                    description: 'Send email via Gmail OR save to drafts folder. IMPORTANT: Set draft=true to save email to drafts instead of sending (allows user to manually review, attach files, and send). Set draft=false or omit to send immediately. Ask user preference if unclear. Supports plain text and file attachments.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            to: {
                                type: 'string',
                                description: 'Recipient email address'
                            },
                            subject: {
                                type: 'string',
                                description: 'Email subject line'
                            },
                            body: {
                                type: 'string',
                                description: 'Email body (plain text)'
                            },
                            cc: {
                                type: 'string',
                                description: 'CC recipients (comma-separated)'
                            },
                            bcc: {
                                type: 'string',
                                description: 'BCC recipients (comma-separated)'
                            },
                            draft: {
                                type: 'boolean',
                                description: 'If true, save to drafts folder instead of sending immediately. User can then review, attach files, and send manually from Gmail.'
                            },
                            attachments: {
                                type: 'array',
                                description: 'Optional file attachments. Each attachment must have: filename (string), content (base64 string), contentType (MIME type like "application/pdf" or "image/png")',
                                items: {
                                    type: 'object',
                                    properties: {
                                        filename: {
                                            type: 'string',
                                            description: 'Filename with extension'
                                        },
                                        content: {
                                            type: 'string',
                                            description: 'Base64 encoded file content'
                                        },
                                        contentType: {
                                            type: 'string',
                                            description: 'MIME type (application/pdf, image/png, image/jpeg, etc.)'
                                        }
                                    },
                                    required: ['filename', 'content', 'contentType']
                                }
                            }
                        },
                        required: ['to', 'subject', 'body']
                    }
                }
            ]
        }
    };
}

/**
 * Handle tool call request
 * Sends email via Gmail API using stored OAuth token
 */
async function handleToolCall(id, params) {
    console.error('[Gmail MCP] Handling tool call');

    // Check if we have a valid token, try fetching from primary if not
    let hasValidToken = oauthToken && tokenExpiry && Date.now() < tokenExpiry;

    if (!hasValidToken) {
        console.error('[Gmail MCP] No local token, attempting to fetch from primary instance...');
        const fetched = await fetchTokenFromPrimary();
        hasValidToken = fetched && oauthToken && tokenExpiry && Date.now() < tokenExpiry;
    }

    if (!hasValidToken) {
        return createErrorResponse(id, -32001, 'No valid OAuth token. Please authorize from Chrome extension first.');
    }

    // Extract email parameters from tool call
    const args = params.arguments || {};
    const { to, subject, body, cc, bcc, draft, attachments } = args;

    if (!to || !subject || !body) {
        return createErrorResponse(id, -32602, 'Missing required parameters: to, subject, body');
    }

    try {
        const isDraft = draft === true;
        const action = isDraft ? 'Creating draft' : 'Sending email';
        console.error(`[Gmail MCP] ${action} to ${to}${attachments ? ` with ${attachments.length} attachment(s)` : ''}`);

        // Build MIME email message
        const mimeMessage = buildMimeMessage(to, subject, body, cc, bcc, attachments);

        // Send via Gmail API or create draft
        const result = await sendGmailMessage(mimeMessage, isDraft);

        const successMsg = isDraft
            ? `Draft created successfully for ${to}. Draft ID: ${result}`
            : `Email sent successfully to ${to}. Message ID: ${result}`;

        console.error(`[Gmail MCP] ${successMsg}`);

        return createSuccessResponse(id, successMsg);

    } catch (error) {
        console.error(`[Gmail MCP] Failed to send email: ${error.message}`);

        // If 401 Unauthorized, the token has expired early - clear it and give a clear message
        if (error.response && error.response.status === 401) {
            console.error('[Gmail MCP] Token rejected by Gmail API (401), clearing stored token');
            oauthToken = null;
            tokenExpiry = null;
            if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
            return createErrorResponse(id, -32001, 'OAuth token expired. Please re-authorize from Chrome extension (click Enable Gmail or Refresh Gmail).');
        }

        return createErrorResponse(id, -32603, `Failed to send email: ${error.message}`);
    }
}

/**
 * Generate unique MIME boundary string
 * @returns {string} Unique boundary identifier
 */
function generateBoundary() {
    return `boundary_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Build RFC 2822 MIME email message
 * Supports plain text emails and multipart messages with attachments
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body (plain text)
 * @param {string} cc - CC recipients (optional)
 * @param {string} bcc - BCC recipients (optional)
 * @param {Array} attachments - File attachments (optional)
 * @returns {string} MIME formatted email message
 */
function buildMimeMessage(to, subject, body, cc, bcc, attachments) {
    const lines = [];

    // Required headers
    lines.push(`To: ${to}`);
    lines.push(`Subject: ${subject}`);

    // Optional headers
    if (cc) lines.push(`Cc: ${cc}`);
    if (bcc) lines.push(`Bcc: ${bcc}`);

    // MIME version
    lines.push('MIME-Version: 1.0');

    // If no attachments, use simple text/plain format
    if (!attachments || attachments.length === 0) {
        lines.push('Content-Type: text/plain; charset=utf-8');
        lines.push('');
        lines.push(body);
        return lines.join('\r\n');
    }

    // With attachments, use multipart/mixed format
    const boundary = generateBoundary();
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');

    // Part 1: Text body
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(body);
    lines.push('');

    // Part 2+: Each attachment
    for (const attachment of attachments) {
        lines.push(`--${boundary}`);
        lines.push(`Content-Type: ${attachment.contentType}; name="${attachment.filename}"`);
        lines.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push('');
        lines.push(attachment.content);
        lines.push('');
    }

    // End boundary
    lines.push(`--${boundary}--`);

    return lines.join('\r\n');
}

/**
 * Send email via Gmail API or create draft
 * @param {string} mimeMessage - RFC 2822 formatted message
 * @param {boolean} isDraft - If true, create draft instead of sending
 * @returns {Promise<string>} Gmail message ID or draft ID
 */
async function sendGmailMessage(mimeMessage, isDraft = false) {
    // Base64url encode the message
    const encodedMessage = Buffer.from(mimeMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    // Choose endpoint and payload based on draft flag
    const endpoint = isDraft
        ? 'https://gmail.googleapis.com/gmail/v1/users/me/drafts'
        : 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

    const payload = isDraft
        ? { message: { raw: encodedMessage } }
        : { raw: encodedMessage };

    // Call Gmail API
    const response = await axios.post(
        endpoint,
        payload,
        {
            headers: {
                'Authorization': `Bearer ${oauthToken}`,
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data.id;
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
 * Route JSON-RPC request to appropriate handler
 */
async function processJsonRpcRequest(request) {
    const { id, method, params } = request;

    switch (method) {
        case 'initialize':
            return handleInitialize(id);

        case 'tools/list':
            return handleToolsList(id);

        case 'tools/call':
            return await handleToolCall(id, params);

        case 'notifications/initialized':
            return null; // No response needed

        default:
            console.error(`[Gmail MCP] Unknown method: ${method}`);
            return createErrorResponse(id, -32601, 'Method not found');
    }
}

/**
 * Send JSON-RPC response to stdout
 */
function sendJsonRpcResponse(response) {
    if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
    }
}

/**
 * Handle incoming input line from stdin
 */
async function handleInputLine(line) {
    const trimmed = line.trim();

    // Ignore empty lines and non-JSON
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
        return;
    }

    try {
        const request = JSON.parse(trimmed);
        const response = await processJsonRpcRequest(request);
        sendJsonRpcResponse(response);
    } catch (error) {
        console.error(`[Gmail MCP] Error processing request: ${error.message}`);
        sendJsonRpcResponse(createErrorResponse('error', -32603, 'Internal error'));
    }
}

// ==============================================================================
// SERVER LIFECYCLE
// ==============================================================================

/**
 * Start the Gmail MCP server
 */
function startServer() {
    console.error('[Gmail MCP] Starting Gmail MCP server...');

    // Start HTTP server for extension communication
    createHttpServer();

    // Set up readline for MCP protocol (stdin/stdout)
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', handleInputLine);

    process.on('SIGINT', () => {
        console.error('[Gmail MCP] Shutting down...');
        rl.close();
        process.exit(0);
    });

    console.error('[Gmail MCP] Server ready');
}

// ==============================================================================
// SERVER STARTUP
// ==============================================================================

startServer();
