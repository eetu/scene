"""Stateless media transcoder sidecar.

The pure-Rust party backend stays a tiny scratch binary; anything that needs
ffmpeg is offloaded here. Endpoints take raw file bytes in the request body plus
an `ext` hint, and return web-native bytes:

  POST /image?ext=lbm  →  PNG   (ffmpeg: ILBM/LBM, PCX, TIFF, TGA, BMP, …)
  POST /video?ext=mpg  →  MP4   (ffmpeg: MPEG-1, AVI, FLI/FLC, …)

ffmpeg handles both — its image decoders cover the Amiga/DOS still formats
(ILBM, PCX, TGA, TIFF) that ImageMagick builds often lack a delegate for. No
state is kept; the backend owns the derived-asset cache. Bind loopback; an
optional bearer (PARTY_TRANSCODER_TOKEN) is defense-in-depth.
"""

from __future__ import annotations

import hmac
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from . import __version__

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="party-transcoder", version=__version__)

_TOKEN = os.environ.get("PARTY_TRANSCODER_TOKEN") or None
if _TOKEN is None:
    log.warning(
        "PARTY_TRANSCODER_TOKEN unset — no bearer auth; relying on the loopback bind alone."
    )

# ffmpeg handles both stills and video.
_FFMPEG = shutil.which("ffmpeg")

# Hard ceilings so a pathological input can't wedge the sidecar.
_MAX_BYTES = 256 * 1024 * 1024
_IMAGE_TIMEOUT = 30
_VIDEO_TIMEOUT = 600


@app.middleware("http")
async def require_token(request: Request, call_next):
    if _TOKEN is not None and request.url.path != "/health":
        hdr = request.headers.get("authorization", "")
        presented = hdr[7:].strip() if hdr[:7].lower() == "bearer " else ""
        if not hmac.compare_digest(presented, _TOKEN):
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return await call_next(request)


def _safe_ext(ext: str) -> str:
    """A short alphanumeric extension, for naming the temp input so the tools
    auto-detect the format. Rejects anything fishy."""
    e = ext.lower().lstrip(".")
    if not e.isalnum() or len(e) > 8:
        raise HTTPException(status_code=400, detail="bad ext")
    return e


async def _read_body(request: Request) -> bytes:
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="input too large")
    return body


def _run(cmd: list[str], timeout: int) -> None:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="transcode timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="transcoder tool missing")
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace")[-400:].strip()
        log.warning("transcode failed: %s", msg)
        raise HTTPException(status_code=422, detail=f"transcode failed: {msg}")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": __version__, "ffmpeg": bool(_FFMPEG)}


@app.post("/image")
async def image(request: Request, ext: str = Query("")) -> Response:
    if not _FFMPEG:
        raise HTTPException(status_code=500, detail="ffmpeg not installed")
    e = _safe_ext(ext)
    body = await _read_body(request)
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / f"in.{e}"
        src.write_bytes(body)
        out = Path(d) / "out.png"
        # `-frames:v 1` takes the first frame of multi-image/animated inputs.
        _run(
            [
                _FFMPEG,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(src),
                "-frames:v",
                "1",
                str(out),
            ],
            _IMAGE_TIMEOUT,
        )
        png = out.read_bytes()
    return Response(content=png, media_type="image/png")


@app.post("/video")
async def video(request: Request, ext: str = Query("")) -> Response:
    if not _FFMPEG:
        raise HTTPException(status_code=500, detail="ffmpeg not installed")
    e = _safe_ext(ext)
    body = await _read_body(request)
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / f"in.{e}"
        src.write_bytes(body)
        out = Path(d) / "out.mp4"
        _run(
            [
                _FFMPEG,
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(src),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                # Even dimensions are required by yuv420p/H.264.
                "-vf",
                "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(out),
            ],
            _VIDEO_TIMEOUT,
        )
        mp4 = out.read_bytes()
    return Response(content=mp4, media_type="video/mp4")
