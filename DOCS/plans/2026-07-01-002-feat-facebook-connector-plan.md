---
title: "feat: Facebook connector for last30days (Marketplace + Groups)"
type: feat
status: active
date: 2026-07-01
target_repo: last30days (vendored at PRECRIME/last30days/, upstream github.com/mvanhorn/last30days-skill)
governed_by: DOCS/Claude.md
supersedes_note: revises the earlier Facebook-connector plan — Ad Library dropped (advertiser skew), Marketplace Search is the new Phase 1
---

# feat: Facebook connector for last30days (Marketplace + Groups)

## Summary

Add Facebook as a `last30days` source so the LAST_30_DAYS worker can surface **buyer-intent**
event posts — the *"ISO caricature artist," "planning my quince, need entertainment"* posts that
live on Facebook, not on Reddit/TikTok. Two surfaces, sequenced:

- **Phase 1 — Marketplace Search** (`/v1/facebook/marketplace/search`): keyword + lat/lng +
  recency searchable, no URL resolution. Easy first win; the only keyword-searchable FB surface.
- **Phase 2 — Group Posts** (`/v1/facebook/group/posts`): grassroots buyer posts in local
  groups — the highest-intent surface, but SC has no group keyword-search, so group URLs are
  resolved externally (Tavily) and persisted as Sources.

Both run on the **existing ScrapeCreators key** (the $50 already spent). The connector mirrors
`lib/tiktok.py` and plugs into the existing source dispatch — no new architecture.

**The core discriminator is BUYER INTENT in the post text, not the source.** FB carries both
buyers and vendors; a text-intent filter (`ISO|looking for|need|wanted|planning|recommend`) is
built in from the start so we don't repeat the vendor flood we found on TikTok/IG.

Governed by `DOCS/Claude.md`: minimum code, reuse the tiktok.py contract, no overthinking. This
is Python (the last30days CLI), separate from the Node MCP server.

---

## Problem Frame

The 6-topic scan proved last30days surfaces mostly **vendors advertising** (TikTok/IG), with the
only real buyers being sparse **Reddit questions**. The buyer surface for event services —
individuals posting *"wanted / planning / ISO"* — is **Facebook local groups + Marketplace**,
which last30days does not scrape at all (confirmed: no `facebook` module). Adding it is what
turns the SC spend into buyer leads instead of a vendor gallery.

**Confirmed SC endpoints (docs.scrapecreators.com, 2026-07-01):**
- `GET /v1/facebook/marketplace/search` — required `x-api-key`, `query`, `lat`, `lng`; optional
  `radius_km`, `date_listed`, `sort_by` (`creation_time_descend` = newest), `count`, `cursor`,
  `availability`. Response per listing: `id`, `url`, `title`, `price{formatted_amount}`,
  `location{city,state,display_name}`, `primary_photo{url}`, `category_id`, `is_sold`,
  `story_type`; paginates via `cursor` + `has_next_page`. **Coordinate-based — no location-id lookup.**
- `GET /v1/facebook/group/posts?url=<public-group-url>` + `cursor` — 3 posts/call, PUBLIC groups
  only, ~1000 free reqs. Response per post: `{ id, text, url, author{name,id,profile},
  reactionCount, commentCount, topComments[]{text,timestamp,author} }`. **No group keyword-search.**
- (Dropped) Ad Library — searches *advertisers*; reproduces the vendor skew. Not used.

---

## Key Technical Decisions

- **Marketplace first, Groups second.** Marketplace is keyword+location+recency searchable with
  zero resolution — a clean, testable Phase 1. Groups are higher-intent but need URL resolution;
  build only if Marketplace under-delivers buyer posts.
- **Buyer-intent text filter is core, not optional.** Both surfaces carry vendor listings/ads.
  A shared `_is_buyer_intent(text)` (regex on `ISO|in search of|looking for|need(ed)?|wanted|
  planning|any recommendations|who did you use`) gates items INTO the buyer set. Vendor-looking
  items are dropped (or, later, tagged as competitor intel — out of scope here).
