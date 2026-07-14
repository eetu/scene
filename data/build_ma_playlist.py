#!/usr/bin/env python3
"""Turn a Mod Archive chart into a tracker import document, with real md5s.

Mod Archive gives the list (chart links carry `moduleid#filename`) and a per-
module **md5** on each module's info page — but no Modland-style fetch path. So:
take each module's md5 (scraped from its cached info page), then look that md5 up
in Modland's catalog (allmods_md5.txt: `<md5> <path>`) to attach a Modland `path`
where the same bytes exist there (→ fetchable). md5 alone already lets the import
match your library precisely (e.g. tunes you already own show present).

Usage: build_ma_playlist.py <ids.txt> <pages_dir> <allmods_md5.txt> <out.json> "<name>" "<source>"
  ids.txt: one `<moduleid>#<filename>` per line (chart order).
  pages_dir: <moduleid>.html info pages (for the md5).
"""
import html as htmllib
import json
import os
import re
import sys

MD5_RE = re.compile(r"MD5:\s*([0-9a-fA-F]{32})")
# Registered-artist block on a module's info page — scoped so the page's
# *favourites* member links don't match (see enrich_ma_artists.py).
ARTIST_BLOCK_RE = re.compile(r"Registered Artist\(s\):.*?<ul[^>]*>(.*?)</ul>", re.IGNORECASE | re.DOTALL)
ARTIST_LINK_RE = re.compile(r'href="member\.php\?[^"]*"[^>]*>([^<]+)</a>', re.IGNORECASE)


def parse_artist(page: str) -> str | None:
    """The first registered-artist alias on a module info page, or None."""
    block = ARTIST_BLOCK_RE.search(page)
    if not block:
        return None
    link = ARTIST_LINK_RE.search(block.group(1))
    if not link:
        return None
    return htmllib.unescape(link.group(1)).strip() or None


def main() -> None:
    ids_path, pages_dir, md5txt, out_path, name, source = sys.argv[1:7]

    # md5 -> Modland path (first match), for fetchability.
    md5_to_path = {}
    with open(md5txt, encoding="utf-8", errors="replace") as f:
        for line in f:
            sp = line.rstrip("\n").split(" ", 1)
            if len(sp) == 2 and len(sp[0]) == 32:
                md5_to_path.setdefault(sp[0].lower(), sp[1])

    items, with_md5, fetchable = [], 0, 0
    for line in open(ids_path, encoding="utf-8", errors="replace"):
        line = line.rstrip("\n")
        if "#" not in line:
            continue
        mid, filename = line.split("#", 1)
        page_path = os.path.join(pages_dir, f"{mid}.html")
        md5 = ma_artist = None
        if os.path.exists(page_path):
            page = open(page_path, encoding="utf-8", errors="replace").read()
            m = MD5_RE.search(page)
            if m:
                md5 = m.group(1).lower()
            ma_artist = parse_artist(page)
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        item = {"title": filename.rsplit(".", 1)[0], "format": ext, "filename": filename}
        # Always carry the Mod Archive direct-download URL so the item stays
        # fetchable even when Modland doesn't have it (the backend downloads the
        # url and verifies md5). A Modland `path`, when found, is preferred.
        item["url"] = f"https://api.modarchive.org/downloads.php?moduleid={mid}"
        if md5:
            item["md5"] = md5
            with_md5 += 1
            path = md5_to_path.get(md5)
            if path:
                item["path"] = path
                segs = path.split("/")
                item["artist"] = segs[1] if len(segs) >= 3 else None
                fetchable += 1
        # No Modland author, but Mod Archive lists a registered artist → use it, so
        # a url-only item files at `_groupless/<artist>/<file>` (not flat).
        if not item.get("artist") and ma_artist:
            item["artist"] = ma_artist
        items.append(item)

    doc = {"name": name, "source": source, "items": items}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")  # trailing newline so the doc stays Prettier-clean
    print(f"wrote {len(items)} items ({with_md5} with md5, {fetchable} fetchable via Modland)")


if __name__ == "__main__":
    main()
