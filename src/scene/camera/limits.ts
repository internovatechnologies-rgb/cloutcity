/**
 * Pure camera-rig maths: bounds, clamping, near/far planes and the starting pose. No three or
 * React, so it is unit-tested directly. Scene axes: x east, y up, z = -north (coords.ts).
 */
import { project, type LocalPoint } from '@/lib/geo/projection'

export const DEG = Math.PI / 180

export function degToRad(degrees: number): number {
  return degrees * DEG
}

export function radToDeg(radians: number): number {
  return radians / DEG
}

/** An extent in local metres (x east, y north). */
export interface LocalBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** data/geo/bounds.json (WGS84 degrees) in local metres. */
export function boundsToLocal(bounds: {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}): LocalBounds {
  const southWest = project({ lat: bounds.south, lng: bounds.west })
  const northEast = project({ lat: bounds.north, lng: bounds.east })
  return { minX: southWest.x, minY: southWest.y, maxX: northEast.x, maxY: northEast.y }
}

export interface ScenePoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** The camera target kept inside the NYC extent (the height is left alone). */
export function clampTarget(target: ScenePoint, bounds: LocalBounds): ScenePoint {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, target.x)),
    y: target.y,
    z: Math.min(-bounds.minY, Math.max(-bounds.maxY, target.z)),
  }
}

export interface ClipConfig {
  readonly nearPerDistance: number
  readonly nearMinM: number
  readonly nearMaxM: number
  readonly farPerMaxDistance: number
  readonly maxDistanceM: number
}

/**
 * Near follows the camera distance (clamped) so close-ups and the whole-city view both keep
 * depth precision; far is fixed so the far plane never clips the city at maximum zoom-out.
 */
export function nearFar(distance: number, clip: ClipConfig): { near: number; far: number } {
  return {
    near: Math.min(clip.nearMaxM, Math.max(clip.nearMinM, distance * clip.nearPerDistance)),
    far: clip.maxDistanceM * clip.farPerMaxDistance,
  }
}

/**
 * Target and camera position for a look at `start` from `distance` metres, tilted `polarDeg`
 * from straight down and turned `azimuthDeg` from north-up. Same spherical convention as three
 * (Spherical / OrbitControls): azimuth 0 puts the camera south of the target, looking north.
 */
export function initialPose(
  start: LocalPoint,
  groundY: number,
  distance: number,
  polarDeg: number,
  azimuthDeg: number,
): { target: ScenePoint; position: ScenePoint } {
  const phi = degToRad(polarDeg)
  const theta = degToRad(azimuthDeg)
  const target = { x: start.x, y: groundY, z: -start.y }
  return {
    target,
    position: {
      x: target.x + distance * Math.sin(phi) * Math.sin(theta),
      y: target.y + distance * Math.cos(phi),
      z: target.z + distance * Math.sin(phi) * Math.cos(theta),
    },
  }
}
