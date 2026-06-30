// responses.js -- JSON-RPC response builders + helpers, extracted from
// mcp_server.js. Pure formatting utilities (no prisma/config/logging deps):
// success/error envelopes, stdout writer, BigInt-safe stringify, JSON sniff.
'use strict';

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

module.exports = { looksLikeJson, createSuccessResponse, createErrorResponse, sendJsonRpcResponse, safeJson };
