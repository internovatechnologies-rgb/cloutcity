import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshDepthMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import { releaseScenePrograms, sceneMaterials } from './releasePrograms'

describe('releaseScenePrograms (3D-3)', () => {
  it('disposes each material once: shared, grouped and depth overrides included', () => {
    const geometry = new BoxGeometry()
    const shared = new MeshBasicMaterial()
    const second = new MeshBasicMaterial()
    const depth = new MeshDepthMaterial()
    const root = new Group()
    const a = new Mesh(geometry, shared)
    const b = new Mesh(geometry, [shared, second])
    b.customDepthMaterial = depth
    b.visible = false
    root.add(a, b)

    expect(sceneMaterials(root)).toEqual(new Set([shared, second, depth]))
    const disposed: string[] = []
    for (const [name, material] of [
      ['shared', shared],
      ['second', second],
      ['depth', depth],
    ] as const) {
      material.addEventListener('dispose', () => disposed.push(name))
    }
    expect(releaseScenePrograms(root)).toBe(3)
    expect(disposed.sort()).toEqual(['depth', 'second', 'shared'])
    // The objects keep their materials: three re-initialises them on their next render.
    expect(a.material).toBe(shared)
  })
})
