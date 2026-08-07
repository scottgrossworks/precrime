// ============================================================================
// find.js -- read-only query handlers for the `find` MCP tool.
//
// Extracted from mcp_server.js. These are pure query/serialize handlers over
// Prisma; they hold no module state. Five mcp_server-local helpers are injected
// (logging, arg-summary, the save-or-terminate watchdog, factlet staleness, and
// live-factlet lookup) so this module stays decoupled from the server graph.
//
// Usage:
//   const { handleFind } = require('./find').createFindHandlers({
//     logInfo, summarizeToolArgs, enforceSessionWatchdog,
//     getFactletStaleDays, findLiveFactletsForClient,
//   });
// ============================================================================

const { prisma } = require('./db');
const { createErrorResponse, createSuccessResponse, safeJson } = require('./responses');

function createFindHandlers(deps) {
    const {
        logInfo,
        summarizeToolArgs,
        enforceSessionWatchdog,
        getFactletStaleDays,
        findLiveFactletsForClient,
    } = deps;

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

    // TOKEN CAPS (2026-08-06): a find result lands in an LLM session transcript and
    // is RE-BILLED on every later turn of that session. Uncapped limits + full
    // unclipped rows (5-20KB dossiers) let one call pull 100k+ tokens into context.
    // Every limit is ceilinged at 50 and the fat text fields on full (summary:false)
    // rows are tail/head-clipped. dossierLimit=0 disables the dossier clip (same
    // contract as the next/save paths' clipClientForResponse).
    const capLimit = (v, dflt) => Math.min(Math.max(1, parseInt(v, 10) || dflt), 50);
    function clipFullClient(c, dossierLimit) {
        if (!c || typeof c !== 'object') return c;
        const dLim = (dossierLimit === undefined || dossierLimit === null) ? 2000 : Number(dossierLimit);
        if (dLim > 0 && typeof c.dossier === 'string' && c.dossier.length > dLim) c.dossier = '…' + c.dossier.slice(-dLim);
        if (typeof c.draft === 'string' && c.draft.length > 1500) c.draft = c.draft.slice(0, 1500) + '…';
        if (typeof c.clientNotes === 'string' && c.clientNotes.length > 600) c.clientNotes = c.clientNotes.slice(0, 600) + '…';
        return c;
    }

    // Shortest distance in days between two (month,day) pairs, ignoring year and
    // wrapping the year boundary (Dec 30 vs Jan 5 = 6, not 360). Reference year
    // 2001 (non-leap) sidesteps Feb 29 for every date except Feb 29 itself, which
    // Date() silently rolls into Mar 1 -- an acceptable one-day skew once every 4
    // years for a "within N days" proximity filter, not worth the added complexity.
    function dayOfYearUTC(mo, day) {
        return Math.round((Date.UTC(2001, mo - 1, day) - Date.UTC(2001, 0, 1)) / 86400000) + 1;
    }
    function cyclicMonthDayDistance(mo1, day1, mo2, day2) {
        const diff = Math.abs(dayOfYearUTC(mo1, day1) - dayOfYearUTC(mo2, day2));
        return Math.min(diff, 365 - diff);
    }

    async function findClients(id, args) {
        const filters = args.filters || {};
        const limit = capLimit(args.limit, 10);
        const useSummary = args.summary !== false;
        let where = {};

        if (filters.id) {
            where.id = filters.id;
        } else if (filters.search) {
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

        // Client.source is the PROVENANCE key -- and the only DURABLE one: it is set
        // once at create and is NOT in pipelineSave's updatable clientFields, so no
        // later worker can overwrite it (segment CAN be overwritten). Filtering on it
        // is how a whole import cohort is recovered later, e.g.
        // find({action:"clients", filters:{source:"square:"}}) -> every Square customer.
        // Applied outside the id/search/else chain so it composes with any of them.
        if (filters.source) where.source = { contains: filters.source };

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
                warmthScore: true, draftStatus: true, lastEnriched: true, source: true,
                // WHAT THE CLIENT IS WORTH. Without this the summary answered "who is
                // this?" but never "what have they paid us / what are we chasing?" --
                // a client looked up by name showed no money at all. Newest 5 bookings,
                // four fields each: the money question answered in the same call.
                bookings: {
                    select: { id: true, title: true, status: true, startDate: true, totalAmount: true },
                    orderBy: { startDate: 'desc' },
                    take: 5
                }
            };
        }

        const clients = await prisma.client.findMany(queryOpts);
        if (!useSummary) clients.forEach(c => clipFullClient(c, args.dossierLimit));
        return createSuccessResponse(id, JSON.stringify(clients));
    }

    async function findBookings(id, args) {
        const filters = args.filters || {};
        const limit = capLimit(args.limit, 20);
        const where = {};

        if (filters.id)     where.id     = filters.id;
        if (filters.status) where.status = filters.status;
        if (filters.trade)  where.trade  = filters.trade;
        // Provenance, same purpose as the Client filter above: "square:payment:" recovers
        // every imported payment record.
        if (filters.source) where.source = { contains: filters.source };
        if (filters.shared !== undefined) where.shared = !!filters.shared;
        if (filters.future === true) where.startDate = { gte: new Date() };
        if (filters.startDateGte) {
            where.startDate = Object.assign(where.startDate || {}, { gte: new Date(filters.startDateGte) });
        }

        // CALENDAR FILTERS (2026-08-07): "show me every Sept/Oct booking, any year"
        // and "what anniversaries are coming up" were UNANSWERABLE before this --
        // Prisma has no month/day-of-year predicate, so there was no tool call that
        // could satisfy the question. The model, given no way to answer, fabricated
        // three different wrong tables rather than saying so. Resolved in JS over a
        // lean {id,startDate} scan (cheap even at thousands of rows) so accuracy
        // never depends on the LLM doing date arithmetic in its head.
        //   monthIn: [9,10]              -- literal calendar month match, any year
        //   anniversaryWithinDays: N     -- within N days of TODAY's month/day,
        //                                    cyclic (wraps Dec->Jan), sorted soonest first
        // Not combinable with filters.id (a single-record lookup); calendar filters
        // are list queries by nature.
        if (!filters.id && ((Array.isArray(filters.monthIn) && filters.monthIn.length) || filters.anniversaryWithinDays != null)) {
            const leanWhere = { ...where, startDate: { not: null } };
            const rows = await prisma.booking.findMany({ where: leanWhere, select: { id: true, startDate: true } });
            const wantMonths = new Set((filters.monthIn || []).map(m => parseInt(m, 10)));
            const withinDays = filters.anniversaryWithinDays != null ? Number(filters.anniversaryWithinDays) : null;
            const today = new Date();
            const todayMo = today.getUTCMonth() + 1, todayDay = today.getUTCDate();
            const scored = [];
            for (const r of rows) {
                const d = new Date(r.startDate);
                const mo = d.getUTCMonth() + 1, day = d.getUTCDate();
                const dist = cyclicMonthDayDistance(mo, day, todayMo, todayDay);
                const hit = (wantMonths.size && wantMonths.has(mo)) || (withinDays != null && dist <= withinDays);
                if (hit) scored.push({ id: r.id, mo, day, dist });
            }
            // Anniversary mode: soonest first. Plain month mode: calendar order
            // (month, then day) so a "Sept/Oct" list reads chronologically.
            scored.sort((a, b) => withinDays != null ? (a.dist - b.dist) : (a.mo - b.mo || a.day - b.day));
            const totalMatched = scored.length;
            const orderedIds = scored.slice(0, limit).map(s => s.id);
            where.id = { in: orderedIds };
            const calRows = await prisma.booking.findMany({
                where,
                include: { client: { select: { id: true, name: true, company: true, email: true, phone: true, segment: true } } }
            });
            const byId = new Map(calRows.map(r => [r.id, r]));
            const ordered = orderedIds.map(i => byId.get(i)).filter(Boolean);
            // Truncation is now VISIBLE instead of silent (yesterday's limit cap
            // could otherwise hide it exactly the way it did here): append one
            // marker row rather than changing the response from array to object,
            // so every existing caller that iterates a bare array is unaffected.
            if (totalMatched > ordered.length) {
                ordered.push({ _truncated: true, totalMatched, returned: ordered.length,
                    note: `${totalMatched} total match(es); showing the ${ordered.length} ${withinDays != null ? 'soonest' : 'first'}. Raise limit or narrow the filter to see the rest.` });
            }
            return createSuccessResponse(id, safeJson(ordered));
        }

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

        if (filters.id) {
            const factlet = await prisma.factlet.findUnique({ where: { id: filters.id } });
            return createSuccessResponse(id, JSON.stringify(factlet ? [factlet] : [], null, 2));
        }

        // If clientId is provided, return live Factlets relevant to that client via
        // cheap content/source overlap on name / company / website host. No join
        // table -- there is no longer a per-link "applied" pointer to read.
        // List responses are capped + content-clipped: factlet content can be 3KB
        // each and these lists were previously unbounded (no take at all).
        const clipF = f => ({ ...f, content: String(f.content || '').slice(0, 300) });
        if (filters.clientId) {
            const client = await prisma.client.findUnique({ where: { id: filters.clientId } });
            if (!client) {
                return createErrorResponse(id, -32602, `findFactlets: no client with id "${filters.clientId}".`);
            }
            const staleDays = await getFactletStaleDays();
            const factlets = await findLiveFactletsForClient(client, staleDays);
            return createSuccessResponse(id, JSON.stringify(factlets.slice(0, capLimit(args.limit, 25)).map(clipF)));
        }

        // Otherwise, global factlet query (queue checking)
        if (!filters.sinceTimestamp) {
            return createErrorResponse(id, -32602, 'factlets action requires filters.sinceTimestamp or filters.clientId.');
        }

        const factlets = await prisma.factlet.findMany({
            where: { createdAt: { gt: new Date(filters.sinceTimestamp) } },
            orderBy: { createdAt: 'asc' },
            take: capLimit(args.limit, 25)
        });
        return createSuccessResponse(id, JSON.stringify(factlets.map(clipF)));
    }

    async function findDrafts(id, args) {
        const limit = capLimit(args.limit, 10);
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
        if (!useSummary) clients.forEach(c => clipFullClient(c, args.dossierLimit));
        return createSuccessResponse(id, JSON.stringify(clients));
    }

    return { handleFind, findClients, findBookings, findFactlets, findDrafts };
}

module.exports = { createFindHandlers };
