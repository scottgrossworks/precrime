#!/usr/bin/env python3
"""
Pre-Crime Instagram Harvester — public profiles, no login required

Fetches posts from public Instagram accounts and hashtags via Instaloader.
Zero Claude tokens. No API keys. No compiled dependencies.

Instaloader handles its own rate limiting. Public profile scraping works
without login up to ~100-200 profiles per session before throttling.

Usage:
  python ig_harvest.py --config ig/ig_config.json
  python ig_harvest.py --account venuelosangeles --limit 20
  python ig_harvest.py --hashtag weddingdjla --limit 25

Requires:
  pip install instaloader

Output:
  ./scrapes/{date}/ig_account_{username}.json
  ./scrapes/{date}/ig_hashtag_{tag}.json
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import instaloader
except ImportError:
    print("ERROR: Missing instaloader. Run: pip install instaloader", file=sys.stderr)
    sys.exit(1)

# Delay between accounts/hashtags (seconds). Instaloader has its own internal
# per-request delay; this is the between-target delay.
ACCOUNT_DELAY = 3
HASHTAG_DELAY = 30  # Hashtag endpoints are more aggressively rate-limited


def make_loader():
    """Create an Instaloader instance configured for read-only, no-download operation."""
    return instaloader.Instaloader(
        quiet=True,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        post_metadata_txt_pattern="",
        max_connection_attempts=3,
    )


def post_to_dict(post, author_override=None):
    """Convert an Instaloader Post object to the standard schema dict."""
    try:
        hashtags = list(post.caption_hashtags) if post.caption_hashtags else []
    except Exception:
        hashtags = []

    try:
        location = str(post.location.name) if post.location and post.location.name else None
    except Exception:
        location = None

    try:
        media_url = post.url
    except Exception:
        media_url = None

    return {
        "id": post.shortcode,
        "text": post.caption or "",
        "author": author_override or post.owner_username,
        "likes": post.likes,
        "comments": post.comments,
        "created_utc": post.date_utc.timestamp(),
        "created_iso": post.date_utc.isoformat(),
        "permalink": f"/p/{post.shortcode}/",
        "location": location,
        "hashtags": hashtags,
        "is_video": post.is_video,
        "media_url": media_url,
    }


def fetch_account_posts(username, limit=20):
    """
    Fetch recent posts from a public Instagram account.
    Returns (list_of_post_dicts, error_string_or_None).
    """
    L = make_loader()
    posts = []
    error = None

    try:
        profile = instaloader.Profile.from_username(L.context, username)
        for i, post in enumerate(profile.get_posts()):
            if i >= limit:
                break
            posts.append(post_to_dict(post, author_override=username))
            # Brief internal pause — instaloader already rate-limits but be extra polite
            if i > 0 and i % 10 == 0:
                time.sleep(2)

    except instaloader.exceptions.LoginRequiredException:
        error = "LOGIN_REQUIRED — account is private or requires auth for this content"
    except instaloader.exceptions.ProfileNotExistsException:
        error = "PROFILE_NOT_FOUND — account does not exist or has been deleted"
    except instaloader.exceptions.QueryReturnedNotFoundException:
        error = "NOT_FOUND — account returned 404"
    except instaloader.exceptions.TooManyRequestsException:
        print(f"  Rate limited on @{username} — waiting 60s...", file=sys.stderr)
        time.sleep(60)
        error = "RATE_LIMITED — skipped after 60s wait; retry later"
    except instaloader.exceptions.BadResponseException as e:
        error = f"BAD_RESPONSE — {e}"
    except Exception as e:
        error = f"ERROR — {type(e).__name__}: {e}"

    return posts, error


def fetch_hashtag_posts(tag, limit=25):
    """
    Fetch recent posts for a public hashtag.
    Returns (list_of_post_dicts, error_string_or_None).
    Hashtag scraping is more rate-limited than profile scraping.
    """
    L = make_loader()
    posts = []
    error = None

    try:
        hashtag = instaloader.Hashtag.from_name(L.context, tag)
        for i, post in enumerate(hashtag.get_posts()):
            if i >= limit:
                break
            posts.append(post_to_dict(post))

    except instaloader.exceptions.LoginRequiredException:
        error = "LOGIN_REQUIRED — hashtag requires auth (private or restricted)"
    except instaloader.exceptions.QueryReturnedNotFoundException:
        error = "NOT_FOUND — hashtag does not exist"
    except instaloader.exceptions.TooManyRequestsException:
        print(f"  Rate limited on #{tag} — waiting 90s...", file=sys.stderr)
        time.sleep(90)
        error = "RATE_LIMITED — skipped after 90s wait; retry later"
    except instaloader.exceptions.BadResponseException as e:
        error = f"BAD_RESPONSE — {e}"
    except Exception as e:
        error = f"ERROR — {type(e).__name__}: {e}"

    return posts, error


def save_results(source_type, source_name, results, error, output_dir="./scrapes"):
    """Save results to JSON in scrapes/{date}/ directory. Returns output path."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    out_dir = Path(output_dir) / date_str
    out_dir.mkdir(parents=True, exist_ok=True)

    slug = source_name.replace("/", "_").replace(" ", "_")[:50]
    filename = f"ig_{source_type}_{slug}.json"
    out_path = out_dir / filename

    output = {
        "scrape_settings": {
            "source": "instagram",
            source_type: source_name,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            "count": len(results),
        },
        "data": results,
    }
    if error:
        output["scrape_settings"]["error"] = error

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    return str(out_path)


