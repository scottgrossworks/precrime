// ============================================================================
// sessionLog.js -- the session accountability layer.
//
// Server-issued, append-only session events + the canonical markdown summary,
// the save-or-terminate watchdog, and the start/report/audit handlers. Sessions
// are queried server-side so the model cannot misreport totals. Requires only
// db/responses/logging -- no injected deps; imported by same names in mcp_server.
// ============================================================================

const { prisma } = require('./db');
const { createSuccessResponse, createErrorResponse } = require('./responses');
const { logInfo } = require('./logging');

/**
 * Internal — log one event against a session. No-op if sessionId is falsy.
 * Catches and swallows errors so logging never breaks the caller.
 */
async function logSessionEvent(sessionId, action, payloadObj) {
    if (!sessionId) return;
    try {
        await prisma.sessionEvent.create({
            data: {
                sessionId,
                action,
                payload: payloadObj ? JSON.stringify(payloadObj) : null
            }
        });
    } catch (e) {
        logInfo(`logSessionEvent failed (sessionId=${sessionId}, action=${action}): ${e.message}`);
    }
}

/**
 * Build the canonical markdown rendering of a session summary. This is the
 * EXACT string the agent is instructed to paste back to the user — pre-baking
 * the wording removes the temptation for the model to paraphrase.
 *
 * Lines are deliberately bland and stat-focused so the model has nothing to
 * "improve" by rewording.
 */
function buildSummaryMarkdown(s) {
    const lines = [];
    const requestedStr = (s.requested === null || s.requested === undefined) ? 'n/a' : String(s.requested);
    const durationSec = Math.round((s.duration_ms || 0) / 1000);
    let headline;
    if (s.status === 'failed_no_data') {
        headline = `Session FAILED -- no save attempts (agent never called pipeline.save)`;
    } else if (s.status === 'failed_all_rejected') {
        headline = `Session FAILED -- ${s.save_attempts} attempts, all rejected by server`;
    } else if (s.status === 'completed_no_new_evidence') {
        headline = `Session complete -- ${s.task_completions || 0} Task(s), no new saves`;
    } else if (s.actually_saved < (s.requested ?? Infinity)) {
        headline = `Session under target -- saved ${s.actually_saved} of ${requestedStr} requested`;
    } else if ((s.worker_saved_clients || 0) + (s.worker_saved_bookings || 0) > 0) {
        headline = `Session complete -- workers saved ${s.worker_saved_clients || 0} client(s) + ${s.worker_saved_bookings || 0} booking(s)`;
    } else {
        headline = `Session complete -- saved ${s.actually_saved}`;
    }

    lines.push(`## ${headline}`);
    lines.push('');
    lines.push(`- Workflow: \`${s.workflow}\``);
    lines.push(`- Requested: ${requestedStr}`);
    lines.push(`- Saved by workers: ${s.worker_saved_clients ?? 0} client(s), ${s.worker_saved_bookings ?? 0} booking(s)`);
    lines.push(`- Saved by orchestrator (direct): ${s.actually_saved} (attempts: ${s.save_attempts ?? 0}, failed: ${s.failed})`);
    if (s.task_total !== undefined) lines.push(`- Tasks: ${s.task_completions || 0} completed of ${s.task_total}`);
    lines.push(`- Status: ${s.status}`);
    if (s.reason) lines.push(`- Reason: ${s.reason}`);
    lines.push(`- Duration: ${durationSec}s`);
    lines.push(`- Session: \`${s.session_id}\``);

    if (Array.isArray(s.saved_clients) && s.saved_clients.length > 0) {
        lines.push('');
        lines.push('**Saved clients:**');
        for (const c of s.saved_clients) {
            const name  = c.name || '(no name)';
            const cid   = c.clientId || '(no id)';
            const score = (c.score === null || c.score === undefined) ? '?' : c.score;
            // A score-0 save is a BARE client (no contact, no booking) -- it cannot
            // become a leed without enrichment. Flag it so a partial "saved N" result
            // is not mistaken for progress toward hot leedz.
            const bare = !c.score ? ' — **bare: no contact/booking yet, needs enrichment to become a leed**' : '';
            lines.push(`- ${name} — clientId: \`${cid}\` — score: ${score}${bare}`);
        }
    }

    if (Array.isArray(s.failures) && s.failures.length > 0) {
        lines.push('');
        lines.push('**Failures:**');
        for (const f of s.failures) {
            const name = f.name || f.id || '(unnamed client)';
            const err  = f.error || '(no error message)';
            const src  = f.source ? `  [${f.source}]` : '';
            lines.push(`- ${name} — ${err}${src}`);
            // Per-booking date detail: which event, what date text was bad, why.
            if (Array.isArray(f.failures)) {
                for (const d of f.failures) {
                    const ev   = d.title || '(untitled event)';
                    const dt   = d.dateText ? ` date="${d.dateText}"` : '';
                    const url  = d.sourceUrl ? ` src=${d.sourceUrl}` : '';
                    const why  = d.reason ? ` — ${d.reason}` : '';
                    lines.push(`    · ${ev}${dt}${url}${why}`);
                }
            }
        }
    }

    // Per-task ground truth. The session-level Reason above is an INFERENCE; this
    // block is what each worker actually reported (output.summary or error code).
    // This is how you tell "judged, changed nothing" apart from "scrape crashed"
    // apart from "no candidate clients" -- instead of one blanket guess.
    if (Array.isArray(s.task_history) && s.task_history.length > 0) {
        lines.push('');
        lines.push('**Per-task outcomes:**');
        for (const t of s.task_history) {
            const why = t.reason ? ` — ${t.reason}` : '';
            lines.push(`- ${t.type} [${t.status}]${why}`);
        }
    }

    if (s.status === 'under_target' && s.actually_saved < (s.requested ?? Infinity)) {
        lines.push('');
        lines.push(`_Under target by ${s.requested - s.actually_saved}. Re-run \`start_session\` to continue, or accept the partial result._`);
    }

    return lines.join('\n');
}

