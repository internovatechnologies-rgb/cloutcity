/**
 * Pure view rules of the district buildings (S04d): how far the tier draws and which districts
 * are near enough to load. No three, no React.
 */
import type { SceneConfig } from '@/lib/data/schemas/scene'

export interface ViewPoint {
  /** Local metres (x east, y north). */
  readonly x: number
  readonly y: number
  /** Height above the ground. */
  readonly altitude: number
}

export interface DistrictCircle {
  readonly id: string
  readonly centre: { readonly x: number; readonly y: number }
  readonly radiusM: number
}

/** Straight-line distance from the camera to the nearest ground point of a district circle. */
export function distanceToDistrict(camera: ViewPoint, district: DistrictCircle): number {
  const across = Math.max(
    0,
    Math.hypot(camera.x - district.centre.x, camera.y - district.centre.y) - district.radiusM,
  )
  return Math.hypot(across, camera.altitude)
}

/** The tier's draw distances: scene.json `buildings.viewM` times its lodDistanceScale. */
export function drawDistances(
  config: SceneConfig['buildings'],
  lodDistanceScale: number,
): { districts: number; blocks: number } {
  return {
    districts: config.viewM.districts * lodDistanceScale,
    blocks: config.viewM.blocks * lodDistanceScale,
  }
}

/** Districts within `rangeM` of the camera, nearest first. */
export function districtsWithin<T extends DistrictCircle>(
  districts: readonly T[],
  camera: ViewPoint,
  rangeM: number,
): T[] {
  return districts
    .map((district) => ({ district, distance: distanceToDistrict(camera, district) }))
    .filter((entry) => entry.distance <= rangeM)
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.district)
}