def run_account(username, limit, output_dir="./scrapes"):
    print(f"  Fetching @{username} (limit={limit})...")
    posts, error = fetch_account_posts(username, limit)
    out_path = save_results("account", username, posts, error, output_dir)
    if error:
        print(f"  -> {error}. Saved empty result to {out_path}")
    else:
        print(f"  -> {len(posts)} posts saved to {out_path}")
    return out_path, len(posts), error


def run_hashtag(tag, limit, output_dir="./scrapes"):
    print(f"  Fetching #{tag} (limit={limit})...")
    posts, error = fetch_hashtag_posts(tag, limit)
    out_path = save_results("hashtag", tag, posts, error, output_dir)
    if error:
        print(f"  -> {error}. Saved empty result to {out_path}")
    else:
        print(f"  -> {len(posts)} posts saved to {out_path}")
    return out_path, len(posts), error


def run_from_config(config_path):
    """Run all accounts and hashtags defined in ig_config.json."""
    with open(config_path, "r") as f:
        config = json.load(f)

    limit = config.get("harvester", {}).get("maxPostsPerAccount", 20)
    hashtag_limit = config.get("harvester", {}).get("maxPostsPerHashtag", 25)
    output_dir = config.get("harvester", {}).get("outputDir", "./scrapes")
    total_posts = 0
    files = []
    errors = []

    # Accounts
    for acct in config.get("accounts", []):
        username = acct.get("username", "").lstrip("@")
        if not username:
            continue
        out_path, count, error = run_account(username, limit, output_dir)
        files.append(out_path)
        total_posts += count
        if error:
            errors.append(f"@{username}: {error}")
        time.sleep(ACCOUNT_DELAY)

    # Hashtags
    for tag in config.get("hashtags", []):
        tag = tag.lstrip("#")
        if not tag:
            continue
        out_path, count, error = run_hashtag(tag, hashtag_limit, output_dir)
        files.append(out_path)
        total_posts += count
        if error:
            errors.append(f"#{tag}: {error}")
        time.sleep(HASHTAG_DELAY)

    if errors:
        print(f"\nWarnings ({len(errors)}):")
        for e in errors:
            print(f"  - {e}")

    return files, total_posts


def main():
    parser = argparse.ArgumentParser(description="Pre-Crime Instagram Harvester")
    parser.add_argument("--account", "-a", help="Instagram username (without @)")
    parser.add_argument("--hashtag", "-t", help="Hashtag to search (without #)")
    parser.add_argument("--limit", "-n", type=int, default=20, help="Max posts to fetch (default: 20)")
    parser.add_argument("--config", "-c", help="Path to ig_config.json (batch mode)")
    parser.add_argument("--output", "-o", default="./scrapes", help="Output directory (default: ./scrapes)")

    args = parser.parse_args()

    if not args.account and not args.hashtag and not args.config:
        parser.print_help()
        print("\nERROR: Provide --account, --hashtag, or --config", file=sys.stderr)
        sys.exit(1)

    if args.config:
        print(f"Running config: {args.config}")
        files, total = run_from_config(args.config)
        print(f"\nDone. {total} posts across {len(files)} targets.")
    elif args.account:
        run_account(args.account.lstrip("@"), args.limit, args.output)
    elif args.hashtag:
        run_hashtag(args.hashtag.lstrip("#"), args.limit, args.output)


if __name__ == "__main__":
    main()
