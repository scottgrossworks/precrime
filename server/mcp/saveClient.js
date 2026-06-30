// ============================================================================
// saveClient.js -- the client SAVE path (pipeline.save).
//
// Validation gates, dedup, the create/update transaction, booking upsert,
// auto-mirror, and the legacy judge invocation. Requires db/responses/verify/
// factlets/dates/judge/sessionLog by same names; isHttpUrl is injected (its home
// is the source-queue module). DI factory keeps it decoupled.
//
//   const { pipelineSave } = require("./saveClient").createSaveHandler({ isHttpUrl });
// ============================================================================

const { prisma } = require('./db');
const { createSuccessResponse, createErrorResponse } = require('./responses');
const verify = require('./verify');
const { isGenericEmail } = require('./factlets');
const { normalizeBookingDatesForSave } = require('./dates');
const { judgeAffected } = require('./judge');
const { logSessionEvent } = require('./sessionLog');

function createSaveHandler(deps) {
    const { isHttpUrl } = deps;

// Seed a stub dossier at Client creation from whatever we already know, so a new
// Client is never an empty shell that can't be matched (the factlet matcher reads the
// dossier) or enriched (enrichment-agent appends to it). If there is genuinely nothing
// to say, the client is a weak lead and stays dormant by design — but we never DISCARD
// content we had at creation time.
function buildStubDossier(patch) {
    const who = patch.name || patch.company || 'Unknown client';
    const facts = [];
    if (patch.company && patch.company !== who) facts.push(patch.company);
    if (patch.segment)     facts.push(`segment: ${patch.segment}`);
    if (patch.website)     facts.push(patch.website);
    if (patch.email)       facts.push(patch.email);
    if (patch.clientNotes) facts.push(patch.clientNotes);
    const today = new Date().toISOString().slice(0, 10);
    const src = patch.source ? ` Source: ${patch.source}.` : '';
    return `[PERMANENT] ${who}${facts.length ? ' — ' + facts.join('; ') : ''}.` +
        `\n[${today}] [background] Client created from initial discovery.${src}`;
}

async function pipelineSave(id, clientId, patch, sessionId, judge, factletId) {
    // judge defaults to true for legacy callers. New Task-based workers MUST
    // pass judge:false and let the Planner schedule a JUDGE_AFFECTED Task.
    if (judge === undefined) judge = true;
    let existing = null;
    let isCreate = false;

    // Validate sessionId if provided — fail fast on a forged id rather than
    // accepting it silently. The model cannot invent a session_id; it must
    // come from a prior start_session call.
    if (sessionId) {
        const sess = await prisma.session.findUnique({ where: { id: sessionId } });
        if (!sess) {
            // Invalid session_id — ignore it, proceed without session logging
            sessionId = null;
        } else if (sess.status !== 'active') {
            // Session already closed — ignore it, proceed without session logging
            sessionId = null;
        }
    }

    // Log the attempt before any validation. report_session uses save_attempt
    // events to distinguish "agent never tried" from "agent tried, got rejected".
    await logSessionEvent(sessionId, 'save_attempt', {
        hasId: !!clientId,
        hasName: !!(patch && patch.name),
        hasCompany: !!(patch && patch.company),
        patchKeys: patch ? Object.keys(patch) : []
    });

    // Empty patches are HARD-REJECTED. A successful no-op gives the agent no
    // signal it's looping uselessly; we want a real error so the procedure
    // forces it to either fill the patch or skip save() entirely.
    if (!patch || Object.keys(patch).length === 0) {
        await logSessionEvent(sessionId, 'save_rejected_empty_patch', { hasId: !!clientId });
        return createErrorResponse(id, -32602,
            'Empty patch rejected. pipeline.save requires patch.name or patch.company. ' +
            'If the scrape yielded zero contacts, do NOT call save -- call pipeline.mark_source({url, clientsFound: 0}) and move on.'
        );
    }

    // HARD GATE: generic email. sales@, info@, contact@, etc. are never a valid
    // direct contact. The system refuses to save them. The agent must run
    // skills/client-finder.md to find the decision-maker's direct email first.
    // The save is rejected outright so the agent cannot "claim" the client with
    // a junk email and move on.
    if (patch.email && typeof patch.email === 'string' && patch.email.includes('@') && isGenericEmail(patch.email)) {
        await logSessionEvent(sessionId, 'save_rejected_generic_email', { email: patch.email, name: patch.name, company: patch.company });
        return createErrorResponse(id, -32602,
            `Generic email rejected: ${patch.email}. Generic inboxes (sales@, info@, contact@, etc.) are never a valid direct contact. ` +
            `Run skills/client-finder.md to find the decision-maker's direct email, then retry save. ` +
            `OR save without the email field to capture the client shell (company + source) for later enrichment.`
        );
    }

    // ANTI-HALLUCINATION (verify.js): when the worker cites the source factlet,
    // strip any structured field (email / phone / zip) that does NOT appear
    // verbatim in that factlet's text. The worker cannot fabricate contact data
    // to clear the hot-leed gate; only real, source-backed values are written.
    if (factletId) {
        try {
            const f = await prisma.factlet.findUnique({ where: { id: factletId }, select: { content: true } });
            const { patch: filtered, dropped } = verify.filterVerifiedPatch(patch, (f && f.content) || '');
            if (dropped.length) {
                await logSessionEvent(sessionId, 'save_dropped_unverified', { factletId, dropped });
                patch = filtered;
            }
        } catch (_) { /* factlet gone -- fall through with patch unchanged */ }
    }

    // Also reject the "all blank values" case.
    const hasUsableValue = Object.entries(patch).some(([_k, v]) => {
        if (v === null || v === undefined) return false;
        if (typeof v === 'string' && v.trim() === '') return false;
        return true;
    });
    if (!hasUsableValue) {
        await logSessionEvent(sessionId, 'save_rejected_blank_values', { patchKeys: Object.keys(patch) });
        return createErrorResponse(id, -32602,
            'Patch had keys but all values were null/empty. pipeline.save requires at least one non-empty field. Proceed to mark_source.'
        );
    }

    const badIdentityValues = ['name', 'company'].filter((field) => {
        const v = patch[field];
        if (typeof v !== 'string') return false;
        const s = v.trim().toLowerCase();
        return (
            /^<[^>]+>$/.test(s) ||
            ['unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'company', 'name', 'vendor', 'business'].includes(s)
        );
    });
    if (badIdentityValues.length > 0) {
        await logSessionEvent(sessionId, 'save_rejected_placeholder_identity', {
            fields: badIdentityValues,
            attemptedPatch: patch
        });
        return createErrorResponse(id, -32602,
            `Patch has placeholder identity field(s): ${badIdentityValues.join(', ')}. ` +
            'Save a real person or company, or skip save and mark_source with a reason.'
        );
    }

    if (!clientId && !patch.name && !patch.company && patch.content && patch.source) {
        const sourceUrl = patch.sourceUrl || patch.url || (isHttpUrl(patch.source) ? patch.source : null);
        // No live re-fetch on save. Proof is captured ONCE when a worker first reads
        // the page (scrape path / resolve_dates) and trusted thereafter. The old
        // save-time verifyEvidenceUrl rejected RFP/PDF/aggregator pages and blocked
        // promotion (the leed-ready Catch-22). See DOCS/CLASSIFICATION.md.

        const factlet = await prisma.factlet.create({
            data: { content: patch.content, source: sourceUrl || patch.source }
        });
        await logSessionEvent(sessionId, 'save_success', {
            factletId: factlet.id,
            name: 'factlet',
            isCreate: true,
            score: null
        });
        return createSuccessResponse(id, JSON.stringify({
            saved: true,
            factletId: factlet.id,
            session_id: sessionId || null
        }, null, 2));
    }

    // Live-URL re-verification on save removed (the leed-ready Catch-22): proof is
    // captured once at fetch (scrape / resolve_dates) and trusted thereafter. See
    // DOCS/CLASSIFICATION.md. Non-network date normalization below stays.

    const dateFailures = await normalizeBookingDatesForSave(patch);
    if (dateFailures.length > 0) {
        await logSessionEvent(sessionId, 'save_failed', {
            error: 'bad_booking_date',
            name: patch.company || patch.name || null,
            source: patch.source || patch.sourceUrl || patch.url || null,
            failures: dateFailures
        });
        return createErrorResponse(id, -32602,
            'Booking date rejected before save. The LLM must provide raw source date text and let MCP resolve st/et. ' +
            JSON.stringify({ failures: dateFailures }, null, 2)
        );
    }

    if (clientId) {
        existing = await prisma.client.findUnique({ where: { id: clientId } });
        if (!existing) {
            await logSessionEvent(sessionId, 'save_failed', { id: clientId, error: 'client_not_found' });
            return createErrorResponse(id, -32602, `Client not found: ${clientId}`);
        }
        // HARD GATE: a Client at draftStatus="sent" has already received outreach.
        // Refuse to flip back to "ready" / "brewing" / null without explicit
        // patch.force=true. Prevents an ENRICH_CLIENT worker from resurrecting a
        // sent client and causing a duplicate email on the next outreach pass.
        // To intentionally re-engage, pass { force: true } in the same save.
        if (existing.draftStatus === 'sent'
            && patch.draftStatus !== undefined
            && patch.draftStatus !== 'sent'
            && patch.force !== true) {
            await logSessionEvent(sessionId, 'save_rejected_sent_resurrection', {
                clientId,
                attemptedDraftStatus: patch.draftStatus
            });
            return createErrorResponse(id, -32602,
                `Client ${clientId} is draftStatus="sent" (already emailed). ` +
                `Refusing to set draftStatus="${patch.draftStatus}" without patch.force=true. ` +
                `Pass { force: true } in the save call to deliberately re-engage.`
            );
        }
    } else {
        // No id = create new client. Requires patch.name OR patch.company.
        // Company-only records are allowed but will score low (contactGate=false)
        // until enrichment finds a real person name.
        if (!patch.name && !patch.company) {
            await logSessionEvent(sessionId, 'save_failed', { error: 'missing_name_and_company', attemptedPatch: patch });
            return createErrorResponse(id, -32602, 'save without id requires patch.name or patch.company to create a new client.');
        }
        if (!patch.name) patch.name = patch.company;

        // Server-side dedup: before creating, check for an exact company name match
        // (case-insensitive, trimmed). This is the last line of defense against
        // duplicates — the skill-level dedup check may miss when company names have
        // slight variations (casing, punctuation). If a match is found, treat this
        // as an update to the existing client rather than a new create.
        if (patch.company) {
            const dupRows = await prisma.$queryRaw`
                SELECT id, name, company FROM "Client"
                WHERE LOWER(TRIM(company)) = LOWER(TRIM(${patch.company}))
                LIMIT 1
            `;
            if (dupRows.length > 0) {
                const dup = dupRows[0];
                clientId = dup.id;
                existing = await prisma.client.findUnique({ where: { id: clientId } });
                await logSessionEvent(sessionId, 'dedup_hit', {
                    company: patch.company,
                    existingId: clientId,
                    existingName: dup.name
                });
                // isCreate stays false — fall through to the update path below
            }
        }

        if (!clientId) {
            isCreate = true;
            try {
                const created = await prisma.client.create({
                    data: {
                        name: patch.name,
                        email: patch.email || null,
                        phone: patch.phone || null,
                        company: patch.company || null,
                        website: patch.website || null,
                        segment: patch.segment || null,
                        clientNotes: patch.clientNotes || null,
                        source: patch.source || null,
                        // Born with content, never an empty shell: use a supplied dossier or
                        // a stub built from what we know. Survives the follow-up update below
                        // (which only touches dossier when patch.dossier/dossierAppend is set).
                        dossier: patch.dossier || buildStubDossier(patch)
                    }
                });
                clientId = created.id;
                existing = created;
            } catch (err) {
                await logSessionEvent(sessionId, 'save_failed', { name: patch.name, error: err.message, attemptedPatch: patch });
                return createErrorResponse(id, -32602, `client.create failed: ${err.message}`);
            }
        }
    }

    await prisma.$transaction(async (tx) => {
        // Build client update data
        const clientData = {};
        const clientFields = [
            'name', 'email', 'phone', 'company', 'website', 'clientNotes',
            'segment', 'draft', 'draftStatus', 'targetUrls'
        ];
        for (const field of clientFields) {
            if (patch[field] !== undefined) {
                clientData[field] = patch[field];
            }
        }

        // dossierAppend: timestamp + append to existing dossier
        if (patch.dossierAppend) {
            const timestamp = new Date().toISOString().slice(0, 10);
            const existingDossier = existing.dossier || '';
            const separator = existingDossier ? '\n\n' : '';
            clientData.dossier = existingDossier + separator + `[${timestamp}] ${patch.dossierAppend}`;
        }

        // Direct dossier overwrite (use dossierAppend instead when possible)
        if (patch.dossier !== undefined && patch.dossierAppend === undefined) {
            clientData.dossier = patch.dossier;
        }

        if (patch.intelScore !== undefined) {
            clientData.intelScore = parseInt(patch.intelScore, 10);
        }

        if (patch.sentAt) {
            clientData.sentAt = new Date(patch.sentAt);
        }

        if (patch.warmthScore !== undefined) {
            clientData.warmthScore = parseFloat(patch.warmthScore);
        }

        clientData.lastEnriched = new Date();

        if (Object.keys(clientData).length > 0) {
            await tx.client.update({ where: { id: clientId }, data: clientData });
        }

        // Create factlets only. Factlet is standalone in this architecture;
        // there is no join table. Client.dossier (timestamped prose) is the
        // durable per-client record; APPLY_FACTLET workers and JUDGE_AFFECTED
        // scoring read live Factlet rows directly via content/source overlap.
        if (Array.isArray(patch.factlets)) {
            for (const f of patch.factlets) {
                const factletSource = f.sourceUrl || f.url || f.source;
                if (!f.content || !factletSource) continue;
                await tx.factlet.create({
                    data: { content: f.content, source: factletSource }
                });
            }
        }

        // Upsert bookings
        if (Array.isArray(patch.bookings)) {
            for (const b of patch.bookings) {
                const bookingData = { clientId };
                const bookingFields = [
                    'title', 'description', 'notes', 'location', 'startTime', 'endTime',
                    'source', 'sourceUrl', 'trade', 'zip', 'sharedTo', 'leedId'
                ];
                for (const f of bookingFields) {
                    if (b[f] !== undefined) bookingData[f] = b[f];
                }

                // Booking.status is owned by the server Judge. A worker save may only
                // DEMOTE a booking to 'cold' or 'brewing' (e.g. returning a shared or
                // skipped leed out of the hot queue). It may NEVER promote to 'hot' --
                // only computeBookingTargetScore / judgeAffected set 'hot'. Any other
                // worker-supplied status (hot, shared, junk) is ignored so a worker
                // cannot fabricate a hot lead. See DOCS/CLASSIFICATION.md.
                if (b.status !== undefined) {
                    if (b.status === 'cold' || b.status === 'brewing') {
                        bookingData.status = b.status;
                    } else {
                        console.error(`[save] ignored worker-supplied Booking.status='${b.status}'` +
                            ` (id=${b.id || 'new'}) -- workers may only demote to cold/brewing; the Judge owns 'hot'.`);
                    }
                }

                if (b.duration !== undefined)   bookingData.duration   = parseFloat(b.duration);
                if (b.hourlyRate !== undefined)  bookingData.hourlyRate  = parseFloat(b.hourlyRate);
                if (b.flatRate !== undefined)    bookingData.flatRate    = parseFloat(b.flatRate);
                if (b.totalAmount !== undefined) bookingData.totalAmount = parseFloat(b.totalAmount);
                if (b.leedPrice !== undefined)   bookingData.leedPrice   = parseInt(b.leedPrice, 10);
                if (b.startDate) bookingData.startDate = new Date(b.startDate);
                if (b.endDate)   bookingData.endDate   = new Date(b.endDate);
                if (b.shared !== undefined) bookingData.shared = !!b.shared;
                if (b.sharedAt !== undefined) bookingData.sharedAt = BigInt(b.sharedAt);

                if (b.id) {
                    // Update existing booking. Use updateMany, NOT update: a worker —
                    // especially a weak model — can pass a stale or hallucinated booking
                    // id, and update() THROWS "Record to update not found", which rolls
                    // back the ENTIRE save (dossier text, zip, date — every bit of
                    // enrichment in this same call is lost). updateMany skips a missing
                    // id (count 0) instead of throwing, so the rest of the save persists.
                    const { clientId: _cid, ...updateData } = bookingData;
                    const upd = await tx.booking.updateMany({ where: { id: b.id }, data: updateData });
                    if (upd.count === 0) {
                        console.error(`[save] booking id='${b.id}' not found — update skipped` +
                            ` (worker passed a stale/hallucinated id); rest of the patch still saved.`);
                    }
                } else {
                    // Create new booking
                    await tx.booking.create({ data: bookingData });
                }
            }
        }

        // Auto-mirror: any Booking just flipped to status="shared" via an email
        // path (email_share or email_user) also marks the parent Client as
        // outreach-sent so ENRICH_CLIENT and the drafter cannot re-queue it for
        // another email. Marketplace shares (sharedTo="leedz_api") do NOT trigger
        // this mirror -- a marketplace post is per-Booking and leaves the Client
        // free to receive direct outreach for other Bookings. Idempotent: skips
        // if Client.draftStatus is already "sent".
        const EMAIL_SHARE_PATHS = new Set(['email_share', 'email_user']);
        const emailShared = Array.isArray(patch.bookings) && patch.bookings.some(b =>
            b.status === 'shared' && EMAIL_SHARE_PATHS.has(b.sharedTo)
        );
        if (emailShared && existing && existing.draftStatus !== 'sent') {
            await tx.client.update({
                where: { id: clientId },
                data:  { draftStatus: 'sent', sentAt: new Date() }
            });
            await logSessionEvent(sessionId, 'client_auto_marked_sent', {
                clientId,
                reason: 'booking_status_shared_via_email_path'
            });
        }
    });

    // Collect affected booking ids for either Judge invocation or Task output.
    const touchedBookings = await prisma.booking.findMany({
        where: { clientId },
        select: { id: true }
    });
    const affectedBookingIds = touchedBookings.map(b => b.id);
    const affectedClientIds  = [clientId];

    let scoreResult = null;
    let judged      = null;

    if (judge) {
        // Legacy compatibility path: pipeline.save(judge:true) routes through
        // the same judgeAffected helper that the new JUDGE_AFFECTED Task uses.
        // No copied scoring block lives here.
        const intelOverride = (patch.intelScore !== undefined) ? parseInt(patch.intelScore, 10) : null;
        judged = await judgeAffected({
            clientIds:   affectedClientIds,
            bookingIds:  affectedBookingIds,
            reason:      'pipeline.save(legacy)',
            writeStatus: true,
            intelOverride
        });
        scoreResult = judged.clientScore || null;
    }

    await logSessionEvent(sessionId, 'save_success', {
        clientId,
        name: existing?.name || patch.name || null,
        isCreate,
        score: typeof scoreResult === 'number' ? scoreResult : (scoreResult?.total ?? null),
        judged: !!judge
    });

    return createSuccessResponse(id, JSON.stringify({
        saved: true,
        clientId,
        score: scoreResult,
        judged: !!judge,
        affectedClientIds,
        affectedBookingIds,
        session_id: sessionId || null
    }, null, 2));
}

    return { pipelineSave };
}

module.exports = { createSaveHandler };
