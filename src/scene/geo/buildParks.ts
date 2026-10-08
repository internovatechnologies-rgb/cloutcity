/** Pure geometry builder for parks and cemeteries (three only, no React). */
import { ShapeGeometry } from 'three'
import type { BufferGeometry } from 'three'
import type { DeltaPolygon } from '@/lib/geo/codec'
import { LAY_FLAT_X } from './coords'
import { polygonToShape } from './buildLand'

export const PARK_KINDS = ['park', 'cemetery'] as const
export type ParkKind = (typeof PARK_KINDS)[number]

interface ParkArea {
  readonly kind: ParkKind
  readonly borough: string
  readonly polygons: readonly DeltaPolygon[]
}

/**
 * Every polygon of one kind, in data order; with `inBoroughs`, only those whose borough is (or,
 * with `exclude`, is not) in the set (S04c: dimmed boroughs' parks draw in their own mesh).
 */
export function polygonsOfKind(
  parks: readonly ParkArea[],
  kind: ParkKind,
  inBoroughs?: { readonly ids: ReadonlySet<string>; readonly exclude: boolean },
): DeltaPolygon[] {
  return parks
    .filter(
      (park) =>
        park.kind === kind &&
        (inBoroughs === undefined || inBoroughs.ids.has(park.borough) !== inBoroughs.exclude),
    )
    .flatMap((park) => park.polygons)
}

/**
 * Flat polygons in one geometry at height `y` (one draw call per kind). The material lifts them
 * off the land top with polygonOffset, so they never z-fight it.
 */
export function buildParkGeometry(polygons: readonly DeltaPolygon[], y: number): BufferGeometry {
  const geometry = new ShapeGeometry(polygons.map(polygonToShape))
  geometry.rotateX(LAY_FLAT_X)
  geometry.translate(0, y, 0)
  geometry.deleteAttribute('uv')
  geometry.clearGroups()
  return geometry
}
