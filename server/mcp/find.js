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

    async function findClients(id, args) {
        const filters = args.filters || {};
        const limit = args.limit || 10;
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

        if (filters.id)     where.id     = filters.id;
        if (filters.status) where.status = filters.status;
        if (filters.trade)  where.trade  = filters.trade;
        if (filters.shared !== undefined) where.shared = !!filters.shared;
        if (filters.future === true) where.startDate = { gte: new Date() };
        if (filters.startDateGte) {
            where.startDate = Object.assign(where.startDate || {}, { gte: new Date(filters.startDateGte) });
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

    return { handleFind, findClients, findBookings, findFactlets, findDrafts };
}

module.exports = { createFindHandlers };
