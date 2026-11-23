# VayaView 3D store -> Blender.
# Run in Blender: Scripting tab > Open this file > Run Script (or Alt+P).
# It imports blender/vayaview-store.glb (made from the live store) into a "VayaView Store" collection.
# Every part of the store (a shelf, a wall, the counter, the TV, a lamp, the theater ...) gets ONE empty
# named after it (shown as a box with arrows). Move / turn those empties to rearrange the store; Claude
# reads the empties back (they remember where they started) and updates the app to match.
# Moving the individual pieces inside a part is fine too, but say so, because only empties are read back.
import bpy
import os
from mathutils import Vector

HERE = r"D:\SelfTV\blender"
GLB = os.path.join(HERE, "vayaview-store.glb")
COLL = "VayaView Store"

scene = bpy.context.scene
old = bpy.data.collections.get(COLL)
if old:
    raise SystemExit(f'"{COLL}" is already in this file. Delete it first if you want a fresh copy.')

coll = bpy.data.collections.new(COLL)
scene.collection.children.link(coll)
layer = bpy.context.view_layer.layer_collection.children[COLL]
bpy.context.view_layer.active_layer_collection = layer

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=GLB, import_shading="NORMALS")
imported = [o for o in bpy.data.objects if o not in before]
bpy.context.view_layer.update()


def part_of(obj):
    return obj.get("part")


# The top object of each part: it has a part, and its parent has a different one (or none).
roots = {}
for obj in imported:
    label = part_of(obj)
    if not label:
        continue
    if obj.parent is not None and part_of(obj.parent) == label:
        continue
    roots.setdefault(label, []).append(obj)


def world_box(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    found = False
    stack = list(objs)
    while stack:
        o = stack.pop()
        stack.extend(o.children)
        if o.type == "MESH" and o.data and len(o.data.vertices):
            for corner in o.bound_box:
                p = o.matrix_world @ Vector(corner)
                lo = Vector(map(min, lo, p))
                hi = Vector(map(max, hi, p))
                found = True
    if not found:
        p = objs[0].matrix_world.translation
        return p.copy(), p.copy()
    return lo, hi


parts_coll = bpy.data.collections.new("Parts (move these)")
coll.children.link(parts_coll)
handles = {}
# Which part each part sits inside (the shopkeeper is inside his corner), so the handles nest the same way.
inside = {label: part_of(objs[0].parent) if objs[0].parent is not None else None for label, objs in roots.items()}
for label in sorted(roots):
    objs = roots[label]
    lo, hi = world_box(objs)
    for o in imported:  # the handle gets the plain name; pieces that had it are renamed
        if o.name == label or o.name.startswith(label + "."):
            o.name = label + " piece"
    handle = bpy.data.objects.new(label, None)
    handle.name = label
    handles[label] = handle
    handle.empty_display_type = "ARROWS"
    handle.empty_display_size = max(0.5, min(2.5, max(hi.x - lo.x, hi.y - lo.y) / 2))
    handle.location = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    handle["vv_part"] = label
    handle["vv_start_location"] = list(handle.location)
    handle["vv_start_rotation"] = list(handle.rotation_euler)
    parts_coll.objects.link(handle)
    bpy.context.view_layer.update()
    for o in objs:
        m = o.matrix_world.copy()
        o.parent = handle
        o.matrix_world = m
bpy.context.view_layer.update()
for label, outer in inside.items():
    if outer in handles:
        h = handles[label]
        m = h.matrix_world.copy()
        h.parent = handles[outer]
        h.matrix_world = m

print(f"VayaView store: {len(imported)} objects, {len(roots)} parts")
