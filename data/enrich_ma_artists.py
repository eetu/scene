#!/usr/bin/env python3
"""Fill in the `artist` for a Mod Archive import doc's url-only items.

Items fetched by a bare Mod Archive `url` (no Modland `path`) carry no artist, so
the backend files them under the library's no-group bucket as `_groupless/<file>`.
Mod Archive's own module page lists the **registered artist(s)**, so scrape that
and write `item["artist"]` back into the doc — the backend then files the tune at
`_groupless/<artist>/<file>` instead.

Keyless: reads the public info page (`index.php?request=view_by_moduleid`), the
same HTML-scrape approach `build_ma_playlist.py` uses for the md5. Only registered
artists are used (a classic tune with none stays artist-less → `_groupless/<file>`).
Throttled — Mod Archive is volunteer-run, so be gentle. Idempotent: items that
already have an artist are left alone.

Usage: enrich_ma_artists.py [doc.json]
  doc.json: playlist import document (default: modarchive_top_favourites.playlist.json
            next to this script). Rewritten in place.
"""
import html
import json
import os
import re
import sys
import time
import urllib.request

MODULEID_RE = re.compile(r"moduleid=(\d+)")
# The registered-artist block: "Registered Artist(s):" ... <ul>…</ul>. Scope the
# member link to that block so the page's *favourites* member links don't match.
ARTIST_BLOCK_RE = re.compile(
    r"Registered Artist\(s\):.*?<ul[^>]*>(.*?)</ul>", re.IGNORECASE | re.DOTALL
)
ARTIST_LINK_RE = re.compile(
    r'href="member\.php\?[^"]*"[^>]*>([^<]+)</a>', re.IGNORECASE
)
INFO_URL = "https://modarchive.org/index.php?request=view_by_moduleid&query={mid}"
USER_AGENT = "scene-tracker/enrich (+homebrew demoscene archive player)"
THROTTLE_S = 0.4  # be kind to a volunteer-run service


def fetch_artist(mid: str) -> str | None:
    """The first registered-artist alias for a module id, or None."""
    req = urllib.request.Request(INFO_URL.format(mid=mid), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        page = resp.read().decode("utf-8", errors="replace")
    block = ARTIST_BLOCK_RE.search(page)
    if not block:
        return None
    link = ARTIST_LINK_RE.search(block.group(1))
    if not link:
        return None
    alias = html.unescape(link.group(1)).strip()
    return alias or None


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    doc_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "modarchive_top_favourites.playlist.json")

    with open(doc_path, encoding="utf-8") as f:
        doc = json.load(f)
    items = doc.get("items", [])

    # url-only items still missing an artist (skip anything already placed).
    todo = [
        it
        for it in items
        if it.get("url") and not (it.get("artist") or "").strip() and MODULEID_RE.search(it["url"])
    ]
    print(f"{len(todo)} url items need an artist (of {len(items)} total)")

    filled = failed = 0
    for it in todo:
        mid = MODULEID_RE.search(it["url"]).group(1)
        try:
            artist = fetch_artist(mid)
        except Exception as e:  # noqa: BLE001 — best-effort scrape; report + continue
            print(f"  moduleid={mid} ({it.get('filename')}): fetch failed: {e}", file=sys.stderr)
            failed += 1
            time.sleep(THROTTLE_S)
            continue
        if artist:
            it["artist"] = artist
            filled += 1
            print(f"  moduleid={mid} ({it.get('filename')}): {artist}")
        else:
            print(f"  moduleid={mid} ({it.get('filename')}): no registered artist")
        time.sleep(THROTTLE_S)

    with open(doc_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")  # trailing newline so the doc stays Prettier-clean
    print(f"filled {filled}, none-found {len(todo) - filled - failed}, failed {failed} → {doc_path}")


if __name__ == "__main__":
    main()
