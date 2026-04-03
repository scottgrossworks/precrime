# Pre-Crime MCP Server — Subprocess Briefing

**Date:** 2026-04-02
**Purpose:** Complete the Pre-Crime MCP server so Bookings work end-to-end.

---

## Two MCP Servers — Do Not Conflate

| | Pre-Crime MCP | The Leedz MCP |
|---|---|---|
| **File** | `PRECRIME\server\mcp\mcp_server.js` | `FRONT_3\py\mcp_server\lambda_function.py` (deployed to AWS us-west-2) |
| **Transport** | Local stdin/stdout JSON-RPC | Remote `POST /mcp` on API Gateway |
| **Backend** | Prisma → SQLite | boto3 → existing Lambdas → DynamoDB |
| **Purpose** | Enrichment pipeline DB (clients, bookings, factlets) | Marketplace CRUD (leedz, trades, users) |
| **Design doc** | `PRECRIME\README.md` | `FRONT_3\DOCS\AGENTIC_FUTURE.md` |

**This briefing is about the Pre-Crime MCP only.** The Leedz MCP is a separate project.

A Pre-Crime Booking is NOT a leed. It **becomes** a leed when posted to the marketplace. The bridge: `Booking.status = leed_ready` → call The Leedz system (share@theleedz.com or The Leedz MCP `createLeed`) → `Booking.leedId` set to the returned marketplace ID. That bridge is TBD — not part of this work.

---

## What Exists

`C:\Users\Scott\Desktop\WKG\PRECRIME\server\mcp\mcp_server.js` — 798 lines, 15 tools, JSON-RPC via stdin/stdout, Prisma + SQLite. No HTTP server. No Express.

### Architecture

```
Claude Code session
    |
    | stdin/stdout (JSON-RPC 2.0)
    |
mcp_server.js
    |
    | PrismaClient (direct SQLite)
    |
deployment.sqlite
```

The server loads `mcp_server_config.json` from its own directory for the DB path. Prisma schema lives at `server\prisma\schema.prisma` in each deployment workspace.

### Current 15 Tools (all handler code is written and working)

**Client (7):** `get_client`, `search_clients`, `update_client`, `get_ready_drafts`, `get_stats`, `get_next_client`, `get_config`

**Factlet (3):** `create_factlet`, `get_new_factlets`, `delete_factlet`

**Config (1):** `update_config`

**Booking (4):** `create_booking`, `update_booking`, `get_bookings`, `get_client_bookings`

---

## What's Broken / Missing

### 1. Prisma Schema Has No Booking Model

The reference schema at `C:\Users\Scott\Desktop\WKG\BLOOMLEEDZ\server\prisma\schema.prisma` has Client, Factlet, Config — but NO Booking. The MCP server code calls `prisma.booking.*` which will crash at runtime.

**Add this model** (from `PRECRIME\DOCS\ONTOLOGY.md`):

```prisma
model Booking {
  id              String    @id @default(cuid())
  clientId        String
  title           String?
  description     String?
  notes           String?
  location        String?
  startDate       DateTime?
  endDate         DateTime?
  startTime       String?
  endTime         String?
  duration        Float?
  hourlyRate      Float?
  flatRate        Float?
  totalAmount     Float?
  status          String    @default("new")
  source          String?
  sourceUrl       String?
  trade           String?
  zip             String?
  shared          Boolean   @default(false)
  sharedTo        String?
  sharedAt        BigInt?
  leedPrice       Int?
  squarePaymentUrl String?
  leedId          String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  client          Client    @relation(fields: [clientId], references: [id])
}
```

**Add relation to Client model:**
```prisma
model Client {
  ...existing fields...
  bookings      Booking[]
}
```

### 2. Config Model Missing v2.0 Fields

The tool definition for `update_config` already accepts these params, but the schema doesn't have them:

