"""Blender: bake the Mixamo dancer FBXs into one small pose file for the dancer viz.

Run headless:
    blender --background --python build-dancer.py -- <out-dir> <in1.fbx> [in2.fbx ...]

One file per dance (`dancer-a.bin`, …): the viz shows one at a time and most
listeners never cycle, so the others are fetched only if asked for.

The viz draws flat unlit silhouettes that snap between poses, so it needs
neither materials nor a skeleton at runtime: every frame it could ever show is a fixed
set of vertex positions. This bakes exactly those — the deformed mesh evaluated
once per output frame — which is why the player carries no glTF loader, no
skinning and no animation system, and therefore no three.js.

The point is to produce a *project asset*, not a repackaged Mixamo character: one
mesh decimated to a silhouette's worth of geometry, no materials or textures, and
positions quantised to 16 bits. The first file supplies the body; the rest
contribute only their animation, since every Mixamo rig shares bone names.

Each file is `<4-byte header length><JSON header><payload>`:
  * indices, uint16, shared by every frame (an armature deforms vertices, it
    never adds or removes them)
  * frames x vertices x 3, uint16 normalised into the clip's bounding box, which
    the header carries so the reader can scale them back
"""

import json
import os
import struct
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
out_dir, sources = argv[0], argv[1:]

# Target triangle count. A flat unlit silhouette has no interior detail to lose,
# so this goes far below what a lit character would tolerate — and here it also
# sets the size of every baked frame, so it is the main lever on the asset. At
# 900 the outline is still smooth at the size the figure is drawn.
TARGET_TRIS = 900
# Poses per second. Finer than the ~10fps the figure snaps at, because the echo
# trail lags in whole poses: at 10 the copies sat 100ms apart and read as several
# dancers rather than one in motion.
BAKE_FPS = 20

bpy.ops.wm.read_factory_settings(use_empty=True)


def imported(kind):
    return [o for o in bpy.context.selected_objects if o.type == kind]


def clip_name(path):
    return os.path.splitext(os.path.basename(path))[0].replace("dancer_", "")


base_arm = None
base_meshes = []
actions = []

for src in sources:
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
    actions.append(action)

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

# One mesh, decimated. Vertex groups survive a collapse, so skinning still works
# for the bake itself.
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

if len(base_meshes) != 1:
    raise SystemExit(f"expected one body mesh, got {len(base_meshes)}")
body = base_meshes[0]

scene = bpy.context.scene
step = max(1, round(scene.render.fps / BAKE_FPS))
print(f"[bake] scene {scene.render.fps}fps, every {step} frames -> {scene.render.fps / step:.1f}fps")


def hips_bone():
    for b in base_arm.pose.bones:
        if b.name.lower().endswith("hips"):
            return b
    return None


HIPS = hips_bone()


def evaluate_frame():
    """The deformed mesh's vertices this frame, in world space, Y-up, with the
    dance's horizontal root travel cancelled.

    Two conversions, both of which are invisible until they aren't:

    * Blender is Z-up and WebGL is Y-up, so `(x, y, z)` is written as
      `(x, z, -y)` — the same swap glTF's `export_yup` does. Skip it and the
      figure dances lying on its back.
    * Mixamo clips walk the figure across the floor, which takes it out of a
      fixed camera's frame; the viz used to cancel that at runtime off the hips
      bone. Doing it here means the runtime has no bones to reason about at all.
      The cancelled axes are Blender's horizontal pair (x, y). Vertical travel is
      left alone — that's jumps and weight shifts, which should show.
    """
    deps = bpy.context.evaluated_depsgraph_get()
    evaluated = body.evaluated_get(deps)
    mesh = evaluated.to_mesh()
    mesh.transform(evaluated.matrix_world)
    offset = Vector((0.0, 0.0, 0.0))
    if HIPS is not None:
        world = base_arm.matrix_world @ HIPS.head
        offset = Vector((world.x, world.y, 0.0))
    verts = [
        (v.co.x - offset.x, v.co.z, -(v.co.y - offset.y)) for v in mesh.vertices
    ]
    evaluated.to_mesh_clear()
    return verts


# Topology, from the bind pose. Every frame shares it: an armature deforms
# vertices, it never adds or removes them.
body.data.calc_loop_triangles()
indices = [i for tri in body.data.loop_triangles for i in tri.vertices]
vertex_count = len(body.data.vertices)
print(f"[mesh] {vertex_count} vertices, {len(indices) // 3} triangles")

if vertex_count > 65535:
    raise SystemExit(f"{vertex_count} vertices exceeds the uint16 index space")

for action in actions:
    base_arm.animation_data.action = action
    start, end = (int(round(v)) for v in action.frame_range)
    frames = []
    for f in range(start, end + 1, step):
        scene.frame_set(f)
        verts = evaluate_frame()
        if len(verts) != vertex_count:
            raise SystemExit(f"{action.name} frame {f}: vertex count changed")
        frames.append(verts)

    lo = [min(c[i] for f in frames for c in f) for i in range(3)]
    hi = [max(c[i] for f in frames for c in f) for i in range(3)]
    span = [max(hi[i] - lo[i], 1e-6) for i in range(3)]

    payload = bytearray()
    payload += struct.pack(f"<{len(indices)}H", *indices)
    for verts in frames:
        flat = []
        for v in verts:
            for i in range(3):
                q = int(round((v[i] - lo[i]) / span[i] * 65535))
                flat.append(min(65535, max(0, q)))
        payload += struct.pack(f"<{len(flat)}H", *flat)

    header = json.dumps(
        {
            "version": 1,
            "name": action.name,
            "fps": scene.render.fps / step,
            "vertexCount": vertex_count,
            "indexCount": len(indices),
            "frames": len(frames),
            "bboxMin": lo,
            "bboxMax": hi,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    # Padded to a multiple of 4 so the payload that follows is aligned: a
    # Uint16Array view onto an odd byte offset is a RangeError, not a slow path.
    header += b" " * (-len(header) % 4)

    path = os.path.join(os.path.abspath(out_dir), f"dancer-{action.name}.bin")
    with open(path, "wb") as fh:
        fh.write(struct.pack("<I", len(header)))
        fh.write(header)
        fh.write(payload)
    size = os.path.getsize(path) / 1e6
    print(f"[clip] {action.name}: frames {start}-{end} -> {len(frames)} poses, {size:.2f} MB")

print("[done]")
