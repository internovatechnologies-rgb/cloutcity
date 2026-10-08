import { Box3 } from 'three'
import { describe, expect, it } from 'vitest'
import { perf } from '@/lib/data/config'
import {
  ARCHETYPE_CATEGORY,
  type Archetype,
  type LandmarkModel,
} from '@/lib/data/schemas/landmarkModels'
import { modelHalfExtents, modelTopM } from '@/lib/landmarks/metrics'
import { buildLandmark, disposeLandmark, TIER_LEVELS, type BuiltLandmark } from './buildLandmark'
import { triangleCount } from './kit/compose'
import { LAND_TOP_Y, MODELS, PALETTE, SETTINGS, frameOf } from './kit.fixture'

const TIERS = ['low', 'mid', 'high'] as const

const build = (model: LandmarkModel, tier: (typeof TIERS)[number], settings = SETTINGS) =>
  buildLandmark(model, frameOf(model.id), tier, PALETTE, settings)

const modelOf = (id: string) => {
  const model = MODELS.find((m) => m.id === id)
  if (model === undefined) throw new Error(`no model ${id}`)
  return model
}

function capFor(model: LandmarkModel, tier: (typeof TIERS)[number]): number {
  const override = perf.landmarkTrianglesOverride[model.id]
  return override?.[tier] ?? perf.landmarkTrianglesMax[ARCHETYPE_CATEGORY[model.archetype]][tier]
}

function boundsOf(built: BuiltLandmark, level = 0): Box3 {
  const meshes = built.levels[level]
  if (meshes === undefined) throw new Error('no such level')
  meshes.body.computeBoundingBox()
  return meshes.body.boundingBox ?? new Box3()
}

describe('triangle budget matrix (perf.json landmarkTrianglesMax)', () => {
  const cases = MODELS.flatMap((model) => TIERS.map((tier) => [model.id, tier] as const))

  it.each(cases)(
    '%s on %s: finest level within the cap, each coarser at most the ratio',
    (id, tier) => {
      const model = modelOf(id)
      const built = build(model, tier)
      const [finest, ...coarser] = built.triangles
      expect(finest).toBeLessThanOrEqual(capFor(model, tier))
      let above = finest ?? 0
      for (const triangles of coarser) {
        expect(triangles).toBeLessThanOrEqual(perf.landmarkLodRatioMax * above)
        above = triangles
      }
      disposeLandmark(built)
    },
  )

  it('counts every mesh of a level: body, windows and outline', () => {
    const built = build(modelOf('deco-spire'), 'mid')
    const level = built.levels[0]
    expect(level?.windows).toBeDefined()
    expect(level?.outline).toBeDefined()
    expect(built.triangles[0]).toBe(
      triangleCount(level?.body) + triangleCount(level?.windows) + triangleCount(level?.outline),
    )
  })
})

