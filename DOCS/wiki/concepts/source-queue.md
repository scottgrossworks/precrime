---
title: Source Queue (Pass 2) — DB-backed work-stealing queue
tags: [source, queue, mcp, pipeline, recursion, pass-2, work-stealing]
source_docs: [server/prisma/schema.prisma, server/mcp/mcp_server.js, templates/skills/url-loop.md, templates/skills/source-discovery.md, templates/docs/FOUNDATION.md]
last_updated: 2026-05-06
staleness: none
---

The Source Queue is the DB-backed replacement for the markdown-as-queue pattern (`discovered_directories.md`, `*_sources.md`). It moves the URL queue out of the agent's context window and out of cmd.exe shell escape land, into a Prisma table the server claims atomically.

This is **Pass 2** of the workflow refactor. Pass 1 made flow control numbered and explicit; Pass 2 moves the queue server-side so weaker orchestrators (goose, hermes, any tool-calling LLM) cannot drift.

---

## Why

Before Pass 2, every URL the agent might scrape lived as a line in a markdown file. To add a URL, the agent ran `echo url ^| label >> "<path>"`. To pop one, the agent read the whole file and picked the first un-stamped line. This pattern had four hard problems:

1. **Silent no-ops.** If the agent's cmd.exe escape syntax was wrong (`^^^^`, `^&`, missing `>>`), Windows wrote nothing but reported success. The queue stopped growing and the run died early.
2. **Token waste.** Reading the whole file each iteration to find one URL.
3. **No concurrency safety.** Two agents would clobber each other's appends.
4. **No claim semantics.** If an agent died mid-scrape, no other agent could safely take over.

Pass 2 fixes all four.

---

## The `Source` table

Defined in `server/prisma/schema.prisma`. Every dereferenceable discovery target is one row.

```prisma
model Source {
  id             String    @id @default(cuid())
  url            String    @unique             // canonical normalized URL
  channel        String                         // directory|rss|fb|ig|reddit|x|blog|website
  subtype        String?                        // page|group|account|hashtag|keyword|feed|subreddit
  label          String?
  category       String?
  scrapedAt      DateTime?
  claimedAt      DateTime?                      // for atomic claim
  claimedBy      String?                        // session_id holding the claim
  clientsFound   Int       @default(0)
  failedReason   String?
  discoveredAt   DateTime  @default(now())
  discoveredFrom String?                        // url of source that linked here
  @@index([channel])
  @@index([scrapedAt])
  @@index([claimedAt])
}
```

The unique constraint on `url` is the dedup primitive. The `claimedAt` + `claimedBy` pair plus a 10-minute timeout is the work-stealing primitive.

URL is canonical and normalized. Handle/tag inputs (`@handle`, `#hashtag`, `r/sub`) are converted to full URLs at insert time so the unique key actually catches duplicates regardless of how the source was originally specified.

---

## The four MCP actions

Added to `precrime__pipeline` in `server/mcp/mcp_server.js`.

### `pipeline.next_source({channel?, maxAgeDays?, session_id?})`

Atomically claim the oldest unscraped or stale source row. Returns one of:

```json
{ "status": "CLAIMED", "id": "...", "url": "...", "channel": "directory",
  "subtype": "...", "label": "...", "category": "...",
  "discoveredFrom": "...", "previouslyScrapedAt": null }
```

```json
{ "status": "QUEUE_EMPTY", "channel": "any",
  "hint": "Run skills/source-discovery.md to grow the queue, then call next_source again." }
```

Eligibility for claim (in order of preference):
1. `scrapedAt IS NULL AND claimedAt IS NULL` — pristine, never scraped.
2. `scrapedAt IS NULL AND claimedAt < now-10min` — stale claim from a dead agent.
3. `scrapedAt < now - maxAgeDays` — re-scrape candidate.

Optional `channel` filters to one channel; omit to claim from any. Optional `session_id` stamps the claim so audits can trace which session locked which row. Optional `maxAgeDays` defaults to 30.

### `pipeline.mark_source({url, scrapedAt?, clientsFound?, failedReason?})`

Releases the claim and persists the result. `scrapedAt` defaults to now. `clientsFound` records how many distinct contacts/companies were saved from the page. `failedReason` is set only on scrape failure — it does NOT prevent re-scrape (a future run with `maxAgeDays` past will retry).

Pair every `next_source` with a `mark_source`. If the agent dies between them, the row stays claimed for 10 minutes then becomes claimable again. No watchdog needed beyond the timeout.

### `pipeline.add_sources({entries: [...]})`

Bulk insert with dedup-on-URL. Each entry: `{url, channel, subtype?, label?, category?, discoveredFrom?}`. Returns `{added, duplicates, invalid[]}`.

