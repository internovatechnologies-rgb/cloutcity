import { describe, expect, it } from 'vitest'
import { scene } from '@/lib/data/config'
import { geoBounds } from '@/lib/data/content'
import { project } from '@/lib/geo/projection'
import { boundsToLocal, clampTarget, degToRad, initialPose, nearFar, radToDeg } from './limits'

describe('camera limits', () => {
  it('converts degrees and radians both ways', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI)
    expect(radToDeg(degToRad(48))).toBeCloseTo(48)
  })

  it('projects the NYC extent to local metres around the origin', () => {
    const bounds = boundsToLocal(geoBounds)
    expect(bounds.minX).toBeLessThan(0)
    expect(bounds.maxX).toBeGreaterThan(0)
    expect(bounds.minY).toBeLessThan(0)
    expect(bounds.maxY).toBeGreaterThan(0)
    expect(bounds.minX).toBeCloseTo(project({ lat: geoBounds.south, lng: geoBounds.west }).x)
  })

  it('keeps the target inside the extent and leaves its height alone', () => {
    const bounds = { minX: -100, minY: -200, maxX: 100, maxY: 200 }
    expect(clampTarget({ x: 50, y: 7, z: -150 }, bounds)).toEqual({ x: 50, y: 7, z: -150 })
    // North (z = -north) beyond maxY and east beyond maxX are pulled back to the edge.
    expect(clampTarget({ x: 500, y: 7, z: -900 }, bounds)).toEqual({ x: 100, y: 7, z: -200 })
    expect(clampTarget({ x: -500, y: 0, z: 900 }, bounds)).toEqual({ x: -100, y: 0, z: 200 })
  })

  it('scales near with distance (clamped) and fixes far beyond the zoom-out limit', () => {
    const clip = scene.camera
    expect(nearFar(0, clip).near).toBe(clip.nearMinM)
    expect(nearFar(1e9, clip).near).toBe(clip.nearMaxM)
    expect(nearFar(clip.distanceM, clip).near).toBeCloseTo(clip.distanceM * clip.nearPerDistance)
    expect(nearFar(clip.distanceM, clip).far).toBe(clip.maxDistanceM * clip.farPerMaxDistance)
    expect(nearFar(clip.maxDistanceM, clip).far).toBeGreaterThan(clip.maxDistanceM)
  })

  it('puts the start camera south of the target, tilted and at the configured distance', () => {
    const pose = initialPose({ x: 100, y: 200 }, 30, 1000, 48, 0)
    expect(pose.target).toEqual({ x: 100, y: 30, z: -200 })
    const dx = pose.position.x - pose.target.x
    const dy = pose.position.y - pose.target.y
    const dz = pose.position.z - pose.target.z
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1000)
    expect(dx).toBeCloseTo(0)
    expect(dz).toBeGreaterThan(0)
    expect(radToDeg(Math.acos(dy / 1000))).toBeCloseTo(48)
    const turned = initialPose({ x: 0, y: 0 }, 0, 1000, 48, 30)
    expect(radToDeg(Math.atan2(turned.position.x, turned.position.z))).toBeCloseTo(30)
  })
})
