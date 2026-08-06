"""
TAVILY_LEAN_MCP -- stdio MCP server that wraps Tavily and trims response bloat.

Exposes two tools (matching the legacy tavily-prefix pattern so skill files using
`tavily__tavily_search` and `tavily__tavily_extract` continue to work):

  tavily_search   { query, max_results?, search_depth?, include_answer? }
  tavily_extract  { url, query_hint?, mode? }

Both go through tools/tavily_lean.py. Search returns compact snippets. Extract
defaults to cleaned full text plus assistive candidates (emails, phones, URLs,
heading/card-like lines) so the LLM can do strict semantic extraction without
adding another MCP server.

JSON-RPC over stdio. Same protocol as mcp_server_v2.js. No SDK required.

Register in goose config.yaml as extension `tavily` (stdio type).
"""

import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# Bring the trim helpers into scope without polluting the package namespace
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))

from tavily_lean import search_lean, extract_lean, lean_from_page_text  # noqa: E402

# Append-only call log so you can tail and confirm the wrapper is active.
CALL_LOG = THIS_DIR.parent / "logs" / "tavily_lean.log"

# ---- BROWSE-FIRST (credit guard #5, 2026-08-03) ----
# Page EXTRACTION is the dominant Tavily credit sink, and the pipeline server
# already exposes a paced, serialized, bot-block-cooled Chrome fetch (`browse`
# action -> chromeBridge.js -> the user's own logged-in Chrome on :12306).
# When precrime_config.json has browseFirst true (the default), every
# tavily_extract call is first routed through that browse action: same lean
# result shape, ZERO credits. Tavily extract runs only as the fallback (server
# down, bridge/Chrome closed, domain cooling after a bot-block, thin render).
# SEARCH is never rerouted -- scraping Google result pages from the user's real
# IP is the fastest way to get it flagged; Tavily search stays the SERP layer.
_PRECRIME_CONFIG_PATH = THIS_DIR.parent / "precrime_config.json"


def _load_precrime_config() -> dict:
    try:
        with _PRECRIME_CONFIG_PATH.open("r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception as e:
        # log() is not defined yet at module-import time -- stderr directly.
        sys.stderr.write(f"[tavily-lean-mcp] precrime_config.json unreadable ({e}); browse-first defaults apply\n")
        return {}


_PC_CFG = _load_precrime_config()
BROWSE_FIRST = _PC_CFG.get("browseFirst", True) is not False
_PIPELINE_PORT = int(((_PC_CFG.get("workers") or {}).get("port")) or 5179)
_PIPELINE_URL = f"http://127.0.0.1:{_PIPELINE_PORT}/mcp"
# browse rides the shared per-domain pacing queue (30s +/- jitter per hop), so a
# queued fetch can legitimately take a couple of minutes. Stay under the
# conductor's 300s hung-worker kill.
_BROWSE_TIMEOUT_S = 120
# When the pipeline server itself is unreachable, don't re-knock on every call.
_srv_down_until = 0.0


def _browse_via_chrome(url: str):
    """Fetch a URL through the pipeline `browse` action (user's logged-in Chrome).
    Returns page text on success, or None for ANY failure -- caller falls back to
    a real (billed) tavily_extract. Never raises."""
    global _srv_down_until
    if time.time() < _srv_down_until:
        return None
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "pipeline", "arguments": {"action": "browse", "url": url}},
    }
    req = urllib.request.Request(
        _PIPELINE_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_BROWSE_TIMEOUT_S) as res:
            rpc = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, OSError) as e:
        _srv_down_until = time.time() + 60
        log(f"browse-first: pipeline server unreachable ({e}); tavily fallback (60s backoff)")
        return None
    except Exception as e:
        log(f"browse-first: {e}; tavily fallback")
        return None
    if not isinstance(rpc, dict) or rpc.get("error"):
        msg = (rpc.get("error") or {}).get("message", "bad response") if isinstance(rpc, dict) else "bad response"
        # Expected fallbacks: bridge not running (Chrome closed), bridge busy,
        # domain cooling after a bot-block. All mean "let Tavily take this one".
        log(f"browse-first: {str(msg)[:160]} -> tavily fallback")
        return None
    try:
        inner = json.loads(rpc["result"]["content"][0]["text"])
        text = inner.get("text") or ""
    except Exception as e:
        log(f"browse-first: unparseable browse result ({e}); tavily fallback")
        return None
    if len(text.strip()) < 200:
        # Near-empty render (JS wall, interstitial). Tavily's fetcher may do better.
        log(f"browse-first: thin render ({len(text.strip())} chars); tavily fallback | {url[:120]}")
        return None
    return text


# ---- JSON-RPC helpers ----