Channels: `directory`, `rss`, `fb`, `ig`, `reddit`, `x`, `blog`, `website`. Server normalizes channel-specific shorthand:
- `r/foo` → `https://www.reddit.com/r/foo`
- `@handle` (channel `ig`) → `https://www.instagram.com/handle/`
- `#tag` (channel `ig`) → `https://www.instagram.com/explore/tags/tag/`
- `@account` (channel `x`) → `https://x.com/account`

`discoveredFrom` records the URL of the parent source that linked here — recursion lineage. Audits can later identify which sources are productive and which are dead ends.

This action replaces every `echo url >> *_sources.md` shell command in every harvester and source-discovery skill.

### `pipeline.import_sources()`

One-time migration. Reads every seed file under `skills/`:

- `skills/source-discovery/discovered_directories.md`
- `skills/rss-factlet-harvester/rss_sources.md`
- `skills/fb-factlet-harvester/fb_sources.md`
- `skills/ig-factlet-harvester/ig_sources.md`
- `skills/reddit-factlet-harvester/reddit_sources.md`
- `skills/x-factlet-harvester/x_sources.md`

Parses each (handles directory `|`-format, RSS `url|name|category` format, plain URL lists, handle/tag lists), then bulk-loads into the Source table. Idempotent — duplicates are silently skipped.

Called by `init-wizard.md` Step 1.5 on every startup. Cheap to re-run; safe to re-run after editing seed files.

The seed files are read once at import. Agents never read them during a run — the queue lives in the DB.

---

## Recursion arms re-routed through the table

The three recursion arms documented in `FOUNDATION.md` now all flow through `Source`:

| Arm | Pre-Pass-2 path | Pass 2 path |
|---|---|---|
| Source recursion | scrape → `echo url >> _sources.md` | scrape → `add_sources` |
| Client recursion | unchanged: scrape → `pipeline.save` → enrichment picks up via `pipeline.next` `lastEnrichedBefore` cursor | (same) |
| Booking recursion | unchanged: every `save` auto-rescores attached bookings | (same) |

Source recursion is the loud one — every page scraped feeds the queue. Pass 2 makes that arm reliable.

---

## Work-stealing semantics

Two agents can run concurrently. Each `next_source` call is atomic at the DB level (Prisma `findFirst` + `update` on the candidate row). Worst case race: two agents pick the same candidate before either updates. The one that loses the update writes a stale `claimedAt`, but they both go on to scrape independently. Their saves dedup by company at `pipeline.save`. Their `mark_source` calls both succeed (idempotent — last-write-wins on `scrapedAt` and `clientsFound`).

If an agent crashes between `next_source` and `mark_source`:
- 10 minutes pass.
- Next agent's `next_source` query matches the stale claim eligibility (`claimedAt < now-10min`).
- That agent claims and re-scrapes. No data loss; one wasted scrape at most.

---

## Startup migration

`server/mcp/mcp_server.js` runs `ensureSourceTable()` on every boot:

```sql
CREATE TABLE IF NOT EXISTS Source (...);
CREATE UNIQUE INDEX IF NOT EXISTS Source_url_key ON Source(url);
CREATE INDEX IF NOT EXISTS Source_channel_idx ON Source(channel);
CREATE INDEX IF NOT EXISTS Source_scrapedAt_idx ON Source(scrapedAt);
CREATE INDEX IF NOT EXISTS Source_claimedAt_idx ON Source(claimedAt);
```

This is the safety net for deployments whose `myproject.sqlite` predates Pass 2. The schema change in `schema.prisma` plus regeneration via `npx prisma generate` (run by `setup.bat`) keeps the typed client in sync. `data/blank.sqlite` and `data/template.sqlite` should also be regenerated via `npx prisma db push --force-reset` per the three-file sync rule, but the CREATE TABLE IF NOT EXISTS means a stale shipped DB still works — the table is created on first MCP boot.

---

## What is NOT in the Source table

- **LLM queries** (Gemini, Grok). These are transient lookups inside `source-discovery.md`, not durable sources. If we ever batch-defer queries, that's a separate `Query` table — not this one.
- **Search keywords without a target site.** Bare keywords are turned into `https://x.com/search?q=...` URLs only when they're meant as `x.com` searches. Generic keywords for SESSION_AI prompts are not stored.
- **Per-client targetUrls.** Those live on `Client.targetUrls` (JSON), enriched per client. They're not part of the discovery queue.

The Source table is for **dereferenceable discovery sources only**. Stay disciplined; don't expand its scope without thinking through whether the new shape fits.

---

## Related

- [[ontology]] — Source entity in the v2 entity model
- [[mcp]] — full action surface of `precrime__pipeline`
- [[architecture]] — MCP layer + DB path resolution
- [[current]] — Pass 1 / Pass 2 session log
