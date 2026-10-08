/**
 * Point lookups against the encoded /data/geo layers: which borough or zone a point is in, and
 * the nearest subway station. Pure: callers pass the data in (the geo build passes the outputs
 * it is about to write; the engine passes the loaded files).
 */
import { decodeRing, type DeltaPolygon } from './codec.ts'
import { bboxOf, distanceToPolyline, pointInPolygon, type BBox, type Polygon } from './polygon.ts'
import { distanceM, type LocalPoint } from './projection.ts'

/** Any layer entry with an id and encoded polygons (boroughs, zone shapes, parks). */
export interface EncodedArea {
  readonly id: string
  readonly polygons: readonly DeltaPolygon[]
}

/** An area decoded once, with per-polygon bboxes, for repeated lookups. */
export interface PreparedArea {
  readonly id: string
  readonly polygons: readonly { readonly rings: Polygon; readonly bbox: BBox }[]
}

export function prepareAreas(areas: readonly EncodedArea[]): PreparedArea[] {
  return areas.map((area) => ({
    id: area.id,
    polygons: area.polygons.map((polygon) => {
      const rings = polygon.map(decodeRing)
      return { rings, bbox: bboxOf(rings[0] ?? []) }
    }),
  }))
}

/** Id of the first area containing the point, or undefined (for example open water). */
export function areaAt(point: LocalPoint, areas: readonly PreparedArea[]): string | undefined {
  return areas.find((area) =>
    area.polygons.some(({ rings, bbox }) => pointInPolygon(point, rings, bbox)),
  )?.id
}

/** Distance from a point to an area's boundary, or 0 when the point is inside it. */
export function distanceToArea(point: LocalPoint, area: PreparedArea): number {
  let best = Infinity
  for (const { rings, bbox } of area.polygons) {
    if (pointInPolygon(point, rings, bbox)) return 0
    for (const ring of rings) {
      const first = ring[0]
      if (first === undefined) continue
      best = Math.min(best, distanceToPolyline(point, [...ring, first]))
    }
  }
  return best
}

/** The area nearest to a point, with its distance (0 when inside). */
export function nearestArea(
  point: LocalPoint,
  areas: readonly PreparedArea[],
): { readonly id: string; readonly distanceM: number } | undefined {
  let best: { id: string; distanceM: number } | undefined
  for (const area of areas) {
    const distance = distanceToArea(point, area)
    if (best === undefined || distance < best.distanceM) best = { id: area.id, distanceM: distance }
  }
  return best
}

export const boroughAt = areaAt
export const zoneAt = areaAt

export interface StationPoint {
  readonly id: string
  readonly x: number
  readonly y: number
}

/** The station nearest to a point (ties go to the earlier station), or undefined if none. */
export function nearestStation<T extends StationPoint>(
  point: LocalPoint,
  stations: readonly T[],
): { readonly station: T; readonly distanceM: number } | undefined {
  let best: { station: T; distanceM: number } | undefined
  for (const station of stations) {
    const distance = distanceM(point, station)
    if (best === undefined || distance < best.distanceM) best = { station, distanceM: distance }
  }
  return best
}
