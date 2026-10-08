/**
 * Land and water for travel: walkers and taxis may not cross open water in a straight line.
 * Uses the borough land layer (data/geo/land.derived.json, S04), passed in by the caller.
 *
 * The water test is exact rather than sampled: it finds where the segment crosses each land
 * polygon's rings, takes each polygon's inside/outside state at the start from one
 * point-in-polygon test, and sweeps along the segment flipping that state at every crossing
 * (even-odd, like the ray-casting test itself). That finds every water stretch whatever its
 * width, in one pass over the ~23k land vertices (filtered by ring bounding boxes), which is
 * far cheaper than sampling a long segment every few metres.
 */
import { decodeRing, type DeltaPolygon } from '@/lib/geo/codec'
import { bboxOf, pointInPolygon, type BBox, type Polygon } from '@/lib/geo/polygon'
import type { LocalPoint } from '@/lib/geo/projection'

/** The fields of the derived land file the mask uses. */
export interface LandData {
  readonly boroughs: readonly {
    readonly id: string
    readonly polygons: readonly DeltaPolygon[]
  }[]
}

export interface LandMask {
  readonly polygons: readonly { readonly rings: Polygon; readonly bbox: BBox }[]
  readonly rings: readonly {
    readonly points: readonly LocalPoint[]
    readonly bbox: BBox
    /** Index into `polygons`. */
    readonly polygon: number
  }[]
}

export function buildLandMask(data: LandData): LandMask {
  const polygons: { rings: Polygon; bbox: BBox }[] = []
  const rings: { points: readonly LocalPoint[]; bbox: BBox; polygon: number }[] = []
  for (const borough of data.boroughs) {
    for (const encoded of borough.polygons) {
      const decoded = encoded.map(decodeRing)
      const polygon = polygons.length
      polygons.push({ rings: decoded, bbox: bboxOf(decoded[0] ?? []) })
      for (const ring of decoded) rings.push({ points: ring, bbox: bboxOf(ring), polygon })
    }
  }
  return { polygons, rings }
}

export function isOnLand(point: LocalPoint, mask: LandMask): boolean {
  return mask.polygons.some(({ rings, bbox }) => pointInPolygon(point, rings, bbox))
}

/** Perpendicular metres within which a ring edge counts as lying along the segment. */
const SHORE_TOLERANCE_M = 0.01

/** The longest continuous stretch of segment a→b that is off land, in metres. */
export function longestWaterRunM(a: LocalPoint, b: LocalPoint, mask: LandMask): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return 0
  const length = Math.sqrt(lengthSq)
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  const overlaps = (box: BBox) =>
    !(box.maxX < minX || box.minX > maxX || box.maxY < minY || box.minY > maxY)

  // Which side of the segment's line a vertex is on. "> 0" against "<= 0" is the same half-open
  // rule ray casting uses, so a vertex exactly on the line is never counted twice.
  const above = (p: LocalPoint) => dx * (p.y - a.y) - dy * (p.x - a.x) > 0

  // A ring edge lying along the segment is shoreline: the boundary counts as land, so walking
  // exactly along the shore is dry whichever way round the island it goes.
  const onLine = SHORE_TOLERANCE_M * length
  const tOf = (p: LocalPoint) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq

  const events: { t: number; polygon: number; shore: number }[] = []
  for (const { points, bbox, polygon } of mask.rings) {
    if (!overlaps(bbox)) continue
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const c = points[j]
      const d = points[i]
      if (c === undefined || d === undefined) continue
      const sc = dx * (c.y - a.y) - dy * (c.x - a.x)
      const sd = dx * (d.y - a.y) - dy * (d.x - a.x)
      if (Math.abs(sc) <= onLine && Math.abs(sd) <= onLine) {
        const t0 = Math.min(tOf(c), tOf(d))
        const t1 = Math.max(tOf(c), tOf(d))
        if (t1 > 0 && t0 < 1 && t1 > t0) {
          events.push({ t: Math.max(0, t0), polygon: -1, shore: 1 })
          events.push({ t: Math.min(1, t1), polygon: -1, shore: -1 })
        }
      }
      if (above(c) === above(d)) continue
      const u = sc / (sc - sd)
      const px = c.x + u * (d.x - c.x)
      const py = c.y + u * (d.y - c.y)
      const t = ((px - a.x) * dx + (py - a.y) * dy) / lengthSq
      if (t > 0 && t < 1) events.push({ t, polygon, shore: 0 })
    }
  }
  // Shore starts before crossings before shore ends at one t, so touching pieces join up.
  events.sort((x, y) => x.t - y.t || y.shore - x.shore || x.polygon - y.polygon)

  const inside = new Map<number, boolean>()
  let insideCount = 0
  mask.polygons.forEach(({ rings, bbox }, index) => {
    if (overlaps(bbox) && pointInPolygon(a, rings, bbox)) {
      inside.set(index, true)
      insideCount++
    }
  })

  let longest = 0
  let run = 0
  let t0 = 0
  let shoreDepth = 0
  const close = (t1: number) => {
    if (t1 <= t0) return
    if (insideCount > 0 || shoreDepth > 0) {
      run = 0
    } else {
      run += (t1 - t0) * length
      longest = Math.max(longest, run)
    }
    t0 = t1
  }
  for (const event of events) {
    close(event.t)
    if (event.shore !== 0) {
      shoreDepth += event.shore
      continue
    }
    const now = !(inside.get(event.polygon) ?? false)
    inside.set(event.polygon, now)
    insideCount += now ? 1 : -1
  }
  close(1)
  return longest
}

