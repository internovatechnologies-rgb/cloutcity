/**
 * One district's building masses as one merged mesh (S04d): each mass is its footprint extruded
 * from the land top to its height, walls and a flat roof, with flat normals and a per-mass facade
 * colour. Masses are ordered most prominent first (footprint area times height), so a tier's
 * `buildingDensity` is just a draw range over the front of the index: the skyline survives and
 * the smallest buildings go first. three only, no React; the build yields through `step` so a
 * district never blocks the main thread for long.
 */
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2 } from 'three'
import { decodeRing } from '@/lib/geo/codec'
import { polygonArea, signedArea } from '@/lib/geo/polygon'
import type { LocalPoint } from '@/lib/geo/projection'
import type { DistrictBuildings } from './schema'

export interface DistrictMass {
  readonly h: number
  /** [outer (counter-clockwise), ...holes (clockwise)], absolute local metres, open rings. */
  readonly rings: readonly (readonly LocalPoint[])[]
  /** Footprint area times height: the draw order. */
  readonly prominence: number
}

/** Decodes a district file into masses, most prominent first (ties keep file order). */
export function districtMasses(file: DistrictBuildings): DistrictMass[] {
  const masses = file.r.map((polygon, index) => {
    const rings = polygon.map((ring, ringIndex) => {
      const points = decodeRing(ring).map((p) => ({
        x: p.x + file.origin.x,
        y: p.y + file.origin.y,
      }))
      const counterClockwise = signedArea(points) > 0
      // Outer rings run counter-clockwise and holes clockwise, whatever the file holds.
      return counterClockwise === (ringIndex === 0) ? points : points.reverse()
    })
    const h = file.h[index] ?? 1
    return { h, rings, prominence: polygonArea(rings) * h, index }
  })
  masses.sort((a, b) => b.prominence - a.prominence || a.index - b.index)
  return masses.map(({ h, rings, prominence }) => ({ h, rings, prominence }))
}

/** Triangles of one mass: the roof (earcut) plus two per wall edge. */
export function massTriangles(rings: readonly (readonly LocalPoint[])[]): number {
  const vertices = rings.reduce((sum, ring) => sum + ring.length, 0)
  return vertices + 2 * (rings.length - 1) - 2 + 2 * vertices
}

export interface DistrictColors {
  /**
   * Facade colours, one picked per mass, so a district reads as a mix of brick, brownstone,
   * limestone, concrete and glass rather than one colour. Repeat a colour to weight it.
   */
  readonly walls: readonly string[]
  readonly roof: string
  /** Facade brightness spread (scene.json buildings.wallJitter). */
  readonly jitter: number
  /**
   * World size of one repeat of the window mask (materials.ts windowTile): walls get `uv` in
   * repeats, running along each ring and up from the ground; roofs sit at uv (0, 0), a wall texel.
   */
  readonly windowTile: { readonly u: number; readonly v: number }
}

/** The entry a 0..1 `noise` value lands on (`items` must not be empty). */
export function pick<T>(items: readonly T[], noise: number): T {
  const item = items[Math.min(items.length - 1, Math.floor(noise * items.length))]
  if (item === undefined) throw new Error('pick needs at least one item')
  return item
}

/** A deterministic 0..1 value per mass index (no Math.random: a rebuild looks the same). */
export function massNoise(index: number): number {
  let x = (index + 1) * 0x9e3779b1
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 0x100000000
}

/**
 * A linear channel (0..1, but a jittered facade can exceed 1) as a normalised byte. Writing
 * straight into a Uint8Array would wrap 1.06 × 255 round to a near-black 15 (3D-5), so it
 * clamps, and rounds rather than truncating.
 */
export function toByte(channel: number): number {
  return Math.min(255, Math.max(0, Math.round(channel * 255)))
}

export interface DistrictGeometry {
  readonly geometry: BufferGeometry
  readonly masses: number
  /** Index count after the first k + 1 masses: the draw range for a density. */
  readonly indexEnds: Uint32Array
  /** Triangles after the first k + 1 masses. */
  readonly triangleEnds: Uint32Array
}

/** How many masses a density draws: at least one while there are any. */
export function massesFor(density: number, total: number): number {
  return total === 0 ? 0 : Math.min(total, Math.max(1, Math.ceil(total * density)))
}

/** The index count and triangles drawn at a density. */
export function drawnAt(
  built: DistrictGeometry,
  density: number,
): { index: number; triangles: number } {
  const k = massesFor(density, built.masses)
  return k === 0
    ? { index: 0, triangles: 0 }
    : { index: built.indexEnds[k - 1] ?? 0, triangles: built.triangleEnds[k - 1] ?? 0 }
}

