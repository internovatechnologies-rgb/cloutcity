import { describe, expect, it } from 'vitest'
import boundsJson from '@data/geo/bounds.json'
import {
  METRES_PER_DEG_LAT,
  METRES_PER_DEG_LNG,
  ORIGIN,
  PROJECTION_ID,
  distanceM,
  project,
  unproject,
} from './projection'

/** True east-west metres per degree of longitude at a latitude, on the WGS84 ellipsoid. */
function trueMetresPerDegLng(lat: number): number {
  const a = 6_378_137
  const f = 1 / 298.257223563
  const e2 = f * (2 - f)
  const phi = (lat * Math.PI) / 180
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  return (n * Math.cos(phi) * Math.PI) / 180
}

describe('projection', () => {
  it('maps the fixed origin to (0, 0)', () => {
    expect(PROJECTION_ID).toBe('cc-enu-v1')
    expect(ORIGIN).toEqual({ lat: 40.7, lng: -73.98 })
    expect(project(ORIGIN)).toEqual({ x: 0, y: 0 })
  })

  it('uses the WGS84 radii of curvature at the origin', () => {
    expect(METRES_PER_DEG_LAT).toBeCloseTo(111_048.11, 1)
    expect(METRES_PER_DEG_LNG).toBeCloseTo(84_515.51, 1)
    // 0.001 degree of latitude is about 111.05 m.
    expect(project({ lat: ORIGIN.lat + 0.001, lng: ORIGIN.lng }).y).toBeCloseTo(111.05, 2)
  })

  it('x points east and y points north', () => {
    const p = project({ lat: 40.71, lng: -73.97 })
    expect(p.x).toBeGreaterThan(0)
    expect(p.y).toBeGreaterThan(0)
  })

  it('round-trips every point of a grid over the NYC extent to well under a micrometre', () => {
    let worst = 0
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const point = {
          lat: boundsJson.south + ((boundsJson.north - boundsJson.south) * i) / 20,
          lng: boundsJson.west + ((boundsJson.east - boundsJson.west) * j) / 20,
        }
        const back = project(unproject(project(point)))
        worst = Math.max(worst, distanceM(back, project(point)))
        const ll = unproject(project(point))
        expect(ll.lat).toBeCloseTo(point.lat, 10)
        expect(ll.lng).toBeCloseTo(point.lng, 10)
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('Times Square to the Brooklyn Bridge matches the geodesic 5843.3 m within 0.1%', () => {
    const timesSquare = project({ lat: 40.758, lng: -73.9855 })
    const brooklynBridge = project({ lat: 40.7061, lng: -73.9969 })
    const distance = distanceM(timesSquare, brooklynBridge)
    expect(Math.abs(distance - 5843.3) / 5843.3).toBeLessThan(0.001)
  })

  it('keeps east-west scale error within 0.35% at the north and south edges', () => {
    for (const lat of [boundsJson.north, boundsJson.south]) {
      const error = Math.abs(METRES_PER_DEG_LNG / trueMetresPerDegLng(lat) - 1)
      expect(error).toBeLessThanOrEqual(0.0035)
    }
  })
})
