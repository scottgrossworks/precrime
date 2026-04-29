"""
LEEDZ_PROXY_MCP -- local stdio MCP wrapping the remote Leedz createLeed API.

Why: three fields on every createLeed call must always have specific values for
this deployment, and the model cannot be trusted to set them every time:
  - email = "false"                  (broadcast-suppression toggle, NEVER blast to subscribers)
  - pr    = 0                        (free-leed marketplace policy)
  - cr    = "theleedz.com@gmail.com" (creator forced to platform admin account regardless of session JWT)
This proxy HARD-CODES all three fields on every createLeed call regardless of
what the caller sends. The "broadcast-on", "non-zero-price", and "creator-other-than-admin"
states are unreachable from goose by construction.

Architecture:
- Goose registers this script as the `leedz` extension (stdio).
- The remote `leedz-remote` HTTP MCP is disabled in goose.
- This proxy forwards createLeed via plain HTTPS POST to the remote /mcp URL
  with MCP JSON-RPC framing.

Tool exposed: createLeed (single tool, matches remote name).

Logs every call to logs/leedz_proxy.log with both original and forced values.
"""

import json
import os
import re
import sqlite3
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

import requests

THIS_DIR = Path(__file__).resolve().parent
CALL_LOG = THIS_DIR.parent / "logs" / "leedz_proxy.log"

LEEDZ_REMOTE_URL = "https://jjz8op6uy4.execute-api.us-west-2.amazonaws.com/Leedz_Stage_1/mcp"
REQUEST_TIMEOUT = 60

# ---- Validation: reject leedz that look like outreach or have wrong identity ----

GREETING_RE = re.compile(r"^\s*(hi|hello|hey|dear|greetings)\b[\s,!.:]", re.IGNORECASE)
FIRST_PERSON_RE = re.compile(r"\b(I|we|our|us|my|me|mine|ours|I'm|I've|I'll|I'd)\b")
PRICING_RE = re.compile(
    r"\$\d|\bfrom\s+\$|\bpackages?\s+from\b|\bstarting\s+at\b|\bno\s+deposit\b|\bdeposit\b|\bquote\b",
    re.IGNORECASE,
)
QUESTION_TO_READER_RE = re.compile(
    r"\b(want to|are you|interested|would you|shall we|can we|let me know|reach out)\b[^.]*\?",
    re.IGNORECASE,
)
EMAIL_BASIC_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")

REQUIRED_FIELDS = ("session", "tn", "ti", "zp", "st", "lc", "dt", "cn", "em")


_user_identity_cached: dict | None = None  # populated by lazy_user_identity()


def lazy_user_identity() -> dict:
    """Read Config row from precrime SQLite DB to know who the USER is.
    Used to reject leedz where cn or em match the user's identity (a critical bug).
    Cached after first read."""
    global _user_identity_cached
    if _user_identity_cached is not None:
        return _user_identity_cached

    db_url = os.environ.get("DATABASE_URL", "").strip().strip('"')
    db_path = db_url.replace("file:", "") if db_url.startswith("file:") else db_url
    out: dict = {}
    if db_path and os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            cur.execute("SELECT companyName, companyEmail FROM Config LIMIT 1")
            row = cur.fetchone()
            conn.close()
            if row:
                out = {
                    "companyName": (row[0] or "").strip(),
                    "companyEmail": (row[1] or "").strip().lower(),
                }
        except Exception as e:
            log(f"could not read user identity from DB: {e}")
    _user_identity_cached = out
    return out


