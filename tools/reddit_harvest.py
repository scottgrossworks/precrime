#!/usr/bin/env python3
"""
Pre-Crime Reddit Harvester — public JSON endpoints, no auth required

Searches subreddits by keyword via Reddit's public .json API and dumps structured JSON.
Zero Claude tokens. No API keys. No PRAW. No Rust.

Usage:
  python reddit_harvest.py --subreddit education --keywords "SEL counselor" --limit 25
  python reddit_harvest.py --config reddit/reddit_config.json
  python reddit_harvest.py --subreddit teachers --keywords "mental health" --limit 10 --sort new

Requires:
  pip install requests   (usually already installed)

Output:
  ./scrapes/{date}/{subreddit}_search_{keywords}.json
"""

import argparse
import json
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: Missing requests. Run: pip install requests", file=sys.stderr)
    sys.exit(1)

# Reddit blocks default python-requests UA. Use a browser-like one.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PreCrime-Harvester/1.0",
    "Accept": "application/json",
}

# Be polite — minimum delay between requests (seconds)
REQUEST_DELAY = 2


def search_subreddit(subreddit_name, keywords, limit=25, sort="relevance", time_filter="month"):
    """Search a subreddit via public JSON endpoint. Returns list of post dicts."""
    url = f"https://www.reddit.com/r/{subreddit_name}/search.json"
    params = {
        "q": keywords,
        "sort": sort,
        "t": time_filter,
        "limit": min(limit, 100),  # Reddit caps at 100 per request
        "restrict_sr": "on",
        "type": "link",
    }

    resp = requests.get(url, headers=HEADERS, params=params, timeout=30)

    if resp.status_code == 429:
        print("  Rate limited — waiting 60s...", file=sys.stderr)
        time.sleep(60)
        resp = requests.get(url, headers=HEADERS, params=params, timeout=30)

    if resp.status_code != 200:
        print(f"  ERROR: HTTP {resp.status_code} for r/{subreddit_name}", file=sys.stderr)
        return []

    data = resp.json()
    children = data.get("data", {}).get("children", [])
    results = []

    for child in children:
        post = child.get("data", {})
        created = post.get("created_utc", 0)
        results.append({
            "id": post.get("id"),
            "title": post.get("title"),
            "selftext": post.get("selftext", ""),
            "author": post.get("author", "[deleted]"),
            "score": post.get("score", 0),
            "upvote_ratio": post.get("upvote_ratio", 0),
            "num_comments": post.get("num_comments", 0),
            "created_utc": created,
            "created_iso": datetime.fromtimestamp(created, tz=timezone.utc).isoformat() if created else None,
            "permalink": post.get("permalink"),
            "url": post.get("url"),
            "subreddit": post.get("subreddit"),
            "link_flair_text": post.get("link_flair_text"),
            "is_self": post.get("is_self", False),
            "over_18": post.get("over_18", False),
        })

    return results


def save_results(subreddit_name, keywords, results, output_dir="./scrapes"):
    """Save results to JSON file in scrapes/{date}/ directory."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    out_dir = Path(output_dir) / date_str
    out_dir.mkdir(parents=True, exist_ok=True)

    # Sanitize keywords for filename
    kw_slug = keywords.replace(" ", "_").replace('"', "")[:50]
    filename = f"{subreddit_name}_search_{kw_slug}.json"
    out_path = out_dir / filename

    output = {
        "scrape_settings": {
            "subreddit": subreddit_name,
            "keywords": keywords,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            "count": len(results),
        },
        "data": results,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    return str(out_path)


def run_single(subreddit, keywords, limit, sort, time_filter, output_dir="./scrapes"):
    """Run a single subreddit search and save."""
    print(f"  Searching r/{subreddit} for \"{keywords}\" (limit={limit}, sort={sort}, time={time_filter})...")
    results = search_subreddit(subreddit, keywords, limit, sort, time_filter)
    out_path = save_results(subreddit, keywords, results, output_dir)
    print(f"  -> {len(results)} posts saved to {out_path}")
    return out_path, len(results)


def run_from_config(config_path):
    """Run all searches defined in a reddit_config.json file."""
    with open(config_path, "r") as f:
        config = json.load(f)

    limit = config.get("harvester", {}).get("maxPostsPerSearch", 25)
    output_dir = config.get("harvester", {}).get("outputDir", "./scrapes")
    global_kw = config.get("globalKeywords", [])
    total_posts = 0
    files = []

    for sub_cfg in config.get("subreddits", []):
        name = sub_cfg["name"]
        keywords = sub_cfg.get("keywords", [])

        # Combine subreddit-specific keywords into a search string
        search_terms = " ".join(keywords) if keywords else " ".join(global_kw)
        if not search_terms:
            print(f"  Skipping r/{name} — no keywords", file=sys.stderr)
            continue

        out_path, count = run_single(name, search_terms, limit, "relevance", "month", output_dir)
        files.append(out_path)
        total_posts += count

        # Polite delay between subreddits
        time.sleep(REQUEST_DELAY)

    return files, total_posts


def main():
    parser = argparse.ArgumentParser(description="Pre-Crime Reddit Harvester")
    parser.add_argument("--subreddit", "-r", help="Subreddit name (without r/)")
    parser.add_argument("--keywords", "-k", help="Search keywords (quoted string)")
    parser.add_argument("--limit", "-n", type=int, default=25, help="Max posts to fetch (default: 25)")
    parser.add_argument("--sort", "-s", default="relevance", choices=["relevance", "hot", "top", "new", "comments"], help="Sort order")
    parser.add_argument("--time", "-t", default="month", choices=["all", "day", "hour", "month", "week", "year"], help="Time filter")
    parser.add_argument("--config", "-c", help="Path to reddit_config.json (runs all configured searches)")
    parser.add_argument("--output", "-o", default="./scrapes", help="Output directory (default: ./scrapes)")

    args = parser.parse_args()

    if not args.subreddit and not args.config:
        parser.print_help()
        print("\nERROR: Provide either --subreddit + --keywords OR --config", file=sys.stderr)
        sys.exit(1)

    if args.config:
        print(f"Running config: {args.config}")
        files, total = run_from_config(args.config)
        print(f"\nDone. {total} posts across {len(files)} searches.")
    else:
        if not args.keywords:
            print("ERROR: --keywords required when using --subreddit", file=sys.stderr)
            sys.exit(1)
        run_single(args.subreddit, args.keywords, args.limit, args.sort, args.time, args.output)


if __name__ == "__main__":
    main()
