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
                        'Pre-Crime workflow operations. IMPORTANT: the names below are ACTIONS of THIS one `pipeline` tool, NOT standalone tools — to run any of them, call the `pipeline` tool with action:"<name>". There is no separate save / audit_session / complete_task / report_session / etc. tool; calling one of those names directly will fail with "Unknown tool". Actions: status, configure, next, save, delete, rescore, resolve_dates, browse, signal, pause, resume, plan_tasks, enqueue, report_session, audit_session, next_source, mark_source, add_sources, import_sources, work_status.',
                        '',
                        'action="browse": Fetch a page THROUGH THE USER\'S OWN LOGGED-IN CHROME (mcp-chrome bridge, transient session). Pass url (http/https). Returns { url, text } — the rendered page text, lean-capped. This is THE way to reach Facebook, Instagram, or any signed-in site when the user asks you to look at one; use tavily for public web. Serialized with background chrome scrape workers; on "bridge busy" simply retry in a moment.',
                        '',
                        'action="pause": USER BRAKE. Pass minutes (default 10). Trips the conductor\'s soft-rest: in-flight workers finish, NO new dispatch until expiry or action="resume". When the user says "pause", "stop for a while", "hold off" — call this, never claim you cannot pause the system. action="resume" (or the pause expiring) resumes with a fresh work window.',
                        '',
                        'action="signal": BIRD-DOG a demand post you cannot attribute yet. When you see someone ASKING for an event vendor/planner/entertainment (an "ask" post) but cannot capture their name or contact, call signal with url (the post/page) and note (the VERBATIM demand text + any date/venue mentioned; channel optional, auto-detected for fb/ig). The server queues a DRILL_DOWN task; a worker chases the poster to a real person + booking. NEVER save a sparse/unnamed client instead, and NEVER drop the demand on the floor — signal it.',
                        '',
                        'action="plan_tasks" focus: optional user steering directive. focus:"factlets" = drain the unprocessed-factlet backlog and create NO other task types (only APPLY_FACTLET / JUDGE_AFFECTED / BOUNCE_SWEEP / SHOW_HOT_LEEDZ) until the backlog reaches the discovery-pause threshold, then focus auto-clears. focus:"none" clears immediately. In-flight tasks are never cancelled — focus only stops NEW work. When the user says "process the factlets, nothing else" call plan_tasks({ mode:"workflow", focus:"factlets" }). targetHot: the run goal — N>0 = auto-stop after N NEW hot leedz (launcher default 1); an explicit 0 = continuous ("don\'t bother me"). Update mid-session with one plan_tasks call.',
                        '',
                        'action="enqueue": USER-ORDERED TASK for ONE named client — the front-of-queue lever. When the user names a specific client/company and asks to drill, dig into, research, or enrich it ("DRILL_DOWN Rock Dimension", "dig into Acme Corp", "find their upcoming events"), THIS is the ONE correct call — NEVER plan_tasks (system-wide, cannot target a client) and NEVER an explanation of why you cannot. Pass client:"<name substring>" (or clientId), optional type ("DRILL_DOWN" default | "ENRICH_CLIENT" | "FIND_CLIENT_SOURCES"), optional missing[] gap codes (server derives sensible defaults from the client record). The task bypasses planner budgets, is timestamped to the FRONT of the queue (drills dispatch before all other work), and the conductor is auto-armed if dormant. Returns ENQUEUED/BUMPED_TO_FRONT with taskId, ALREADY_RUNNING if a worker holds it, or AMBIGUOUS with candidates[] (re-call with clientId). Quote the literal status to the user, then continue what you were doing.',
                        '',
                        'action="status": Read system state. Pass report=true (ALWAYS do this when a user asked for status/progress/a report) to get ONLY the pre-formatted human report text -- output it exactly as returned, never summarize it. Without report=true returns the full JSON { report, config, stats, completeness, readyDrafts, brewingCount } for programmatic use.',
                        '',
                        'action="ignore": PERMANENT BLACKLIST for a named company or person. When the user says "ignore X", "blacklist X", "never show me X again", "no more X" -- this is the ONE correct call: pass term:"<the name>". Server-side it dismisses every existing matching booking (cold forever), cancels open tasks on them, and refuses ALL future saves mentioning the term (stored in DOCS/BLACKLIST.md, survives restarts). Effective immediately. Returns { ignored, dismissedBookings, clientsReset, cancelledOpenTasks }. Distinct from dismiss_booking (one booking only) -- ignore kills the name everywhere, forever.',
                        '',
                        'action="get_config": Read ONE identity/config field by key. Pass key, one of: signature, sampleEmail, companyName, companyEmail, businessDescription, defaultTrade, leedzEmail, defaultBookingAction. Returns { key, value, present }. key="sampleEmail" is the seller\'s approved outreach email — the MANDATORY template every outreach draft REWRITES (never compose an email from scratch); key="signature" is the verbatim sign-off block. Both are always present. Omit key to get the full VALUE_PROP profile (trade, pitch, buyerRoles, serviceZips, forbiddenPhrases, ...). Never returns secrets.',
                        '',
                        'action="configure": RETIRED — config is read-only at runtime; this action always errors. To read identity fields use action="get_config". To change them, edit DOCS/VALUE_PROP.md (identity, trade, signature, sample email) or precrime_config.json (LLM, runtime) and restart the server.',
                        '',
                        'action="next": Atomically claim the next work item and return it fully hydrated. Pass entity="client" (default) or entity="booking". For clients: returns the client record with all linked factlets and bookings in one payload. The lastQueueCheck is stamped before return so no other agent claims it. Pass optional criteria to filter (company, name, draftStatus). Returns null if queue is empty. Response is automatically trimmed for context efficiency: dossier tail-clipped to last 2000 chars (or override via dossierLimit), factlets capped to 8 most recent (or override via factletLimit). Pass 0 to disable a cap. _clipped metadata is included if anything was trimmed.',
                        '',
                        'action="save": Atomically persist client work in a single transaction. Two modes: (1) UPDATE existing client - pass id and patch with any of: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, clientClass, factlets[], bookings[]. clientClass: "host" (default) | "booker" -- set "booker" when the client is an agency / event planner / venue coordinator who books entertainment FOR CLIENTS (they get roster-pitch outreach, not single-event outreach). (2) CREATE new client - omit id, patch must include name OR company. Company-only sparse records are allowed when relevant; enrichment fills person/email later. Optional fields: email, phone, website, segment, source, factlets[], bookings[]. After persisting, refreshes the client enrichment signal AND re-classifies every booking under that client to cold / brewing / hot via the procedural gates (server/mcp/classification.js) plus the LLM product-market-fit judge. See DOCS/CLASSIFICATION.md.',
                        '',
                        'action="delete": Permanently remove records. Pass target ("booking" | "client" | "factlet") plus ONE of: id (single record), ids (array of ids), or search (substring matched across the record\'s identity fields — client: name/company/segment/email; booking: title/description/location; factlet: title/content). For target="client", attached bookings cascade. Open tasks targeting deleted rows are auto-cancelled. Returns { deleted, target, matched, deletedClients, deletedBookings, deletedFactlets, cancelledOpenTasks }. Use this for ANY removal, including bulk ("delete ALL comic con rows" -> one call with search:"comic con"). NEVER touch the database by any other means — no shell, no scripts, no sqlite: this action is the only sanctioned delete path.',
                        '',
                        'action="rescore": Re-classify every booking to cold / brewing / hot (procedural gates + LLM judge). Use after editing DOCS/CLASSIFICATION.md policy or DOCS/SCORING.json knobs. Pass scope="all" (default), scope="hot" to sanity-check the current hot queue, or scope=<clientId> to limit to one client. Add procedural=true for a TOKEN-FREE demote-only sweep (gates only, no LLM) -- e.g. {scope:"hot", procedural:true} cheaply scrubs legacy mis-scored hot leedz. Returns counts: rescored, changed, before/after status distribution.',
                        '',
                        'action="resolve_dates": STRUCTURED-ONLY. Server-side date validation + tz-aware epoch math. Required: start { year, month, day, hour, minute, ampm? }, end { year, month, day, hour, minute, ampm? }, timezone (IANA, e.g. "America/Los_Angeles"). Optional: zip (echoed only -- zip-to-tz derivation NOT supported), rawText (informational evidence only -- timezone smuggled inside rawText is REJECTED), sourceProof. The LLM is forbidden from computing epoch ms; it must only extract the structured fields. Returns { ok, st, et, startIso, endIso, timezone, zip, warnings } on success, or { ok:false, errors:[fieldName:reason] } on failure.',
                        '',
                        'action="share_booking": ONLY normal path to marketplace posting. Required: bookingId, mode ("draft" | "post"). FORBIDDEN inputs: st, et (LLM-supplied epochs are rejected by name). Loads the Booking + Client, rescores via judgeAffected, requires status hot, then converts the Booking\'s already-verified wall-clock dates (set at enrichment) to a tz-correct epoch -- no re-resolution. In "draft" mode returns the addLeed payload + humanReadable verification block. In "post" mode posts to Leedz and records leedId/sharedAt.',
                        '',
                        'action="report_session"/"audit_session": Read-only session summaries (audit_session auto-picks the most recent session if no session_id). Sessions are an audit artifact of a run; the orchestrator does NOT open them. To summarize a workflow run, prefer action="status" (live booking/task counts).',
                        '',
                        'action="audit_session": Show what the agent ACTUALLY did this session — saves, failures, shares, raw event log from the server. THIS IS THE TOOL TO USE when the user says "show the audit", "what did you do", "what did you save", "show your work", "audit", "show me what happened", or any progress check. Returns the unfakeable server-side event record, not the agent\'s memory. session_id is OPTIONAL — if omitted, audits the most recent session automatically. NEVER substitute action=status for an audit request — status returns config snapshots, not the work record.',
                        '',
                        'action="next_source": Atomically claim the oldest unscraped or stale source URL from the queue. Pass optional channel ("directory"|"rss"|"fb"|"ig"|"reddit"|"x"|"blog"|"website") to filter. Optional maxAgeDays (default 30) -- sources scraped longer ago than this are eligible for re-scrape. Optional session_id stamps the claim. Returns { status: "CLAIMED", id, url, channel, subtype, label, category, discoveredFrom, previouslyScrapedAt } or { status: "QUEUE_EMPTY", channel } when nothing is available. Stale claims (>10min with no mark_source) are eligible for re-claim. THIS REPLACES reading discovered_directories.md by hand.',
                        '',
                        'action="mark_source": Release the claim and persist the scrape result. REQUIRED url (the URL returned by next_source). Optional scrapedAt (ISO datetime, defaults to now), clientsFound (integer), failedReason (string for failures). Pair this with every next_source -- if you do not mark, the row stays claimed for 10 minutes then becomes claimable again. THIS REPLACES "echo url ^| scraped:date >> discovered_directories.md".',
                        '',
                        'action="add_sources": Bulk-insert new source URLs discovered during scraping. REQUIRED entries[] -- non-empty array of { url, channel, subtype?, label?, category?, discoveredFrom? }. Channel must be one of the eight allowed values. URLs are normalized to canonical form (handle/tag inputs like "@account" or "r/sub" become full URLs). Returns { added, duplicates, invalid[] }. Dedup is on URL. THIS REPLACES every "echo line >> *_sources.md" shell command in every harvester and source-discovery skill.',
                        '',
                        'action="import_sources": DEPRECATED. Markdown is the single source of truth: the server reads data/sources/<channel>.md into an in-memory index at startup, so there is no separate import step. This action just re-reads those files and returns the live per-channel counts. There is no Source table.',
                        '',
                        'action="work_status": Live operational snapshot -- the answer to "what workers are running right now / what is the conductor doing / why is nothing progressing". Returns conductor{ armed, running (count), workers[{type, task, elapsedSec}], resting/halted + reason, hotProduced/hotTarget } PLUS source/client/booking counts and a recommendation. The conductor runs in THIS server process, so this reflects the true in-flight worker set. Use it whenever asked what is running or active.',
                        '',
                        'action="bounce_sweep": Run a Gmail bounce check RIGHT NOW, synchronously, and return the REAL result -- { addresses, scanned, flagged, reason, summary }. Use this whenever the user says "run BOUNCE_SWEEP", "check for bounces", or "did the bounce sweep run". Do NOT call plan_tasks for this and do NOT report success from a "queue seeded" message -- plan_tasks only ENQUEUES a background sweep (cooldown-gated, may create nothing) and tells you nothing about the outcome. This action bypasses the queue and the cooldown entirely; ALWAYS quote the literal result (per the tool-call honesty rule) -- reason:"no_gmail_token" or "gmail_readonly_scope_missing" means the Gmail extension token needs refreshing, not a fabricated success.'
                    ].join('\n'),
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['status', 'configure', 'get_config', 'get_task', 'next', 'save', 'delete', 'rescore', 'resolve_dates', 'share_booking', 'dismiss_booking', 'ignore', 'report_session', 'audit_session', 'next_source', 'mark_source', 'add_sources', 'import_sources', 'work_status', 'judge_affected', 'plan_tasks', 'enqueue', 'claim_task', 'complete_task', 'tasks', 'recycler', 'bounce_sweep', 'browse', 'signal', 'pause', 'resume', 'mark_sent', 'mark_bounced'],
                                description: 'Which pipeline operation to run.'
                            },
                            term: {
                                type: 'string',
                                description: 'For action=ignore: the company/person name to permanently blacklist (>= 3 chars, substring-matched against all client and booking identity text -- keep it specific: "Rivian" yes, "LA Auto Show" NO, that would kill every exhibitor at the show).'
                            },
                            report: {
                                type: 'boolean',
                                description: 'For action=status: true returns ONLY the pre-formatted human report text (no JSON). Always pass true when answering a user status request; echo the result verbatim.'
                            },
                            key: {
                                type: 'string',
                                description: 'For action=get_config: which field to read. One of: signature, sampleEmail (the MANDATORY outreach email template), companyName, companyEmail, businessDescription, defaultTrade, leedzEmail, defaultBookingAction.'
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
                                description: 'For action=share_booking: Booking.id to share. For action=dismiss_booking: a single Booking.id to permanently skip (or use bookingIds[] to dismiss many in ONE call). For action=enqueue type=DRAFT_OUTREACH: the Booking.id to draft outreach for.'
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
                                description: 'For action=mark_source: the URL returned by next_source. For action=browse / action=signal: the page or post URL.'
                            },
                            note: {
                                type: 'string',
                                description: 'For action=signal: the VERBATIM demand text seen on the page (who is asking, for what, any date/venue mentioned).'
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
                            session_id: {
                                type: 'string',
                                description: 'For action=report_session/audit_session: which session to summarize (audit_session auto-picks the most recent if omitted). Sessions are an audit artifact; the orchestrator does NOT open them (start_session is disabled -- the Node conductor owns all dispatch).'
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
                                description: 'For action=delete only. Which kind of record to delete. id/ids/search must resolve to records of this type.'
                            },
                            ids: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=delete only. Multiple record IDs to delete in one call (alternative to id/search).'
                            },
                            search: {
                                type: 'string',
                                description: 'For action=delete only. Delete EVERY record of the target type whose identity fields contain this substring (case-insensitive). One call replaces any bulk-delete loop — never script deletions yourself.'
                            },
                            patch: {
                                type: 'object',
                                description: 'For action=save or action=configure. For save UPDATE: dossierAppend, draft, draftStatus, targetUrls, intelScore, name, email, phone, company, website, clientNotes, segment, clientClass ("host"|"booker"), factlets[], bookings[]. For save CREATE (no id): name OR company is required; sparse company-only records are allowed when relevant. Optional: email, phone, website, segment, source, factlets[], bookings[]. For configure: any Config model fields.',
                                // Declared so strict upstream validators (Groq et al.) accept
                                // legitimate worker saves; additionalProperties stays open via
                                // relaxObjectNodes below.
                                properties: {
                                    name:          { type: 'string' },
                                    email:         { type: 'string' },
                                    phone:         { type: 'string' },
                                    company:       { type: 'string' },
                                    website:       { type: 'string' },
                                    clientNotes:   { type: 'string' },
                                    segment:       { type: 'string' },
                                    source:        { type: 'string' },
                                    dossierAppend: { type: 'string', description: 'Text appended to the client dossier (server stamps the date).' },
                                    draft:         { type: 'string' },
                                    draftStatus:   { type: 'string', enum: ['brewing', 'ready', 'sent'] },
                                    targetUrls:    { description: 'JSON array [{url, type, label}] (array or pre-serialized string).' },
                                    intelScore:    { type: 'number' },
                                    factlets: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                content: { type: 'string' },
                                                source:  { type: 'string' }
                                            },
                                            required: ['content']
                                        }
                                    },
                                    bookings: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                title:       { type: 'string' },
                                                description: { type: 'string' },
                                                notes:       { type: 'string' },
                                                location:    { type: 'string' },
                                                startDate:   { type: 'string' },
                                                endDate:     { type: 'string' },
                                                startTime:   { type: 'string' },
                                                endTime:     { type: 'string' },
                                                duration:    { type: 'number' },
                                                hourlyRate:  { type: 'number' },
                                                flatRate:    { type: 'number' },
                                                totalAmount: { type: 'number' },
                                                status:      { type: 'string' },
                                                source:      { type: 'string' },
                                                sourceUrl:   { type: 'string' },
                                                trade:       { type: 'string' },
                                                zip:         { type: 'string' }
                                            }
                                        }
                                    }
                                }
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
                                description: 'For action=complete_task. Result blob, e.g. { clientIds:[], bookingIds:[], factletIds:[], sourceIds:[], summary, needsJudge }. Pass the object directly, NOT a JSON string.',
                                properties: {
                                    clientIds:  { type: 'array', items: { type: 'string' } },
                                    bookingIds: { type: 'array', items: { type: 'string' } },
                                    factletIds: { type: 'array', items: { type: 'string' } },
                                    sourceIds:  { type: 'array', items: { type: 'string' } },
                                    summary:    { type: 'string' },
                                    needsJudge: { type: 'boolean' }
                                }
                            },
                            error: {
                                type: 'string',
                                description: 'For action=complete_task with status "failed"/"cancelled". Short error code.'
                            },
                            client: {
                                type: 'string',
                                description: 'For action=enqueue: name/company/email substring identifying ONE client (e.g. "Rock Dimension"). Multiple matches return AMBIGUOUS with candidates -- re-call with clientId.'
                            },
                            clientId: {
                                type: 'string',
                                description: 'For action=enqueue: exact Client.id to target. Wins over client when both are passed.'
                            },
                            type: {
                                type: 'string',
                                description: 'For action=enqueue: task type to create -- DRILL_DOWN (default; find missing contact/upcoming events), ENRICH_CLIENT, FIND_CLIENT_SOURCES (all take client/clientId), or DRAFT_OUTREACH (takes bookingId; the draft worker rewrites the VALUE_PROP Sample Email from the dossier and puts the draft in the Gmail Drafts folder -- NEVER compose outreach yourself). For action=tasks: optional filter, any task type.'
                            },
                            missing: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'For action=enqueue with type DRILL_DOWN (optional): gap codes to hunt (client_email, client_email_generic, booking, start_date, location_with_zip, title). Omit to let the server derive them from the client record.'
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
                                description: 'For action=judge_affected: Booking ids to (re-)judge. For action=dismiss_booking: Booking ids to permanently skip in ONE batch call (preferred for "dismiss all" — never loop one-id status writes). Pass the array DIRECTLY, NOT a JSON string.'
                            },
                            reason: {
                                type: 'string',
                                description: 'For action=judge_affected. Optional audit note.'
                            },
                            writeStatus: {
                                type: 'boolean',
                                description: 'For action=judge_affected. Default true; pass false to compute without persisting Booking.status.'
                            },
                            completeTask: {
                                type: 'object',
                                description: 'For action=save (optional): fold the terminal complete_task INTO this save to remove a whole turn. On a SUCCESSFUL save the server marks the task terminal — do NOT also call action=complete_task. Pass { taskId, status:"done"|"failed"|"cancelled", output?, error? }; output has the same shape as complete_task output (clientIds, bookingIds, factletIds, sourceIds, summary, needsJudge). Multi-save workers pass completeTask ONLY on their FINAL save, with output ids accumulated across all their saves.',
                                properties: {
                                    taskId: { type: 'string' },
                                    status: { type: 'string', enum: ['done', 'failed', 'cancelled'] },
                                    output: {
                                        type: 'object',
                                        properties: {
                                            clientIds:  { type: 'array', items: { type: 'string' } },
                                            bookingIds: { type: 'array', items: { type: 'string' } },
                                            factletIds: { type: 'array', items: { type: 'string' } },
                                            sourceIds:  { type: 'array', items: { type: 'string' } },
                                            summary:    { type: 'string' },
                                            needsJudge: { type: 'boolean' }
                                        }
                                    },
                                    error: { type: 'string' }
                                }
                                // NO nested `required`: a strict upstream rejecting the whole
                                // call orphans the worker, while the server handles a missing
                                // field gracefully. Requiredness is documented in the description.
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
                        'action="bookings": Search bookings by status, trade, keyword (checks title, description, notes, location). Returns bookings with slim client stub. Default limit 20. Sorted by createdAt descending. CALENDAR (any year, ignores the year entirely): filters.monthIn:[9,10] returns every booking whose start month is September or October in ANY year, calendar-ordered; filters.anniversaryWithinDays:60 returns bookings whose month/day falls within 60 days of TODAY (cyclic, wraps Dec->Jan), soonest first -- use this for "who should I proactively re-contact" / upcoming-anniversary requests. These do the month math in code; never estimate or filter by year yourself when the user asked for "any year" or "anniversaries" -- there is no other way to answer that correctly. If the result array\'s last element has _truncated:true, more matches exist than were returned (totalMatched in that element) -- say so, do not claim the list is complete.',
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
                                description: 'Action-specific filters. All actions: id (fetch one record by id). clients: search, name, email, company, exactCompany (exact dedup match), segment, source, draftStatus, warmthScore, minWarmthScore, maxWarmthScore. bookings: status, trade, source, search, shared (boolean), future (boolean, startDate >= now), startDateGte (ISO date), monthIn (array of 1-12, any year), anniversaryWithinDays (number, cyclic proximity to today). factlets: sinceTimestamp, clientId. drafts: minScore.',
                                properties: {
                                    id: {
                                        type: 'string',
                                        description: 'Fetch a single record by its id (any action). Not combinable with other filters.'
                                    },
                                    search:         { type: 'string' },
                                    name:           { type: 'string' },
                                    email:          { type: 'string' },
                                    company:        { type: 'string' },
                                    exactCompany: {
                                        type: 'string',
                                        description: 'clients only: exact (case-insensitive) company match, for dedup lookups before creating a new client.'
                                    },
                                    segment:        { type: 'string' },
                                    // Provenance prefix match -- how an entire import cohort is
                                    // recovered later, e.g. source:"square:" for every Square customer.
                                    source:         { type: 'string' },
                                    draftStatus:    { type: 'string' },
                                    warmthScore:    { type: 'number' },
                                    minWarmthScore: { type: 'number' },
                                    maxWarmthScore: { type: 'number' },
                                    status:         { type: 'string' },
                                    trade:          { type: 'string' },
                                    sinceTimestamp: { type: 'string' },
                                    clientId:       { type: 'string' },
                                    minScore:       { type: 'number' },
                                    shared: {
                                        type: 'boolean',
                                        description: 'bookings only: filter by whether the booking has already been shared.'
                                    },
                                    future: {
                                        type: 'boolean',
                                        description: 'bookings only: when true, only bookings with startDate >= now.'
                                    },
                                    startDateGte: {
                                        type: 'string',
                                        description: 'bookings only: ISO date string, only bookings starting on or after this date.'
                                    },
                                    monthIn: {
                                        type: 'array', items: { type: 'number' },
                                        description: 'bookings only: calendar months 1-12, any year (e.g. [9,10] for Sept/Oct across all years).'
                                    },
                                    anniversaryWithinDays: {
                                        type: 'number',
                                        description: 'bookings only: within N days of TODAY\'s month/day, cyclic across the year boundary. For "upcoming anniversary" / proactive-recontact requests.'
                                    }
                                }
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

// ============================================================================
// Per-worker action scoping (served at tools/list, keyed on ?scope=<taskType>).
// A spawned worker uses only a handful of the pipeline's ~25 actions; the rest are
// orchestrator/interactive-only, and several (share_booking, plan_tasks, judge_affected,
// claim_task) are EXPLICITLY forbidden to workers by the skills. So a worker's tools/list
// can advertise a PRUNED pipeline — smaller action enum, only the relevant action
// description fragments, and only the properties those actions use — cutting the per-turn
// schema token tax with ZERO extra round-trips (pruning happens once, at connect time).
//
// Safe by construction: an unknown/absent scope returns the FULL TOOL_DEFS, so the
// interactive orchestrator and claude workers (which connect WITHOUT ?scope) are unchanged.
// ============================================================================

// taskType -> the EXACT pipeline actions that type's deployed skill actually calls (verified by
// grepping templates/skills/*.md). Scope is per-type, NOT one flat set: an action a skill's own
// prose forbids must not be in that type's schema, or a weak model calls it anyway (the get_task
// orphan bug generalized). Concretely this removes: resolve_dates + next_source (NO worker calls
// either), save/next_source/mark_source from DISCOVER_SOURCES (its skill says "Never call" them),
// and next_source/mark_source from the drill/enrich types. toolDefs.test.js locks this per type.
// get_task is absent everywhere: Half A injects the task as the ASSIGNED TASK packet.
// Scopes now DERIVE from workerManifest.js (2026-08-06) -- the one table of
// worker capability shared with db.js (skill map) and conductor.js (recipe
// extensions). Edit the manifest, never a local copy here.
const { WORKER_MANIFEST } = require('./workerManifest');
const SCOPE_ACTIONS = Object.fromEntries(
    Object.entries(WORKER_MANIFEST).map(([t, m]) => [t, m.actions]));
// Union of every per-type scope — used only where a generic "is this a worker action" check is
// needed. Never used AS a scope (that would re-grant forbidden actions).
const WORKER_ACTIONS = [...new Set(Object.values(SCOPE_ACTIONS).flat())];

function _prunePipeline(pipeline, allowedActions) {
    const allow = new Set(allowedActions);
    // Description: the fragments were join('\n') over ['header','',frag,'',frag,...], so
    // fragments are blank-line separated. Keep only allowed action fragments; drop the
    // original enumerated header and replace it with a scoped one. (get_task/complete_task
    // have no prose fragment — they are documented by their properties + the header list.)
    const segs = String(pipeline.description).split('\n\n');
    const keptFrags = segs.filter(s => {
        const m = s.match(/^action="([^"]+)"/);
        return m && allow.has(m[1]);
    });
    const header = 'Pre-Crime workflow operations. These are ACTIONS of THIS one `pipeline` tool, NOT standalone tools — call `pipeline` with action:"<name>" (there is no separate save/complete_task/get_task/etc. tool). Actions available for this task: ' + allowedActions.join(', ') + '.';
    const description = [header, ...keptFrags].join('\n\n');
    // Properties: keep `action` (with a pruned enum) + every property that is shared (its
    // description names no action) or references at least one allowed action. This drops
    // properties used ONLY by disallowed actions (share_booking epochs, session ids, rescore
    // knobs, next filters, claim_task/judge_affected params, ...). The dispatch reads args.*
    // directly and never validates against the advertised schema, so trimming a property only
    // changes what the MODEL sees — it can never reject a call the server would have accepted.
    // A property's actions are matched by the "action=<name>" convention AND by bare action
    // name: several props name their action WITHOUT the prefix ("FORBIDDEN on share_booking",
    // "DEPRECATED. Structured resolve_dates ..."), so an action=-only scan mis-read them as
    // shared and leaked share_booking/resolve_dates props (st, et, dtDraft, titleDraft, rqDraft,
    // defaultDurationHours) into every worker scope. \b treats "_" as a word char, so
    // "next_source" matches atomically and never as a stray "next".
    const props = pipeline.inputSchema.properties;
    const ACTION_NAMES = pipeline.inputSchema.properties.action.enum || [];
    const prunedProps = {};
    for (const [name, def] of Object.entries(props)) {
        if (name === 'action') { prunedProps.action = { ...def, enum: allowedActions.slice() }; continue; }
        const desc = String(def.description || '');
        const mentioned = ACTION_NAMES.filter(a => new RegExp(`\\b${a}\\b`).test(desc));
        if (mentioned.length === 0) { prunedProps[name] = def; continue; }        // shared param
        if (mentioned.some(a => allow.has(a))) prunedProps[name] = def;
    }
    return { ...pipeline, description, inputSchema: { ...pipeline.inputSchema, properties: prunedProps } };
}

