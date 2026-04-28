"""
TAVILY_LEAN -- thin wrapper around Tavily API that strips bloat before the model sees the response.

Why: raw Tavily responses include `raw_content` (full page HTML/text, often 10k+ chars per result).
The model rarely needs that. It needs the relevant snippets and any structured data
(emails, phones, names).

Two-layer trim:
  1. Server-side: ask Tavily for the lean form (include_raw_content=False, max_results capped).
  2. Client-side: post-filter snippets, extract emails/phones, drop boilerplate.

Usage:
    from tavily_lean import search_lean, extract_lean

    result = search_lean("Anime Expo 2026 marketing director email", max_results=5)
    # result = {
    #   "query": "...",
    #   "answer": "...",        # Tavily's direct answer if any
    #   "hits": [
    #     {"url": "...", "title": "...", "score": 0.87,
    #      "snippet": "...", "emails": [...], "phones": [...]}
    #   ],
    #   "stats": {"raw_chars": 45123, "lean_chars": 1240, "ratio": 0.027}
    # }

CLI:
    python tavily_lean.py search "Anime Expo 2026 marketing director email"
    python tavily_lean.py extract https://example.com/about
    python tavily_lean.py benchmark    # runs sample query and prints bloat ratio
"""

import json
import os
import re
import sys
from pathlib import Path

import requests

# ---- API key resolution ----

KEY_FILE = Path(r"C:\Users\Admin\Desktop\WKG\TAVILY_API_KEY.md")


def get_api_key() -> str:
    """Resolve key from env first, then KEY_FILE."""
    env = os.environ.get("TAVILY_API_KEY", "").strip()
    if env:
        return env
    if KEY_FILE.exists():
        text = KEY_FILE.read_text(encoding="utf-8")
        # File format: header line + blank + key
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("tvly-"):
                return line
    raise RuntimeError(
        f"TAVILY_API_KEY not in env and not found in {KEY_FILE}"
    )


# ---- Regex extractors ----

EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)
# US phone: 10 digits with optional separators, optional +1
PHONE_RE = re.compile(
    r"(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}"
)
# Drop common cookie/nav/footer boilerplate
BOILERPLATE_PATTERNS = [
    re.compile(r"(?i)cookie\s*(policy|consent|preferences)"),
    re.compile(r"(?i)terms\s*(of\s*service|and\s*conditions)"),
    re.compile(r"(?i)privacy\s*policy"),
    re.compile(r"(?i)all\s*rights\s*reserved"),
    re.compile(r"(?i)skip\s*to\s*(main\s*)?content"),
    re.compile(r"(?i)subscribe\s*to\s*(our\s*)?newsletter"),
    re.compile(r"(?i)follow\s*us\s*on"),
]


def is_boilerplate(line: str) -> bool:
    return any(p.search(line) for p in BOILERPLATE_PATTERNS)


# ---- Snippet selection ----


def score_sentence(sentence: str, query_terms: set[str]) -> int:
    """Count distinct query terms present in the sentence (case-insensitive)."""
    s = sentence.lower()
    return sum(1 for t in query_terms if t and t in s)


MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
MD_HEADER_RE = re.compile(r"^#{1,6}\s+", re.MULTILINE)
EMPTY_LINK_RE = re.compile(r"\[\s*\]\([^)]*\)")
# Nav chains: 3+ short items separated by + | • › > * (common menu separators)
NAV_CHAIN_RE = re.compile(
    r"(?:[+|•›>*]\s*[A-Za-z][\w\s&/.\-']{1,40}\s*){3,}"
)
# Bullet salads: 4+ asterisks/dashes in a row treated as bullets
BULLET_SALAD_RE = re.compile(r"(?:[*\-]\s+[A-Za-z][^*\n]{0,80}\s*){4,}")
# Repeated separator characters
REPEAT_SEP_RE = re.compile(r"\s*[*+|•›>\-]{2,}\s*")


def clean_markdown_noise(text: str) -> str:
    """Strip markdown image/link syntax, header marks, nav chains, bullet salads."""
    text = MD_IMAGE_RE.sub("", text)
    text = EMPTY_LINK_RE.sub("", text)
    text = MD_LINK_RE.sub(r"\1", text)
    text = MD_HEADER_RE.sub("", text)
    text = NAV_CHAIN_RE.sub(" ", text)
    text = BULLET_SALAD_RE.sub(" ", text)
    text = REPEAT_SEP_RE.sub(" ", text)
    # Collapse runs of whitespace/newlines
    text = re.sub(r"\s+", " ", text).strip()
    return text


def split_sentences(text: str) -> list[str]:
    """Cheap sentence splitter. Good enough for snippet selection."""
    text = clean_markdown_noise(text)
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [p.strip() for p in parts if p.strip() and len(p.strip()) > 8]


def pick_relevant_snippets(
    content: str, query: str, max_snippets: int = 3, max_chars: int = 400
) -> str:
    """Score sentences by query-term overlap, return top N joined."""
    if not content:
        return ""
    query_terms = {t.lower() for t in re.findall(r"\w{3,}", query)}
    sentences = split_sentences(content)
    sentences = [s for s in sentences if not is_boilerplate(s)]

    scored = sorted(
        ((score_sentence(s, query_terms), -i, s) for i, s in enumerate(sentences)),
        reverse=True,
    )
    picked: list[str] = []
    used_chars = 0
    for score, _neg_i, sentence in scored:
        if score == 0 and picked:
            break  # only keep zero-score sentences as fallback if we have nothing
        if used_chars + len(sentence) > max_chars:
            continue
        picked.append(sentence)
        used_chars += len(sentence)
        if len(picked) >= max_snippets:
            break

    if not picked and sentences:
        # Fallback: just take the first non-boilerplate sentence
        picked = [sentences[0][:max_chars]]

    return " ".join(picked)