/**
 * Builds the merged geometry in scene space (x east, y up, z = -north) standing on `groundY`.
 * Awaits `step` after every mass, which yields when the current slice has run long enough.
 */
export async function buildDistrictGeometry(
  masses: readonly DistrictMass[],
  groundY: number,
  colors: DistrictColors,
  step: () => Promise<void>,
): Promise<DistrictGeometry> {
  let vertexCount = 0
  let indexCount = 0
  for (const mass of masses) {
    const ringVertices = mass.rings.reduce((sum, ring) => sum + ring.length, 0)
    vertexCount += ringVertices * 4 + ringVertices
    indexCount += massTriangles(mass.rings) * 3
  }
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const vertexColors = new Uint8Array(vertexCount * 3)
  const index = new Uint32Array(indexCount)
  const indexEnds = new Uint32Array(masses.length)
  const triangleEnds = new Uint32Array(masses.length)

  const walls = colors.walls.map((hex) => new Color(hex))
  const roof = new Color(colors.roof)
  const facade = new Color()
  let v = 0
  let i = 0

  const vertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: Color,
    u = 0,
    w = 0,
  ) => {
    uvs[v * 2] = u
    uvs[v * 2 + 1] = w
    const o = v * 3
    positions[o] = x
    positions[o + 1] = y
    positions[o + 2] = z
    normals[o] = nx
    normals[o + 1] = ny
    normals[o + 2] = nz
    vertexColors[o] = toByte(c.r)
    vertexColors[o + 1] = toByte(c.g)
    vertexColors[o + 2] = toByte(c.b)
    return v++
  }

  for (const [m, mass] of masses.entries()) {
    const noise = massNoise(m)
    const shade = 1 + colors.jitter * (2 * massNoise(m + 7919) - 1)
    facade.copy(pick(walls, noise)).multiplyScalar(shade)
    const top = groundY + mass.h

    // Walls: one quad per edge, outward for the outer ring and into each courtyard for holes.
    const vTop = mass.h / colors.windowTile.v
    for (const ring of mass.rings) {
      let along = 0
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]
        const b = ring[(k + 1) % ring.length]
        if (a === undefined || b === undefined) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const length = Math.hypot(dx, dy) || 1
        // The outward normal of a counter-clockwise edge in local metres is (dy, -dx); in scene
        // space (x, 0, -y) that is (dy, 0, dx).
        const nx = dy / length
        const nz = dx / length
        const u0 = along / colors.windowTile.u
        along += length
        const u1 = along / colors.windowTile.u
        const a0 = vertex(a.x, groundY, -a.y, nx, 0, nz, facade, u0, 0)
        const b0 = vertex(b.x, groundY, -b.y, nx, 0, nz, facade, u1, 0)
        const b1 = vertex(b.x, top, -b.y, nx, 0, nz, facade, u1, vTop)
        const a1 = vertex(a.x, top, -a.y, nx, 0, nz, facade, u0, vTop)
        index.set([a0, b0, b1, a0, b1, a1], i)
        i += 6
      }
    }

    // Roof: earcut over the outer ring and its holes, facing up.
    const [outer = [], ...holes] = mass.rings
    const contour = outer.map((p) => new Vector2(p.x, p.y))
    const holePoints = holes.map((hole) => hole.map((p) => new Vector2(p.x, p.y)))
    // Triangulate first: it drops repeated closing points in place, which renumbers vertices.
    const faces = ShapeUtils.triangulateShape(contour, holePoints)
    const first = v
    for (const point of contour.concat(...holePoints)) {
      vertex(point.x, top, -point.y, 0, 1, 0, roof)
    }
    const roofPoints = [...contour, ...holePoints.flat()]
    for (const [p = 0, q = 0, r = 0] of faces) {
      const a = roofPoints[p]
      const b = roofPoints[q]
      const c = roofPoints[r]
      if (a === undefined || b === undefined || c === undefined) continue
      // Counter-clockwise in local metres faces up in scene space (see coords.ts).
      const ccw = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0
      index.set(ccw ? [first + p, first + q, first + r] : [first + p, first + r, first + q], i)
      i += 3
    }
    indexEnds[m] = i
    triangleEnds[m] = i / 3
    await step()
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions.subarray(0, v * 3), 3))
  geometry.setAttribute('normal', new BufferAttribute(normals.subarray(0, v * 3), 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs.subarray(0, v * 2), 2))
  geometry.setAttribute('color', new BufferAttribute(vertexColors.subarray(0, v * 3), 3, true))
  geometry.setIndex(new BufferAttribute(index.subarray(0, i), 1))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return { geometry, masses: masses.length, indexEnds, triangleEnds }
}
