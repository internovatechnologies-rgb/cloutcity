import { describe, expect, it } from 'vitest'
import { Box3, Mesh, Raycaster, Vector3 } from 'three'
import { scene } from '@/lib/data/config'
import { PLAYER_AVATAR_NAME, avatarSize, buildAvatar } from './buildAvatar'

const { avatar, camera } = scene

function triangles(mesh: Mesh): number {
  const { index, attributes } = mesh.geometry
  return (index?.count ?? attributes.position?.count ?? 0) / 3
}

describe('avatarSize (S05)', () => {
  it('grows with camera distance and is clamped at both ends', () => {
    expect(avatarSize(camera.distanceM, avatar)).toBeCloseTo(
      camera.distanceM * avatar.heightPerDistance,
    )
    expect(avatarSize(0, avatar)).toBe(avatar.minHeightM)
    expect(avatarSize(1e9, avatar)).toBe(avatar.maxHeightM)
    expect(avatarSize(camera.minDistanceM, avatar)).toBeGreaterThanOrEqual(avatar.minHeightM)
    expect(avatarSize(camera.maxDistanceM, avatar)).toBeLessThanOrEqual(avatar.maxHeightM)
  })

  it('is never smaller up close than at a farther distance', () => {
    let last = 0
    for (let d = camera.minDistanceM; d <= camera.maxDistanceM; d *= 1.5) {
      const size = avatarSize(d, avatar)
      expect(size).toBeGreaterThanOrEqual(last)
      last = size
    }
  })
})

describe('buildAvatar (S05)', () => {
  const built = buildAvatar('#ffcc00', [0.35, 0.65, 1], avatar)
  const meshes = built.group.children.filter((child): child is Mesh => child instanceof Mesh)

  it('is two meshes (two draw calls) under 1k triangles', () => {
    expect(built.group.name).toBe(PLAYER_AVATAR_NAME)
    expect(meshes).toHaveLength(2)
    const total = meshes.reduce((sum, mesh) => sum + triangles(mesh), 0)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThan(1000)
  })

  it('stands with its feet on the group origin and is exactly its height tall', () => {
    built.setHeight(50)
    built.group.updateMatrixWorld(true)
    const body = meshes.find((mesh) => mesh.name.endsWith('-body'))
    if (body === undefined) throw new Error('no body mesh')
    const box = new Box3().setFromObject(body)
    expect(box.min.y).toBeCloseTo(0, 6)
    expect(box.max.y).toBeCloseTo(50, 6)
  })

  it('lays the ring flat just above the ground, wider than the body', () => {
    built.setHeight(1)
    built.group.updateMatrixWorld(true)
    const ring = meshes.find((mesh) => mesh.name.endsWith('-ring'))
    if (ring === undefined) throw new Error('no ring mesh')
    const box = new Box3().setFromObject(ring)
    expect(box.max.y - box.min.y).toBeCloseTo(0, 6)
    expect(box.min.y).toBeCloseTo(avatar.ringLiftRatio, 6)
    expect(box.max.x).toBeCloseTo(avatar.ringOuterRatio, 2)
    expect(avatar.ringOuterRatio).toBeGreaterThan(avatar.radiusRatio)
  })

  it('is never hit by a raycast, so taps go to the map', () => {
    built.setHeight(50)
    built.group.updateMatrixWorld(true)
    const ray = new Raycaster(new Vector3(0, 25, 100), new Vector3(0, 0, -1))
    expect(ray.intersectObject(built.group, true)).toEqual([])
  })

  it('disposes without throwing', () => {
    expect(() => buildAvatar('#ffcc00', [0.5, 1], avatar).dispose()).not.toThrow()
  })
})
