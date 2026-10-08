import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BufferAttribute, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { encodeRing } from '@/lib/geo/codec'
import { ORIGIN, PROJECTION_ID } from '@/lib/geo/projection'
import {
  buildDistrictGeometry,
  districtMasses,
  drawnAt,
  massNoise,
  massTriangles,
  massesFor,
  pick,
  toByte,
} from './buildDistrict'
import { DistrictBuildingsMiniSchema, type DistrictBuildings } from './schema'

const noYield = async () => undefined
const COLORS = {
  walls: ['#7b5a4a', '#9a9286'],
  roof: '#5b5d61',
  jitter: 0.1,
  windowTile: { u: 16, v: 13.2 },
}

/** A synthetic file: a 20 m square tower, a low L-shape, and a courtyard block with a hole. */
function file(): DistrictBuildings {
  const square = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ]
  // Clockwise on purpose: the decoder must turn it counter-clockwise.
  const ell = [
    { x: 100, y: 0 },
    { x: 100, y: 30 },
    { x: 110, y: 30 },
    { x: 110, y: 10 },
    { x: 130, y: 10 },
    { x: 130, y: 0 },
  ]
  const outer = [
    { x: 200, y: 0 },
    { x: 260, y: 0 },
    { x: 260, y: 60 },
    { x: 200, y: 60 },
  ]
  const hole = [
    { x: 220, y: 20 },
    { x: 240, y: 20 },
    { x: 240, y: 40 },
    { x: 220, y: 40 },
  ]
  return DistrictBuildingsMiniSchema.parse({
    format: 'cc-buildings-v1',
    derived: true,
    notice: 'test',
    sources: ['oti-buildings-astoria'],
    projection: { id: PROJECTION_ID, originLat: ORIGIN.lat, originLng: ORIGIN.lng },
    tier: 'high',
    district: 'astoria',
    origin: { x: 1000, y: 2000 },
    h: [80, 6, 15],
    r: [[encodeRing(square)], [encodeRing(ell)], [encodeRing(outer), encodeRing(hole)]],
  })
}

describe('districtMasses', () => {
  it('orders masses most prominent first and orients outer rings ccw, holes cw', () => {
    const masses = districtMasses(file())
    expect(masses.map((m) => m.h)).toEqual([15, 80, 6])
    const signed = (ring: readonly { x: number; y: number }[]) =>
      ring.reduce((sum, p, i) => {
        const q = ring[(i + 1) % ring.length] ?? p
        return sum + p.x * q.y - q.x * p.y
      }, 0)
    for (const mass of masses) {
      expect(signed(mass.rings[0] ?? [])).toBeGreaterThan(0)
      for (const hole of mass.rings.slice(1)) expect(signed(hole)).toBeLessThan(0)
    }
    expect(masses[0]?.rings[0]?.[0]).toEqual({ x: 1200, y: 2000 })
  })
})

