import { Vector3, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import type { Part } from '../types'
import {
  arcade,
  beam,
  box,
  boxFaceWindows,
  cable,
  cylinder,
  dome,
  gable,
  prism,
  sampleCatenary,
  setbackBoxes,
  setbackStack,
  taperedBox,
  wallWindows,
  windowGrid,
} from './primitives'

const stone = { role: 'stone' as const }
const tris = (g: BufferGeometry) => g.getAttribute('position').count / 3

function vertex(g: BufferGeometry, name: 'position' | 'normal', i: number) {
  const a = g.getAttribute(name)
  return new Vector3(a.getX(i), a.getY(i), a.getZ(i))
}

/** Non-indexed, no uvs, every triangle's three normals equal its face normal (flat). */
function expectFlat(g: BufferGeometry) {
  expect(g.index).toBeNull()
  expect(g.getAttribute('uv')).toBeUndefined()
  for (let t = 0; t < tris(g); t++) {
    const [a, b, c] = [0, 1, 2].map((k) => vertex(g, 'position', t * 3 + k)) as [
      Vector3,
      Vector3,
      Vector3,
    ]
    const face = b.clone().sub(a).cross(c.clone().sub(a)).normalize()
    for (let k = 0; k < 3; k++) {
      expect(vertex(g, 'normal', t * 3 + k).distanceTo(face)).toBeLessThan(1e-5)
    }
  }
}

/** Every face of a convex solid points away from its centroid. */
function expectOutward(g: BufferGeometry) {
  const centre = new Vector3()
  const count = g.getAttribute('position').count
  for (let i = 0; i < count; i++) centre.add(vertex(g, 'position', i))
  centre.divideScalar(count)
  for (let t = 0; t < tris(g); t++) {
    const mid = new Vector3()
    for (let k = 0; k < 3; k++) mid.add(vertex(g, 'position', t * 3 + k))
    mid.divideScalar(3)
    expect(vertex(g, 'normal', t * 3).dot(mid.sub(centre))).toBeGreaterThan(0)
  }
}

const solids: [string, () => Part][] = [
  ['box', () => box([0, 0, 0], [2, 3, 4], stone, { bottom: true })],
  ['tapered box', () => taperedBox([1, 1], 0, 10, [4, 4], [1, 2], stone)],
  [
    'prism',
    () =>
      prism(
        [
          [0, 0],
          [4, 0],
          [2, 5],
        ],
        0,
        6,
        stone,
      ),
  ],
  ['cylinder', () => cylinder([0, 0], 2, 0, 5, 8, stone)],
  ['dome', () => dome([0, 0], 3, 10, 2, 8, 3, stone)],
  ['gable along x', () => gable(0, 10, 0, 4, 5, 2, 'x', stone)],
  ['gable along z', () => gable(0, 10, 0, 4, 5, 2, 'z', stone)],
  ['beam', () => beam([0, 0, 0], [10, 3, 5], 2, 1, stone, { caps: true })],
  ['vertical beam', () => beam([0, 0, 0], [0, 8, 0], 1, 1, stone, { caps: true })],
]

describe('primitives', () => {
  it.each(solids)('%s: flat normals, no uvs, faces outward', (_name, make) => {
    const part = make()
    expectFlat(part.geometry)
    expectOutward(part.geometry)
    expect(part).toMatchObject({ role: 'stone', group: 'body', outline: true })
  })

  it('a box hides the face it stands on unless asked', () => {
    expect(tris(box([0, 0, 0], [1, 1, 1], stone).geometry)).toBe(10)
    expect(tris(box([0, 0, 0], [1, 1, 1], stone, { bottom: true }).geometry)).toBe(12)
    expect(tris(box([0, 0, 0], [1, 1, 1], stone, { top: false }).geometry)).toBe(8)
  })

  it('drops the slivers of a collapsed apex', () => {
    // A pyramid: four sides of one triangle each, no top.
    expect(tris(taperedBox([0, 0], 0, 5, [2, 2], [0, 0], stone).geometry)).toBe(4)
  })

  it('arcade: count openings as a frame of boxes (jambs, lintels, haunches)', () => {
    const one = arcade(0, 10, 1, 0, 6, 0, 1, 1, 1, stone)
    const two = arcade(0, 20, 2, 0, 6, 0, 1, 1, 1, stone)
    expect(tris(one.geometry)).toBe(5 * 10)
    expect(tris(two.geometry)).toBe(9 * 10)
    expectFlat(two.geometry)
    expect(() => arcade(0, 2, 1, 0, 6, 0, 1, 1, 1, stone)).toThrow(/no room/)
  })

  it('setback stack: each tier inset from the one below, stacked', () => {
    const boxes = setbackBoxes([0, 0], 20, 10, 5, [
      { heightM: 10, insetM: 0 },
      { heightM: 5, insetM: 2 },
    ])
    expect(boxes).toEqual([
      { min: [-10, 5, -5], max: [10, 15, 5] },
      { min: [-8, 15, -3], max: [8, 20, 3] },
    ])
    expect(tris(setbackStack([0, 0], 20, 10, 5, [{ heightM: 1, insetM: 0 }], stone).geometry)).toBe(
      10,
    )
  })

  it('catenary sampler: hits both ends and sags at mid-span', () => {
    const points = sampleCatenary([0, 50, 0], [100, 50, 0], 20, 10)
    expect(points).toHaveLength(11)
    expect(points[0]).toEqual([0, 50, 0])
    expect(points[10]?.[1]).toBeCloseTo(50, 9)
    expect(points[5]).toEqual([50, 30, 0])
  })

  it('cables are never outlined', () => {
    const part = cable(sampleCatenary([0, 50, 0], [100, 50, 0], 20, 4), 1, 'accent')
    expect(part.outline).toBe(false)
    expect(tris(part.geometry)).toBe(4 * 8)
  })

  it('window grids: rows × cols panes facing the given normal, in the windows group', () => {
    const grid = windowGrid({
      origin: [0, 0, 0],
      right: [1, 0, 0],
      up: [0, 1, 0],
      normal: [0, 0, -1],
      width: 10,
      height: 6,
      rows: 3,
      cols: 4,
    })
    expect(grid).toMatchObject({ role: 'window', group: 'windows', outline: false })
    expect(tris(grid.geometry)).toBe(3 * 4 * 2)
    expectFlat(grid.geometry)
    for (let i = 0; i < grid.geometry.getAttribute('normal').count; i++) {
      expect(vertex(grid.geometry, 'normal', i).z).toBeCloseTo(-1, 6)
      expect(vertex(grid.geometry, 'position', i).z).toBeLessThan(0)
    }
  })

  it.each([
    ['-z', new Vector3(0, 0, -1)],
    ['+z', new Vector3(0, 0, 1)],
    ['-x', new Vector3(-1, 0, 0)],
    ['+x', new Vector3(1, 0, 0)],
  ] as const)('box face windows on %s face outward', (face, outward) => {
    const grid = boxFaceWindows([-5, 0, -5], [5, 10, 5], face, 2, 2)
    expect(vertex(grid.geometry, 'normal', 0).distanceTo(outward)).toBeLessThan(1e-6)
  })

  it('wall windows on a slanted wall face away from the inside point', () => {
    const grid = wallWindows([0, -10], [10, 10], 0, 10, 2, 2, [0, 0])
    const normal = vertex(grid.geometry, 'normal', 0)
    expect(normal.x).toBeGreaterThan(0)
    expect(normal.z).toBeLessThan(0)
    expect(normal.dot(new Vector3(10, 0, 20))).toBeCloseTo(0, 4)
  })
})