# ---- Tavily calls ----

TAVILY_SEARCH_URL = "https://api.tavily.com/search"
TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"


def _post(url: str, payload: dict, timeout: int = 30) -> dict:
    resp = requests.post(url, json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def search_lean(
    query: str,
    max_results: int = 5,
    include_answer: bool = True,
    search_depth: str = "basic",
) -> dict:
    """
    Lean search. Asks Tavily for the slim form, then trims further.
    Returns: { query, answer, hits[{url,title,score,snippet,emails,phones}], stats }
    """
    api_key = get_api_key()
    payload = {
        "api_key": api_key,
        "query": query,
        "search_depth": search_depth,
        "max_results": max_results,
        "include_answer": include_answer,
        "include_raw_content": False,  # the big lever
    }
    raw = _post(TAVILY_SEARCH_URL, payload)
    raw_chars = len(json.dumps(raw))

    hits = []
    for r in raw.get("results", []):
        content = r.get("content", "") or ""
        snippet = pick_relevant_snippets(content, query)
        emails = list(dict.fromkeys(EMAIL_RE.findall(content)))[:5]
        phones = list(dict.fromkeys(PHONE_RE.findall(content)))[:3]
        hits.append({
            "url": r.get("url"),
            "title": r.get("title"),
            "score": round(float(r.get("score", 0.0)), 3),
            "snippet": snippet,
            "emails": emails,
            "phones": phones,
        })

    lean = {
        "query": query,
        "answer": (raw.get("answer") or "").strip() or None,
        "hits": hits,
    }
    lean_chars = len(json.dumps(lean))
    lean["stats"] = {
        "raw_chars": raw_chars,
        "lean_chars": lean_chars,
        "ratio": round(lean_chars / raw_chars, 4) if raw_chars else None,
    }
    return lean


def extract_lean(url: str, query_hint: str = "", timeout: int = 30) -> dict:
    """
    Extract one URL, return only relevant snippets + structured data.
    query_hint biases snippet selection toward what you care about.
    """
    api_key = get_api_key()
    payload = {
        "api_key": api_key,
        "urls": [url],
        "include_images": False,
    }
    raw = _post(TAVILY_EXTRACT_URL, payload, timeout=timeout)
    raw_chars = len(json.dumps(raw))

    results = raw.get("results", [])
    if not results:
        return {"url": url, "ok": False, "error": "no result", "stats": {"raw_chars": raw_chars, "lean_chars": 0}}

    r = results[0]
    content = r.get("raw_content") or r.get("content") or ""
    snippet = pick_relevant_snippets(content, query_hint or url, max_snippets=5, max_chars=800)
    emails = list(dict.fromkeys(EMAIL_RE.findall(content)))[:10]
    phones = list(dict.fromkeys(PHONE_RE.findall(content)))[:5]

    lean = {
        "url": url,
        "ok": True,
        "snippet": snippet,
        "emails": emails,
        "phones": phones,
    }
    lean_chars = len(json.dumps(lean))
    lean["stats"] = {
        "raw_chars": raw_chars,
        "lean_chars": lean_chars,
        "ratio": round(lean_chars / raw_chars, 4) if raw_chars else None,
    }
    return lean


# ---- CLI ----


def _print_json(obj: dict) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def cli_benchmark() -> None:
    """Run a representative query and report the bloat ratio."""
    queries = [
        "Anime Expo 2026 exhibitor list",
        "VidCon 2026 marketing director email",
        "Los Angeles Convention Center upcoming events 2026",
    ]
    print("=" * 72)
    print("TAVILY_LEAN BENCHMARK")
    print("=" * 72)
    total_raw = 0
    total_lean = 0
    for q in queries:
        try:
            r = search_lean(q, max_results=5)
        except Exception as e:
            print(f"  FAIL  {q}  --  {e}")
            continue
        s = r["stats"]
        total_raw += s["raw_chars"]
        total_lean += s["lean_chars"]
        print(f"\nquery: {q}")
        print(f"  raw_chars : {s['raw_chars']:>8}")
        print(f"  lean_chars: {s['lean_chars']:>8}")
        print(f"  ratio     : {s['ratio']}")
        print(f"  hits      : {len(r['hits'])}")
        if r.get("answer"):
            print(f"  answer    : {r['answer'][:120]}")
    print("\n" + "-" * 72)
    if total_raw:
        print(f"TOTAL raw : {total_raw}")
        print(f"TOTAL lean: {total_lean}")
        print(f"Trim ratio: {round(total_lean/total_raw, 4)}  (lower is better)")
        savings = 1 - (total_lean / total_raw)
        print(f"Savings   : {round(savings*100, 1)}% chars dropped")
    print("=" * 72)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "search":
        if len(argv) < 3:
            print("usage: tavily_lean.py search <query>")
            return 1
        query = " ".join(argv[2:])
        _print_json(search_lean(query))
        return 0
    if cmd == "extract":
        if len(argv) < 3:
            print("usage: tavily_lean.py extract <url> [query_hint]")
            return 1
        url = argv[2]
        hint = " ".join(argv[3:]) if len(argv) > 3 else ""
        _print_json(extract_lean(url, query_hint=hint))
        return 0
    if cmd == "benchmark":
        cli_benchmark()
        return 0
    print(f"unknown command: {cmd}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