describe('buildLandmark', () => {
  it.each(TIERS)('%s: at most three meshes per level, finest first', (tier) => {
    for (const model of MODELS) {
      const built = build(model, tier)
      expect(built.id).toBe(model.id)
      expect(built.levels.map((l) => l.level)).toEqual(TIER_LEVELS[tier])
      expect(built.triangles).toHaveLength(built.levels.length)
      expect(built.effects).toEqual([])
      for (const level of built.levels) {
        const meshes = [level.body, level.windows, level.outline].filter(Boolean)
        expect(meshes.length).toBeGreaterThanOrEqual(1)
        expect(meshes.length).toBeLessThanOrEqual(3)
      }
      expect(['body', 'windows', 'outline']).toEqual(
        expect.arrayContaining([...built.materialsUsed]),
      )
      expect(built.materialsUsed[0]).toBe('body')
    }
  })

  it('low tier starts at L1 with no outline and no windows', () => {
    for (const model of MODELS) {
      const built = build(model, 'low')
      expect(built.levels[0]?.level).toBe(1)
      for (const level of built.levels) {
        expect(level.outline).toBeUndefined()
        expect(level.windows).toBeUndefined()
      }
      expect(built.materialsUsed).toEqual(['body'])
    }
  })

  it('mid and high put the outline and lit windows on the finest level only', () => {
    const built = build(modelOf('city-hall'), 'high')
    expect(built.levels[0]?.outline).toBeDefined()
    expect(built.levels[0]?.windows).toBeDefined()
    for (const level of built.levels.slice(1)) {
      expect(level.outline).toBeUndefined()
      expect(level.windows).toBeUndefined()
    }
    expect(built.materialsUsed).toEqual(['body', 'windows', 'outline'])
  })

  it('honours the per-tier outline and window flags', () => {
    const plain = {
      ...SETTINGS,
      outline: { ...SETTINGS.outline, mid: false },
      windows: { ...SETTINGS.windows, mid: false },
    }
    const built = build(modelOf('city-hall'), 'mid', plain)
    expect(built.levels[0]?.outline).toBeUndefined()
    expect(built.levels[0]?.windows).toBeUndefined()
  })

  it('is deterministic: two builds are identical vertex for vertex', () => {
    for (const model of MODELS) {
      const a = build(model, 'high')
      const b = build(model, 'high')
      a.levels.forEach((level, i) => {
        const other = b.levels[i]
        expect(Array.from(level.body.getAttribute('position').array)).toEqual(
          Array.from(other?.body.getAttribute('position').array ?? []),
        )
        expect(Array.from(level.body.getAttribute('color').array)).toEqual(
          Array.from(other?.body.getAttribute('color').array ?? []),
        )
      })
    }
  })

  it('rejects a frame for another landmark and a bridge without a span', () => {
    const model = modelOf('city-hall')
    expect(() => buildLandmark(model, frameOf('deco-spire'), 'mid', PALETTE, SETTINGS)).toThrow(
      /frame deco-spire for city-hall/,
    )
    const bridge = modelOf('brooklyn-bridge')
    const noSpan = { ...frameOf('brooklyn-bridge'), spanM: undefined, ends: undefined }
    expect(() => buildLandmark(bridge, noSpan, 'mid', PALETTE, SETTINGS)).toThrow(/no span/)
  })
})

describe('placement and height', () => {
  it('rotates by -headingDeg about y: the front (-z) points along the heading', () => {
    // queens-borough-hall's portico is its front: at heading 0 it reaches further toward -z.
    const model = modelOf('queens-borough-hall')
    const frame = frameOf(model.id)
    const north = buildLandmark(model, { ...frame, headingDeg: 0 }, 'mid', PALETTE, SETTINGS)
    const unturned = boundsOf(north, 1)
    expect(-unturned.min.z).toBeGreaterThan(unturned.max.z + 3)
    const base = north.levels[1]?.body.getAttribute('position')
    for (const headingDeg of [90, frame.headingDeg]) {
      const turned = buildLandmark(model, { ...frame, headingDeg }, 'mid', PALETTE, SETTINGS)
      const position = turned.levels[1]?.body.getAttribute('position')
      const rad = (headingDeg * Math.PI) / 180
      // A model point (x, z) lands at east = x cos + (-z) sin, north = -x sin + (-z) cos.
      for (let i = 0; i < (base?.count ?? 0); i += 7) {
        const x = base?.getX(i) ?? 0
        const z = base?.getZ(i) ?? 0
        const east = x * Math.cos(rad) - z * Math.sin(rad)
        const northM = -x * Math.sin(rad) - z * Math.cos(rad)
        expect(position?.getX(i)).toBeCloseTo(east, 3)
        expect(-(position?.getZ(i) ?? 0)).toBeCloseTo(northM, 3)
      }
    }
  })

  it('a heading of 90° turns model -z to scene +x (east)', () => {
    const model = modelOf('wedge-building')
    const built = buildLandmark(
      model,
      { ...frameOf(model.id), headingDeg: 90 },
      'mid',
      PALETTE,
      SETTINGS,
    )
    const bounds = boundsOf(built, 2)
    // The wedge is long (58 m) along its heading and 26 m across it.
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(58, 3)
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(26, 3)
  })

  it.each(MODELS.map((m) => [m.id, m] as const))(
    '%s: its top is pinLiftM above its base, and its footprint fits the exclusion rectangle',
    (_id, model) => {
      const frame = frameOf(model.id)
      const built = build(model, 'high')
      const bounds = boundsOf(built, 0)
      const baseY = frame.base === 'water' ? 0 : LAND_TOP_Y
      expect(bounds.max.y - baseY).toBeCloseTo(frame.pinLiftM, 1)
      expect(modelTopM(model)).toBeCloseTo(frame.pinLiftM, 1)
      // Every body vertex, turned back into model axes, lies inside the exclusion rectangle.
      const position = built.levels[0]?.body.getAttribute('position')
      const rad = ((90 - frame.exclusion.angleDeg) * Math.PI) / 180
      let maxAlong = 0
      let maxAcross = 0
      for (let i = 0; i < (position?.count ?? 0); i++) {
        const east = position?.getX(i) ?? 0
        const north = -(position?.getZ(i) ?? 0)
        maxAlong = Math.max(maxAlong, Math.abs(east * Math.sin(rad) + north * Math.cos(rad)))
        maxAcross = Math.max(maxAcross, Math.abs(east * Math.cos(rad) - north * Math.sin(rad)))
      }
      expect(maxAlong).toBeLessThanOrEqual(frame.exclusion.halfLengthM)
      expect(maxAcross).toBeLessThanOrEqual(frame.exclusion.halfWidthM)
      const { halfWidthM } = modelHalfExtents(model, frame.spanM ?? 0)
      expect(frame.exclusion.halfWidthM).toBeGreaterThanOrEqual(halfWidthM)
      expect([frame.exclusion.x, frame.exclusion.y]).toEqual([frame.anchor.x, frame.anchor.y])
    },
  )

  it('buildings stand on the land top; bridge piers on the water and decks meet the land', () => {
    for (const model of MODELS) {
      const frame = frameOf(model.id)
      const bounds = boundsOf(build(model, 'mid'), 0)
      expect(bounds.min.y).toBeCloseTo(frame.base === 'water' ? 0 : LAND_TOP_Y, 3)
    }
    const bridge = modelOf('brooklyn-bridge')
    const frame = frameOf(bridge.id)
    const body = build(bridge, 'mid').levels[0]?.body
    const position = body?.getAttribute('position')
    // At the very ends of the span, the deck top sits at the land top.
    const half = (frame.spanM ?? 0) / 2
    let endTop = -Infinity
    for (let i = 0; i < (position?.count ?? 0); i++) {
      const x = position?.getX(i) ?? 0
      const z = position?.getZ(i) ?? 0
      if (Math.abs(Math.hypot(x, z) - half) < 1) endTop = Math.max(endTop, position?.getY(i) ?? 0)
    }
    expect(endTop).toBeGreaterThanOrEqual(LAND_TOP_Y - 0.01)
    expect(endTop).toBeLessThanOrEqual(LAND_TOP_Y + 3)
  })

  it('heightScale stretches heights about the base', () => {
    const model = modelOf('deco-spire')
    const built = build(model, 'mid', { ...SETTINGS, heightScale: 1.5 })
    const bounds = boundsOf(built, 0)
    expect(bounds.max.y - LAND_TOP_Y).toBeCloseTo(1.5 * modelTopM(model), 1)
    expect(bounds.min.y).toBeCloseTo(LAND_TOP_Y, 3)
  })
})

