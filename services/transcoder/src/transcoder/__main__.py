"""Dev entrypoint for the transcoder.

Loads `.env` from the working directory, then boots uvicorn with reload enabled.
Production deploys (../mini launchd, Phase 4) run uvicorn directly under a
wrapper with the env file — that path skips this script.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
import uvicorn


def main() -> None:
    load_dotenv()  # picks up ./.env, no-op if missing
    host = os.environ.get("PARTY_TRANSCODER_HOST", "127.0.0.1")
    port = int(os.environ.get("PARTY_TRANSCODER_PORT", "3021"))
    reload = os.environ.get("PARTY_TRANSCODER_RELOAD", "1") != "0"
    uvicorn.run(
        "transcoder.main:app",
        host=host,
        port=port,
        reload=reload,
        reload_dirs=["src"] if reload else None,
        log_level=os.environ.get("PARTY_TRANSCODER_LOG", "info"),
    )


if __name__ == "__main__":
    main()
