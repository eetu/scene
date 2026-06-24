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
    ( cd apps/{{app}}/backend && cargo run ) &
    ( cd apps/{{app}}/frontend && yarn dev ) &
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