def validate_leed(payload: dict) -> list[str]:
    """Return a list of validation error messages. Empty list = pass."""
    errors: list[str] = []

    # 1. Required fields
    for f in REQUIRED_FIELDS:
        v = payload.get(f)
        if v is None or (isinstance(v, str) and not v.strip()):
            errors.append(f"missing required field '{f}'")

    # 2. Identity confusion: cn / em must NOT match the user's identity
    user = lazy_user_identity()
    if user.get("companyName"):
        cn = (payload.get("cn") or "").strip()
        if cn and cn.lower() == user["companyName"].lower():
            errors.append(f"cn='{cn}' is the USER's company name, not the buyer. cn must come from the Client record.")
    if user.get("companyEmail"):
        em = (payload.get("em") or "").strip().lower()
        if em and em == user["companyEmail"]:
            errors.append(f"em='{em}' is the USER's email, not the buyer's. em must come from the Client record.")

    # 3. dt content rules
    dt = (payload.get("dt") or "").strip()
    if dt:
        if GREETING_RE.search(dt):
            errors.append("dt starts with a greeting (Hi/Hello/Dear/...). The leed is not addressed to anyone. Rewrite as third-person event description.")
        if FIRST_PERSON_RE.search(dt):
            m = FIRST_PERSON_RE.search(dt)
            errors.append(f"dt contains first-person pronoun '{m.group(0)}'. The leed is from no one to no one. Strip all first-person language.")
        if PRICING_RE.search(dt):
            errors.append("dt contains pricing language ($, 'from $X', 'packages from', 'deposit', etc). Pricing belongs in pr (always 0). Strip from dt.")
        if QUESTION_TO_READER_RE.search(dt):
            errors.append("dt asks a question to the reader (want to/are you/interested/...). The reader is a stranger vendor, not the buyer. Strip questions.")

    # 4. em format sanity
    em = (payload.get("em") or "").strip()
    if em and not EMAIL_BASIC_RE.match(em):
        errors.append(f"em='{em}' is not a valid email format.")

    return errors


# ---- JSON-RPC helpers ----


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[leedz-proxy] {msg}\n")
    sys.stderr.flush()


def call_log(action: str, original_email, original_pr, original_cr, payload: dict, status: str) -> None:
    """One line per call so you can tail the log."""
    try:
        CALL_LOG.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().isoformat(timespec="seconds")
        ti = (payload.get("ti") or "")[:60]
        tn = payload.get("tn", "")
        cn = payload.get("cn", "")
        line = (
            f"{ts}  {action:<14}  status={status}  "
            f"orig_email={original_email!r:<8}  "
            f"orig_pr={original_pr!r:<8}  "
            f"orig_cr={original_cr!r:<28}  "
            f"forced(email='false', pr=0, cr='theleedz.com@gmail.com')  tn={tn:<14} cn={cn:<24} ti={ti}\n"
        )
        with CALL_LOG.open("a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        log(f"call_log failed: {e}")


def ok(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def err(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


# ---- Protocol handlers ----


def handle_initialize(req_id):
    return ok(
        req_id,
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "leedz-proxy", "version": "1.0.0"},
        },
    )


def handle_tools_list(req_id):
    return ok(
        req_id,
        {
            "tools": [
                {
                    "name": "createLeed",
                    "description": (
                        "Post a leed to the Leedz marketplace. The full payload is forwarded "
                        "to the remote Leedz API. Three fields are HARD-CODED inside this proxy "
                        "regardless of what the caller sends:\n"
                        "  - email = 'false'                    (broadcast-suppression toggle)\n"
                        "  - pr    = 0                          (free-leed policy)\n"
                        "  - cr    = 'theleedz.com@gmail.com'   (creator forced to platform admin)\n"
                        "The buyer's contact email lives in `em`, which is forwarded as-is.\n\n"
                        "Standard createLeed fields:\n"
                        "  tn (string, required) -- trade name, lowercase, must be in get_trades()\n"
                        "  ti (string, required) -- title\n"
                        "  zp (string, required) -- zip\n"
                        "  st (number, required) -- start epoch ms\n"
                        "  et (number) -- end epoch ms\n"
                        "  lc (string, required) -- full address\n"
                        "  dt (string, required) -- description\n"
                        "  rq (string) -- requirements / sellable hook\n"
                        "  cn (string, required) -- buyer contact name\n"
                        "  em (string, required) -- buyer contact email\n"
                        "  ph (string) -- buyer contact phone\n"
                        "  sh (string) -- share string per SHARE_API.md\n"
                        "  pr (number) -- IGNORED. Always overwritten to 0.\n"
                        "  email (any)  -- IGNORED. Always overwritten to 'false'."
                    ),
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "session": {"type": "string", "description": "REQUIRED. Leedz session JWT from Config.leedzSession. Fetch via precrime__pipeline({action:'status'}) and pass in here."},
                            "tn": {"type": "string", "description": "REQUIRED. Trade name, lowercase. Must be in precrime__trades()."},
                            "ti": {"type": "string", "description": "REQUIRED. Event-focused title."},
                            "zp": {"type": "string", "description": "REQUIRED. Zip code."},
                            "st": {"type": "number", "description": "REQUIRED. Start time, epoch milliseconds."},
                            "et": {"type": "number", "description": "End time, epoch milliseconds. Optional."},
                            "lc": {"type": "string", "description": "REQUIRED. Full venue address including zip."},
                            "dt": {"type": "string", "description": "REQUIRED. Event description, third-person, no greetings, no first-person, no pricing."},
                            "rq": {"type": "string", "description": "Logistics: power, footprint, parking, COI. Not seller deliverables."},
                            "cn": {"type": "string", "description": "REQUIRED. Buyer contact name from CLIENT record. Never the user."},
                            "em": {"type": "string", "description": "REQUIRED. Buyer contact email from CLIENT record. Never the user's email."},
                            "ph": {"type": "string", "description": "Buyer contact phone from CLIENT record."},
                            "sh": {"type": "string", "description": "Share string per SHARE_API.md, typically '*'."},
                        },
                        "required": ["session", "tn", "ti", "zp", "st", "lc", "dt", "cn", "em"],
                        "additionalProperties": True,
                    },
                }
            ]
        },
    )


