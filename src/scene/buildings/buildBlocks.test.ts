import { Color, MeshBasicMaterial, PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'
import { encodePath } from '@/lib/geo/codec'
import { ORIGIN, PROJECTION_ID } from '@/lib/geo/projection'
import { BLOCK_TRIANGLES, buildBlockGeometry, buildBlocks } from './buildBlocks'
import { BlocksMiniSchema } from './schema'

const materials = { normal: new MeshBasicMaterial(), dimmed: new MeshBasicMaterial() }
const COLORS = { blocks: ['#9a9286', '#b5654a'], dimmed: '#5a5852', jitter: 0 }

/** Queens blocks in a row along x every 500 m, plus one Bronx block. */
const file = BlocksMiniSchema.parse({
  format: 'cc-blocks-v1',
  derived: true,
  notice: 'test',
  sources: ['dcp-mappluto-density'],
  projection: { id: PROJECTION_ID, originLat: ORIGIN.lat, originLng: ORIGIN.lng },
  tier: 'low',
  sizeM: 60,
  groups: [
    {
      borough: 'queens',
      angleDeg: 0,
      p: encodePath(Array.from({ length: 20 }, (_, i) => ({ x: i * 500, y: 0 }))),
      h: Array.from({ length: 20 }, () => 12),
    },
    { borough: 'bronx', angleDeg: 29, p: encodePath([{ x: 0, y: 3000 }]), h: [9] },
  ],
})

/** Camera 1500 m up over x = 0, looking down at the origin. */
function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(45, 1, 1, 100_000)
  cam.position.set(0, 1500, 1)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()
  return cam
}

describe('block geometry', () => {
  it('is a floorless unit box of ten triangles', () => {
    const geometry = buildBlockGeometry()
    expect((geometry.index?.count ?? 0) / 3).toBe(BLOCK_TRIANGLES)
    geometry.computeBoundingBox()
    expect(geometry.boundingBox?.min.toArray()).toEqual([-0.5, 0, -0.5])
    expect(geometry.boundingBox?.max.toArray()).toEqual([0.5, 1, 0.5])
  })
})

describe('buildBlocks', () => {
  it('makes one instanced mesh per borough, dimmed land with the dimmed material, unpickable', () => {
    const blocks = buildBlocks(file, 30, COLORS, new Set(['bronx']), materials)
    const meshes = blocks.group.children
    expect(meshes.map((m) => m.name)).toEqual(['blocks-queens', 'blocks-bronx'])
    expect((meshes[1] as unknown as { material: unknown }).material).toBe(materials.dimmed)
    expect(blocks.view()).toEqual({ total: 21, drawn: 0, triangles: 0 })
    blocks.dispose()
  })

  it('colours each block from the palette, and blocks on dimmed land with the dimmed colour', () => {
    const blocks = buildBlocks(file, 30, COLORS, new Set(['bronx']), materials)
    const above = new PerspectiveCamera(90, 1, 1, 100_000)
    above.position.set(5000, 8000, -1500)
    above.lookAt(5000, 0, -1500)
    above.updateMatrixWorld()
    blocks.cull(above, 100_000)
    const hexes = (name: string) => {
      const mesh = blocks.group.getObjectByName(name) as unknown as {
        count: number
        instanceColor: { array: Float32Array }
      }
      return new Set(
        Array.from(
          { length: mesh.count },
          (_, i) => `#${new Color().fromArray(mesh.instanceColor.array, i * 3).getHexString()}`,
        ),
      )
    }
    const queens = hexes('blocks-queens')
    // Twenty blocks in view: both palette colours appear, and nothing else.
    expect(queens).toEqual(new Set(COLORS.blocks))
    expect([...hexes('blocks-bronx')]).toEqual([COLORS.dimmed])
    blocks.dispose()
  })

  it('draws only blocks in the frustum and within the draw distance', () => {
    const blocks = buildBlocks(file, 30, COLORS, new Set(), materials)
    const near = blocks.cull(camera(), 100_000)
    expect(near.drawn).toBeGreaterThan(0)
    expect(near.drawn).toBeLessThan(near.total)
    expect(near.triangles).toBe(near.drawn * BLOCK_TRIANGLES)
    const close = blocks.cull(camera(), 1480)
    expect(close.drawn).toBeLessThan(near.drawn)
    expect(blocks.cull(camera(), 10).drawn).toBe(0)
    const queens = blocks.group.getObjectByName('blocks-queens') as unknown as {
      count: number
      visible: boolean
    }
    expect(queens.visible).toBe(false)
    blocks.dispose()
  })
})
