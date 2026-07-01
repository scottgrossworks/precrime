// ============================================================================
// toolDefs.js -- the static MCP tools/list payload (pipeline, find, trades).
//
// Pure data: the exact tool descriptions + JSON Schemas the server advertises
// on tools/list. No logic, no deps. Extracted from mcp_server.js so the (large)
// pipeline description can be edited in isolation and, later, served per-worker-
// role as a trimmed subset to cut the per-turn schema token tax.
// ============================================================================

const TOOL_DEFS = [
                {
                    name: 'pipeline',
                    description: [
                        'Pre-Crime workflow operations. One tool, fifteen actions: status, configure, next, save, delete, rescore, resolve_dates, start_session, report_session, audit_session, next_source, mark_source, add_sources, import_sources, work_status.',
                        '',
                        'action="status": Read full system state in one call. Returns { config, stats, completeness, readyDrafts, brewingCount }. completeness is a derived check of whether config has the fields needed for the current defaultBookingAction. Use this at startup and between enrichment rounds.',
                        '',
                        'action="configure": Update Config fields. Pass patch with any Config fields (companyName, companyEmail, businessDescription, activeEntities, defaultTrade, marketplaceEnabled, leadCaptureEnabled, leedzEmail, leedzSession, llmApiKey, llmProvider, llmModel, llmBaseUrl, llmAnthropicVersion, llmMaxTokens, factletStaleDays, defaultBookingAction). Returns updated config.',
                        '',
                        'action="next": Atomically claim the next work item and return it fully hydrated. Pass entity="client" (default) or entity="booking". For clients: returns the client record with all linked factlets and bookings in one payload. The lastQueueCheck is stamped before return so no other agent claims it. Pass optional criteria to filter (company, name, draftStatus). Returns null if queue is empty. Response is automatically trimmed for context efficiency: dossier tail-clipped to last 2000 chars (or override via dossierLimit), factlets capped to 8 most recent (or override via factletLimit). Pass 0 to disable a cap. _clipped metadata is included if anything was trimmed.',
                        '',
                        'action="save": Atomically persist client work in a single transaction. Two modes: (1) UPDATE existing client - pass id and patch with any of: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. (2) CREATE new client - omit id, patch must include name OR company. Company-only sparse records are allowed when relevant; enrichment fills person/email later. Optional fields: email, phone, website, segment, source, factlets[], bookings[]. Optionally pass session_id (returned by start_session) to log this save against an open workflow session. After persisting, refreshes the client enrichment signal AND re-classifies every booking under that client to cold / brewing / hot via the procedural gates (server/mcp/classification.js) plus the LLM product-market-fit judge. See DOCS/CLASSIFICATION.md.',
                        '',
                        'action="delete": Permanently remove a record. Pass target ("booking" | "client" | "factlet") and id. For target="client", any attached bookings and factlet links are removed too (cascade). Returns { deleted: true, target, id, cascadedBookings, cascadedFactlets }. Use this when the user says "delete this booking", "remove this client", "drop this factlet", or any imperative removal.',
                        '',
                        'action="rescore": Re-classify every booking to cold / brewing / hot (procedural gates + LLM judge). Use after editing DOCS/CLASSIFICATION.md policy or DOCS/SCORING.json knobs. Pass scope="all" (default), scope="hot" to sanity-check the current hot queue, or scope=<clientId> to limit to one client. Add procedural=true for a TOKEN-FREE demote-only sweep (gates only, no LLM) -- e.g. {scope:"hot", procedural:true} cheaply scrubs legacy mis-scored hot leedz. Returns counts: rescored, changed, before/after status distribution.',
                        '',
                        'action="resolve_dates": STRUCTURED-ONLY. Server-side date validation + tz-aware epoch math. Required: start { year, month, day, hour, minute, ampm? }, end { year, month, day, hour, minute, ampm? }, timezone (IANA, e.g. "America/Los_Angeles"). Optional: zip (echoed only -- zip-to-tz derivation NOT supported), rawText (informational evidence only -- timezone smuggled inside rawText is REJECTED), sourceProof. The LLM is forbidden from computing epoch ms; it must only extract the structured fields. Returns { ok, st, et, startIso, endIso, timezone, zip, warnings } on success, or { ok:false, errors:[fieldName:reason] } on failure.',
                        '',
                        'action="share_booking": ONLY normal path to marketplace posting. Required: bookingId, mode ("draft" | "post"). FORBIDDEN inputs: st, et (LLM-supplied epochs are rejected by name). Loads the Booking + Client, rescores via judgeAffected, requires status hot, then converts the Booking\'s already-verified wall-clock dates (set at enrichment) to a tz-correct epoch -- no re-resolution. In "draft" mode returns the addLeed payload + humanReadable verification block. In "post" mode posts to Leedz and records leedId/sharedAt.',
                        '',
                        'action="start_session": Open a workflow session and receive a server-issued session_id. Pass workflow (string, e.g. "convention-leeds") and optional target_count (e.g. 5) and metadata (object). The session_id MUST be passed to subsequent save calls in this workflow so the server can log each save. Use this BEFORE any save calls when you intend to summarize results — the report_session call will return the truth.',
                        '',
                        'action="report_session": Close a session and return the SERVER-COMPUTED truth: { session_id, workflow, requested, actually_saved, failed, saved_clients[], failures[], duration_ms }. THIS IS THE ONLY SANCTIONED SUMMARY OF SESSION RESULTS. Echo its output verbatim. DO NOT write your own "N clients created" prose — the server is the single source of truth. Pass session_id (required).',
                        '',
                        'action="audit_session": Show what the agent ACTUALLY did this session — saves, failures, shares, raw event log from the server. THIS IS THE TOOL TO USE when the user says "show the audit", "what did you do", "what did you save", "show your work", "audit", "show me what happened", or any progress check. Returns the unfakeable server-side event record, not the agent\'s memory. session_id is OPTIONAL — if omitted, audits the most recent session automatically. NEVER substitute action=status for an audit request — status returns config snapshots, not the work record.',
                        '',
                        'action="next_source": Atomically claim the oldest unscraped or stale source URL from the queue. Pass optional channel ("directory"|"rss"|"fb"|"ig"|"reddit"|"x"|"blog"|"website") to filter. Optional maxAgeDays (default 30) -- sources scraped longer ago than this are eligible for re-scrape. Optional session_id stamps the claim. Returns { status: "CLAIMED", id, url, channel, subtype, label, category, discoveredFrom, previouslyScrapedAt } or { status: "QUEUE_EMPTY", channel } when nothing is available. Stale claims (>10min with no mark_source) are eligible for re-claim. THIS REPLACES reading discovered_directories.md by hand.',
                        '',
                        'action="mark_source": Release the claim and persist the scrape result. REQUIRED url (the URL returned by next_source). Optional scrapedAt (ISO datetime, defaults to now), clientsFound (integer), failedReason (string for failures), session_id (pass the active workflow session_id so report_session can distinguish "scraped, no clients" from "did nothing"). Pair this with every next_source -- if you do not mark, the row stays claimed for 10 minutes then becomes claimable again. THIS REPLACES "echo url ^| scraped:date >> discovered_directories.md".',
                        '',
                        'action="add_sources": Bulk-insert new source URLs discovered during scraping. REQUIRED entries[] -- non-empty array of { url, channel, subtype?, label?, category?, discoveredFrom? }. Channel must be one of the eight allowed values. URLs are normalized to canonical form (handle/tag inputs like "@account" or "r/sub" become full URLs). Returns { added, duplicates, invalid[] }. Dedup is on URL. THIS REPLACES every "echo line >> *_sources.md" shell command in every harvester and source-discovery skill.',
                        '',
                        'action="import_sources": DEPRECATED. Markdown is the single source of truth: the server reads data/sources/<channel>.md into an in-memory index at startup, so there is no separate import step. This action just re-reads those files and returns the live per-channel counts. There is no Source table.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['status', 'configure', 'get_config', 'get_task', 'next', 'save', 'delete', 'rescore', 'resolve_dates', 'share_booking', 'dismiss_booking', 'start_session', 'report_session', 'audit_session', 'next_source', 'mark_source', 'add_sources', 'import_sources', 'work_status', 'judge_affected', 'plan_tasks', 'claim_task', 'complete_task', 'tasks', 'recycler'],
                                description: 'Which pipeline operation to run.'
                            },
                            text: {
                                type: 'string',
                                description: 'For action=resolve_dates: DEPRECATED. The structured-only path is authoritative; text is ignored except as evidence echo.'
                            },
                            sourceUrl: {
                                type: 'string',
                                description: 'For action=resolve_dates: optional source URL kept only for provenance. No longer used for date math.'
                            },
                            defaultDurationHours: {
                                type: 'number',
                                description: 'DEPRECATED. Structured resolve_dates requires explicit end fields.'
                            },
                            rawText: {
                                type: 'string',
                                description: 'For action=resolve_dates: informational raw evidence text. NEVER used to derive timezone or epoch -- structured fields are required.'
                            },
                            start: {
                                type: 'object',
                                description: 'For action=resolve_dates: { year, month (1-12), day, hour, minute, ampm? }. Required.',
                                properties: {
                                    year:   { type: 'integer' },
                                    month:  { type: 'integer' },
                                    day:    { type: 'integer' },
                                    hour:   { type: 'integer' },
                                    minute: { type: 'integer' },
                                    ampm:   { type: 'string', enum: ['AM', 'PM', 'am', 'pm'] }
                                }
                            },
                            end: {
                                type: 'object',
                                description: 'For action=resolve_dates: { year, month, day, hour, minute, ampm? }. Required. Overnight events must supply the next-day date.',
                                properties: {
                                    year:   { type: 'integer' },
                                    month:  { type: 'integer' },
                                    day:    { type: 'integer' },
                                    hour:   { type: 'integer' },
                                    minute: { type: 'integer' },
                                    ampm:   { type: 'string', enum: ['AM', 'PM', 'am', 'pm'] }
                                }
                            },
                            timezone: {
                                type: 'string',
                                description: 'For action=resolve_dates: IANA timezone, e.g. "America/Los_Angeles". Required. Timezone smuggled inside rawText is rejected.'
                            },
                            zip: {
                                type: 'string',
                                description: 'For action=resolve_dates: 5-digit zip. Echoed only -- no zip-to-tz derivation.'
                            },
                            sourceProof: {
                                type: 'string',
                                description: 'For action=resolve_dates / share_booking: provenance string (email id, URL, snippet).'
                            },
                            bookingId: {
                                type: 'string',
                                description: 'For action=share_booking: Booking.id to share.'
                            },
                            mode: {
                                type: 'string',
                                enum: ['draft', 'post'],
                                description: 'For action=share_booking: "draft" returns the payload + humanReadable; "post" posts to Leedz.'
                            },
                            titleDraft: {
                                type: 'string',
                                description: 'Optional share_booking prose override for payload.ti only. No emails, phones, epochs, or unsupported date/time claims.'
                            },
                            dtDraft: {
                                type: 'string',
                                description: 'Optional share_booking prose override for payload.dt only. Vendor-facing event prose; additional useful contact info is allowed when evidence-backed. No epochs, payload fields, or unsupported date/time claims.'
                            },
                            rqDraft: {
                                type: 'string',
                                description: 'Optional share_booking prose override for payload.rq only. Requirements/follow-up prose; additional useful contact info is allowed when evidence-backed. No epochs, payload fields, or unsupported date/time claims.'
                            },
                            st: {
                                type: 'number',
                                description: 'FORBIDDEN on share_booking. The LLM is not allowed to supply marketplace epoch ms. Pass structured date pieces and let MCP resolve them.'
                            },
                            et: {
                                type: 'number',
                                description: 'FORBIDDEN on share_booking. The LLM is not allowed to supply marketplace epoch ms. Pass structured date pieces and let MCP resolve them.'
                            },
                            channel: {
                                type: 'string',
                                enum: ['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website'],
                                description: 'For action=next_source: filter to one channel. Omit to claim from any channel.'
                            },
                            maxAgeDays: {
                                type: 'number',
                                description: 'For action=next_source: a previously-scraped source is eligible for re-scrape if its scrapedAt is older than this many days. Default 30.'
                            },
                            url: {
                                type: 'string',
                                description: 'For action=mark_source: the URL returned by next_source.'
                            },
                            scrapedAt: {
                                type: 'string',
                                description: 'For action=mark_source: ISO datetime. Defaults to now if omitted.'
                            },
                            clientsFound: {
                                type: 'number',
                                description: 'For action=mark_source: number of distinct companies/contacts saved from this URL. 0 if scrape failed.'
                            },
                            failedReason: {
                                type: 'string',
                                description: 'For action=mark_source: short error string if scrape failed (e.g., "timeout", "404", "parse error"). Omit on success.'
                            },
                            entries: {
                                type: 'array',
                                description: 'For action=add_sources: array of { url, channel, subtype?, label?, category?, discoveredFrom? }. Channel: directory|rss|fb|ig|reddit|x|blog|website. discoveredFrom is the URL of the source that linked here (recursion lineage).',
                                items: {
                                    type: 'object',
                                    properties: {
                                        url: { type: 'string' },
                                        channel: { type: 'string', enum: ['directory', 'rss', 'fb', 'ig', 'reddit', 'x', 'blog', 'website'] },
                                        subtype: { type: 'string' },
                                        label: { type: 'string' },
                                        category: { type: 'string' },
                                        discoveredFrom: { type: 'string' }
                                    },
                                    required: ['url', 'channel']
                                }
                            },
                            workflow: {
                                type: 'string',
                                description: 'For action=start_session only. Name of the workflow being run, e.g. "convention-leeds", "enrichment", "drafting".'
                            },
                            target_count: {
                                type: 'number',
                                description: 'For action=start_session only. Optional declared target (e.g. 5 if you intend to save 5 clients). Used by report_session to compare requested vs actually_saved.'
                            },
                            metadata: {
                                type: 'object',
                                description: 'For action=start_session only. Optional JSON blob of workflow-specific params (e.g. {region:"LA", segment:"convention"}).'
                            },
                            session_id: {
                                type: 'string',
                                description: 'For action=save (optional, links the save to an open session) or action=report_session/audit_session (REQUIRED). Server-issued by start_session. Cannot be self-generated.'
                            },
                            scope: {
                                type: 'string',
                                description: 'For action=rescore only. "all" (default) re-classifies every booking. "hot" sanity-checks only the current hot queue. Or pass a clientId to re-classify one client only. Use after editing DOCS/CLASSIFICATION.md or DOCS/SCORING.json.'
                            },
                            procedural: {
                                type: 'boolean',
                                description: 'For action=rescore only. When true, run a TOKEN-FREE procedural rescore: deterministic gates only (no LLM), DEMOTE-ONLY. Scrubs legacy/mis-scored leedz that no longer pass the gates (event passed, missing field, generic/org contact) down to brewing/cold; never promotes to hot. Pair with scope="hot" to cheaply clean the hot backlog. Default false (full re-judge, which spends tokens on the LLM fit-gate).'
                            },
                            entity: {
                                type: 'string',
                                enum: ['client', 'booking'],
                                description: 'For action=next only. Which entity queue to pull from. Defaults to client.'
                            },
                            criteria: {
                                type: 'object',
                                description: 'For action=next only. Optional filters: { company, name, draftStatus, segment, lastEnrichedBefore }. Pass lastEnrichedBefore as an ISO datetime string (e.g. 30 days ago) to skip recently-enriched clients and prioritize new contacts.',
                                properties: {
                                    company: { type: 'string' },
                                    name: { type: 'string' },
                                    draftStatus: { type: 'string' },
                                    segment: { type: 'string' },
                                    lastEnrichedBefore: { type: 'string', description: 'ISO datetime. Only return clients whose lastEnriched is null or older than this timestamp. Use to skip recently-enriched clients.' }
                                }
                            },
                            dossierLimit: {
                                type: 'number',
                                description: 'For action=next only. Max chars of dossier to return, tail-clipped (most recent kept). Default 2000. Pass 0 to return full dossier.'
                            },
                            factletLimit: {
                                type: 'number',
                                description: 'For action=next only. Max factlets to return (most recent first). Default 8. Pass 0 for all.'
                            },
                            id: {
                                type: 'string',
                                description: 'For action=save: Client ID to update. OMIT this to CREATE a new client (patch.name OR patch.company then required). For action=delete: the ID of the record to delete (booking ID, client ID, or factlet ID — must match target).'
                            },
                            target: {
                                type: 'string',
                                enum: ['booking', 'client', 'factlet'],
                                description: 'For action=delete only. Which kind of record to delete. id must point to a record of this type.'
                            },
                            patch: {
                                type: 'object',
                                description: 'For action=save or action=configure. For save UPDATE: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, factlets[], bookings[]. For save CREATE (no id): name OR company is required; sparse company-only records are allowed when relevant. Optional: email, phone, website, segment, source, factlets[], bookings[]. For configure: any Config model fields.'
                            },
                            taskId: {
                                type: 'string',
                                description: 'For action=complete_task. The id of the claimed Task being completed.'
                            },
                            status: {
                                type: 'string',
                                description: 'For action=complete_task: "done" | "failed" | "cancelled". For action=tasks: optional status filter.'
                            },
                            output: {
                                type: 'object',
                                description: 'For action=complete_task. Result blob, e.g. { clientIds:[], bookingIds:[], factletIds:[], sourceIds:[], summary, needsJudge }. Pass the object directly, NOT a JSON string.'
                            },
                            error: {
                                type: 'string',
                                description: 'For action=complete_task with status "failed"/"cancelled". Short error code.'
                            },
                            role: {
                                type: 'string',
                                description: 'For action=claim_task. Claimer label, e.g. "worker" | "interactive-orchestrator".'
                            },
                            types: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=claim_task. Optional list of Task types this claimer accepts (e.g. ["APPLY_FACTLET"]). Omit to accept any. Pass the array directly, NOT a JSON string.'
                            },
                            clientIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=judge_affected. Client ids to (re-)judge. Pass the array DIRECTLY (e.g. ["school-013"]), NOT a JSON string and NOT wrapped in another object.'
                            },
                            bookingIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=judge_affected. Booking ids to (re-)judge. Pass the array DIRECTLY, NOT a JSON string.'
                            },
                            reason: {
                                type: 'string',
                                description: 'For action=judge_affected. Optional audit note.'
                            },
                            writeStatus: {
                                type: 'boolean',
                                description: 'For action=judge_affected. Default true; pass false to compute without persisting Booking.status.'
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    name: 'find',
                    description: [
                        'Read-only search across the Pre-Crime database. One tool, four actions.',
                        '',
                        'action="clients": Search clients by name, email, company, segment, draftStatus, warmth range. Default summary=true returns slim records (no dossier/draft/targetUrls). Pass summary=false only when you need full records. Default limit 10. Sorted by dossierScore descending.',
                        '',
                        'action="bookings": Search bookings by status, trade, keyword (checks title, description, notes, location). Returns bookings with slim client stub. Default limit 20. Sorted by createdAt descending.',
                        '',
                        'action="factlets": Get factlets. Pass filters.sinceTimestamp (ISO string) for queue checking, or filters.clientId for a specific client. Returns factlets sorted by createdAt ascending.',
                        '',
                        'action="drafts": Get clients with draftStatus="ready", sorted by dossierScore descending. Pass summary=true for slim records. Default limit 10. Optional filters.minScore for minimum dossierScore.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['clients', 'bookings', 'factlets', 'drafts'],
                                description: 'Which entity type to search.'
                            },
                            filters: {
                                type: 'object',
                                description: 'Action-specific filters. clients: search, name, email, company, segment, draftStatus, warmthScore, minWarmthScore, maxWarmthScore. bookings: status, trade, search. factlets: sinceTimestamp, clientId. drafts: minScore.'
                            },
                            summary: {
                                type: 'boolean',
                                description: 'Default true. When true, returns slim records without heavy text fields (dossier, draft, targetUrls). Pass false only when you need full records.'
                            },
                            limit: {
                                type: 'number',
                                description: 'Max results. Default 10 for clients/drafts, 20 for bookings.'
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    name: 'trades',
                    description: 'Fetch the canonical Leedz marketplace trade names from the Leedz API. Returns a sorted array of trade name strings (e.g. ["bartender", "caricatures", "dj", "photo booth"]). This is the ONLY authoritative source for valid Leedz trades. Never guess from training data. Cached 10 minutes. Serves stale cache on network failure.',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                }
];

module.exports = { TOOL_DEFS };