def forward_to_remote(args: dict) -> dict:
    """POST a tools/call envelope to the remote Leedz MCP and return result."""
    envelope = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000),
        "method": "tools/call",
        "params": {"name": "createLeed", "arguments": args},
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    resp = requests.post(LEEDZ_REMOTE_URL, json=envelope, headers=headers, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    # The remote may return JSON or SSE; handle JSON first, fall back to text.
    ctype = resp.headers.get("content-type", "")
    if "application/json" in ctype:
        return resp.json()
    if "text/event-stream" in ctype:
        # Parse the first `data:` line from the SSE stream
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                if payload and payload != "[DONE]":
                    return json.loads(payload)
        raise RuntimeError("remote returned SSE with no data: line")
    # Plain text fallback
    return {"raw": resp.text}


def handle_tools_call(req_id, params):
    name = params.get("name")
    if name != "createLeed":
        return err(req_id, -32601, f"Unknown tool: {name}. Only createLeed is exposed.")

    incoming = dict(params.get("arguments") or {})
    original_email = incoming.get("email", "<not-set>")
    original_pr = incoming.get("pr", "<not-set>")
    original_cr = incoming.get("cr", "<not-set>")

    # Hard-codes: nothing the caller sent for `email`, `pr`, or `cr` reaches the remote.
    # email = "false"                 -> broadcast suppression (never blast to subscribers)
    # pr    = 0                       -> free-leed marketplace policy
    # cr    = "theleedz.com@gmail.com"-> creator forced to platform admin account
    #                                    regardless of which session JWT authenticated the call
    incoming["email"] = "false"
    incoming["pr"] = 0
    incoming["cr"] = "theleedz.com@gmail.com"

    # Mechanical validation: reject obvious junk before forwarding.
    errors = validate_leed(incoming)
    if errors:
        msg = "Leed REJECTED by proxy validator. Fix and retry:\n  - " + "\n  - ".join(errors)
        log(msg)
        call_log("createLeed", original_email, original_pr, original_cr, incoming, "VALIDATE_FAIL")
        return err(req_id, -32000, msg)

    try:
        remote_response = forward_to_remote(incoming)
    except requests.exceptions.RequestException as e:
        log(f"remote request failed: {e}")
        call_log("createLeed", original_email, original_pr, original_cr, incoming, f"HTTP_FAIL:{type(e).__name__}")
        return err(req_id, -32603, f"Remote Leedz API error: {e}")
    except Exception as e:
        log(f"forward failed: {e}\n{traceback.format_exc()}")
        call_log("createLeed", original_email, original_pr, original_cr, incoming, f"FAIL:{type(e).__name__}")
        return err(req_id, -32603, f"Proxy error: {e}")

    # Log a truncated copy of the remote response so we can see what actually came back.
    raw_str = json.dumps(remote_response, ensure_ascii=False)[:600]
    log(f"remote response: {raw_str}")

    # Strict success detection. The remote returns HTTP 200 even when the JSON-RPC
    # call failed (error encoded in the body). Treat a body that lacks `result`
    # OR has an `error` key OR has a `result.isError` flag as a failure.
    if not isinstance(remote_response, dict):
        call_log("createLeed", original_email, original_pr, original_cr, incoming, f"BAD_SHAPE: {raw_str[:200]}")
        return err(req_id, -32603, f"Unexpected remote response shape: {raw_str[:200]}")

    if "error" in remote_response:
        e = remote_response["error"]
        call_log("createLeed", original_email, original_pr, original_cr, incoming,
                 f"REMOTE_ERR code={e.get('code')} msg={(e.get('message') or '')[:200]}")
        return err(req_id, e.get("code", -32000), e.get("message", "remote error"))

    result_payload = remote_response.get("result")
    if not isinstance(result_payload, dict):
        call_log("createLeed", original_email, original_pr, original_cr, incoming,
                 f"NO_RESULT: {raw_str[:200]}")
        return err(req_id, -32603, f"Remote returned no result: {raw_str[:300]}")

    # MCP servers signal tool errors via result.isError=true with the error in content.
    if result_payload.get("isError"):
        content = result_payload.get("content") or []
        msg = ""
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                msg += c.get("text", "")
        call_log("createLeed", original_email, original_pr, original_cr, incoming,
                 f"TOOL_ERR: {msg[:300]}")
        return err(req_id, -32000, f"Remote tool error: {msg[:500]}")

    # Sanity: result.content must have at least one text block. If absent, the
    # remote almost certainly didn't actually do anything.
    content_blocks = result_payload.get("content")
    if not content_blocks:
        call_log("createLeed", original_email, original_pr, original_cr, incoming,
                 f"EMPTY_RESULT: {raw_str[:200]}")
        return err(req_id, -32603, f"Remote returned empty result. Body: {raw_str[:300]}")

    # Real success. Log a sample of the content so the user can verify a leedId came back.
    first_text = ""
    for c in content_blocks:
        if isinstance(c, dict) and c.get("type") == "text":
            first_text = (c.get("text") or "")[:200]
            break
    call_log("createLeed", original_email, original_pr, original_cr, incoming, f"OK content={first_text}")
    return ok(req_id, result_payload)


def handle_request(req: dict):
    method = req.get("method")
    req_id = req.get("id")
    params = req.get("params") or {}

    if method == "initialize":
        return handle_initialize(req_id)
    if method == "tools/list":
        return handle_tools_list(req_id)
    if method == "tools/call":
        return handle_tools_call(req_id, params)
    if method == "notifications/initialized":
        return None
    if method == "prompts/list":
        return ok(req_id, {"prompts": []})
    if method == "resources/list":
        return ok(req_id, {"resources": []})

    return err(req_id, -32601, f"Method not found: {method}")


def main():
    log(f"starting (stdio JSON-RPC, leedz proxy, target={LEEDZ_REMOTE_URL})")
    log("HARD-CODE: every createLeed call has email='false' forced regardless of caller input")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"parse error: {e} / line={line[:120]}")
            continue

        response = handle_request(req)
        if response is not None:
            send(response)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("shutting down")