/**
 * Watchdog: enforce the 3-min save-or-terminate wall on active sessions.
 *
 * Sweeps any active session older than 180s with 0 save_attempts -- closes
 * it as 'abandoned' and returns an error response refusing the current call.
 * Read-tool handlers (status, next, rescore, find/*) call this at the top.
 * start_session also calls it (ignoring the return) to clean up first.
 *
 * Returns:
 *   { terminated: true, errorResponse }  -- caller MUST return errorResponse
 *   { terminated: false }                 -- proceed normally
 */
async function enforceSessionWatchdog(id) {
    const TERMINATE_AT_SEC      = 180;   // 3 min: zombie threshold (mark abandoned)
    const ERROR_THRESHOLD_SEC   = 600;   // 10 min: above this, silent cleanup -- the
                                          // session predates the current agent and
                                          // erroring its first call is a false positive.

    const activeSessions = await prisma.session.findMany({
        where: { status: 'active' },
        include: { events: true },
        orderBy: { startedAt: 'desc' }
    });

    let freshZombie = null;  // a fresh zombie (3-10 min) likely belongs to the current
                              // agent and is a real in-session stall worth flagging.

    for (const sess of activeSessions) {
        const ageSec = Math.round((Date.now() - sess.startedAt.getTime()) / 1000);
        const attempts = sess.events.filter(e => e.action === 'save_attempt').length;
        const taskEvents = sess.events.filter(e => e.action === 'task_completed').length;
        const taskRows = await prisma.task.count({ where: { sessionId: sess.id } });
        const hasTaskProgress = taskEvents > 0 || taskRows > 0;

        if (attempts > 0 && ageSec >= ERROR_THRESHOLD_SEC) {
            await prisma.session.update({
                where: { id: sess.id },
                data: { status: 'abandoned', finishedAt: new Date() }
            });
            await prisma.sessionEvent.create({
                data: {
                    sessionId: sess.id,
                    action: 'auto_abandoned',
                    payload: JSON.stringify({
                        ageSec,
                        attempts,
                        reason: 'stale_active_session_silent_cleanup'
                    })
                }
            });
            logInfo(`Watchdog: silent cleanup of stale active session ${sess.id} (workflow="${sess.workflow}", attempts ${attempts}, age ${ageSec}s).`);
            continue;
        }

        if (attempts === 0 && !hasTaskProgress && ageSec >= TERMINATE_AT_SEC) {
            const isStale = ageSec >= ERROR_THRESHOLD_SEC;
            await prisma.session.update({
                where: { id: sess.id },
                data: { status: 'abandoned', finishedAt: new Date() }
            });
            await prisma.sessionEvent.create({
                data: {
                    sessionId: sess.id,
                    action: 'auto_abandoned',
                    payload: JSON.stringify({
                        ageSec,
                        reason: isStale ? 'stale_from_previous_run_silent_cleanup' : 'no_saves_within_3min'
                    })
                }
            });
            if (isStale) {
                logInfo(`Watchdog: silent cleanup of stale zombie ${sess.id} (workflow="${sess.workflow}", age ${ageSec}s) -- not erroring current call.`);
            } else if (!freshZombie || ageSec < freshZombie.ageSec) {
                freshZombie = { sess, ageSec };
            }
        }
    }

    if (freshZombie) {
        return {
            terminated: true,
            errorResponse: createErrorResponse(id, -32000,
                `Session ${freshZombie.sess.id} (workflow="${freshZombie.sess.workflow}") auto-terminated at ${freshZombie.ageSec}s with 0 saves. ` +
                `Switch strategy: claim a different source via pipeline.next_source(channel?, maxAgeDays?), or call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task (or seed via pipeline.add_sources). ` +
                `Do NOT re-open the same workflow without changing approach -- that just burns another 3 min.`)
        };
    }

    return { terminated: false };
}

