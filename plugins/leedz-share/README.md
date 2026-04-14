# Plugin: leedz-share

Posts `leed_ready` Bookings to The Leedz marketplace (theleedz.com).

Not included in the core Pre-Crime package. Apply manually to deployments that need it.

---

## What It Does

When the evaluator finds a Booking with `status: leed_ready`, this skill handles the final action:
- Posts to The Leedz API Gateway via `createLeed`
- Falls back to email (share@theleedz.com) if API fails
- Or emails the booking to the seller directly

---

## How to Apply

1. Copy `share-skill.md` into the deployment's `skills/` folder
2. Set the required Config fields (see below)
3. Update `evaluator.md` — restore the hand-off line at the `leed_ready` section:
   > `Once a Booking reaches leed_ready, pass it to skills/share-skill.md.`

---

## Required Config Fields

Set via `update_config` during init-wizard or manually:

| Field | Value |
|-------|-------|
| `leedzEmail` | The seller's theleedz.com account email |
| `leedzSession` | HS256 JWT — see generation instructions below |
| `marketplaceEnabled` | `true` |
| `defaultBookingAction` | `leedz_api` (or `email_share` / `email_user`) |

### JWT Generation

```
jwt.encode(
  {'email': leedzEmail, 'type': 'session', 'exp': <1yr from now>},
  '648373eeea08d422032db0d1e61a1bc096fe08dd2729ce611092c7a1af15d09c',
  algorithm='HS256'
)
```

---

## API Endpoint

`POST https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/mcp`

JSON-RPC 2.0. Tool name: `createLeed`. See `share-skill.md` for full field mapping.
