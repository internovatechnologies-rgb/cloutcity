/**
 * Low-poly building blocks for landmark models. Every primitive returns a Part: non-indexed
 * triangles with flat (per-face) normals and no uvs, painted with one palette role.
 *
 * Solids are convex, so each triangle is oriented to face away from the solid's centroid
 * instead of trusting hand-written winding: front faces always point outward, which the toon
 * shading and the inverted-hull outline both rely on. Faces a solid stands on are left out by
 * default (`bottom: false`), since nothing ever sees them.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { LandmarkRole } from '@/lib/data/schemas/landmarkModels'
import type { Part, PartGroup } from '../types'

export type Vec3 = readonly [number, number, number]
/** A point on the ground plane: [x, z]. */
export type Vec2 = readonly [number, number]
type Tri = readonly [Vec3, Vec3, Vec3]

export interface PartStyle {
  readonly role: LandmarkRole
  /** Default true. */
  readonly outline?: boolean
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1))

const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Tri[] => [
  [a, b, c],
  [a, c, d],
]

/** Twice the triangle's area below this is a sliver (a collapsed apex): dropped. */
const DEGENERATE = 1e-9

function toGeometry(tris: readonly Tri[]): BufferGeometry {
  const positions: number[] = []
  for (const [a, b, c] of tris) {
    if (length(cross(sub(b, a), sub(c, a))) < DEGENERATE) continue
    positions.push(...a, ...b, ...c)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  // Non-indexed: every triangle gets its own face normal, i.e. flat shading.
  geometry.computeVertexNormals()
  return geometry
}

/** Turns every triangle of a convex solid to face away from its centroid. */
function orientConvex(tris: readonly Tri[]): Tri[] {
  let centre: Vec3 = [0, 0, 0]
  let n = 0
  for (const tri of tris) {
    for (const v of tri) {
      centre = add(centre, v)
      n++
    }
  }
  centre = scale(centre, 1 / Math.max(n, 1))
  return tris.map(([a, b, c]) => {
    const normal = cross(sub(b, a), sub(c, a))
    const mid = scale(add(add(a, b), c), 1 / 3)
    return dot(normal, sub(mid, centre)) < 0 ? [a, c, b] : [a, b, c]
  })
}

function part(tris: readonly Tri[], style: PartStyle, group: PartGroup = 'body'): Part {
  return {
    geometry: toGeometry(tris),
    role: style.role,
    group,
    outline: group === 'body' && (style.outline ?? true),
  }
}

/** Merges parts of one role into one (fewer, larger pieces for compose to merge again). */
export function mergeParts(parts: readonly Part[], style: PartStyle): Part {
  const merged = mergeGeometries(parts.map((p) => p.geometry))
  if (merged === null) throw new Error('mergeParts: incompatible geometries')
  for (const p of parts) p.geometry.dispose()
  return { geometry: merged, role: style.role, group: 'body', outline: style.outline ?? true }
}

// ---- solids -----------------------------------------------------------------------------

export interface LoftOptions {
  /** Default false: the face it stands on. */
  readonly bottom?: boolean
  /** Default true. */
  readonly top?: boolean
}

/**
 * A convex solid between two convex rings on the ground plane (same vertex count, same order):
 * the general case of box, prism, tapered box and cylinder.
 */
function loftTris(
  lower: readonly Vec2[],
  y0: number,
  upper: readonly Vec2[],
  y1: number,
  options: LoftOptions = {},
): Tri[] {
  if (lower.length !== upper.length || lower.length < 3) {
    throw new Error('loft: rings need the same vertex count, at least 3')
  }
  const at = (ring: readonly Vec2[], i: number, y: number): Vec3 => {
    const p = ring[i % ring.length] ?? [0, 0]
    return [p[0], y, p[1]]
  }
  const tris: Tri[] = []
  for (let i = 0; i < lower.length; i++) {
    tris.push(
      ...quad(at(lower, i, y0), at(lower, i + 1, y0), at(upper, i + 1, y1), at(upper, i, y1)),
    )
  }
  for (let i = 1; i + 1 < lower.length; i++) {
    if (options.top ?? true) tris.push([at(upper, 0, y1), at(upper, i, y1), at(upper, i + 1, y1)])
    if (options.bottom ?? false) {
      tris.push([at(lower, 0, y0), at(lower, i, y0), at(lower, i + 1, y0)])
    }
  }
  return orientConvex(tris)
}

export function loft(
  lower: readonly Vec2[],
  y0: number,
  upper: readonly Vec2[],
  y1: number,
  style: PartStyle,
  options?: LoftOptions,
): Part {
  return part(loftTris(lower, y0, upper, y1, options), style)
}

const rect = (cx: number, cz: number, width: number, depth: number): Vec2[] => [
  [cx - width / 2, cz - depth / 2],
  [cx + width / 2, cz - depth / 2],
  [cx + width / 2, cz + depth / 2],
  [cx - width / 2, cz + depth / 2],
]

/** An axis-aligned box from `min` to `max` (x, y, z). */
export function box(min: Vec3, max: Vec3, style: PartStyle, options?: LoftOptions): Part {
  const ring = rect((min[0] + max[0]) / 2, (min[2] + max[2]) / 2, max[0] - min[0], max[2] - min[2])
  return loft(ring, min[1], ring, max[1], style, options)
}

/** A box whose top is a smaller (or larger) rectangle on the same centre: setbacks, spires. */
export function taperedBox(
  centre: Vec2,
  y0: number,
  y1: number,
  lowerSize: Vec2,
  upperSize: Vec2,
  style: PartStyle,
  options?: LoftOptions,
): Part {
  return loft(
    rect(centre[0], centre[1], lowerSize[0], lowerSize[1]),
    y0,
    rect(centre[0], centre[1], upperSize[0], upperSize[1]),
    y1,
    style,
    options,
  )
}

/** A vertical prism over a convex footprint. */
export function prism(
  footprint: readonly Vec2[],
  y0: number,
  y1: number,
  style: PartStyle,
  options?: LoftOptions,
): Part {
  return loft(footprint, y0, footprint, y1, style, options)
}

/** A regular polygon on the ground plane, starting on the +x axis. */
export function ngon(centre: Vec2, radius: number, sides: number): Vec2[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (2 * Math.PI * i) / sides
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)] as const
  })
}

