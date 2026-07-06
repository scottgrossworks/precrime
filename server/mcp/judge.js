// ============================================================================
// judge.js -- the in-process Judge orchestration (the hot-leedz maker).
//
// judgeAffected re-scores affected clients/bookings via the factlets.js scoring
// primitives and writes Booking.status; the dismiss/judge_affected handlers wrap
// it. Requires db/responses/factlets/sessionLog -- imported by same names so save,
// the in-process executor, and the share.js factory wiring resolve unchanged.
// ============================================================================

const { prisma } = require('./db');
const { createSuccessResponse, createErrorResponse } = require('./responses');
const { computeBookingTargetScore, computeClientScore } = require('./factlets');
const { logSessionEvent } = require('./sessionLog');

async function judgeAffected({ clientIds, bookingIds, reason, writeStatus, intelOverride }) {
    if (writeStatus === undefined) writeStatus = true;

    const bookingIdSet = new Set(Array.isArray(bookingIds) ? bookingIds.filter(Boolean) : []);
    if (Array.isArray(clientIds) && clientIds.length > 0) {
        const rows = await prisma.booking.findMany({
            where: { clientId: { in: clientIds.filter(Boolean) } },
            select: { id: true }
        });
        for (const r of rows) bookingIdSet.add(r.id);
    }

    const bookings = await prisma.booking.findMany({
        where: { id: { in: Array.from(bookingIdSet) } },
        select: { id: true, status: true, clientId: true }
    });

    const changed = [];
    const errors  = [];
    for (const b of bookings) {
        try {
            const score = await computeBookingTargetScore(b.id);
            if (!score || !score.status) continue;
            if (score.status !== b.status) {
                if (writeStatus) {
                    await prisma.booking.update({ where: { id: b.id }, data: { status: score.status } });
                }
                changed.push({ bookingId: b.id, from: b.status, to: score.status });
            }
        } catch (e) {
            errors.push({ bookingId: b.id, error: e.message });
        }
    }

    // Re-score clients last so dossier/client score reflects post-judge state.
    const clientScores = [];
    let lastScore = null;
    const uniqueClientIds = Array.from(new Set((clientIds || []).filter(Boolean)));
    for (const cid of uniqueClientIds) {
        try {
            const s = await computeClientScore(cid, intelOverride == null ? null : intelOverride);
            clientScores.push({ clientId: cid, score: s });
            lastScore = s;
        } catch (e) {
            errors.push({ clientId: cid, error: e.message });
        }
    }

    return {
        reason: reason || null,
        affectedBookingIds: Array.from(bookingIdSet),
        affectedClientIds:  uniqueClientIds,
        changed,
        clientScores,
        clientScore: lastScore,
        errors,
        wroteStatus: !!writeStatus
    };
}

// dismiss_booking -- the user's permanent SKIP. A hot leed the user rejects must
// never resurface. Mark it acted-on (shared=true, sharedTo="dismissed") and cold:
// the classification cold-gate (booking.shared) keeps it cold through every future
// rescore, and the hot query (shared:false) excludes it. Distinct from a real
// marketplace share by sharedTo="dismissed".
async function pipelineDismissBooking(id, args) {
    // Accept a single bookingId OR a batch bookingIds[]. "Dismiss all X rows" is a natural
    // bulk action; batching it in ONE call is essential -- without it the model, told to
    // dismiss many, fires N sequential saves that mis-write Booking.status and hang the
    // session (the freeze we saw). updateMany dismisses every match at once; ids that don't
    // exist simply don't match (count < requested), no error -- correct for "dismiss all".
    let ids = [];
    if (Array.isArray(args.bookingIds)) ids = args.bookingIds.filter(Boolean);
    else if (args.bookingId) ids = [args.bookingId];
    if (ids.length === 0) {
        return createErrorResponse(id, -32602, 'dismiss_booking requires bookingId (string) or bookingIds (array of Booking.id).');
    }
    const r = await prisma.booking.updateMany({
        where: { id: { in: ids } },
        data: { shared: true, sharedTo: 'dismissed', sharedAt: BigInt(Date.now()), status: 'cold' }
    });
    return createSuccessResponse(id, JSON.stringify({
        dismissed: r.count, requested: ids.length,
        note: `Permanently skipped ${r.count} booking(s). They will not be presented as hot again.`
    }, null, 2));
}

async function pipelineJudgeAffected(id, args) {
    const clientIds  = Array.isArray(args.clientIds)  ? args.clientIds  : [];
    const bookingIds = Array.isArray(args.bookingIds) ? args.bookingIds : [];
    if (clientIds.length === 0 && bookingIds.length === 0) {
        return createErrorResponse(id, -32602, 'judge_affected requires clientIds[] or bookingIds[].');
    }
    const result = await judgeAffected({
        clientIds,
        bookingIds,
        reason:      args.reason || 'judge_affected',
        writeStatus: args.writeStatus !== false
    });
    await logSessionEvent(args.session_id || null, 'judge_affected', {
        changed: result.changed.length,
        clientIds: result.affectedClientIds,
        bookingIds: result.affectedBookingIds
    });
    return createSuccessResponse(id, JSON.stringify(result, null, 2));
}

module.exports = { judgeAffected, pipelineDismissBooking, pipelineJudgeAffected };
