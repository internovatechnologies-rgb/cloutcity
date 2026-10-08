/**
 * Compact coordinate codec for /data/geo: integer metres, flattened, the first pair absolute and
 * every later pair a delta from the previous one. Deltas are small numbers, so the JSON stays
 * short and gzips well.
 *
 * A ring is open (its first vertex is not repeated at the end); a path is an open polyline.
 */
import type { LocalPoint } from './projection.ts'

/** [x0, y0, dx1, dy1, ...] in integer metres. */
export type DeltaRing = readonly number[]
export type DeltaPath = readonly number[]
/** [outer, ...holes]. */
export type DeltaPolygon = readonly DeltaRing[]

function encode(points: readonly LocalPoint[]): number[] {
  const out: number[] = []
  let px = 0
  let py = 0
  for (const point of points) {
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
      throw new Error(`codec: coordinates must be integer metres, got ${point.x}, ${point.y}`)
    }
    out.push(point.x - px, point.y - py)
    px = point.x
    py = point.y
  }
  return out
}

function decode(deltas: readonly number[]): LocalPoint[] {
  if (deltas.length % 2 !== 0) throw new Error('codec: odd coordinate count')
  const points: LocalPoint[] = []
  let x = 0
  let y = 0
  for (let i = 0; i < deltas.length; i += 2) {
    x += deltas[i] ?? 0
    y += deltas[i + 1] ?? 0
    points.push({ x, y })
  }
  return points
}

export const encodeRing = (ring: readonly LocalPoint[]): DeltaRing => encode(ring)
export const decodeRing = (ring: DeltaRing): LocalPoint[] => decode(ring)
export const encodePath = (path: readonly LocalPoint[]): DeltaPath => encode(path)
export const decodePath = (path: DeltaPath): LocalPoint[] => decode(path)