/** A low-poly vertical cylinder (a regular prism). */
export function cylinder(
  centre: Vec2,
  radius: number,
  y0: number,
  y1: number,
  sides: number,
  style: PartStyle,
  options?: LoftOptions,
): Part {
  const ring = ngon(centre, radius, sides)
  return loft(ring, y0, ring, y1, style, options)
}

/** A low-poly dome: `rings` bands of a quarter ellipse closing to an apex. */
export function dome(
  centre: Vec2,
  radius: number,
  y0: number,
  height: number,
  sides: number,
  rings: number,
  style: PartStyle,
): Part {
  const tris: Tri[] = []
  for (let k = 0; k < rings; k++) {
    const a0 = (Math.PI / 2) * (k / rings)
    const a1 = (Math.PI / 2) * ((k + 1) / rings)
    tris.push(
      ...loftTris(
        ngon(centre, radius * Math.cos(a0), sides),
        y0 + height * Math.sin(a0),
        ngon(centre, radius * Math.cos(a1), sides),
        y0 + height * Math.sin(a1),
        { top: false },
      ),
    )
  }
  // Each band is oriented on its own centroid; the dome as a whole is convex, so re-orient.
  return part(orientConvex(tris), style)
}

/**
 * A gable or pediment: a triangular prism whose ridge runs along x (across the front) or z,
 * standing on y0 over the rectangle x0..x1, z0..z1.
 */
export function gable(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y0: number,
  height: number,
  ridge: 'x' | 'z',
  style: PartStyle,
): Part {
  const top = y0 + height
  const tris: Tri[] =
    ridge === 'x'
      ? [
          ...quad([x0, y0, z0], [x1, y0, z0], [x1, top, (z0 + z1) / 2], [x0, top, (z0 + z1) / 2]),
          ...quad([x1, y0, z1], [x0, y0, z1], [x0, top, (z0 + z1) / 2], [x1, top, (z0 + z1) / 2]),
          [
            [x0, y0, z0],
            [x0, top, (z0 + z1) / 2],
            [x0, y0, z1],
          ],
          [
            [x1, y0, z0],
            [x1, y0, z1],
            [x1, top, (z0 + z1) / 2],
          ],
        ]
      : [
          ...quad([x0, y0, z0], [(x0 + x1) / 2, top, z0], [(x0 + x1) / 2, top, z1], [x0, y0, z1]),
          ...quad([x1, y0, z0], [x1, y0, z1], [(x0 + x1) / 2, top, z1], [(x0 + x1) / 2, top, z0]),
          [
            [x0, y0, z0],
            [x1, y0, z0],
            [(x0 + x1) / 2, top, z0],
          ],
          [
            [x0, y0, z1],
            [(x0 + x1) / 2, top, z1],
            [x1, y0, z1],
          ],
        ]
  return part(orientConvex(tris), style)
}

