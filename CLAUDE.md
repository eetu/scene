# scene — demoscene archive players (monorepo)

A monorepo for the scene-archive apps. Each app is a sibling-app (Rust axum
backend embedding a Svelte SPA); shared frontend code lives in `packages/*`.
Siblings: deploy via `../raspi`; media sidecar pattern from `../scribe`.

## Layout

```text
packages/        shared FRONTEND libs (yarn workspace members, source-only)
  player/          @scene/player  — libopenmpt (chiptune3) engine + store + transport UI
  design/          @scene/design  — halo tokens, fonts, theme store
apps/
  tracker/         MOD/tracker-music player
    backend/         tracker-backend (cargo member)
    frontend/        SvelteKit SPA (yarn member, deps @scene/*)
    e2e/             integration crate
  party/           multi-party demoparty archive player
    backend/         party-backend (cargo member)
    frontend/        SvelteKit SPA (yarn member, deps @scene/*)
    parties/         checked-in per-party config JSONs
services/
  transcoder/      Python/uv FastAPI sidecar (ffmpeg) — party media. NOT in any
                   workspace; reached over loopback HTTP with a bearer token.
Cargo.toml         one Rust workspace (all backends + e2e)
package.json       one yarn workspace (packages/* + apps/*/frontend)
justfile           task runner — `just dev party`, `just build`, `just lint`
```

## Conventions

- **Two workspaces, one repo.** Frontends → yarn (Berry, node-modules linker,
  vendored `.yarn/releases`). Backends → cargo workspace sharing
  `[workspace.dependencies]`, one `Cargo.lock`, one `target/`.
- **Shared packages export raw source** (`.svelte`/`.ts`); the consuming app's
  Vite transpiles them. No build step in `packages/*`. Import as `@scene/player`,
  `@scene/design`.
- **Sidecars stay out of both workspaces** and are reached only over loopback
  HTTP — the isolation boundary (see `../scribe`). One container image per
  service; one `../raspi` quadlet each.
- **The frontend↔backend seam** is per app: SPA builds to `dist/`, the backend
  serves it with an SPA fallback; dev uses Vite's proxy for `/api`+`/status`.
  Manual type sharing (Rust `Serialize` ↔ hand-written TS), no codegen.

## Working on this repo

- `just dev party` / `just dev tracker` — backend (cargo) + frontend (vite).
- `just build` — all frontends + the whole rust workspace.
- `just lint` — yarn lint/format + clippy + ruff.
- Backend dev needs each app's `backend/.env` (see `backend/.env.example`);
  `PARTY_OPEN=1` / `DEV_AUTH` bypass forward-auth locally.

## Out of scope

- Monorepo build daemons (Turborepo/Nx/Bazel) — plain workspaces + justfile.
- Cross-app runtime coupling: apps share UI code, not databases or services.