def send(obj: dict) -> None:
    """Write a single JSON-RPC message to stdout, flushed."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    """Diagnostic log to stderr (stdout is the JSON-RPC channel)."""
    sys.stderr.write(f"[tavily-lean-mcp] {msg}\n")
    sys.stderr.flush()


def call_log(tool: str, payload: str, stats: dict) -> None:
    """Append a one-line summary of each tool call to logs/tavily_lean.log."""
    try:
        CALL_LOG.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().isoformat(timespec="seconds")
        raw = stats.get("raw_chars", 0)
        lean = stats.get("lean_chars", 0)
        ratio = stats.get("ratio", "n/a")
        savings = (1 - lean / raw) * 100 if raw else 0
        line = (
            f"{ts}  {tool:<16}  raw={raw:>6}  lean={lean:>6}  "
            f"ratio={ratio}  saved={savings:>5.1f}%  | {payload[:120]}\n"
        )
        with CALL_LOG.open("a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        log(f"call_log failed: {e}")


def _clamp_depth(args: dict) -> str:
    """CREDIT GUARD (#4): return 'advanced' ONLY when the caller passed both
    search_depth='advanced' and allow_advanced=true; otherwise 'basic'. Advanced bills
    2 credits vs 1, so this is default-deny. Log any downgrade so the clamp is visible."""
    requested = str(args.get("search_depth", "basic")).lower()
    if requested == "advanced" and bool(args.get("allow_advanced", False)):
        return "advanced"
    if requested == "advanced":
        log("depth clamp: advanced -> basic (allow_advanced not set); saved 1 credit")
    return "basic"


def _find_client_sources_worker() -> bool:
    """CREDIT GUARD (#1b): true when this Tavily wrapper is running inside a
    FIND_CLIENT_SOURCES worker. The conductor stamps PRECRIME_TASK_TYPE on the worker
    env and goose passes it through to this stdio child, so we can enforce snippet-first
    (no extract) here rather than trusting skill prose."""
    return (os.environ.get("PRECRIME_TASK_TYPE") or "").strip() == "FIND_CLIENT_SOURCES"


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
            "serverInfo": {"name": "tavily-lean", "version": "1.0.0"},
        },
    )


def handle_tools_list(req_id):
    return ok(
        req_id,
        {
            "tools": [
                {
                    "name": "tavily_search",
                    "description": (
                        "Web search via Tavily, with response bloat trimmed before return. "
                        "Returns query, optional direct answer, and up to max_results hits "
                        "with relevance-scored snippets and any extracted emails/phones. "
                        "Roughly 50% smaller than raw tavily_search output, preserving the "
                        "useful signal. Default max_results=5, search_depth=basic."
                    ),
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query"},
                            "max_results": {"type": "number", "description": "Max hits to return. Default 5."},
                            "search_depth": {
                                "type": "string",
                                "enum": ["basic", "advanced"],
                                "description": "basic (1 credit) or advanced (2 credits, deeper). Default basic. Advanced is IGNORED unless allow_advanced=true is also passed.",
                            },
                            "allow_advanced": {
                                "type": "boolean",
                                "description": "Must be true together with search_depth='advanced' to actually run advanced (2-credit) search; otherwise the call is clamped to basic. Reserved for stubborn decision-maker email hunts (DRILL_DOWN prime directive).",
                            },
                            "include_answer": {
                                "type": "boolean",
                                "description": "Include Tavily's pre-built direct answer if any. Default true.",
                            },
                        },
                        "required": ["query"],
                    },
                },
                {
                    "name": "tavily_extract",
                    "description": (
                        "Extract content from a single URL via Tavily. Default mode='full' "
                        "returns cleaned page content, length-capped (markdown image syntax and "
                        "link URLs stripped, structure preserved) plus candidates: obvious emails, "
                        "phones, outbound URLs, and heading/card-like lines. The candidates are "
                        "hints, not final classification; the LLM should emit strict clients / "
                        "factlets / sources JSON against VALUE_PROP. Use this for vendor lists, "
                        "exhibitor rosters, contact directories -- anywhere structured names "
                        "matter. mode='snippet' returns only 5 relevance-scored sentences "
                        "(~800 chars), useful for teasing a long article but destructive for "
                        "list pages -- do not use for vendor extraction. NOTE: when the "
                        "pipeline's Chrome bridge is available the fetch is transparently "
                        "served through the user's own logged-in Chrome at zero Tavily cost "
                        "(result carries via='chrome_browse'); treat the result identically."
                    ),
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string", "description": "URL to extract"},
                            "mode": {
                                "type": "string",
                                "enum": ["full", "snippet"],
                                "description": "full (default): cleaned full content. snippet: 5 best sentences (legacy).",
                            },
                            "query_hint": {
                                "type": "string",
                                "description": "Used only in mode='snippet' to bias selection. Ignored in mode='full'.",
                            },
                        },
                        "required": ["url"],
                    },
                },
            ]
        },
    )


def handle_tools_call(req_id, params):
    name = params.get("name")
    args = params.get("arguments") or {}

    try:
        if name == "tavily_search":
            query = args.get("query")
            if not query:
                return err(req_id, -32602, "tavily_search requires 'query'")
            # CREDIT GUARD (#6): a cuid-shaped token (Prisma DB id like
            # cmr1nswvb004gmzof0qmxmbbo) in a web search is ALWAYS worker confusion --
            # the public web has never heard of our row ids. Refuse at 0 credits.
            if re.search(r"\bc[a-z0-9]{20,}\b", query):
                log(f"search blocked: cuid-shaped token in query (db id, not a web term); saved 1 credit | {query[:120]}")
                return ok(req_id, {"content": [{"type": "text", "text": json.dumps({
                    "skipped": True,
                    "reason": "query_contains_database_id",
                    "hint": "That token is a PRECRIME database id, not a searchable term. Look the record up via the pipeline (find/get_task), or search the client/event NAME instead.",
                }, ensure_ascii=False, separators=(",", ":"))}]})
            result = search_lean(
                query=query,
                # Clamp: a worker asking for 10-20 hits multiplies the payload (re-billed on
                # every later turn) without adding signal past the top 5. Depth stays
                # caller-controllable (advanced is legitimate for hard queries).
                max_results=min(5, max(1, int(args.get("max_results", 5)))),
                include_answer=bool(args.get("include_answer", True)),
                # CREDIT GUARD (#4): advanced search bills 2 Tavily credits vs 1 for basic.
                # Default-DENY advanced: a caller only gets it by passing BOTH search_depth=
                # "advanced" AND allow_advanced=true (reserved for the DRILL_DOWN decision-maker
                # hunt). Everything else is clamped to basic here -- enforced in code, not by
                # skill prose the weak model ignores. Downgrades are logged to stderr.
                search_depth=_clamp_depth(args),
            )
            call_log("tavily_search", query, result.get("stats", {}))
            # Compact JSON (no indent): pretty-printing pads every search result with
            # whitespace the worker re-pays for on each subsequent turn.
            return ok(req_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}]})

        if name == "tavily_extract":
            url = args.get("url")
            if not url:
                return err(req_id, -32602, "tavily_extract requires 'url'")
            # CREDIT GUARD (#1b): FIND_CLIENT_SOURCES is snippet-first -- it stores the
            # search-result snippets as each source summary and never extracts (per-URL
            # extract is the dominant Tavily sink). If a FIND worker calls extract anyway,
            # refuse it and return a 0-credit note so the worker proceeds with its snippets
            # instead of spending. Belt-and-suspenders with the skill rewrite.
            if _find_client_sources_worker():
                log(f"extract blocked for FIND_CLIENT_SOURCES (snippet-first); saved 1 credit | {url[:120]}")
                return ok(req_id, {"content": [{"type": "text", "text": json.dumps({
                    "skipped": True,
                    "reason": "extract_disabled_for_find_client_sources",
                    "hint": "FIND_CLIENT_SOURCES is snippet-first: use the search-result snippet as the summary; do not extract.",
                    "url": url,
                }, ensure_ascii=False, separators=(",", ":"))}]})
            # CREDIT GUARD (#5): browse-first. Route the fetch through the user's own
            # logged-in Chrome (pipeline `browse` -> paced/serialized/cooldown-guarded
            # bridge). Success = same lean shape, 0 credits. Any failure falls through
            # to the billed Tavily extract so work never stalls.
            if BROWSE_FIRST:
                page_text = _browse_via_chrome(url)
                if page_text is not None:
                    result = lean_from_page_text(
                        url=url,
                        content=page_text,
                        query_hint=str(args.get("query_hint", "")),
                        mode=str(args.get("mode", "full")),
                    )
                    log(f"browse-first: served via Chrome, saved 1 credit | {url[:120]}")
                    call_log("browse_extract", url, result.get("stats", {}))
                    return ok(req_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}]})
            result = extract_lean(
                url=url,
                query_hint=str(args.get("query_hint", "")),
                mode=str(args.get("mode", "full")),
            )
            call_log("tavily_extract", url, result.get("stats", {}))
            return ok(req_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}]})

        return err(req_id, -32601, f"Unknown tool: {name}")

    except Exception as exc:
        log(f"tool {name} failed: {exc}\n{traceback.format_exc()}")
        return err(req_id, -32603, f"{name} error: {exc}")


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
        return None  # No response for notifications
    if method == "prompts/list":
        return ok(req_id, {"prompts": []})
    if method == "resources/list":
        return ok(req_id, {"resources": []})

    return err(req_id, -32601, f"Method not found: {method}")


def main():
    log("starting (stdio JSON-RPC, tavily lean wrapper); "
        f"browse-first={'ON (extracts try Chrome via :' + str(_PIPELINE_PORT) + ' first)' if BROWSE_FIRST else 'OFF'}")
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
