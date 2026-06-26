#!/usr/bin/env python3
"""Turn a Modland .m3u (full-URL entries) into a tracker import document.

Tracker plays MOD/XM/S3M/IT (+ kin) via libopenmpt, so we keep only those, then
sample down to a "nice" ~target size. Each item carries the Modland `path` (the
fetch key) + display metadata. If a Modland md5 catalog (allmods_md5.txt:
`<md5> <path>`, from /pub/documents/allmods_md5.zip) is given, the md5 is filled
in too — so the import resolves overlap against the library precisely by md5
(otherwise md5 is filled on fetch).

Usage: build_playlist.py <in.m3u> <out.json> "<name>" "<source>" [target] [allmods_md5.txt]
"""
import json
import sys
from urllib.parse import unquote

# Extensions libopenmpt opens (a practical subset of the tracker's MODULE_EXTS).
PLAYABLE = {
    "mod", "xm", "s3m", "it", "mptm", "stm", "mtm", "669", "far", "ult",
    "okt", "okta", "med", "dbm", "digi", "dmf", "dsm", "mdl", "ptm", "psm",
}


def load_md5(path: str) -> dict[str, str]:
    p2m: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            sp = line.rstrip("\n").split(" ", 1)
            if len(sp) == 2 and len(sp[0]) == 32:
                p2m[sp[1]] = sp[0].lower()
    return p2m


def main() -> None:
    src_path, out_path, name, source = sys.argv[1:5]
    target = int(sys.argv[5]) if len(sys.argv) > 5 else 100
    p2m = load_md5(sys.argv[6]) if len(sys.argv) > 6 else {}

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
        item = {"path": path, "title": title, "artist": segs[1], "format": ext, "filename": filename}
        if path in p2m:
            item["md5"] = p2m[path]
        items.append(item)

    # Even sample down to ~target, preserving order (variety across authors).
    if len(items) > target:
        step = len(items) / target
        items = [items[int(i * step)] for i in range(target)]

    doc = {"name": name, "source": source, "items": items}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    with_md5 = sum(1 for i in items if "md5" in i)
    print(f"wrote {len(items)} items to {out_path} ({with_md5} with md5)")


if __name__ == "__main__":
    main()