```prisma
model Config {
  ...existing fields...
  activeEntities     String?    // JSON: ["client"] or ["client", "booking"]
  defaultTrade       String?
  marketplaceEnabled Boolean    @default(false)
  leadCaptureEnabled Boolean    @default(false)
  leedzEmail         String?    // The Leedz account email — used to generate session JWT
  leedzSession       String?    // Pre-generated HS256 JWT for The Leedz MCP createLeed calls
}
```

**`leedzEmail` and `leedzSession` notes:**
- `leedzEmail` is the user's email address on theleedz.com. Pre-Crime does not know this by default — it must be configured at workspace setup time (prompted from the user in the setup skill, or set manually in the config).
- `leedzSession` is a pre-generated JWT signed with the shared HS256 secret. Generated at setup time, stored here so the agent can call `createLeed` on The Leedz MCP without any browser/magic-link flow.
- To generate: `jwt.encode({'email': leedzEmail, 'type': 'session', 'exp': <1yr from now>}, JWT_SECRET, algorithm='HS256')`
- JWT_SECRET: `648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c`
- If the email doesn't exist in Leedz_DB yet, `addLeed` will auto-create a stub user on first post.

### 3. `update_booking` Doesn't Auto-Evaluate `leed_ready`

`create_booking` (line 597-601 of mcp_server.js) already has the Booking Action Criterion:

```js
// Status defaults to 'new' via schema — check Booking Action Criterion
if (args.status) {
    data.status = args.status;
} else if (data.trade && data.startDate && (data.location || data.zip)) {
    data.status = 'leed_ready';
}
```

`update_booking` does NOT have this. When fields are updated incrementally (trade added first, then startDate later, then location), the status should auto-promote to `leed_ready` once all three are present.

**Fix:** After building the `data` object in `handleUpdateBooking`, fetch the existing booking, merge with the update, and re-evaluate:

```js
// After building data object, before the prisma.booking.update call:
const existing = await prisma.booking.findUnique({ where: { id: args.id } });
const merged = { ...existing, ...data };
if (!data.status && merged.trade && merged.startDate && (merged.location || merged.zip)) {
    data.status = 'leed_ready';
}
```

Only auto-promote if `status` wasn't explicitly set in this update call.

### 4. `get_stats` Doesn't Include Bookings

Current `handleGetStats` (line 476-488) only counts clients and factlets. Add booking counts:

```js
const [totalBookings, newBookings, leedReady, taken, shared] = await Promise.all([
    prisma.booking.count(),
    prisma.booking.count({ where: { status: 'new' } }),
    prisma.booking.count({ where: { status: 'leed_ready' } }),
    prisma.booking.count({ where: { status: 'taken' } }),
    prisma.booking.count({ where: { status: 'shared' } })
]);
```

Include in the response object alongside existing client/factlet counts.

---

## What NOT To Do

- Do NOT add an HTTP server. stdin/stdout JSON-RPC only.
- Do NOT modify tool handler signatures or tool names. Skill files reference these exact names.
- Do NOT add new npm packages. Prisma + readline + fs + path is the full dependency list.
- Do NOT touch the RSS scorer (`rss-scorer-mcp/`). Separate concern.
- Do NOT wire marketplace posting in this server. The Leedz MCP `createLeed` tool (which calls the `addLeed` Lambda — NOT a Lambda named `createLeed`) is implemented separately in `LEEDZ\FRONT_3\py\mcp_server\lambda_function.py`. The bridge from Pre-Crime to The Leedz MCP is a future skill-file task.

---

## Files To Edit

| File | What |
|------|------|
| `BLOOMLEEDZ\server\prisma\schema.prisma` | Add Booking model, Client relation, Config v2.0 fields |
| `PRECRIME\server\mcp\mcp_server.js` | Fix `update_booking` auto-eval, fix `get_stats` booking counts |

After schema changes: `npx prisma db push` from the `server\` directory to update the SQLite.

---

## Reference Docs

- `PRECRIME\DOCS\ONTOLOGY.md` — Full entity definitions, Booking fields, status values
- `PRECRIME\README.md` — Deployment framework overview, tool reference table
- `PRECRIME\templates\skills\evaluator.md` — Booking Completeness Evaluation section (just added)
