/**
 * Douglas-Peucker simplification for the geo build. The path implementation lives in src/lib/geo
 * so the server's static fallback map (src/app/geo/fallback) simplifies outlines the same way.
 */
import { douglasPeucker } from '../../src/lib/geo/simplify.ts'
import type { LocalPoint } from '../../src/lib/geo/projection.ts'

export { douglasPeucker }

/**
 * Douglas-Peucker for an open ring (first vertex not repeated). The ring is split at its first
 * vertex and the vertex farthest from it, both kept, and each half simplified as a path, so the
 * same error bound holds all the way round. Returns the ring unchanged when simplifying would
 * leave fewer than three vertices (a sliver narrower than the tolerance keeps its shape).
 */
export function douglasPeuckerRing(ring: readonly LocalPoint[], toleranceM: number): LocalPoint[] {
  const first = ring[0]
  if (first === undefined || ring.length <= 3) return [...ring]
  let farthest = 1
  let farthestDistance = -1
  for (let i = 1; i < ring.length; i++) {
    const point = ring[i]
    if (point === undefined) continue
    const distance = Math.hypot(point.x - first.x, point.y - first.y)
    if (distance > farthestDistance) {
      farthestDistance = distance
      farthest = i
    }
  }
  const there = douglasPeucker(ring.slice(0, farthest + 1), toleranceM)
  const back = douglasPeucker([...ring.slice(farthest), first], toleranceM)
  const simplified = [...there, ...back.slice(1, -1)]
  return simplified.length >= 3 ? simplified : [...ring]
}
