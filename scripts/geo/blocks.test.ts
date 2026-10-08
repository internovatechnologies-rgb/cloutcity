/** Procedural blocks (S04d) on the synthetic fixture, plus the CD → zone mapping on real zones. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUALITY_TIERS, type QualityTier } from '../../src/lib/data/schemas/config'
import {
  BlocksFileSchema,
  ZonesFileSchema,
  type BlocksFile,
} from '../../src/lib/data/schemas/world'
import { decodePath, decodeRing } from '../../src/lib/geo/codec'
import { pointInPolygon } from '../../src/lib/geo/polygon'
import { distanceM, project } from '../../src/lib/geo/projection'
import { EXPECTED_COUNTS } from './build'
import { BLOCK_TRIANGLES, cdToCdta, fillChance, readDensity } from './blocks'
import { FIXTURE_DENSITY, FIXTURE_DISTRICT } from './fixtures/buildings'
import { FIXTURE_PARAMS, fixtureInputs } from './fixtures/synthetic'
import { insideAnyExclusion, readLandmarkExclusions } from './landmark-exclusions'
import { OUTPUT_FILES, blocksFilePath, buildGeoOutputs, type GeoBuildResult } from './transform'

const ROOT = join(import.meta.dirname, '../..')

const blocksOf = (result: GeoBuildResult, tier: QualityTier): BlocksFile =>
  BlocksFileSchema.parse(JSON.parse(result.files.get(blocksFilePath(tier)) ?? 'null'))

const countOf = (file: BlocksFile) => file.groups.reduce((sum, g) => sum + g.h.length, 0)

/** FIXTURE_DENSITY with every FAR multiplied by `factor`. */
const scaledDensity = (factor: number) => ({
  features: FIXTURE_DENSITY.features.map((f) => ({
    attributes: { ...f.attributes, bldgArea: f.attributes.bldgArea * factor },
  })),
})

describe('MapPLUTO community districts', () => {
  it('maps CD codes to CDTA codes', () => {
    expect(cdToCdta(101)).toBe('MN01')
    expect(cdToCdta(212)).toBe('BX12')
    expect(cdToCdta(318)).toBe('BK18')
    expect(cdToCdta(414)).toBe('QN14')
    expect(cdToCdta(503)).toBe('SI03')
    expect(cdToCdta(164)).toBe('MN64')
    expect(cdToCdta(600)).toBeUndefined()
    expect(cdToCdta(400)).toBeUndefined()
  })

  it('every district-kind zone has a CD that maps to it', () => {
    const zones = ZonesFileSchema.parse(
      JSON.parse(readFileSync(join(ROOT, 'data', OUTPUT_FILES.zones), 'utf8')),
    ).zones.filter((zone) => zone.kind === 'district')
    expect(zones).toHaveLength(EXPECTED_COUNTS.communityDistricts)
    const boroughDigit = { MN: 1, BX: 2, BK: 3, QN: 4, SI: 5 } as const
    for (const zone of zones) {
      const digit = boroughDigit[zone.cdtaCode.slice(0, 2) as keyof typeof boroughDigit]
      expect(cdToCdta(digit * 100 + Number(zone.cdtaCode.slice(2))), zone.id).toBe(zone.cdtaCode)
    }
  })

  const cached = join(ROOT, '.cache/geo/dcp-mappluto-density.json')
  it.skipIf(!existsSync(cached))('the cached statistics cover exactly the district zones', () => {
    const density = readDensity(
      JSON.parse(readFileSync(cached, 'utf8')),
      EXPECTED_COUNTS.communityDistricts,
    )
    const zones = ZonesFileSchema.parse(
      JSON.parse(readFileSync(join(ROOT, 'data', OUTPUT_FILES.zones), 'utf8')),
    ).zones
    expect([...density.keys()].sort()).toEqual(
      zones
        .filter((z) => z.kind === 'district')
        .map((z) => z.id)
        .sort(),
    )
  })

  it('reads FAR and floors per zone, skipping the null district, and checks the count', () => {
    const density = readDensity(FIXTURE_DENSITY, 2)
    expect(Object.fromEntries(density)).toEqual({
      bk01: { far: 1.5, avgFloors: 3 },
      qn01: { far: 3, avgFloors: 6 },
    })
    expect(() => readDensity(FIXTURE_DENSITY, 3)).toThrow(/expected 3 community districts, got 2/)
    expect(() => readDensity({ error: { code: 400 } }, 2)).toThrow(/Invalid MapPLUTO density/)
  })
})

describe('fill chance', () => {
  it('rises with FAR and saturates at fullFar', () => {
    const fars = [0, 0.2, 0.5, 1, 1.5, 2.9, 3, 5, 12]
    const chances = fars.map((far) => fillChance(far, 3))
    expect(chances).toEqual([...chances].sort((a, b) => a - b))
    expect(chances[0]).toBe(0)
    expect(chances.at(-1)).toBe(1)
    expect(fillChance(3, 3)).toBe(1)
  })
})

