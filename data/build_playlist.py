#!/usr/bin/env python3
"""Turn a Modland .m3u (full-URL entries) into a tracker import document.

Tracker plays MOD/XM/S3M/IT (+ kin) via libopenmpt, so we keep only those, then
sample down to a "nice" ~target size. Each item carries the Modland `path` (the
fetch key) + display metadata; md5 is left out and filled when fetched.

Usage: build_playlist.py <in.m3u> <out.json> "<name>" "<source>" [target]
"""
import json
import sys
from urllib.parse import unquote

# Extensions libopenmpt opens (a practical subset of the tracker's MODULE_EXTS).
PLAYABLE = {
    "mod", "xm", "s3m", "it", "mptm", "stm", "mtm", "669", "far", "ult",
    "okt", "okta", "med", "dbm", "digi", "dmf", "dsm", "mdl", "ptm", "psm",
}


def main() -> None:
    src_path, out_path, name, source = sys.argv[1:5]
    target = int(sys.argv[5]) if len(sys.argv) > 5 else 100

    items = []
    for line in open(src_path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line.startswith("#") or "/pub/modules/" not in line:
            continue
        path = unquote(line.split("/pub/modules/", 1)[1])
        segs = [s for s in path.split("/") if s]
        if len(segs) < 3:
            continue  # need Format/Author/file
        filename = segs[-1]
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext not in PLAYABLE:
            continue
        title = filename.rsplit(".", 1)[0]
        items.append(
            {"path": path, "title": title, "artist": segs[1], "format": ext, "filename": filename}
        )

    # Even sample down to ~target, preserving order (variety across authors).
    if len(items) > target:
        step = len(items) / target
        items = [items[int(i * step)] for i in range(target)]

    doc = {"name": name, "source": source, "items": items}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    print(f"wrote {len(items)} items to {out_path}")


if __name__ == "__main__":
    main()