/** True when segment a→b leaves land for more than `maxWaterM` in one stretch. */
export function crossesWater(
  a: LocalPoint,
  b: LocalPoint,
  mask: LandMask,
  maxWaterM: number,
): boolean {
  return longestWaterRunM(a, b, mask) > maxWaterM
}

/** How far past the shoreline a snapped point is placed, tried in turn, in metres. */
const SNAP_INSET_M = [0.5, 1, 2, 5]

/**
 * A point on land for `point`: the point itself when it is on land, otherwise the nearest land
 * within `maxM` (just inside the shoreline), or undefined when there is none that close.
 */
export function snapToLand(
  point: LocalPoint,
  mask: LandMask,
  maxM: number,
): LocalPoint | undefined {
  if (isOnLand(point, mask)) return point
  let best: { point: LocalPoint; distanceM: number; nx: number; ny: number } | undefined
  for (const { points, bbox } of mask.rings) {
    if (
      point.x < bbox.minX - maxM ||
      point.x > bbox.maxX + maxM ||
      point.y < bbox.minY - maxM ||
      point.y > bbox.maxY + maxM
    ) {
      continue
    }
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const c = points[j]
      const d = points[i]
      if (c === undefined || d === undefined) continue
      const ex = d.x - c.x
      const ey = d.y - c.y
      const lengthSq = ex * ex + ey * ey
      const t =
        lengthSq === 0
          ? 0
          : Math.max(0, Math.min(1, ((point.x - c.x) * ex + (point.y - c.y) * ey) / lengthSq))
      const near = { x: c.x + t * ex, y: c.y + t * ey }
      const distance = Math.hypot(point.x - near.x, point.y - near.y)
      if (distance <= maxM && (best === undefined || distance < best.distanceM)) {
        const edgeLength = Math.sqrt(lengthSq) || 1
        best = { point: near, distanceM: distance, nx: -ey / edgeLength, ny: ex / edgeLength }
      }
    }
  }
  if (best === undefined) return undefined
  const { point: near, distanceM: away } = best
  // Step inland: away from the water point, or along both edge normals if it sits on the edge.
  const directions =
    away > 0
      ? [{ x: (near.x - point.x) / away, y: (near.y - point.y) / away }]
      : [
          { x: best.nx, y: best.ny },
          { x: -best.nx, y: -best.ny },
        ]
  for (const inset of SNAP_INSET_M) {
    for (const direction of directions) {
      const candidate = { x: near.x + direction.x * inset, y: near.y + direction.y * inset }
      if (isOnLand(candidate, mask)) return candidate
    }
  }
  return undefined
}