/**
 * A box between two points with a rectangular section (`width` horizontal, `height` in the
 * vertical plane through the segment): decks, beams, truss members and cables. No end caps
 * unless asked: members meet other members or the ground.
 */
export function beam(
  from: Vec3,
  to: Vec3,
  width: number,
  height: number,
  style: PartStyle,
  options: { caps?: boolean } = {},
): Part {
  return part(beamTris(from, to, width, height, options.caps ?? false), style)
}

function beamTris(from: Vec3, to: Vec3, width: number, height: number, caps: boolean): Tri[] {
  const axis = sub(to, from)
  const side = normalize(
    Math.abs(axis[0]) + Math.abs(axis[2]) < 1e-9 ? [1, 0, 0] : cross(axis, [0, 1, 0]),
  )
  const up = normalize(cross(side, axis))
  const corner = (origin: Vec3, s: number, u: number): Vec3 =>
    add(origin, add(scale(side, (s * width) / 2), scale(up, (u * height) / 2)))
  const ring = (origin: Vec3) => [
    corner(origin, -1, -1),
    corner(origin, 1, -1),
    corner(origin, 1, 1),
    corner(origin, -1, 1),
  ]
  const a = ring(from)
  const b = ring(to)
  const tris: Tri[] = []
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    tris.push(...quad(a[i] as Vec3, a[j] as Vec3, b[j] as Vec3, b[i] as Vec3))
  }
  if (caps) {
    tris.push(...quad(a[0] as Vec3, a[1] as Vec3, a[2] as Vec3, a[3] as Vec3))
    tris.push(...quad(b[0] as Vec3, b[1] as Vec3, b[2] as Vec3, b[3] as Vec3))
  }
  return orientConvex(tris)
}

/** A cable (or chord) through `points`: one square-section beam per pair. Never outlined. */
export function cable(points: readonly Vec3[], thickness: number, role: LandmarkRole): Part {
  const tris: Tri[] = []
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    if (from === undefined || to === undefined) continue
    tris.push(...beamTris(from, to, thickness, thickness, false))
  }
  return part(tris, { role, outline: false })
}

/**
 * Points along a hanging cable from `from` to `to` that dips `sag` metres below the straight
 * line at mid-span. A parabola, which matches a suspension cable (uniform load per horizontal
 * metre) and a catenary closely at these sag ratios.
 */
export function sampleCatenary(from: Vec3, to: Vec3, sag: number, segments: number): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments
    const straight = add(from, scale(sub(to, from), t))
    return [straight[0], straight[1] - 4 * sag * t * (1 - t), straight[2]] as const
  })
}

// ---- composites ---------------------------------------------------------------------------

/**
 * Arch openings in a wall, as a frame of boxes (no CSG): `count` openings side by side across
 * x0..x1, with a jamb between and beside them, a lintel over each and two corner haunches that
 * round its top. The wall plane is z0..z1 (its depth); openings run from y0 to y1.
 */
export function arcade(
  x0: number,
  x1: number,
  count: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  jamb: number,
  lintel: number,
  style: PartStyle,
): Part {
  const opening = (x1 - x0 - (count + 1) * jamb) / count
  if (opening <= 0) throw new Error('arcade: the jambs leave no room for an opening')
  const haunch = Math.min(opening / 4, (y1 - y0) / 4)
  const parts: Part[] = []
  for (let i = 0; i <= count; i++) {
    const left = x0 + i * (opening + jamb)
    parts.push(box([left, y0, z0], [left + jamb, y1 + lintel, z1], style))
  }
  for (let i = 0; i < count; i++) {
    const left = x0 + jamb + i * (opening + jamb)
    const right = left + opening
    parts.push(box([left, y1, z0], [right, y1 + lintel, z1], style))
    parts.push(box([left, y1 - haunch, z0], [left + haunch, y1, z1], style))
    parts.push(box([right - haunch, y1 - haunch, z0], [right, y1, z1], style))
  }
  return mergeParts(parts, style)
}

export interface SetbackTier {
  readonly heightM: number
  readonly insetM: number
}

/** The boxes of a setback stack: each tier inset from the one below, bottom to top. */
export function setbackBoxes(
  centre: Vec2,
  width: number,
  depth: number,
  y0: number,
  tiers: readonly SetbackTier[],
): { min: Vec3; max: Vec3 }[] {
  let w = width
  let d = depth
  let y = y0
  return tiers.map((tier) => {
    w -= 2 * tier.insetM
    d -= 2 * tier.insetM
    const min: Vec3 = [centre[0] - w / 2, y, centre[1] - d / 2]
    const max: Vec3 = [centre[0] + w / 2, y + tier.heightM, centre[1] + d / 2]
    y += tier.heightM
    return { min, max }
  })
}

