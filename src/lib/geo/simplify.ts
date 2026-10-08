/**
 * Douglas-Peucker polyline simplification. Unlike area-based simplification it gives a hard
 * error bound: every dropped vertex lies within `toleranceM` of the simplified path, which is
 * what keeps subway stations on their lines. Endpoints are always kept.
 */
import { distanceToSegment } from './polygon.ts'
import type { LocalPoint } from './projection.ts'

export function douglasPeucker(points: readonly LocalPoint[], toleranceM: number): LocalPoint[] {
  if (points.length <= 2) return [...points]
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  // An explicit stack instead of recursion: shapes have thousands of points.
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop() ?? [0, 0]
    const a = points[start]
    const b = points[end]
    if (a === undefined || b === undefined) continue
    let farthest = -1
    let farthestDistance = 0
    for (let i = start + 1; i < end; i++) {
      const point = points[i]
      if (point === undefined) continue
      const distance = distanceToSegment(point, a, b)
      if (distance > farthestDistance) {
        farthestDistance = distance
        farthest = i
      }
    }
    if (farthest !== -1 && farthestDistance > toleranceM) {
      keep[farthest] = 1
      stack.push([start, farthest], [farthest, end])
    }
  }
  return points.filter((_, index) => keep[index] === 1)
}
