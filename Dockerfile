# syntax=docker/dockerfile:1
#
# Monorepo image builder. One image per service — build with --target:
#   docker build --target tracker     -t scene-tracker     .
#   docker build --target party       -t scene-party       .
#   docker build --target transcoder  -t scene-transcoder  .
#
# Rust backends cross-compile (tonistiigi/xx) to a static musl binary on
# scratch; each frontend-serving backend ships its app's built SPA. The
# transcoder is a Python/uv sidecar (needs ffmpeg, so a slim base, not scratch).

# --- Cross-compilation helper ---
FROM --platform=$BUILDPLATFORM tonistiigi/xx AS xx

# ============================================================================
# Frontends (yarn workspace — one install, then per-app builds)
# ============================================================================
# Vendored yarn (no corepack): the binary is committed at .yarn/releases and
# pinned by .yarnrc.yml's `yarnPath`, so the build doesn't depend on the base
# image's bundled yarn. Manifests are copied first so `install` caches across
# source-only changes.
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend-deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY packages/design/package.json ./packages/design/
COPY packages/player/package.json ./packages/player/
COPY apps/tracker/frontend/package.json ./apps/tracker/frontend/
COPY apps/party/frontend/package.json ./apps/party/frontend/
RUN node .yarn/releases/yarn-*.cjs install --immutable --network-timeout 1000000
# Shared packages + the app sources (built by the per-app stages below).
COPY packages ./packages
COPY apps/tracker/frontend ./apps/tracker/frontend
COPY apps/party/frontend ./apps/party/frontend

FROM frontend-deps AS tracker-frontend-build
RUN node .yarn/releases/yarn-*.cjs workspace tracker-frontend run build

FROM frontend-deps AS party-frontend-build
RUN node .yarn/releases/yarn-*.cjs workspace party-frontend run build

# ============================================================================
# Rust backends (one cargo workspace; warm dep cache via stub sources)
# ============================================================================
FROM --platform=$BUILDPLATFORM rust:1-alpine AS workspace-deps
COPY --from=xx / /
RUN apk add --no-cache clang lld musl-dev curl
ARG TARGETPLATFORM
RUN xx-apk add --no-cache musl-dev gcc
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY apps/tracker/backend/Cargo.toml apps/tracker/backend/Cargo.toml
COPY apps/tracker/e2e/Cargo.toml apps/tracker/e2e/Cargo.toml
COPY apps/party/backend/Cargo.toml apps/party/backend/Cargo.toml
# Stub sources so cargo can parse + warm the dep cache for every shipped crate.
# e2e is test-only (never built here) but its manifest must parse → stub lib.
RUN mkdir -p apps/tracker/backend/src apps/tracker/e2e/src apps/party/backend/src \
    && printf 'fn main() {}\n' > apps/tracker/backend/src/main.rs \
    && : > apps/tracker/backend/src/lib.rs \
    && : > apps/tracker/e2e/src/lib.rs \
    && printf 'fn main() {}\n' > apps/party/backend/src/main.rs \
    && : > apps/party/backend/src/lib.rs \
    && xx-cargo build --release -p tracker-backend -p party-backend

FROM workspace-deps AS tracker-backend-build
ARG TARGETPLATFORM
COPY apps/tracker/backend/src ./apps/tracker/backend/src
# `touch` so cargo notices the stub→real source swap (shared target dir → only
# the changed package rebuilds).
RUN touch apps/tracker/backend/src/main.rs apps/tracker/backend/src/lib.rs \
    && xx-cargo build --release -p tracker-backend \
    && cp target/*/release/tracker-backend /tracker-backend

FROM workspace-deps AS party-backend-build
ARG TARGETPLATFORM
COPY apps/party/backend/src ./apps/party/backend/src
RUN touch apps/party/backend/src/main.rs apps/party/backend/src/lib.rs \
    && xx-cargo build --release -p party-backend \
    && cp target/*/release/party-backend /party-backend

# ============================================================================
# Runtime images (one per service)
# ============================================================================
FROM scratch AS tracker
WORKDIR /app
LABEL org.opencontainers.image.description="tracker — FastTracker 2-style player for a filesystem module collection"
COPY --from=tracker-backend-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=tracker-backend-build /tracker-backend ./tracker-backend
COPY --from=tracker-frontend-build /app/apps/tracker/frontend/dist ./dist
ENV STATIC_DIR=./dist
ENV TRACKER_DB_PATH=/data/tracker.db
ENV TRACKER_BIND=0.0.0.0:3010
USER 1000
EXPOSE 3010
CMD ["./tracker-backend"]

FROM scratch AS party
WORKDIR /app
LABEL org.opencontainers.image.description="party — multi-party demoparty archive player (music, images, video, WASM emulators)"
COPY --from=party-backend-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=party-backend-build /party-backend ./party-backend
COPY --from=party-frontend-build /app/apps/party/frontend/dist ./dist
# Checked-in per-party config JSONs ship with the image.
COPY apps/party/parties ./parties
ENV STATIC_DIR=./dist
ENV PARTY_CONFIG_DIR=./parties
ENV PARTY_DB_PATH=/data/party.db
ENV PARTY_CACHE_DIR=/data/cache
ENV PARTY_BIND=0.0.0.0:3020
# PARTY_ROOT (the Parties/ tree) + PARTY_TRANSCODER_URL are set at deploy.
USER 1000
EXPOSE 3020
CMD ["./party-backend"]

# Python media sidecar — ffmpeg from the distro, uv for a frozen venv. Not
# scratch (needs ffmpeg + a libc). Reached only over loopback by party-backend.
FROM python:3.14-slim AS transcoder
WORKDIR /app
LABEL org.opencontainers.image.description="party transcoder — stateless ffmpeg media sidecar"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
# Lock the venv in two steps so deps cache across source-only changes.
COPY services/transcoder/pyproject.toml services/transcoder/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/transcoder/src ./src
RUN uv sync --frozen --no-dev
ENV PARTY_TRANSCODER_HOST=0.0.0.0
ENV PARTY_TRANSCODER_PORT=3021
USER 1000
EXPOSE 3021
# Call the venv entry-point directly — `uv run` would try to write a lock/cache
# as USER 1000; the venv is already frozen at build time.
CMD ["/app/.venv/bin/party-transcoder"]
