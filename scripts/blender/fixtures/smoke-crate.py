"""Smoke fixture for the Blender runner: a 0.6 m wooden crate with dark corner straps.

Licence: project-original. Not a shipped model; tests use its committed output to check the
`local` source kind (hash pins on the script, the runner and the GLB).
"""


def material(bpy, name, rgba):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 1.0
    return mat


def build(bpy):
    wood = material(bpy, "wood", (0.33, 0.16, 0.06, 1.0))
    strap = material(bpy, "strap", (0.02, 0.02, 0.02, 1.0))

    bpy.ops.mesh.primitive_cube_add(size=0.6, location=(0.0, 0.0, 0.3))
    crate = bpy.context.active_object
    crate.name = "smoke-crate"
    crate.data.materials.append(wood)

    for x in (-0.28, 0.28):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0.0, 0.3))
        band = bpy.context.active_object
        band.scale = (0.06, 0.62, 0.62)
        band.name = f"strap{'L' if x < 0 else 'R'}"
        band.data.materials.append(strap)
