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