describe('blocks on the fixture', () => {
  const result = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
  const land = JSON.parse(result.files.get(OUTPUT_FILES.land) ?? 'null') as {
    boroughs: { id: string; polygons: number[][][] }[]
  }
  const parks = JSON.parse(result.files.get(OUTPUT_FILES.parks) ?? 'null') as {
    parks: { polygons: number[][][] }[]
  }
  const shapes = JSON.parse(result.files.get(OUTPUT_FILES.zoneShapes) ?? 'null') as {
    zones: { id: string; polygons: number[][][] }[]
  }
  const inside = (point: { x: number; y: number }, polygons: number[][][]) =>
    polygons.some((polygon) => pointInPolygon(point, polygon.map(decodeRing)))

  it('places blocks on every tier, each file valid and seeded deterministically', () => {
    const again = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
    for (const tier of QUALITY_TIERS) {
      const file = blocksOf(result, tier)
      expect(countOf(file)).toBeGreaterThan(0)
      expect(file.sizeM).toBe(
        Math.round(
          FIXTURE_PARAMS.config.blocks.spacingM[tier] *
            FIXTURE_PARAMS.config.blocks.footprintFraction,
        ),
      )
      expect(again.files.get(blocksFilePath(tier))).toBe(result.files.get(blocksFilePath(tier)))
      const stat = result.blockStats.find((s) => s.tier === tier)
      expect(stat).toMatchObject({
        instances: countOf(file),
        triangles: countOf(file) * BLOCK_TRIANGLES,
      })
    }
  })

  it('more blocks on denser tiers', () => {
    const [low, mid, high] = QUALITY_TIERS.map((tier) => countOf(blocksOf(result, tier)))
    expect(low).toBeLessThanOrEqual(mid ?? 0)
    expect(mid).toBeLessThanOrEqual(high ?? 0)
  })

  it('keeps blocks on land, out of the district circle and out of parks', () => {
    const centre = project(FIXTURE_DISTRICT.center)
    for (const tier of QUALITY_TIERS) {
      for (const group of blocksOf(result, tier).groups) {
        const borough = land.boroughs.find((b) => b.id === group.borough)
        for (const point of decodePath(group.p)) {
          expect(inside(point, borough?.polygons ?? [])).toBe(true)
          expect(distanceM(point, centre)).toBeGreaterThan(FIXTURE_DISTRICT.radiusM)
          for (const park of parks.parks) expect(inside(point, park.polygons)).toBe(false)
          const zone = shapes.zones.find((z) => inside(point, z.polygons))
          expect(['qn01', 'bk01']).toContain(zone?.id)
        }
      }
    }
  })

  it('keeps every block clear of the landmark exclusion rectangles (INT-7)', () => {
    const rects = readLandmarkExclusions(
      JSON.parse(result.files.get(OUTPUT_FILES.landmarkFrames) ?? 'null'),
    )
    expect(rects.length).toBeGreaterThan(0)
    for (const tier of QUALITY_TIERS) {
      const file = blocksOf(result, tier)
      const reach = (file.sizeM * Math.SQRT2) / 2
      const grown = rects.map((rect) => ({
        ...rect,
        halfLengthM: rect.halfLengthM + reach,
        halfWidthM: rect.halfWidthM + reach,
      }))
      for (const group of file.groups) {
        for (const point of decodePath(group.p)) {
          expect(insideAnyExclusion(point, grown)).toBe(false)
        }
      }
    }
  })

  it('heights follow the zone’s average floors within the jitter', () => {
    const { floorM, heightJitter } = FIXTURE_PARAMS.config.blocks
    for (const group of blocksOf(result, 'high').groups) {
      const floors = group.borough === 'queens' ? 6 : 3
      for (const h of group.h) {
        expect(h).toBeGreaterThanOrEqual(
          Math.round(Math.max(1, Math.round(floors * (1 - heightJitter))) * floorM),
        )
        expect(h).toBeLessThanOrEqual(Math.round(Math.round(floors * (1 + heightJitter)) * floorM))
      }
    }
  })

  it('FAR monotonicity: more floor area never means fewer blocks; none at FAR 0', () => {
    const counts = [0, 0.25, 0.5, 1, 2, 4].map((factor) => {
      const built = buildGeoOutputs(
        { ...fixtureInputs(), density: scaledDensity(factor) },
        FIXTURE_PARAMS,
      )
      return QUALITY_TIERS.map((tier) => countOf(blocksOf(built, tier)))
    })
    for (let i = 1; i < counts.length; i++) {
      QUALITY_TIERS.forEach((_, t) => {
        expect(counts[i]?.[t]).toBeGreaterThanOrEqual(counts[i - 1]?.[t] ?? 0)
      })
    }
    expect(counts[0]).toEqual([0, 0, 0])
  })

  it('a different seed moves the blocks', () => {
    const params = {
      ...FIXTURE_PARAMS,
      config: { ...FIXTURE_PARAMS.config, blocks: { ...FIXTURE_PARAMS.config.blocks, seed: 8 } },
    }
    const reseeded = buildGeoOutputs(fixtureInputs(), params)
    expect(reseeded.files.get(blocksFilePath('high'))).not.toBe(
      result.files.get(blocksFilePath('high')),
    )
  })

  it('fails the build when a tier exceeds blocks.maxInstances', () => {
    const params = {
      ...FIXTURE_PARAMS,
      config: {
        ...FIXTURE_PARAMS.config,
        blocks: { ...FIXTURE_PARAMS.config.blocks, maxInstances: { low: 1, mid: 200, high: 400 } },
      },
    }
    expect(() => buildGeoOutputs(fixtureInputs(), params)).toThrow(
      /exceed blocks\.maxInstances\.low/,
    )
  })
})
