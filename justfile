# scene monorepo task runner. `just` with no args lists recipes.
# Frontends: yarn workspaces. Backends: one cargo workspace. Sidecars: uv.

default:
    @just --list

# Install all JS workspace deps (root yarn workspace).
install:
    yarn install

# Per-component alternative (own terminals): `cd apps/<app>/backend && bacon`
# (TUI), `cd apps/<app>/frontend && yarn dev`, `uv run …` for a Python sidecar.
# In `just dev` the backend runs headless (`bacon --headless -j run`) so all the
# logs compose into one stream; backends hot-reload on src + .env changes.
#
# Dev a whole service: backend (bacon) + frontend (vite) + sidecars. e.g. just dev tracker
dev app:
    #!/usr/bin/env bash
    set -euo pipefail
    # Tear down every child (and its grandchildren — the backend binary under
    # bacon, vite under yarn) on Ctrl-C / exit, so nothing orphans and holds its
    # port. Killing only the children — NOT `kill 0` — leaves `just` and the
    # shell unsignalled, so no stray SIGTERM noise on exit.
    pids=""
    cleanup() {
        trap - INT TERM EXIT
        for p in $pids; do
            pkill -P "$p" 2>/dev/null || true
            kill "$p" 2>/dev/null || true
        done
    }
    trap cleanup INT TERM EXIT
    ( cd apps/{{app}}/backend && exec bacon --headless -j run ) &
    pids="$pids $!"
    ( cd apps/{{app}}/frontend && exec yarn dev ) &
    pids="$pids $!"
    # Sidecars this service needs (loopback). Party fronts the ffmpeg transcoder.
    if [ "{{app}}" = "party" ]; then
        ( cd services/transcoder && exec bacon --headless -j run ) &
        pids="$pids $!"
    fi
    wait

# Build everything: all frontends, then the whole rust workspace.
build:
    yarn build
    cargo build --release --workspace

# Build one app's frontend + backend.
build-app app:
    yarn workspace {{app}}-frontend run build
    cargo build --release -p {{app}}-backend

# Lint/format/typecheck across the repo.
lint:
    yarn lint
    cargo clippy --workspace --all-targets -- -D warnings

format:
    yarn format

# Tests: rust workspace.
test:
    cargo test --workspace

# Run the party transcoder sidecar (loopback), auto-reloading via bacon.
transcoder:
    cd services/transcoder && bacon --headless -j run