- **Mirror `lib/tiktok.py` exactly.** `search_and_enrich(...)` → normalized items
  `{text, url, author_name, date, engagement, relevance, why_relevant}` → 30-day date-filter →
  `{items}`. Dispatch is the `if source == "...":` switch in `pipeline.py`. Token via
  `env.get_facebook_token` reusing `SCRAPECREATORS_API_KEY`. Source name also added to
  `planner.py`, `normalize.py`, `render.py`, `signals.py`, and `INCLUDE_SOURCES`.
- **Location is config, not hardcoded.** LA metro (and OC) lat/lng + radius live in
  `precrime_config.json` `last30days.facebook`, since VALUE_PROP spans LA + SFV + OC. Default
  center LA (34.0522, -118.2437), radius ~48 km; optional second center for OC (Irvine ~33.68,
  -117.83) if one radius misses OC.
- **Event date ≠ listing/post date.** Marketplace `creation_time` and group post timestamp are
  when it was POSTED, not the event date. The event date is extracted from text downstream
  (the LAST_30_DAYS worker / verify already do date extraction) — the connector passes text through.

---

## Implementation Units

### U1. lib/facebook.py — Marketplace Search (Phase 1)

**Goal:** Keyword+location Marketplace search returning buyer-intent items.
**Files:** `last30days/skills/last30days/scripts/lib/facebook.py` (new).
**Approach:**
- `search_marketplace(topic, lat, lng, radius_km, since_date, token, count)` → GET
  `/v1/facebook/marketplace/search` with `query`=core subject (reuse `query.extract_core_subject`),
  `lat`/`lng`/`radius_km` from config, `sort_by=creation_time_descend`, cursor-paginate to `count`.
  Map each listing → `{ text: title, url, author_name: location.display_name, date: creation→YYYY-MM-DD,
  engagement:{}, relevance: relevance.token_overlap_relevance(topic, title),
  why_relevant: f"FB Marketplace: {location.city}" }`. Skip `is_sold`.
- `_is_buyer_intent(text)` — shared regex gate (see Key Decisions). Applied in `search_and_enrich`.
- `search_and_enrich(topic, ...)` — expand queries (mirror `expand_tiktok_queries`), merge/dedup by
  listing `id`, keep only `_is_buyer_intent` items, 30-day date-filter.
- `parse_facebook_response(result)` → `result["items"]`.
**Patterns to follow:** `lib/tiktok.py` (`search_and_enrich`, `parse_*`), `lib/dates.py` timestamp
helpers, `lib/relevance.py`.
**Test scenarios:**
- A Marketplace fixture with a mix of vendor listings ("Caricature artist for hire $175") and a
  buyer post ("ISO caricature artist for daughter's quince") keeps ONLY the buyer post.
- `is_sold:true` listings are dropped.
- Items older than 30 days are dropped; newest-first ordering preserved.
- Missing `title`/malformed listing is skipped without throwing.
**Verification:** `python last30days.py "caricature artist" --search facebook --emit=json` returns
Marketplace buyer items with location + date.

### U2. Wire facebook into the pipeline (Phase 1 activation)

**Goal:** Make `facebook` a first-class source.
**Files:** `lib/pipeline.py`, `lib/planner.py`, `lib/normalize.py`, `lib/render.py`,
`lib/signals.py`, `lib/env.py`, `scripts/bootstrap_config.js` (or the INCLUDE_SOURCES default),
`precrime_config.json` (`last30days.facebook` = {lat, lng, radius_km, centers?}).
**Dependencies:** U1.
**Approach:**
- `pipeline.py`: `if source == "facebook": result = facebook.search_and_enrich(...); items =
  facebook.parse_facebook_response(result)`.
- `env.py`: `get_facebook_token(config)` = SCRAPECREATORS key (same as IG/TikTok).
- Add `"facebook"` to the source enum in `planner.py`, per-source normalize in `normalize.py`,
  render label `"Facebook (Marketplace)"` in `render.py`, a signal weight in `signals.py`.