/**
 * Open a new workflow session. Returns the server-issued session_id —
 * the agent must carry this forward to subsequent save calls and to the
 * eventual report_session call.
 *
 * Hard rules enforced here:
 * - target_count is REQUIRED and must be a positive number. No more "n/a requested".
 * - Only one active session per workflow. Refuses overlap.
 * - Refuses to re-open within 60s of an auto-abandoned session for the same
 *   workflow -- forces strategy change after a 3-min wall.
 * - Sweeps stale sessions before checking overlap.
 */
async function pipelineStartSession(id, workflow, targetCount, metadata) {
    if (!workflow || typeof workflow !== 'string') {
        return createErrorResponse(id, -32602, 'start_session requires workflow (string), e.g. "url-loop".');
    }
    if (typeof targetCount !== 'number' || targetCount <= 0) {
        return createErrorResponse(id, -32602,
            'start_session requires target_count (number > 0). E.g. target_count: 10. ' +
            'No more "n/a requested" -- commit to a number.');
    }

    // Sweep stale sessions first so the overlap check is fair.
    await enforceSessionWatchdog(id);

    // Refuse overlap on the same workflow.
    const existing = await prisma.session.findFirst({
        where: { status: 'active', workflow },
        include: { events: true }
    });
    if (existing) {
        const ageSec = Math.round((Date.now() - existing.startedAt.getTime()) / 1000);
        const attempts = existing.events.filter(e => e.action === 'save_attempt').length;
        if (ageSec >= 3600) {
            await prisma.session.update({
                where: { id: existing.id },
                data: { status: 'abandoned', finishedAt: new Date() }
            });
            await prisma.sessionEvent.create({
                data: {
                    sessionId: existing.id,
                    action: 'auto_abandoned',
                    payload: JSON.stringify({
                        ageSec,
                        attempts,
                        reason: 'stale_active_overlap_cleanup'
                    })
                }
            });
        } else {
        return createErrorResponse(id, -32602,
            `Session ${existing.id} for workflow "${workflow}" is already active ` +
            `(${ageSec}s old, ${attempts} save attempts). Close it with report_session, or wait for the 3-min watchdog.`);
        }
    }

    // Refuse rapid re-open after auto-termination on the same workflow.
    const recentAbandoned = await prisma.session.findFirst({
        where: {
            workflow,
            status: 'abandoned',
            startedAt: { gte: new Date(Date.now() - 10 * 60_000) },
            finishedAt: { gte: new Date(Date.now() - 60_000) }
        },
        orderBy: { finishedAt: 'desc' }
    });
    if (recentAbandoned) {
        return createErrorResponse(id, -32602,
            `Workflow "${workflow}" had a session auto-terminated <60s ago (${recentAbandoned.id}). ` +
            `Wait 60s OR change strategy: claim a different source via pipeline.next_source(channel?, maxAgeDays?), or call pipeline.plan_tasks({mode:"workflow"}) to enqueue a DISCOVER_SOURCES Task (or seed via pipeline.add_sources). ` +
            `Repeating the same workflow without saves only burns time.`);
    }

    const sid = 'ses_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const session = await prisma.session.create({
        data: {
            id: sid,
            workflow,
            targetCount: (typeof targetCount === 'number' && targetCount > 0) ? targetCount : null,
            metadata: metadata ? JSON.stringify(metadata) : null
        }
    });
    return createSuccessResponse(id, JSON.stringify({
        session_id: session.id,
        workflow: session.workflow,
        target_count: session.targetCount,
        started_at: session.startedAt.toISOString(),
        note: 'Pass this session_id to every save call in this workflow. End with report_session.'
    }, null, 2));
}

