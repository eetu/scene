# Player assets

Bundled art for the visualizers. Vite emits these as URLs (`import bgUrl from
"./assets/starfield-bg.jpg"`); see `assets.d.ts` for the module declarations.

## `dancer.fbx` — the dancer viz's figure

The `dancer` viz (`DancerScene.svelte`) puts a rotoscope-style silhouette over an
op-art backdrop, as a nod to Spaceballs' **State of the Art** (Amiga, 1992). The rig is
drawn several times along a magenta gradient, each copy a beat behind the last and
stepped to 12 fps, so it snaps between poses the way traced film does.

The model is picked up by `import.meta.glob` as `dancer.fbx` or `dancer.glb`. It's
optional: with no file present the backdrop and readout still run, the figure's place
reads `no dancer.fbx`, and no model is fetched.

> **Licence — do not commit a Mixamo file to a public repo.** Mixamo's terms allow
> commercial use, editing and client work with no attribution, but prohibit
> redistributing the assets as *standalone files*; they have to be incorporated into a
> project. A `.fbx` in a public repository is directly downloadable without the app,
> which is the case that's disallowed. Keep it local (it's already optional), or use a
> model under a licence that permits redistribution — CC0 sources can be rigged through
> Mixamo's Auto-Rigger and committed freely.

### Replacing it, from Mixamo

On [Mixamo](https://www.mixamo.com/) (free with an Adobe account): pick a
**character first** (skipping this yields the default grey mannequin), then a dance
on the Animations tab; download as **`FBX Binary(.fbx)`** (no glTF export) with
**Skin: "With Skin"** ("Without Skin" has no body to draw); save here as
`dancer.fbx`. A ~4-second loop is plenty — playback is tempo-locked to the tune.

### What the loader needs

- **A rigged humanoid with at least one animation clip.** The first clip is the dance;
  nothing else is read.
- **Roughly upright, standing near the origin.** The camera frames the model from its
  bounding box, so any scale works (Mixamo's centimetre units are fine), but a figure
  lying along the wrong axis gets framed side-on.
- Materials don't matter. Every surface is repainted flat black, so an untextured rig
  is ideal — and smaller.

To shrink the multi-MB Mixamo FBX, convert it to `.glb` (Blender, or `FBX2glTF`) and
drop it in as `dancer.glb` — the loader picks the format off the extension.
