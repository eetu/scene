"""Blender: fold the Mixamo dancer FBXs into one small .glb for the dancer viz.

Run headless:
    blender --background --python build_dancer.py -- <out.glb> <in1.fbx> [in2.fbx ...]

The point is to produce a *project asset*, not a repackaged Mixamo character: one
mesh decimated to a silhouette's worth of geometry, no materials or textures, the
animation resampled down to roughly what we render, and every dance as a clip on a
single shared rig. The first file supplies the body; the rest contribute only their
animation, since every Mixamo rig shares bone names.
"""

import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
out_path, sources = argv[0], argv[1:]

# Target triangle count. A flat silhouette has no interior detail to lose, so this
# can go far lower than a lit character would tolerate.
TARGET_TRIS = 6000
# Source is 30fps; every 2nd frame is 15fps, comfortably above the 12fps the viz
# steps at, and it keeps the clip's real duration (unlike changing scene fps).
FRAME_STEP = 2

bpy.ops.wm.read_factory_settings(use_empty=True)


def imported(kind):
    return [o for o in bpy.context.selected_objects if o.type == kind]


def clip_name(path):
    return os.path.splitext(os.path.basename(path))[0].replace("dancer_", "")


def fcurve_holders(action):
    """Every object owning a `.fcurves` collection for this action.

    Blender 4.4+ replaced the flat `action.fcurves` with layers → strips →
    channelbags; 5.x drops the old attribute entirely. Handle both so the script
    isn't pinned to one Blender generation."""
    if hasattr(action, "fcurves"):
        return [action]
    holders = []
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            holders.extend(getattr(strip, "channelbags", []))
    return holders


def strip_redundant_channels(action):
    """Drop per-bone location and scale curves, keeping rotation (and the hips'
    location). Mixamo writes all three for every bone, which is roughly two thirds
    of the animation data — but a skeleton animates by rotation: bone lengths are
    fixed, and nothing here scales a bone. The hips keep location because that's
    the root travel."""
    removed = 0
    for holder in fcurve_holders(action):
        doomed = []
        for fc in holder.fcurves:
            path = fc.data_path
            is_hips = "hips" in path.lower()
            if path.endswith(".scale") or (path.endswith(".location") and not is_hips):
                doomed.append(fc)
        for fc in doomed:
            holder.fcurves.remove(fc)
        removed += len(doomed)
    return removed


base_arm = None
base_meshes = []

for i, src in enumerate(sources):
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(src))
    arms, meshes = imported("ARMATURE"), imported("MESH")
    if not arms:
        raise SystemExit(f"no armature in {src}")
    arm = arms[0]
    action = arm.animation_data.action if arm.animation_data else None
    if action is None:
        raise SystemExit(f"no action in {src}")
    action.name = clip_name(src)
    action.use_fake_user = True
    print(f"[trim] {action.name}: dropped {strip_redundant_channels(action)} curves")

    if base_arm is None:
        base_arm, base_meshes = arm, meshes
        print(f"[base] {src}: armature={arm.name} meshes={[m.name for m in meshes]}")
    else:
        # Same rig, same bone names — the action retargets by reuse. Keep only the
        # action and discard this file's duplicate body.
        print(f"[clip] {src}: action={action.name}")
        arm.animation_data.action = None
        for o in list(meshes) + [arm]:
            bpy.data.objects.remove(o, do_unlink=True)

# Every action becomes its own NLA track, which is what the glTF exporter turns
# into separate named clips.
base_arm.animation_data.action = None
for act in bpy.data.actions:
    track = base_arm.animation_data.nla_tracks.new()
    track.name = act.name
    track.strips.new(act.name, int(act.frame_range[0]), act)

# One mesh, decimated. Vertex groups survive a collapse, so skinning still works.
for mesh in base_meshes:
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    ratio = min(1.0, TARGET_TRIS / max(1, tris))
    print(f"[mesh] {mesh.name}: {tris} tris -> ratio {ratio:.4f}")
    if ratio < 1.0:
        mod = mesh.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = mesh
        bpy.ops.object.modifier_apply(modifier=mod.name)
    mesh.data.materials.clear()

bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(out_path),
    export_format="GLB",
    export_materials="NONE",
    export_animation_mode="NLA_TRACKS",
    export_frame_step=FRAME_STEP,
    export_skins=True,
    export_yup=True,
    export_apply=True,
    export_cameras=False,
    export_lights=False,
    # The exporter bakes the armature pose per frame, writing translation,
    # rotation AND scale for every bone whether or not a curve drives them —
    # so deleting F-curves alone changes nothing. This is the flag that drops
    # channels which never actually vary.
    export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=False,
)
print(f"[done] {out_path}: {os.path.getsize(out_path) / 1e6:.2f} MB")