- Add `facebook` to `INCLUDE_SOURCES` default + `precrime_config.json` `last30days.includeSources`.
**Test scenarios:**
- `--search facebook` routes to the connector; `--search reddit,facebook` runs both.
- A run with no facebook config falls back gracefully (skips facebook with a logged note, does not crash).
- Rendered output shows the "Facebook (Marketplace)" section with items.
**Verification:** facebook appears in the research-complete source tally and in `ranked_candidates`.

### U3. lib/facebook.py — Group Posts (Phase 2)

**Goal:** Grassroots group buyer posts. Build only if Phase 1 under-delivers.
**Files:** `lib/facebook.py` (extend), `lib/pipeline.py` (extend facebook dispatch), plus a
`fb_group` Source channel so resolved group URLs recur.
**Dependencies:** U1, U2.
**Approach:**
- Group-URL resolution (NOT a python keyword-search — SC has none): the LAST_30_DAYS worker /
  skill composes group search terms from VALUE_PROP (Audience Segments + Buyer Roles), resolves
  them to REAL public group URLs via **Tavily** `site:facebook.com/groups <term>` (Tavily already
  wired), and persists the URLs as `fb_group` Sources. Avoids the LLM hallucinating group IDs.
- `fetch_group_posts(group_url, token, max_posts)` → GET `/v1/facebook/group/posts`, cursor-paginate
  (3/call) to `max_posts`, map posts → items `{text, url, author_name: author.name,
  date: timestamp→YYYY-MM-DD, engagement:{comments: commentCount}, relevance}`, 30-day filter,
  `_is_buyer_intent` gate.
- `pipeline.py`: facebook dispatch accepts a `facebook_groups` param (like tiktok hashtags/creators);
  merge group items with marketplace items.
**Test scenarios:**
- A group-posts fixture with buyer ("planning our fall carnival, need vendors") and chit-chat posts
  keeps only the buyer post.
- Pagination stops at `max_posts`; a private/deleted group URL is skipped with a logged note.
- Resolved group URLs persist as `fb_group` Sources and are reused on the next run.
**Verification:** `--search facebook` with configured `fb_group` sources returns group buyer posts.

---

## Risks & Trade-offs

- **R1 — Marketplace still carries vendors.** Service listings ("caricature artist for hire") are
  vendors. `_is_buyer_intent` is the mitigation; measure the buyer:vendor ratio after U1 before
  trusting it. If the ratio is poor, Groups (U3) is the real answer.
- **R2 — Groups: public-only + 3 posts/call.** The most valuable groups are often private
  (unscrapable); paginating public groups costs many calls. Bound `max_posts` per group; log the cap.
- **R3 — Date is post/listing time, not event time.** Downstream date extraction must find the
  event date in the text; the connector must pass full text through, not just a title.
- **R4 — Vendored third-party edit.** These files live in the vendored `last30days` skill
  (upstream github.com/mvanhorn/last30days-skill). Keep the connector self-contained and mirror
  tiktok.py so an upstream pull is mergeable.
- **R5 — SC is PAYG after free credits.** Marketplace + group calls draw down the same key; keep
  `count`/`max_posts`/depth conservative until yield is proven.

---

## Out of Scope / Deferred

- FB Ad Library (advertiser skew — reproduces the vendor problem).
- Competitor-intel tagging of vendor listings (a later routing decision).
- Private group access, FB login/session scraping.
- Nextdoor / Craigslist (separate connectors if buyer yield justifies).

## Success Criteria

- `python last30days.py "<topic>" --search facebook --emit=json` returns buyer-intent Marketplace
  items (location + date), gated by `_is_buyer_intent`.
- `facebook` is a first-class source (planner/normalize/render/signals/INCLUDE_SOURCES); the
  LAST_30_DAYS worker ingests FB buyer posts as Client/Booking/Factlet with a queued DRILL_DOWN.
- Phase 2 group posts land only when `fb_group` Sources are configured; group URLs persist and recur.
- Buyer:vendor ratio on FB is measurably better than the TikTok/IG surface (the reason we built it).
