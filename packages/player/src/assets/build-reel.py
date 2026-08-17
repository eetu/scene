"""Bake a video into a one-bit reel for the flip-dot board.

    python build-reel.py <in.mp4> <out-dir>/<id>.bin [--cols 48] [--rows 36] [--fps 12]

`id` is what the reel is matched against: the viz plays it when the loaded module's
name contains it (letters and digits only, folded to lower case), so `badapple.bin`
plays for `Bad Apple!! (XM cover).xm` and for nothing else.

Reels are NOT committed. They are derived frames of somebody else's video, and this
repository is public — build yours locally from a file you have, and the folder they
live in is gitignored. A missing reel is not an error anywhere: the board simply keeps
showing its own modes.

Needs ffmpeg on PATH and nothing else — the frames come out of it already scaled and
grey, so the whole of the image processing here is a threshold.

The output is what flip-reel.ts reads:

    "REEL" | version u8 | cols u8 | rows u8 | fps u8 | frames u32le
    then per frame an XOR delta against the one before it, run-length encoded in BITS:
    alternating runs of unchanged and flipped, starting with unchanged, each LEB128.

Frame rate is the board's, not the video's. The board updates about fourteen times a
second behind a 70ms driver sweep and a 38ms flip, so a reel baked at 24fps would ask
for changes the discs cannot finish; twelve is the most that still lands, and eight
reads as deliberate rather than as a board struggling to keep up.
"""

import argparse
import subprocess
import sys
from pathlib import Path


def frames(video: Path, cols: int, rows: int, fps: int):
    """Grey, scaled and un-letterboxed frames, one bytes() of cols*rows per frame."""
    # `scale` alone would squash a 4:3 source into whatever the board is; the reel is
    # fitted to the board at runtime instead, so here the aspect is kept and the frame
    # is padded to the target. force_original_aspect_ratio does the fitting, pad
    # centres it.
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(video),
        "-vf",
        f"fps={fps},scale={cols}:{rows}:force_original_aspect_ratio=decrease,"
        f"pad={cols}:{rows}:(ow-iw)/2:(oh-ih)/2:black,format=gray",
        "-f",
        "rawvideo",
        "-",
    ]
    size = cols * rows
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    assert proc.stdout is not None
    while True:
        buf = proc.stdout.read(size)
        if not buf or len(buf) < size:
            break
        yield buf
    proc.stdout.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")


def pack(buf: bytes, threshold: int) -> bytearray:
    """One bit per dot, MSB first, row-major."""
    out = bytearray((len(buf) + 7) // 8)
    for i, v in enumerate(buf):
        if v >= threshold:
            out[i >> 3] |= 0x80 >> (i & 7)
    return out


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def delta(prev: bytearray, cur: bytearray, total: int) -> bytes:
    """Runs of unchanged then flipped bits, alternating, starting with unchanged."""
    out = bytearray()
    run = 0
    flip = False
    for i in range(total):
        bit = 0x80 >> (i & 7)
        changed = ((prev[i >> 3] ^ cur[i >> 3]) & bit) != 0
        if changed == flip:
            run += 1
        else:
            out += varint(run)
            run = 1
            flip = changed
    out += varint(run)
    return bytes(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("out", type=Path)
    # 48x36 is 4:3 at a size the board can hold: it is downsampled to whatever the
    # pane's board actually is, and baking a little above that keeps a silhouette's
    # edges from being decided twice.
    ap.add_argument("--cols", type=int, default=48)
    ap.add_argument("--rows", type=int, default=36)
    ap.add_argument("--fps", type=int, default=12)
    # Shadow animation is already black and white; the threshold only decides what the
    # scaler's grey edge pixels become. Half is the neutral choice.
    ap.add_argument("--threshold", type=int, default=128)
    ap.add_argument("--invert", action="store_true", help="lit background, dark subject")
    args = ap.parse_args()

    if not 1 <= args.cols <= 255 or not 1 <= args.rows <= 255 or not 1 <= args.fps <= 255:
        sys.exit("cols, rows and fps are one byte each")

    total = args.cols * args.rows
    stride = (total + 7) // 8
    prev = bytearray(stride)
    body = bytearray()
    count = 0

    for buf in frames(args.video, args.cols, args.rows, args.fps):
        cur = pack(buf, args.threshold)
        if args.invert:
            for i in range(stride):
                cur[i] ^= 0xFF
        body += delta(prev, cur, total)
        prev = cur
        count += 1

    if not count:
        sys.exit("no frames — is that a video?")

    head = bytearray(b"REEL")
    head.append(1)
    head += bytes([args.cols, args.rows, args.fps])
    head += count.to_bytes(4, "little")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(bytes(head) + bytes(body))
    raw = count * stride
    print(
        f"{args.out}: {count} frames at {args.cols}x{args.rows}, {args.fps}fps — "
        f"{len(head) + len(body):,} bytes ({raw:,} raw)"
    )


if __name__ == "__main__":
    main()