/** A setback stack as one part. */
export function setbackStack(
  centre: Vec2,
  width: number,
  depth: number,
  y0: number,
  tiers: readonly SetbackTier[],
  style: PartStyle,
): Part {
  return mergeParts(
    setbackBoxes(centre, width, depth, y0, tiers).map(({ min, max }) => box(min, max, style)),
    style,
  )
}

/**
 * A grid of lit window panes on a wall: `rows` × `cols` cells over the rectangle from `origin`
 * along `right` (unit) for `width` and along `up` (unit) for `height`, each pane `fill` of its
 * cell, lifted off the wall along `normal` (unit, outward) so it never z-fights. Group windows.
 */
export function windowGrid(options: {
  readonly origin: Vec3
  readonly right: Vec3
  readonly up: Vec3
  readonly normal: Vec3
  readonly width: number
  readonly height: number
  readonly rows: number
  readonly cols: number
  readonly fill?: number
  readonly liftM?: number
}): Part {
  const { origin, right, up, normal, width, height, rows, cols } = options
  const fill = options.fill ?? 0.55
  const lifted = add(origin, scale(normal, options.liftM ?? 0.3))
  const cellW = width / cols
  const cellH = height / rows
  const tris: Tri[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u0 = (c + (1 - fill) / 2) * cellW
      const v0 = (r + (1 - fill) / 2) * cellH
      const at = (u: number, v: number) => add(lifted, add(scale(right, u), scale(up, v)))
      const a = at(u0, v0)
      const b = at(u0 + fill * cellW, v0)
      const cc = at(u0 + fill * cellW, v0 + fill * cellH)
      const d = at(u0, v0 + fill * cellH)
      // Single-sided panes: wind them to face `normal`.
      const facing = dot(cross(sub(b, a), sub(cc, a)), normal) > 0
      tris.push(...(facing ? quad(a, b, cc, d) : quad(a, d, cc, b)))
    }
  }
  return part(tris, { role: 'window', outline: false }, 'windows')
}

/** Windows on one face of an axis-aligned box, facing ±x or ±z. */
export function boxFaceWindows(
  min: Vec3,
  max: Vec3,
  face: '-z' | '+z' | '-x' | '+x',
  rows: number,
  cols: number,
  margins: { readonly bottomM?: number; readonly topM?: number } = {},
): Part {
  const y0 = min[1] + (margins.bottomM ?? 0)
  const height = max[1] - (margins.topM ?? 0) - y0
  switch (face) {
    case '-z':
      return windowGrid({
        origin: [min[0], y0, min[2]],
        right: [1, 0, 0],
        up: [0, 1, 0],
        normal: [0, 0, -1],
        width: max[0] - min[0],
        height,
        rows,
        cols,
      })
    case '+z':
      return windowGrid({
        origin: [max[0], y0, max[2]],
        right: [-1, 0, 0],
        up: [0, 1, 0],
        normal: [0, 0, 1],
        width: max[0] - min[0],
        height,
        rows,
        cols,
      })
    case '-x':
      return windowGrid({
        origin: [min[0], y0, max[2]],
        right: [0, 0, -1],
        up: [0, 1, 0],
        normal: [-1, 0, 0],
        width: max[2] - min[2],
        height,
        rows,
        cols,
      })
    case '+x':
      return windowGrid({
        origin: [max[0], y0, min[2]],
        right: [0, 0, 1],
        up: [0, 1, 0],
        normal: [1, 0, 0],
        width: max[2] - min[2],
        height,
        rows,
        cols,
      })
  }
}

/**
 * Windows on a vertical wall standing on the ground segment a→b (any direction), from y0 to
 * y1, facing away from `inside` (a point within the building's footprint).
 */
export function wallWindows(
  a: Vec2,
  b: Vec2,
  y0: number,
  y1: number,
  rows: number,
  cols: number,
  inside: Vec2,
): Part {
  const along: Vec3 = normalize([b[0] - a[0], 0, b[1] - a[1]])
  let normal: Vec3 = [along[2], 0, -along[0]]
  const mid: Vec3 = [(a[0] + b[0]) / 2 - inside[0], 0, (a[1] + b[1]) / 2 - inside[1]]
  if (dot(normal, mid) < 0) normal = scale(normal, -1)
  return windowGrid({
    origin: [a[0], y0, a[1]],
    right: along,
    up: [0, 1, 0],
    normal,
    width: Math.hypot(b[0] - a[0], b[1] - a[1]),
    height: y1 - y0,
    rows,
    cols,
  })
}
