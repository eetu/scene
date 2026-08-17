# Player assets

Bundled art for the visualizers. Vite emits these as URLs (`import bgUrl from
"./assets/starfield-bg.jpg"`); see `assets.d.ts` for the module declarations.

## `dancer-*.bin` — the dancer viz's figure

The `dancer` viz (`DancerScene.svelte`) puts a rotoscope-style silhouette over an
op-art backdrop, as a nod to Spaceballs' **State of the Art** (Amiga, 1992). The figure
is drawn several times along a colour gradient, each copy a pose behind the last and
stepped to 10 fps, so it snaps between poses the way traced film does.

Because those silhouettes are flat and unlit, the runtime needs no skeleton: every
frame it can show is a fixed set of vertex positions. `build-dancer.py` bakes exactly
those, which is why the player carries no glTF loader, no skinning and no animation
system — and therefore no three.js.

One file per dance, picked up by `import.meta.glob("./assets/dancer-*.bin")`. They're
optional: with none present the backdrop and readout still run, the figure's place
reads `no dancer model`, and nothing is fetched. Only the first is fetched on mount;
the others follow if a track's hash selects them.

> **Licence — do not commit a Mixamo file to a public repo.** Mixamo's terms allow
> commercial use, editing and client work with no attribution, but prohibit
> redistributing the assets as *standalone files*; they have to be incorporated into a
> project. A `.fbx` in a public repository is directly downloadable without the app,
> which is the case that's disallowed. The baked `.bin` is a decimated, materialless
> vertex dump that only this viz can read — incorporated rather than republished — but
> keep the sources local (they're gitignored), or use a model under a licence that
> permits redistribution: CC0 sources can be rigged through Mixamo's Auto-Rigger and
> committed freely.

### Rebuilding

```
blender --background --python build-dancer.py -- . dancer_a.fbx dancer_b.fbx dancer_c.fbx
```

The first file supplies the body; the rest contribute only their animation, since every
Mixamo rig shares bone names. Each becomes `dancer-<name>.bin` — the mesh decimated to a
silhouette's worth of geometry, positions quantised to 16 bits, root travel cancelled and
the axes converted to Y-up. The script prints each clip's size; `TARGET_TRIS` and
`BAKE_FPS` at the top are the two levers on it.

### Replacing them, from Mixamo

On [Mixamo](https://www.mixamo.com/) (free with an Adobe account): pick a
**character first** (skipping this yields the default grey mannequin), then a dance
on the Animations tab; download as **`FBX Binary(.fbx)`** (no glTF export) with
**Skin: "With Skin"** ("Without Skin" has no body to draw); save here as
`dancer_<name>.fbx` and rebuild. Clip length is free — the bake is proportional to it,
and playback is tempo-locked to the tune either way.

### What the bake needs

- **A rigged humanoid with at least one animation clip.** The first clip of each file is
  the dance; nothing else is read.
- **Roughly upright, standing near the origin.** The camera frames the figure from its
  baked bounding box, so any scale works (Mixamo's centimetre units are fine), but a
  figure lying along the wrong axis gets framed side-on.
- **A bone whose name ends in `hips`**, for cancelling the clip's root travel. Without
  one the dance walks out of frame.
- Materials don't matter. Every surface is drawn as one flat colour, so an untextured rig
  is ideal — and smaller.

## `reels/*.bin` — the flip-dot board's one-bit films

`FlipDots.svelte` normally shows faces generated from the music. A **reel** is the
exception: a fixed clip of one-bit silhouettes, matched to a track by name and driven
off the playhead, so it only ever runs against the tune it was cut for. Everything
else on that board still reacts; this doesn't, which is why it isn't a mode you can
pick — pressing any mode button dismisses it.

The display is the point. A flip-dot board is one bit per dot with a mechanical
settling time, which is what shadow animation was drawn for; the driver sweep across
the board isn't an obstacle to work around, it's the reason to do this here rather
than on a canvas.

### Building one

```
python build-reel.py bad-apple.mp4 reels/badapple.bin
```

The id is the filename: `badapple.bin` plays for a module whose name contains
`badapple` once letters and digits are folded to lower case — `Bad Apple!! (XM
cover).xm` matches, everything else doesn't. What counts as "name" is the track's
title, its filename, and its curator notes' `title`/`name`; for a SID that last part is
the important one, because HVSC files a cover under the arranger's own title and keeps
the thing it covers in STIL.

**Restart the dev server after adding a reel.** The registry is an
`import.meta.glob`, which Vite resolves when it transforms the module — a file dropped
into `reels/` while `vite` is running is not in that list yet.

Defaults are 48×36 at 12fps, which is a 4:3 field a little above what any pane's board
will be (it's fitted and centred at runtime, never stretched). Twelve is about the
ceiling: the board updates ~14 times a second behind a 70ms sweep and a 38ms flip, so
a faster reel asks for changes the discs can't finish. `--fps 8` reads as deliberate
rather than as a board struggling. The file is XOR deltas, run-length encoded in bits,
so a three-minute clip is tens of kilobytes — silhouette animation is a still field
with a moving edge.

> **Licence — don't commit a reel.** These are derived frames of somebody else's
> video, and this repository is public. `reels/` is gitignored; build yours locally
> from a file you have. A missing reel is not an error anywhere: with the folder empty
> the glob resolves to no clips, nothing is fetched, and the board keeps showing its
> own modes.