describe('buildDistrictGeometry', () => {
  it('has the triangle count the geo build budgets, per mass, and stands on the ground', async () => {
    const masses = districtMasses(file())
    const built = await buildDistrictGeometry(masses, 30, COLORS, noYield)
    const expected = masses.map((m) => massTriangles(m.rings))
    expect(built.triangleEnds[2]).toBe(expected.reduce((a, b) => a + b, 0))
    expect(built.geometry.index?.count).toBe((built.triangleEnds[2] ?? 0) * 3)
    const box = built.geometry.boundingBox
    expect(box?.min.y).toBe(30)
    expect(box?.max.y).toBe(30 + 80)
    expect(built.geometry.getAttribute('uv')).toBeInstanceOf(BufferAttribute)
  })

  it('faces every triangle along its normal (walls out, roofs up)', async () => {
    const built = await buildDistrictGeometry(districtMasses(file()), 0, COLORS, noYield)
    const pos = built.geometry.getAttribute('position')
    const nor = built.geometry.getAttribute('normal')
    const index = built.geometry.index
    if (index === null) throw new Error('no index')
    const a = new Vector3()
    const b = new Vector3()
    const c = new Vector3()
    const n = new Vector3()
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(pos, index.getX(i))
      b.fromBufferAttribute(pos, index.getX(i + 1))
      c.fromBufferAttribute(pos, index.getX(i + 2))
      n.fromBufferAttribute(nor, index.getX(i))
      const face = b.clone().sub(a).cross(c.clone().sub(a))
      expect(face.dot(n), `triangle ${i / 3}`).toBeGreaterThan(0)
    }
  })

  it('maps wall uvs in window-mask repeats and roofs to the wall texel at 0, 0', async () => {
    const masses = districtMasses(file())
    const built = await buildDistrictGeometry(masses, 0, COLORS, noYield)
    const uv = built.geometry.getAttribute('uv')
    const nor = built.geometry.getAttribute('normal')
    let maxV = 0
    for (let i = 0; i < uv.count; i++) {
      if (nor.getY(i) > 0.5) {
        expect([uv.getX(i), uv.getY(i)]).toEqual([0, 0])
      } else {
        maxV = Math.max(maxV, uv.getY(i))
      }
    }
    expect(maxV).toBeCloseTo(80 / COLORS.windowTile.v, 5)
  })

  it('draws the most prominent share of masses for a density', async () => {
    const built = await buildDistrictGeometry(districtMasses(file()), 0, COLORS, noYield)
    expect(massesFor(1, 3)).toBe(3)
    expect(massesFor(0.5, 3)).toBe(2)
    expect(massesFor(0.01, 3)).toBe(1)
    expect(massesFor(0.5, 0)).toBe(0)
    expect(drawnAt(built, 1).index).toBe(built.geometry.index?.count)
    expect(drawnAt(built, 0.34).triangles).toBe(built.triangleEnds[1])
  })

  it('yields between masses and is deterministic', async () => {
    let yields = 0
    const masses = districtMasses(file())
    const one = await buildDistrictGeometry(masses, 0, COLORS, async () => {
      yields++
    })
    const two = await buildDistrictGeometry(masses, 0, COLORS, noYield)
    expect(yields).toBe(3)
    expect([...(one.geometry.getAttribute('color').array as Uint8Array)]).toEqual([
      ...(two.geometry.getAttribute('color').array as Uint8Array),
    ])
    expect(massNoise(5)).toBe(massNoise(5))
    expect(massNoise(5)).toBeGreaterThanOrEqual(0)
    expect(massNoise(5)).toBeLessThan(1)
  })

  it('picks each facade from the walls by the mass noise, so a district mixes them', () => {
    expect(pick(['a', 'b', 'c'], 0)).toBe('a')
    expect(pick(['a', 'b', 'c'], 0.5)).toBe('b')
    expect(pick(['a', 'b', 'c'], 0.999)).toBe('c')
    expect(pick(['a', 'b', 'c'], 1)).toBe('c')
    expect(() => pick([], 0.5)).toThrow()
    const walls = Array.from({ length: 64 }, (_, m) => pick(['a', 'b', 'c', 'd'], massNoise(m)))
    expect(new Set(walls).size).toBe(4)
  })

  it('builds a real committed district within its build-time triangle count', async () => {
    const json = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../../data/geo/districts/jamaica.low.derived.json'),
        'utf8',
      ),
    ) as unknown
    const parsed = DistrictBuildingsMiniSchema.parse(json)
    const built = await buildDistrictGeometry(districtMasses(parsed), 30, COLORS, noYield)
    expect(built.masses).toBe(parsed.h.length)
    // geo:build counted 3815 triangles for jamaica.low (earcut can only drop degenerate ones).
    expect(built.triangleEnds[built.masses - 1]).toBeLessThanOrEqual(3815)
    expect(built.triangleEnds[built.masses - 1]).toBeGreaterThan(3815 * 0.95)
  })
})

describe('facade colour bytes (3D-5)', () => {
  it('clamps and rounds a channel instead of wrapping', () => {
    expect(toByte(1.06)).toBe(255)
    expect(toByte(-0.2)).toBe(0)
    expect(toByte(0.5)).toBe(128)
  })

  it('keeps a white wall bright whatever its jitter, never wrapping to dark', async () => {
    const white = { ...COLORS, walls: ['#ffffff'], roof: '#ffffff', jitter: 0.5 }
    const built = await buildDistrictGeometry(districtMasses(file()), 0, white, noYield)
    const colors = built.geometry.getAttribute('color') as BufferAttribute
    const array = colors.array as Uint8Array
    // Shade spans 0.5..1.5: unclamped, a brightened channel would wrap to a dark byte.
    for (const value of array) expect(value).toBeGreaterThanOrEqual(127)
  })
})
