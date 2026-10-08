/**
 * Polylines in local metres (src/lib/geo/projection.ts) with precomputed arc lengths, so a
 * point can be placed along a line or a stretch of it cut out without re-measuring.
 */
import type { LocalPoint } from '@/lib/geo/projection'

export interface MeasuredPath {
  readonly points: readonly LocalPoint[]
  /** cumulative[i]: metres along the path from points[0] to points[i]. */
  readonly cumulative: readonly number[]
  readonly lengthM: number
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new RangeError(`index ${index} out of range`)
  return item
}

export function measurePath(points: readonly LocalPoint[]): MeasuredPath {
  const cumulative: number[] = []
  let total = 0
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const a = at(points, i - 1)
      const b = at(points, i)
      total += Math.hypot(b.x - a.x, b.y - a.y)
    }
    cumulative.push(total)
  }
  return { points, cumulative, lengthM: total }
}

/** Where a point lies closest to the path: its distance off the path and metres along it. */
export function locateOnPath(
  point: LocalPoint,
  path: MeasuredPath,
): { readonly offsetM: number; readonly arcM: number } {
  const { points, cumulative } = path
  if (points.length === 1) {
    const only = at(points, 0)
    return { offsetM: Math.hypot(point.x - only.x, point.y - only.y), arcM: 0 }
  }
  let best = { offsetM: Infinity, arcM: 0 }
  for (let i = 1; i < points.length; i++) {
    const a = at(points, i - 1)
    const b = at(points, i)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq))
    const offsetM = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
    // Strictly less: ties keep the earlier segment, so the result is stable.
    if (offsetM < best.offsetM) {
      best = { offsetM, arcM: at(cumulative, i - 1) + t * Math.sqrt(lengthSq) }
    }
  }
  return best
}

/** Index of the segment holding arc position `arcM` (binary search). */
function segmentAt(path: MeasuredPath, arcM: number): number {
  const { cumulative } = path
  let lo = 0
  let hi = cumulative.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (at(cumulative, mid) <= arcM) lo = mid
    else hi = mid
  }
  return lo
}

/** The point `arcM` metres along the path, clamped to its ends. */
export function pointAtArc(path: MeasuredPath, arcM: number): LocalPoint {
  const { points, cumulative, lengthM } = path
  if (points.length === 1 || arcM <= 0) return at(points, 0)
  if (arcM >= lengthM) return at(points, points.length - 1)
  const i = segmentAt(path, arcM)
  const a = at(points, i)
  const b = at(points, i + 1)
  const span = at(cumulative, i + 1) - at(cumulative, i)
  const t = span === 0 ? 0 : (arcM - at(cumulative, i)) / span
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
}

/**
 * The stretch of the path between two arc positions, as points from `fromArcM` to `toArcM`
 * (reversed when `fromArcM > toArcM`), including the interpolated end points.
 */
export function subPath(path: MeasuredPath, fromArcM: number, toArcM: number): LocalPoint[] {
  const lo = Math.max(0, Math.min(fromArcM, toArcM))
  const hi = Math.min(path.lengthM, Math.max(fromArcM, toArcM))
  const out: LocalPoint[] = [pointAtArc(path, lo)]
  for (let i = 0; i < path.points.length; i++) {
    const arc = at(path.cumulative, i)
    if (arc > lo && arc < hi) out.push(at(path.points, i))
  }
  out.push(pointAtArc(path, hi))
  return fromArcM <= toArcM ? out : out.reverse()
}

/** Appends `next` to `into`, dropping its first point when it repeats the last one. */
export function appendPath(into: LocalPoint[], next: readonly LocalPoint[]): void {
  const last = into[into.length - 1]
  next.forEach((point, index) => {
    if (index === 0 && last !== undefined && last.x === point.x && last.y === point.y) return
    into.push(point)
  })
}
