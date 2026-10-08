/**
 * Pure geometry builders for borough land and the water plane. three only, no React, so they
 * run (and are tested) in Node.
 */
import { ExtrudeGeometry, Path, PlaneGeometry, Shape, Vector2 } from 'three'
import type { BufferGeometry } from 'three'
import { decodeRing, type DeltaPolygon } from '@/lib/geo/codec'
import { bboxOf } from '@/lib/geo/polygon'
import { LAY_FLAT_X } from './coords'

/** Heights of the land slab: its top sits `heightM - baseM` above the water plane (y = 0). */
export interface LandHeights {
  readonly heightM: number
  readonly baseM: number
}

export function landTopY(land: LandHeights): number {
  return land.heightM - land.baseM
}

/** One delta-encoded polygon ([outer, ...holes]) as a three Shape in the XY plane. */
export function polygonToShape(polygon: DeltaPolygon): Shape {
  const [outer, ...holes] = polygon.map((ring) =>
    decodeRing(ring).map((point) => new Vector2(point.x, point.y)),
  )
  const shape = new Shape(outer ?? [])
  shape.holes = holes.map((hole) => new Path(hole))
  return shape
}

/**
 * One borough's land: every polygon extruded into one geometry (one draw call per borough, so
 * boroughs outside the view are frustum-culled). Uvs are dropped (no textures); the cap/side
 * groups are cleared because one material draws everything.
 */
export function buildLandGeometry(
  polygons: readonly DeltaPolygon[],
  land: LandHeights,
): BufferGeometry {
  const geometry = new ExtrudeGeometry(polygons.map(polygonToShape), {
    depth: land.heightM,
    bevelEnabled: false,
    steps: 1,
  })
  geometry.rotateX(LAY_FLAT_X)
  geometry.translate(0, -land.baseM, 0)
  geometry.deleteAttribute('uv')
  geometry.clearGroups()
  return geometry
}

/** The water plane at y = 0: the sea polygon's bounding box grown by `extraM` on every side. */
export function buildWaterGeometry(sea: DeltaPolygon, extraM: number): BufferGeometry {
  const outer = sea[0]
  if (outer === undefined) throw new Error('water: the sea polygon has no outer ring')
  const box = bboxOf(decodeRing(outer))
  const width = box.maxX - box.minX + 2 * extraM
  const depth = box.maxY - box.minY + 2 * extraM
  const geometry = new PlaneGeometry(width, depth)
  geometry.rotateX(LAY_FLAT_X)
  geometry.translate((box.minX + box.maxX) / 2, 0, -(box.minY + box.maxY) / 2)
  geometry.deleteAttribute('uv')
  return geometry
}
