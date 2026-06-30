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

// All logging utilities live in logging.js. Required FIRST (before any code path
// that logs) because requiring it installs the crash-visibility console.error
// tee + uncaught/unhandled handlers and sets up the structured log file.
const { logInfo, logWarn, logError, summarizeToolArgs } = require('./logging');

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

// Runtime/API config (Subproject 10). Optional file; loader returns defaults
// if absent so the server still boots during the transition.
const { PRECRIME_CONFIG, RUNTIME_CONFIG, VALUE_PROP, SCORING, PROMPTS } = require('./runtime');

// DATABASE_URL is now guaranteed to be a `file:` URL pointing at an existing DB
// (the safety block above falls back or exits). dbPath is reused in startup logs.
const dbPath = process.env.DATABASE_URL.replace(/^file:/, '');
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
const { resolveEventDates, normalizeBookingDatesForSave } = dates;
const { createSuccessResponse, createErrorResponse, safeJson } = require('./responses');
console.error(`[MCP] Database: ${dbPath}`);

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

const { TOOL_DEFS } = require('./toolDefs');

function handleToolsList(id) {
    logInfo(`Handling tools/list request (${TOOL_DEFS.length} tools)`);
    return {
        jsonrpc: '2.0',
        id: id,
        result: {
            tools: TOOL_DEFS
        }
    };
}

// ============================================================================
// SCORING / JUDGE CORE -- extracted to factlets.js
// ============================================================================
// The in-process judge: factlet scoring, client/booking target scoring, the LLM
// promote-gate, and demand-term matching. Imported by the SAME names so the ~30
// call sites across this file resolve unchanged. judgeAffected and
// computeNearHotBookings stay here (orchestration) and call these primitives.
const {
    isGenericEmail,
    getFactletStaleDays,
    findLiveFactletsForClient,
    computeClientScore,
    computeBookingTargetScore,
    bookingActionToMode,
    factletMentionsValueProp,
    collectValuePropDemandTerms,
    normalizeDemandText,
    VALUE_PROP_TOKEN_STOPWORDS,
} = require('./factlets');

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
// SOURCE QUEUE -- extracted to sourceQueue.js
// ============================================================================
// next/mark/add/import_source + URL-verify helpers. sourceStore injected; isHttpUrl
// is returned so the save path shares one definition. See sourceQueue.js.
const { isHttpUrl, pipelineNextSource, pipelineMarkSource, pipelineAddSources, pipelineImportSources } = require('./sourceQueue').createSourceQueue({ sourceStore });

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

// normalizeBookingDatesForSave (pure booking-date resolution/validation) lives in
// dates.js next to its primitives. The caller below owns audit logging of failures.

// ============================================================================
// CLIENT SAVE -- extracted to saveClient.js
// ============================================================================
// pipeline.save (gates, dedup, create/update txn, booking upsert, auto-mirror).
// judgeAffected + logSessionEvent are now importable; only isHttpUrl is injected
// (still mcp_server-local until sourceQueue.js). See saveClient.js.
const { pipelineSave } = require('./saveClient').createSaveHandler({ isHttpUrl });

// ============================================================================
// JUDGE -- extracted to judge.js
// ============================================================================
// judgeAffected (the in-process scoring authority) + dismiss/judge_affected
// handlers. Imported by same names so save, the executor, and the share.js
// factory wiring below resolve unchanged. See judge.js.
const { judgeAffected, pipelineDismissBooking, pipelineJudgeAffected } = require('./judge');

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

// ============================================================================
// FACTLET MATCHING -- extracted to factletMatch.js
// ============================================================================
// factlet->client candidate matching + near-hot ranking + event-signal detection.
// safeJsonParse (task-util above) is injected; all else imported. See factletMatch.js.
const { parseClientSourceSummaries, candidateClientIdsForFactlet, computeNearHotBookings, factletHasEventSignal, loadCandidateClients } = require('./factletMatch').createFactletMatch({ safeJsonParse });

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
        let transitions = [];
        if (clientIds.length || bookingIds.length) {
            const result = await judgeAffected({ clientIds, bookingIds, reason: 'judge_affected_task', writeStatus: true });
            transitions = (result && Array.isArray(result.changed)) ? result.changed : [];
        }
        const changed = transitions.length;
        const judgedN = clientIds.length + bookingIds.length;
        // Human-readable: name the actual bucket moves (e.g. "brewing->hot"), or say
        // plainly that nothing re-bucketed. "changed=N" alone was inscrutable.
        const moves = transitions.map(t => `${t.from}->${t.to}`).join(', ');
        const summary = changed
            ? `re-judged ${judgedN} leed(s): ${changed} changed status (${moves})`
            : `re-judged ${judgedN} leed(s): no status changes (still same buckets)`;
        await pipelineCompleteTask('inproc-judge', {
            taskId: task.id, status: 'done',
            output: { clientIds, bookingIds, changed, transitions, summary }
        });
        return { type: task.type, changed, summary };
    }
    if (task.type === 'SHOW_HOT_LEEDZ') {
        const hotCount = await prisma.booking.count({
            where: { status: 'hot', shared: false, startDate: { gte: new Date() } }
        });
        const summary = `${hotCount} hot booking(s) ready to present (query via status / show-hot-leedz)`;
        await pipelineCompleteTask('inproc-showhot', {
            taskId: task.id, status: 'done',
            output: { hotCount, summary }
        });
        return { type: task.type, hotCount, summary };
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
    // One condition, two semantic names so they can diverge later if needed.
    const shouldPlanDiscovery = !workflowState || workflowState.strategy !== 'consume_factlets';
    const shouldPlanClientEnrichment = shouldPlanDiscovery;

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
                // Load the candidate-client set ONCE for the whole factlet loop -- it is
                // identical per factlet and nothing in this loop mutates clients (it only
                // creates APPLY_FACTLET tasks). Was a full Client+Bookings table load PER
                // factlet (the dominant replan cost).
                const candidateClients = orderedFactletIds.length ? await loadCandidateClients() : [];
                for (const factletId of orderedFactletIds) {
                    if (skipF.has(factletId)) continue; // active task exists -- don't double-plan
                    const factlet = await prisma.factlet.findUnique({ where: { id: factletId } });
                    if (!factlet) continue;
                    // Server pre-filters candidate clients (token/name/host overlap):
                    // each APPLY_FACTLET worker gets exactly ONE (factlet, client) pair
                    // = one small LLM call.
                    const matched = await candidateClientIdsForFactlet(factlet, candidateClients);
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
// RECYCLER -- extracted to recycler.js
// ============================================================================
// Stale Task/Factlet cleanup. pruneStaleFactlets is shared by startup + planner
// + the recycler action; imported by same names. See recycler.js.
const { pruneStaleFactlets, pipelineRecycler } = require('./recycler');

// ============================================================================
// SESSION LIFECYCLE -- extracted to sessionLog.js
// ============================================================================
// The accountability layer (events, summary, watchdog, start/report/audit).
// Imported by same names so call sites (save, source ops, judge, router, and
// the find.js factory wiring below) resolve unchanged. See sessionLog.js.
const { logSessionEvent, enforceSessionWatchdog, pipelineStartSession, pipelineReportSession } = require('./sessionLog');

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
