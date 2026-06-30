// ============================================================================
// logging.js -- all logging utilities for the MCP server.
//
// Self-contained: depends only on Node builtins (fs/path). It computes its own
// project root and reads its own mcp_server_config.json, so it has NO dependency
// on any other PRECRIME module and can be required FIRST in mcp_server.js -- the
// earlier it loads, the earlier the crash-visibility tee is installed.
//
// Requiring this module has load-time SIDE EFFECTS (by design):
//   - tees console.error to data/mcp.log + installs uncaught/unhandled handlers
//   - ensures the structured log file directory exists
// It exports the structured loggers + the tool-arg summarizer.
// ============================================================================

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

// Internal config (logging, MCP metadata)
const CONFIG_PATH = path.resolve(__dirname, 'mcp_server_config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (error) {
    console.error(`[MCP] FATAL: mcp_server_config.json not found: ${error.message}`);
    process.exit(1);
}

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

// Compact, secret-redacting summary of tool-call arguments for log lines.
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

module.exports = { logDebug, logInfo, logWarn, logError, summarizeToolArgs };