/**
 * Aggregate a session's events server-side and return the truth.
 * If close=true (action=report_session), marks the session complete and
 * appends a "report" event so the report itself is auditable.
 * If close=false (action=audit_session), leaves status untouched.
 */
async function pipelineReportSession(id, sessionId, close) {
    let session;
    if (!sessionId) {
        // audit_session with no ID: auto-pick the most recent session.
        // report_session still requires an explicit ID (it closes a session — must be deliberate).
        if (close) {
            return createErrorResponse(id, -32602, `report_session requires session_id.`);
        }
        session = await prisma.session.findFirst({
            orderBy: { startedAt: 'desc' },
            include: { events: { orderBy: { ts: 'asc' } } }
        });
        if (!session) {
            return createErrorResponse(id, -32602, `audit_session: no sessions exist yet. Start one with action=start_session.`);
        }
        sessionId = session.id;
    } else {
        session = await prisma.session.findUnique({
            where: { id: sessionId },
            include: { events: { orderBy: { ts: 'asc' } } }
        });
        if (!session) {
            return createErrorResponse(id, -32602, `session_id "${sessionId}" not found.`);
        }
    }

    const attempts  = session.events.filter(e => e.action === 'save_attempt');
    const successes = session.events.filter(e => e.action === 'save_success');
    const failures  = session.events.filter(e => e.action === 'save_failed');
    const marks     = session.events.filter(e => e.action === 'source_marked');
    const taskDone  = session.events.filter(e => e.action === 'task_completed');

    // Task history -- the new Planner/Worker/Judge path writes a task_completed
    // event for every complete_task call, and the Task rows themselves carry
    // sessionId. Aggregate by type so headless final reports and audit_session
    // can use server-truthful counts instead of LLM-rolled totals.
    const sessionTasks = await prisma.task.findMany({
        where: { sessionId: sessionId },
        orderBy: { createdAt: 'asc' }
    });
    const taskCountsByType = {};
    const taskOutcomesByType = {};   // { TYPE: { done: n, failed: n, cancelled: n, ready: n, claimed: n } }
    for (const t of sessionTasks) {
        taskCountsByType[t.type] = (taskCountsByType[t.type] || 0) + 1;
        if (!taskOutcomesByType[t.type]) taskOutcomesByType[t.type] = {};
        taskOutcomesByType[t.type][t.status] = (taskOutcomesByType[t.type][t.status] || 0) + 1;
    }
    const taskHistory = sessionTasks.map(t => {
        // Per-task ground truth: the worker wrote output.summary (done) or error
        // (failed/cancelled). Surface it so the report says WHY each task saved
        // nothing, instead of leaning only on the inferred session-level reason.
        let outSummary = null;
        try { outSummary = t.output ? (JSON.parse(t.output)?.summary || null) : null; } catch (_) { outSummary = null; }
        return {
            id:         t.id,
            type:       t.type,
            status:     t.status,
            targetType: t.targetType,
            targetId:   t.targetId,
            finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
            error:      t.error || null,
            // One field the reader can scan: failed/cancelled -> error code;
            // done -> the worker's own summary; null only if the worker wrote neither.
            reason:     t.error || outSummary || null
        };
    });

    const savedClients = successes.map(e => {
        try { return JSON.parse(e.payload); } catch { return { raw: e.payload }; }
    });
    const failureList = failures.map(e => {
        try { return JSON.parse(e.payload); } catch { return { raw: e.payload }; }
    });

    // REAL saves made by spawned WORKER processes. Workers write straight to the DB and
    // report the affected ids in their complete_task output -- but they never carry the
    // orchestrator's session_id, so the save_success EVENT count above is ~always 0 for an
    // autonomous workflow run. That made every autonomous session read "0 saves" even when
    // workers minted dozens of leedz. Count the workers' actual output ids instead.
    const workerClientIds = new Set();
    const workerBookingIds = new Set();
    for (const t of sessionTasks) {
        if (t.status !== 'done' || !t.output) continue;
        try {
            const out = JSON.parse(t.output);
            (out.clientIds  || []).forEach(x => x && workerClientIds.add(x));
            (out.bookingIds || []).forEach(x => x && workerBookingIds.add(x));
        } catch (_) { /* skip unparseable output */ }
    }
    const workerSavedClients  = workerClientIds.size;
    const workerSavedBookings = workerBookingIds.size;

    // Honest status. Distinguish:
    //   - agent did literally nothing                 -> failed_no_data
    //   - agent scraped sources but URLs yielded zero -> scraped_no_clients (NOT a failure)
    //   - agent tried saves, server rejected all     -> failed_all_rejected
    //   - under target                                -> under_target
    //   - complete                                    -> complete
    // The agent is forbidden from overwriting this.
    let honestStatus;
    let reason = null;
    const terminalTaskCount = sessionTasks.filter(t => ['done', 'failed', 'cancelled'].includes(t.status)).length;
    if (attempts.length === 0 && marks.length === 0 && terminalTaskCount === 0) {
        honestStatus = 'failed_no_data';
        reason = 'no_save_attempts and no_sources_marked -- agent ran the workflow but did nothing';
    } else if (attempts.length === 0 && marks.length === 0 && terminalTaskCount > 0) {
        if (workerSavedClients > 0 || workerSavedBookings > 0) {
            honestStatus = 'complete';
            reason = `${terminalTaskCount} Task(s) done; workers saved ${workerSavedClients} client(s) + ${workerSavedBookings} booking(s) (out-of-band, so the session save_success events read 0).`;
        } else {
            honestStatus = 'completed_no_new_evidence';
            reason = `${terminalTaskCount} Task(s) reached terminal status with 0 saves -- valid Task workflow result when evidence is duplicate, irrelevant, or judge-only`;
        }
    } else if (attempts.length === 0 && marks.length > 0) {
        honestStatus = 'scraped_no_clients';
        const cf = marks.reduce((s, m) => { try { return s + (JSON.parse(m.payload).clientsFound || 0); } catch { return s; } }, 0);
        reason = `${marks.length} source(s) scraped, ${cf} client(s) extracted, 0 saves -- URLs yielded nothing this round (legitimate null result, keep digging)`;
    } else if (successes.length === 0) {
        honestStatus = 'failed_all_rejected';
        reason = `all ${attempts.length} save attempts rejected by server -- see failures[]`;
    } else if (session.targetCount && successes.length < session.targetCount) {
        honestStatus = 'under_target';
    } else {
        honestStatus = 'complete';
    }

    const summary = {
        session_id: sessionId,
        workflow: session.workflow,
        status: close ? honestStatus : session.status,
        reason,
        requested: session.targetCount,
        save_attempts: attempts.length,
        actually_saved: successes.length,
        worker_saved_clients: workerSavedClients,
        worker_saved_bookings: workerSavedBookings,
        failed: failures.length,
        saved_clients: savedClients,
        failures: failureList,
        // Task-based truth (Planner/Worker/Judge architecture):
        task_total:         sessionTasks.length,
        task_counts_by_type: taskCountsByType,
        task_outcomes:      taskOutcomesByType,
        task_completions:   taskDone.length,
        task_history:       taskHistory,
        started_at: session.startedAt.toISOString(),
        duration_ms: Date.now() - session.startedAt.getTime(),
        note: 'This summary is generated by the server from the session event log + Task table. Echo verbatim -- do not paraphrase.'
    };
    summary.summary_markdown = buildSummaryMarkdown(summary);

    if (close) {
        await prisma.session.update({
            where: { id: sessionId },
            data: { status: honestStatus, finishedAt: new Date() }
        });
        await prisma.sessionEvent.create({
            data: { sessionId, action: 'report', payload: JSON.stringify(summary) }
        });
    }

    return createSuccessResponse(id, JSON.stringify(summary, null, 2));
}

module.exports = { logSessionEvent, enforceSessionWatchdog, pipelineStartSession, pipelineReportSession };
