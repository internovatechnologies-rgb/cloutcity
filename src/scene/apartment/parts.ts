/**
 * Geometry helpers for the apartment (S16): every room or decor part is reduced to position and
 * normal (plus a vertex colour where the room uses one), non-indexed, so parts of different
 * primitives merge into one geometry: one draw call per material.
 */
import { BufferAttribute, BoxGeometry, Color, type BufferGeometry } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/** Position and normal only, non-indexed: the shape every merged part shares. */
export function part(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('uv')
  return geometry.index === null ? geometry : geometry.toNonIndexed()
}

/** `part`, with every vertex in one colour (linear, as three stores vertex colours). */
export function paintedPart(geometry: BufferGeometry, hex: string): BufferGeometry {
  const shaped = part(geometry)
  const color = new Color(hex)
  const count = shaped.getAttribute('position').count
  const values = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) values.set([color.r, color.g, color.b], i * 3)
  shaped.setAttribute('color', new BufferAttribute(values, 3))
  return shaped
}

/**
 * Merges parts into one geometry and disposes them. With `groups`, each entry of `parts` is its
 * own material group (a decor item's main and second colours).
 */
export function mergeParts(
  parts: readonly BufferGeometry[],
  what: string,
  groups = false,
): BufferGeometry {
  const geometry = mergeGeometries([...parts], groups)
  if (geometry === null) throw new Error(`apartment: could not merge the ${what} geometry`)
  for (const piece of parts) piece.dispose()
  return geometry
}

/** A box of `size` metres whose centre sits at `at`. */
export function boxAt(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
): BufferGeometry {
  const box = new BoxGeometry(size[0], size[1], size[2])
  box.translate(at[0], at[1], at[2])
  return box
}

/** Triangles in a non-indexed geometry (or an indexed one's index). */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex()
  return (index === null ? geometry.getAttribute('position').count : index.count) / 3
}
