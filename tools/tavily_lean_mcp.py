"""
TAVILY_LEAN_MCP -- stdio MCP server that wraps Tavily and trims response bloat.

Exposes two tools (matching the legacy tavily-prefix pattern so skill files using
`tavily__tavily_search` and `tavily__tavily_extract` continue to work):

  tavily_search   { query, max_results?, search_depth?, include_answer? }
  tavily_extract  { url, query_hint? }

Both go through tools/tavily_lean.py which strips raw_content, markdown noise,
nav chains, bullet salads, and returns only relevant snippets + emails + phones.

JSON-RPC over stdio. Same protocol as mcp_server_v2.js. No SDK required.

Register in goose config.yaml as extension `tavily` (stdio type).
"""

import json
import sys
import traceback
from datetime import datetime
from pathlib import Path

# Bring the trim helpers into scope without polluting the package namespace
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))

from tavily_lean import search_lean, extract_lean  # noqa: E402

# Append-only call log so you can tail and confirm the wrapper is active.
CALL_LOG = THIS_DIR.parent / "logs" / "tavily_lean.log"


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
                                "description": "basic (cheap) or advanced (deeper). Default basic.",
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
                        "Extract content from a single URL via Tavily, with response bloat "
                        "trimmed before return. Strips markdown image/link syntax, nav chains, "
                        "bullet salads, footers. Returns relevance-scored snippets plus any "
                        "extracted emails/phones. Roughly 80-90% smaller than raw extract output. "
                        "Pass query_hint to bias snippet selection."
                    ),
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "url": {"type": "string", "description": "URL to extract"},
                            "query_hint": {
                                "type": "string",
                                "description": "Optional. Biases snippet selection toward this intent.",
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
            result = search_lean(
                query=query,
                max_results=int(args.get("max_results", 5)),
                include_answer=bool(args.get("include_answer", True)),
                search_depth=str(args.get("search_depth", "basic")),
            )
            call_log("tavily_search", query, result.get("stats", {}))
            return ok(req_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]})

        if name == "tavily_extract":
            url = args.get("url")
            if not url:
                return err(req_id, -32602, "tavily_extract requires 'url'")
            result = extract_lean(url=url, query_hint=str(args.get("query_hint", "")))
            call_log("tavily_extract", url, result.get("stats", {}))
            return ok(req_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]})

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
    log("starting (stdio JSON-RPC, tavily lean wrapper)")
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
