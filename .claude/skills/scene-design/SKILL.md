---
name: scene-design
description: The scene monorepo's shared visual identity — a FastTracker 2 / Amiga / DOS demoscene look layered on the halo-design family tokens, covering both scene apps (tracker, party). One skill for the whole repo: the shared scene identity first, then each app's deltas. Use when building or restyling any scene UI (library browser, player overlay, pattern grid, party landing, cards, empty/error states).
user-invocable: true
---

# scene-design

The one design skill for the **scene** monorepo. Both apps — [tracker](../../../apps/tracker)
(a FastTracker 2-style module player) and [party](../../../apps/party) (a
demoparty archive player) — share a **demoscene** identity layered on the shared
halo-design family tokens. The product _is_ retro, so the surface leans into a
FT2 / Amiga / DOS-demoscene look rather than the family's neutral chrome.

This skill covers the **shared scene identity** once, then the two apps' **deltas**.

## Tokens

halo-design is adopted, consumed as the shared workspace package **`@scene/design`**
(`packages/design/src/halo.css` — the canonical `--halo-*` palette). Two
deliberate deviations from the verbatim family file:

- **Dark-first, `data-theme`-driven.** Dark values are the `:root` default and
  `[data-theme='light']` overrides — not `@media (prefers-color-scheme)`. The
  apps have an explicit light/dark/auto switch (`theme.svelte.ts`).
- **No Google-Fonts CDN.** The CSP forbids it, so Inter is self-hosted via
  `@fontsource`, and the retro surfaces use Amiga/DOS bitmap fonts instead of
  Space Grotesk.

Otherwise it's the canonical palette (accent `#f78f08`, the family greys). Each
app's `+layout.svelte` maps its local app tokens (`--bg` / `--panel` / `--accent`
/ the `--surface-*` player set) onto `--halo-*`, so components consume the local
tokens and both themes follow automatically. Never hard-code hex — use a token.

## Type — the two-tier retro/Inter split (the defining rule)

A **two-tier font split** is what makes scene look like scene:

- **Retro bitmap faces** on the _brand_ and the _player / scene surfaces_ — the
  pattern grid, sample list, ord/pat/row + time readouts, now-playing, NFO/DIZ
  art, party card glyphs. Faces are defined per app in `+layout.svelte`
  (`@font-face`, files in `static/fonts/`):
  - **`--font-amiga` = Amiga TopazPlus** (`TopazPlus_a1200`, 8×16 bitmap).
  - **`--font-dos` = DOS IBM VGA** (PxPlus/WebPlus IBM VGA 8×16, CP437).
  - **`--font-retro`** selects the app's _primary_ retro face — tracker points it
    at TopazPlus; party points it at IBM VGA (and opts into `--font-amiga` per
    surface when the content is Amiga-platform).
- **Inter (body)** for dense chrome — the library list, toolbars, filters —
  where bitmap faces are unreadable at list density. Keep a surface **wholly one
  or the other**; mixing the two _within_ one surface looks off.

## Wordmark — the scene override

**A documented override of the halo canonical wordmark** (which is Inter, the app
name in `--halo-text-main` + a single trailing accent period). The scene apps use
a demoscene **title-screen** treatment instead:

- **Font** → the retro face (`--font-retro`), not Inter.
- **Coloring** → the _whole_ word in `--accent` (the halo amber `#f78f08`), not
  just an accent dot — it reads as a lit demoscene logo.
- **No dot** → no trailing accent period.

Lowercase and the terse voice still hold. This is exactly the kind of deviation
the family sanctions when it's documented with a reason (see the `halo-design`
"Wordmark" section) — this section is that documentation. Per-app text differs
(below).

## Icons & voice

- **Icons:** Lucide (`@lucide/svelte`), **CSS-squared** (square caps/joins,
  thicker stroke, small) so they sit with the pixel fonts — never Material Icons.
  Stroke in `currentColor`.
- **Voice:** demoscene-retro but quiet — **lowercase**, no exclamation marks, no
  emoji. Empty/error states stay one plain line (e.g. "No modules indexed yet —
  try rescan."). The numbers (row/pattern/time, play counts) and the moving
  scope / ball / backdrop do the talking.

---

## tracker delta

- **Glyph** — a **tracker pattern with the playing row lit**: a 3×3 grid of
  rounded cells, the **middle row in accent amber** over a faint accent
  centerline band, the other rows in muted slate — the current row glowing as the
  pattern scrolls under the playhead. Source:
  `apps/tracker/frontend/static/favicon.svg` (+ `icon-maskable-512.png`;
  `apple-touch-icon` / `icon-192` / `icon-512` rasterised from the SVG).
- **Wordmark** — `tracker` (one word, lowercase), TopazPlus, whole word in
  `--accent`, **no tagline**. It's the sole header brand. Markup:
  `apps/tracker/frontend/src/routes/+page.svelte` (`.brand`).
- **Layout** — **library** (full-width, grouped expanding **cards** with
  group/artist/format facets + filter + favourites + sort, rendered through a
  **virtualized list** — TanStack Virtual, fixed row heights; rename/move is a
  centered modal); **player overlay** (full-screen tabs pattern / samples / ball,
  a fixed transport bar floating over the bottom); **pattern view** (locked
  fixed-centerline VU or free-scroll, toggled by `ScanLine`).

## party delta

- **Glyph** — a **low-poly rubber duck** (the classic 3D test mesh, a
  demoscene/CG in-joke): a faceted amber duck lit from the upper-left, on a
  full-bleed **square** dark frame (square on purpose — iOS/Android round the
  icon themselves). Source: `apps/party/frontend/static/favicon.svg`.
- **Wordmark** — `party` + a muted `.sub` tagline (`demoparty archive player`),
  `--font-retro` (IBM VGA), whole word in `--accent`, no dot. The muted subtitle
  sits beside the word instead of the family riff. Markup:
  `apps/party/frontend/src/routes/+page.svelte` (`h1` + `.sub`).
- **Type note** — party's `--font-retro` is IBM VGA (DOS-era content is the
  default); TopazPlus (`--font-amiga`) is opted into per-surface for Amiga
  content.
- **Layout** — landing is a grid of party **cards** (the glyph is the artwork
  fallback when a party has no logo); the player stage is shared via
  `@scene/player` (`PlayerStage`, with the `SampleBrowser`).

## Production sources of truth

- `packages/design/src/halo.css` — tokens (adopted halo-design), the theme store,
  fonts. Consumed as `@scene/design`.
- `packages/player` — `@scene/player`: the shared libopenmpt engine + transport /
  `PlayerStage` UI both apps embed.
- tracker: `apps/tracker/frontend/src/routes/{+page,+layout}.svelte`,
  `apps/tracker/frontend/static/favicon.svg`.
- party: `apps/party/frontend/src/routes/{+page,+layout}.svelte`,
  `apps/party/frontend/static/favicon.svg`.
