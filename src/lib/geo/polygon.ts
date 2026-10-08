/**
 * Planar geometry on local metres (see projection.ts). Pure, no dependencies, so the geo build,
 * the engine and the tests share one implementation.
 */
import type { LocalPoint } from './projection.ts'

export type Ring = readonly LocalPoint[]
/** [outer, ...holes]. Rings are open: the first vertex is not repeated. */
export type Polygon = readonly Ring[]

export interface BBox {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export function bboxOf(ring: Ring): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** Shoelace area: positive when the ring runs counter-clockwise (x east, y north). */
export function signedArea(ring: Ring): number {
  let twice = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    if (a === undefined || b === undefined) continue
    twice += a.x * b.y - b.x * a.y
  }
  return twice / 2
}

/** Area of a polygon: the outer ring minus its holes, whatever their winding. */
export function polygonArea(polygon: Polygon): number {
  return polygon.reduce(
    (sum, ring, index) => sum + (index === 0 ? 1 : -1) * Math.abs(signedArea(ring)),
    0,
  )
}

/**
 * Even-odd test over every ring, so holes (and any nested islands) come out right. Points
 * exactly on an edge may land either side. The bbox defaults to the outer ring's; pass a
 * precomputed one to skip the work in hot loops.
 */
export function pointInPolygon(
  point: LocalPoint,
  polygon: Polygon,
  bbox: BBox = bboxOf(polygon[0] ?? []),
): boolean {
  if (point.x < bbox.minX || point.x > bbox.maxX || point.y < bbox.minY || point.y > bbox.maxY) {
    return false
  }
  let inside = false
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]
      const b = ring[i]
      if (a === undefined || b === undefined) continue
      if (a.y > point.y !== b.y > point.y) {
        const crossX = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x)
        if (point.x < crossX) inside = !inside
      }
    }
  }
  return inside
}

export function distanceToSegment(point: LocalPoint, a: LocalPoint, b: LocalPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** Shortest distance from a point to an open polyline (a single vertex counts as a point). */
export function distanceToPolyline(point: LocalPoint, path: readonly LocalPoint[]): number {
  const first = path[0]
  if (first === undefined) return Infinity
  if (path.length === 1) return Math.hypot(point.x - first.x, point.y - first.y)
  let best = Infinity
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    if (a === undefined || b === undefined) continue
    best = Math.min(best, distanceToSegment(point, a, b))
  }
  return best
}

/** Area centroid of a polygon with holes (holes subtract). */
export function polygonCentroid(polygon: Polygon): LocalPoint {
  let area = 0
  let cx = 0
  let cy = 0
  polygon.forEach((ring, index) => {
    const sign = (index === 0 ? 1 : -1) * Math.sign(signedArea(ring))
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]
      const b = ring[i]
      if (a === undefined || b === undefined) continue
      const cross = (a.x * b.y - b.x * a.y) * sign
      area += cross
      cx += (a.x + b.x) * cross
      cy += (a.y + b.y) * cross
    }
  })
  if (area === 0) return polygon[0]?.[0] ?? { x: 0, y: 0 }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}

/** Inside spans along the horizontal line at `y`, as [x0, x1] pairs sorted by x. */
function insideSpans(polygon: Polygon, y: number): [number, number][] {
  const crossings: number[] = []
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]
      const b = ring[i]
      if (a === undefined || b === undefined) continue
      if (a.y > y !== b.y > y) crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
  }
  crossings.sort((p, q) => p - q)
  const spans: [number, number][] = []
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    spans.push([crossings[i] ?? 0, crossings[i + 1] ?? 0])
  }
  return spans
}

/**
 * An integer-metre point guaranteed to lie inside the polygon: its rounded area centroid when
 * that is inside (the natural label spot), otherwise the middle of the widest inside span on a
 * horizontal scanline (for C- and ring-shaped areas whose centroid falls outside).
 */
export function interiorPoint(polygon: Polygon): LocalPoint {
  const outer = polygon[0]
  if (outer === undefined || outer.length < 3) throw new Error('interiorPoint: empty polygon')
  const bbox = bboxOf(outer)
  const centroid = polygonCentroid(polygon)
  const rounded = { x: Math.round(centroid.x), y: Math.round(centroid.y) }
  if (pointInPolygon(rounded, polygon, bbox)) return rounded

  const midY = (bbox.minY + bbox.maxY) / 2
  const height = bbox.maxY - bbox.minY
  const candidates = [centroid.y, midY]
  for (let step = 1; step < 8; step++) candidates.push(bbox.minY + (height * step) / 8)
  for (const candidateY of candidates) {
    const y = Math.round(candidateY)
    const widest = insideSpans(polygon, y).reduce<[number, number] | undefined>(
      (best, span) => (best === undefined || span[1] - span[0] > best[1] - best[0] ? span : best),
      undefined,
    )
    if (widest === undefined) continue
    const point = { x: Math.round((widest[0] + widest[1]) / 2), y }
    if (pointInPolygon(point, polygon, bbox)) return point
  }
  throw new Error('interiorPoint: no interior point found')
}
