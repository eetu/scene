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

[Mixamo](https://www.mixamo.com/) is the easy source — free with an Adobe account, and
the licence covers use in a project like this.

1. **Characters tab first — pick an actual character.** Skip this and Mixamo applies
   the animation to its default grey mannequin (Y Bot / X Bot), which is what you'll
   get in the viz: a figure with no hair and no shape. Choosing the character is the
   step that's easy to miss, because the animation preview works fine without it.
2. **Animations tab** — pick a dance, with that character still selected.
3. **Download → Format: `FBX Binary(.fbx)`.** Mixamo offers no glTF export, only FBX
   and Collada, so FBX is what this expects.
4. **Skin: "With Skin"** — "Without Skin" is animation data only, no body to draw.
5. Save it here as `dancer.fbx`.

A ~4-second looping dance is plenty: playback is tempo-locked to the tune (scaled
around 120 BPM), so a short loop reads fine.

### Choosing for silhouette

This renders as a flat black cut-out, so **the mesh outline is the only thing that
survives** — textures, materials and colours are all discarded. Choose accordingly:

- **Long loose hair and a skirt or dress read instantly.** A tight ponytail reads as a
  spike; short hair and trousers read androgynous, which is why the default mannequin
  looks like nothing in particular.
- **Mixamo's hair is rigid**, weighted to the head bone — it won't flow, lag or swing.
  With no shading to distract from the outline, that stiffness shows more than it
  would on a textured model.
- **Interior detail is wasted, but the outline isn't.** Textures and materials are
  discarded outright, and the mesh decimates hard — 6k triangles is plenty. What does
  survive is the *silhouette*, and more of it reads than you'd expect: with the camera
  framed this close, individual fingers are clearly legible. Don't strip finger bones
  to save animation data; the hand goes stiff and it shows.

If none of Mixamo's characters suit, its **Auto-Rigger** takes your own T-posed mesh
(FBX/OBJ), rigs it, and then any Mixamo animation can be applied to it — so a
CC0 model from elsewhere can be used, with only the geometry needing a licence.

### What the loader needs

- **A rigged humanoid with at least one animation clip.** The first clip is the dance;
  nothing else is read.
- **Roughly upright, standing near the origin.** The camera frames the model from its
  bounding box, so any scale works (Mixamo's centimetre units are fine), but a figure
  lying along the wrong axis gets framed side-on.
- Materials don't matter. Every surface is repainted flat black, so an untextured rig
  is ideal — and smaller.

### Size

Mixamo FBX runs to several MB and ships whole to the browser. A silhouette needs no
texture or mesh detail, so it's worth shrinking: converting to `.glb` (Blender, or
`FBX2glTF`) typically cuts it several-fold, and decimating the mesh costs nothing
visually when the result is a black cut-out. Drop the converted file in as
`dancer.glb` — the loader picks the format off the extension.
