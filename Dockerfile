# syntax=docker/dockerfile:1
#
# Monorepo image builder. One image per service — build with --target:
#   docker build --target tracker     -t scene-tracker     .
#   docker build --target party       -t scene-party       .
#   docker build --target transcoder  -t scene-transcoder  .
#
# Rust backends cross-compile (tonistiigi/xx) to a static musl binary on
# scratch; each frontend-serving backend ships its app's built SPA. The
# transcoder is also Rust but runs on alpine (it shells out to ffmpeg, which
# scratch can't provide).

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
COPY apps/tracker/integration/Cargo.toml apps/tracker/integration/Cargo.toml
COPY apps/party/backend/Cargo.toml apps/party/backend/Cargo.toml
COPY services/transcoder/Cargo.toml services/transcoder/Cargo.toml
# Stub sources so cargo can parse + warm the dep cache for every shipped crate.
# integration is test-only (never built here) but its manifest must parse → stub lib.
RUN mkdir -p apps/tracker/backend/src apps/tracker/integration/src apps/party/backend/src services/transcoder/src \
    && printf 'fn main() {}\n' > apps/tracker/backend/src/main.rs \
    && : > apps/tracker/backend/src/lib.rs \
    && : > apps/tracker/integration/src/lib.rs \
    && printf 'fn main() {}\n' > apps/party/backend/src/main.rs \
    && : > apps/party/backend/src/lib.rs \
    && printf 'fn main() {}\n' > services/transcoder/src/main.rs \
    && xx-cargo build --release -p tracker-backend -p party-backend -p scene-transcoder

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

FROM workspace-deps AS transcoder-build
ARG TARGETPLATFORM
COPY services/transcoder/src ./services/transcoder/src
RUN touch services/transcoder/src/main.rs \
    && xx-cargo build --release -p scene-transcoder \
    && cp target/*/release/scene-transcoder /scene-transcoder

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

# Media sidecar — Rust ffmpeg worker. Not scratch (it shells out to the ffmpeg
# CLI, which comes from the distro): alpine + apk ffmpeg, same as ../scribe's
# `press` worker. Reached only over loopback by party-backend.
FROM alpine:3.24 AS transcoder
WORKDIR /app
LABEL org.opencontainers.image.description="scene transcoder — stateless ffmpeg media sidecar"
RUN apk add --no-cache ffmpeg ca-certificates
COPY --from=transcoder-build /scene-transcoder ./scene-transcoder
ENV PARTY_TRANSCODER_HOST=0.0.0.0
ENV PARTY_TRANSCODER_PORT=3021
USER 1000
EXPOSE 3021
CMD ["./scene-transcoder"]
