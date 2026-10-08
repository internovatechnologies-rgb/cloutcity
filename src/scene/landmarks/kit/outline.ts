/**
 * Inverted-hull outline: the body pushed outward along averaged normals, drawn back faces only
 * in the outline colour, so a dark rim shows around the silhouette (the sticker look).
 *
 * Vertices are welded first (mergeVertices) so each corner gets one normal averaged over the
 * faces that meet there; with the flat per-face normals the hull would split at every edge.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Part } from '../types'

/** The hull of the parts that cast an outline, or undefined when none does. */
export function buildOutline(parts: readonly Part[], widthM: number): BufferGeometry | undefined {
  const sources = parts.filter((part) => part.group === 'body' && part.outline)
  if (sources.length === 0) return undefined
  const positionsOnly = sources.map((part) => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', part.geometry.getAttribute('position').clone())
    return geometry
  })
  const merged = mergeGeometries(positionsOnly)
  for (const geometry of positionsOnly) geometry.dispose()
  if (merged === null) throw new Error('outline: cannot merge the outlined parts')
  const hull = mergeVertices(merged, 1e-3)
  merged.dispose()
  hull.computeVertexNormals()
  const position = hull.getAttribute('position')
  const normal = hull.getAttribute('normal')
  const pushed = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    pushed[i * 3] = position.getX(i) + normal.getX(i) * widthM
    pushed[i * 3 + 1] = position.getY(i) + normal.getY(i) * widthM
    pushed[i * 3 + 2] = position.getZ(i) + normal.getZ(i) * widthM
  }
  hull.setAttribute('position', new Float32BufferAttribute(pushed, 3))
  // The outline material is unlit: normals would only cost memory.
  hull.deleteAttribute('normal')
  return hull
}