// Which of the precrime tools each worker scope's skill actually calls (2026-07-19
// context trim): scrapers never call find/trades; only discover-sources uses trades.
// Dropping an unused tool removes its whole schema from EVERY turn of that worker.
const SCOPE_TOOLS = Object.fromEntries(
    Object.entries(WORKER_MANIFEST).map(([t, m]) => [t, m.tools]));

// Return the tools/list payload for a given connection scope. No/unknown scope => full set.
function scopedToolDefs(scope) {
    const allowed = scope && SCOPE_ACTIONS[scope];
    if (!allowed) return TOOL_DEFS;
    const keep = new Set(SCOPE_TOOLS[scope] || ['pipeline', 'find', 'trades']);
    return TOOL_DEFS
        .filter(t => keep.has(t.name))
        .map(t => t.name === 'pipeline' ? _prunePipeline(t, allowed) : t);
}

// ---------------------------------------------------------------------------
// Strict-upstream armor. Some OpenAI-compatible hosts reached via OpenRouter
// (Groq, observed 2026-07-16) validate tool-call arguments STRICTLY against
// this schema and treat any object node WITHOUT an explicit additionalProperties
// as additionalProperties:false. A bare { type:'object' } then rejects EVERY
// key inside it ("/patch: additionalProperties 'phone' not allowed") and the
// worker dies orphaned mid-task — while lenient hosts accept the identical
// call, so failures flake with provider routing. The server dispatch reads
// only the args it knows and never validates against this schema, so unknown
// keys are harmless: stamp additionalProperties:true on every object node
// (a node that explicitly sets its own value is left alone). Runs once at
// require time, before any tools/list is served; _prunePipeline copies
// property nodes whole, so scoped worker schemas inherit the stamp.
// ---------------------------------------------------------------------------
function relaxObjectNodes(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(relaxObjectNodes); return; }
    if (node.type === 'object' && node.additionalProperties === undefined) {
        node.additionalProperties = true;
    }
    if (node.properties) Object.values(node.properties).forEach(relaxObjectNodes);
    if (node.items) relaxObjectNodes(node.items);
}
TOOL_DEFS.forEach(t => relaxObjectNodes(t.inputSchema));

module.exports = { TOOL_DEFS, scopedToolDefs };