describe('triangle-count snapshot per archetype (update only on purpose)', () => {
  const firstOf = (archetype: Archetype) => {
    const model = MODELS.find((m) => m.archetype === archetype)
    if (model === undefined) throw new Error(`no ${archetype} model`)
    return model
  }

  it('matches the recorded counts per tier and level', () => {
    const counts = Object.fromEntries(
      (
        [
          'civicHall',
          'stationConcourse',
          'setbackSpire',
          'terminalHall',
          'wedgeTower',
          'suspensionBridge',
          'cantileverBridge',
        ] as const
      ).map((archetype) => {
        const model = firstOf(archetype)
        return [
          `${archetype}:${model.id}`,
          Object.fromEntries(TIERS.map((tier) => [tier, build(model, tier).triangles])),
        ]
      }),
    )
    expect(counts).toEqual({
      'civicHall:city-hall': { low: [88, 30], mid: [520, 88, 30], high: [520, 88, 30] },
      'stationConcourse:penn-station': {
        low: [140, 30],
        mid: [480, 140, 30],
        high: [480, 140, 30],
      },
      'setbackSpire:deco-spire': { low: [50, 20], mid: [1140, 50, 20], high: [1140, 50, 20] },
      'terminalHall:midtown-terminal': { low: [56, 20], mid: [500, 56, 20], high: [500, 56, 20] },
      'wedgeTower:wedge-building': { low: [20, 10], mid: [400, 20, 10], high: [400, 20, 10] },
      'suspensionBridge:brooklyn-bridge': {
        low: [288, 44],
        mid: [1536, 288, 44],
        high: [1536, 288, 44],
      },
      'cantileverBridge:queensboro-bridge': {
        low: [312, 48],
        mid: [1536, 312, 48],
        high: [1536, 312, 48],
      },
    })
  })
})
