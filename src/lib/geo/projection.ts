/**
 * The one projection shared by the geo build, the scene and the engine: WGS84 lat/lng to local
 * metres on a plane tangent at a fixed origin (equirectangular, scaled by the ellipsoid's radii
 * of curvature at the origin latitude). x points east, y points north.
 *
 * Over the NYC extent the scale error stays within 0.35%, which is far below what the game can
 * show. Changing the origin or the formula moves every derived coordinate, so it carries an id
 * that every file in /data/geo records; bump the id with any change and rebuild the geo data.
 *
 * No imports, so Node can load it from scripts/ with its built-in type stripping.
 */

export const PROJECTION_ID = 'cc-enu-v1'

/** Fixed origin near Midtown Manhattan; it never moves with the data. */
export const ORIGIN = { lat: 40.7, lng: -73.98 } as const

export interface LatLng {
  readonly lat: number
  readonly lng: number
}

/** Local metres from ORIGIN: x east, y north. */
export interface LocalPoint {
  readonly x: number
  readonly y: number
}

const WGS84_A = 6_378_137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const DEG = Math.PI / 180

const sinOrigin = Math.sin(ORIGIN.lat * DEG)
const curvatureTerm = 1 - WGS84_E2 * sinOrigin * sinOrigin
/** Meridional radius of curvature M at the origin latitude. */
const MERIDIAN_RADIUS = (WGS84_A * (1 - WGS84_E2)) / curvatureTerm ** 1.5
/** Prime-vertical radius of curvature N at the origin latitude. */
const PRIME_VERTICAL_RADIUS = WGS84_A / Math.sqrt(curvatureTerm)

/** About 111,048 m. */
export const METRES_PER_DEG_LAT = MERIDIAN_RADIUS * DEG
/** About 84,516 m. */
export const METRES_PER_DEG_LNG = PRIME_VERTICAL_RADIUS * Math.cos(ORIGIN.lat * DEG) * DEG

export function project(point: LatLng): LocalPoint {
  return {
    x: (point.lng - ORIGIN.lng) * METRES_PER_DEG_LNG,
    y: (point.lat - ORIGIN.lat) * METRES_PER_DEG_LAT,
  }
}

export function unproject(point: LocalPoint): LatLng {
  return {
    lat: ORIGIN.lat + point.y / METRES_PER_DEG_LAT,
    lng: ORIGIN.lng + point.x / METRES_PER_DEG_LNG,
  }
}

/** Straight-line distance in local metres. */
export function distanceM(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
