---
name: precrime-share-skill
description: Post a leed_ready Booking to The Leedz marketplace or email it — handles all sharing paths
triggers:
  - share this booking
  - post this leed
  - share the leed
---

# Pre-Crime — Share Skill

You handle the final mile: a Booking has hit `leed_ready` and needs to be actioned.

**Called by:** Evaluator after a Booking passes the Completeness Check.

## Input

- Booking object (id, trade, startDate, location, zip, title, description, leedPrice, clientId)
- Session context: `defaultBookingAction`, `leedzMode`, `marketplaceEnabled`

## Step 1: Determine Action

Check session context for `defaultBookingAction`:

| Value | Action |
|-------|--------|
| `leedz_api` | Call `createLeed` via Leedz MCP → Step 2a |
| `email_share` | Email to share@theleedz.com → Step 2b |
| `email_user` | Email to Config.companyEmail → Step 2c |
| *(not set)* | Ask user once → Step 1a |

### Step 1a: Ask the user (once per session)

> "A booking just hit `leed_ready`:
> **Trade:** {trade} | **Date:** {startDate} | **Location:** {location}
>
> What should I do?
> 1. Post to The Leedz marketplace via API (leedz_api)
> 2. Email to share@theleedz.com for review (email_share)
> 3. Email to you ({companyEmail}) to decide (email_user)
>
> Which default? (1 / 2 / 3 — I'll use this for all future bookings this session.)"

Note the answer as session context: `defaultBookingAction = [choice]`. Apply to this booking and all subsequent ones.

---

## Step 2a: Post via Leedz API Gateway (leedz_api)

**Endpoint:** `POST https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/mcp`

Send a JSON-RPC 2.0 body:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "createLeed",
    "arguments": { ...see fields below... }
  }
}
```

Field codes map directly to DynamoDB. Use them exactly as shown.

```
session: config.leedzSession          // JWT — required, extracted for creator email
tn:      booking.trade.toLowerCase()  // trade name — MUST be lowercase
ti:      booking.title or (booking.trade + " needed — " + (booking.location or booking.zip))
zp:      booking.zip                  // 5-digit zip — required
st:      <booking.startDate as epoch milliseconds>   // convert datetime → epoch ms
et:      <booking.endDate as epoch ms if present>    // optional
lc:      booking.location             // optional full address — if present MUST end with zip
dt:      booking.description          // event details — optional, max 1000 chars
rq:      booking.notes                // requirements — optional, max 1000 chars
pr:      booking.flatRate or 0        // price in CENTS (e.g. $5.00 = 500) — default 0
cn:      client.name                  // client name — optional, pay-to-see
em:      client.email                 // client email — optional, pay-to-see
ph:      client.phone                 // client phone — optional, pay-to-see
sh:      "*"                          // broadcast to all platform subscribers
```

**lc constraint:** if `booking.location` is provided, verify it ends with `booking.zip`. If not, append: `booking.location + " " + booking.zip`.

**st conversion:** `booking.startDate` is a datetime string. Convert to epoch ms before passing: `new Date(booking.startDate).getTime()`.

**leedzSession JWT** is stored in `Config.leedzSession`. Set during init-wizard Step 5a. Generate with:
```
jwt.encode(
  {'email': leedzEmail, 'type': 'session', 'exp': <1yr from now>},
  '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c',
  algorithm='HS256'
)
```

On success (response body contains `result.content[0].text` as JSON `{id, tn, ti, pr, cd:1}`):
```
update_booking({ id: booking.id, leedId: result.id, status: "shared", shared: true, sharedTo: "leedz_api", sharedAt: Date.now() })
```

On failure: fall back to Step 2b. Log: `LEEDZ_API_FAILED — [error] — falling back to email_share`

---

## Step 2b: Email to share@theleedz.com

- **FROM:** leedzEmail (from Config) or companyEmail
- **TO:** share@theleedz.com
- **SUBJECT:** `price={leedPrice or 0}, share=*`
  - Use `share=*` for broadcast (default)
  - Use `share=friends` if user has a friends list on The Leedz
  - Use `share=[email1,email2]` for private share to specific vendors
- **BODY:** Human-readable booking summary for LLM parsing:
  ```
  Trade: {trade}
  Title: {title}
  Location: {location}
  Zip: {zip}
  Date: {startDate}
  Time: {startTime if known}
  Description: {description}
  Contact: {client.name} / {client.email} / {client.phone}
  ```

```
mcp__gmail-sender__gmail_send({
  to: "share@theleedz.com",
  subject: "price={leedPrice or 0}, share=*",
  body: "[composed body above]"
})
```

On success: `update_booking({ id, status: "shared", shared: true, sharedTo: "share@theleedz.com", sharedAt: Date.now() })`

---

## Step 2c: Email to seller

Same body as Step 2b, but:
- **TO:** Config.companyEmail
- **SUBJECT:** `New leed_ready booking: {trade} / {startDate} / {location}`

```
mcp__gmail-sender__gmail_send({
  to: config.companyEmail,
  subject: "New leed_ready booking: {trade} / {startDate} / {location}",
  body: "[same body as 2b]"
})
```

On success: `update_booking({ id, status: "shared", shared: true, sharedTo: config.companyEmail, sharedAt: Date.now() })`

---

## Step 3: Log

Append to `logs/ROUNDUP.md`:
```
ACTION: {trade} / {startDate} / {location} → {action taken} [{success|failed}: {detail}]
```

---

## Rules

- **leedzMode = false or marketplaceEnabled = false:** Skip Step 2a. Go directly to email path (2b or 2c based on defaultBookingAction).
- **trade not in canonical list:** Same as above — no API post. Log: `TRADE_NOT_IN_LEEDZ — {trade}`
- **No email configured:** Log `NO_EMAIL_CONFIG` and skip. Do not crash the pipeline.
- **Ask once per session.** Once `defaultBookingAction` is set as session context, never ask again.
- **Do not auto-send without at least one booking detail confirmed.** The Completeness Check gate upstream handles this — trust it.
