# scene monorepo task runner. `just` with no args lists recipes.
# Frontends: yarn workspaces. Backends: one cargo workspace. Sidecars: uv.

default:
    @just --list

# Install all JS workspace deps (root yarn workspace).
install:
    yarn install

# Run an app in dev: backend (cargo) + frontend (vite) together.
# Usage: just dev party   |   just dev tracker
dev app:
    #!/usr/bin/env bash
    set -euo pipefail
    # Tear down both children (and their grandchildren — the actual backend
    # binary under cargo, vite under yarn) on Ctrl-C / exit, so nothing orphans
    # and holds its port. Killing only the children — NOT `kill 0` — leaves
    # `just` and the shell unsignalled, so no stray SIGTERM noise on exit.
    back="" front=""
    cleanup() {
        trap - INT TERM EXIT
        for p in "$back" "$front"; do
            [ -n "$p" ] || continue
            pkill -P "$p" 2>/dev/null || true
            kill "$p" 2>/dev/null || true
        done
    }
    trap cleanup INT TERM EXIT
    ( cd apps/{{app}}/backend && exec cargo run ) &
    back=$!
    ( cd apps/{{app}}/frontend && exec yarn dev ) &
    front=$!
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
    cd services/transcoder && uv run ruff check src

format:
    yarn format

# Tests: rust workspace.
test:
    cargo test --workspace

# Run the party transcoder sidecar (loopback).
transcoder:
    cd services/transcoder && uv run transcoder
