/** District building masses (S04d) on the synthetic fixture: no network, no real data. */
import { describe, expect, it } from 'vitest'
import { QUALITY_TIERS, type QualityTier } from '../../src/lib/data/schemas/config'
import { BuildingsFileSchema, type BuildingsFile } from '../../src/lib/data/schemas/world'
import { decodeRing } from '../../src/lib/geo/codec'
import { distanceToPolyline, polygonArea, signedArea } from '../../src/lib/geo/polygon'
import { project, type LocalPoint } from '../../src/lib/geo/projection'
import { binHeight, heightMetres, massTriangles, readDistrictFootprints } from './buildings'
import {
  FIXTURE_BUILDING_COUNT,
  FIXTURE_BUILDING_PAGES,
  FIXTURE_DISTRICT,
  FIXTURE_EXCLUSION,
  FIXTURE_FOOTPRINTS,
} from './fixtures/buildings'
import { FIXTURE_PARAMS, fixtureInputs } from './fixtures/synthetic'
import {
  insideAnyExclusion,
  readLandmarkExclusions,
  type LandmarkExclusion,
} from './landmark-exclusions'
import { OUTPUT_FILES, buildGeoOutputs, districtFilePath, type GeoBuildResult } from './transform'

const CENTRE = project(FIXTURE_DISTRICT.center)
const tiers = FIXTURE_PARAMS.config.buildingTiers

interface Mass {
  readonly h: number
  readonly rings: LocalPoint[][]
  readonly area: number
  /** Bounding box relative to the district centre, in metres. */
  readonly box: { minX: number; minY: number; maxX: number; maxY: number }
}

function masses(file: BuildingsFile): Mass[] {
  return file.r.map((polygon, index) => {
    const rings = polygon.map((ring) =>
      decodeRing(ring).map((p) => ({ x: p.x + file.origin.x, y: p.y + file.origin.y })),
    )
    const outer = rings[0] ?? []
    const xs = outer.map((p) => p.x - CENTRE.x)
    const ys = outer.map((p) => p.y - CENTRE.y)
    return {
      h: file.h[index] ?? 0,
      rings,
      area: polygonArea(rings),
      box: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
    }
  })
}

const fileOf = (result: GeoBuildResult, tier: QualityTier) =>
  BuildingsFileSchema.parse(
    JSON.parse(result.files.get(districtFilePath(FIXTURE_DISTRICT.id, tier)) ?? 'null'),
  )

/** The mass whose bounding box (relative to the centre) contains the given point. */
const massAt = (list: readonly Mass[], x: number, y: number) =>
  list.filter((m) => m.box.minX <= x && x <= m.box.maxX && m.box.minY <= y && y <= m.box.maxY)

const near = (a: number, b: number, slack = 1.5) => Math.abs(a - b) <= slack

describe('heights', () => {
  it('converts HEIGHT_ROOF feet to whole metres', () => {
    expect(heightMetres(100, 9)).toBe(30)
    expect(heightMetres(98, 9)).toBe(30)
    expect(heightMetres(40, 9)).toBe(12)
    expect(heightMetres(1, 9)).toBe(1)
    expect(heightMetres(1000.4, 9)).toBe(305)
  })

  it('uses the default for NULL, zero and negative heights', () => {
    expect(heightMetres(null, 9)).toBe(9)
    expect(heightMetres(0, 9)).toBe(9)
    expect(heightMetres(-3, 9)).toBe(9)
  })

  it('rounds into bins, never below one bin', () => {
    expect(binHeight(30, 6)).toBe(30)
    expect(binHeight(9, 6)).toBe(12)
    expect(binHeight(8, 6)).toBe(6)
    expect(binHeight(2, 6)).toBe(6)
    expect(binHeight(17, 1)).toBe(17)
  })

  it('counts roof plus wall triangles', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    expect(massTriangles([square])).toBe(2 + 8)
    // Earcut bridges the hole: 8 vertices + 2 per hole − 2 roof triangles, 16 wall triangles.
    expect(massTriangles([square, square])).toBe(8 + 16)
  })
})

describe('district buildings on the fixture', () => {
  const result = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
  const files = Object.fromEntries(
    QUALITY_TIERS.map((tier) => [tier, fileOf(result, tier)]),
  ) as Record<QualityTier, BuildingsFile>
  const byTier = Object.fromEntries(
    QUALITY_TIERS.map((tier) => [tier, masses(files[tier])]),
  ) as Record<QualityTier, Mass[]>

  it('stores rings relative to the rounded district centre', () => {
    for (const tier of QUALITY_TIERS) {
      expect(files[tier].origin).toEqual({ x: Math.round(CENTRE.x), y: Math.round(CENTRE.y) })
      expect(files[tier]).toMatchObject({
        district: 'midtown',
        tier,
        sources: ['oti-buildings-midtown'],
      })
    }
  })

  it('high keeps every footprint inside the circle as its own mass, with metre heights', () => {
    const high = byTier.high
    expect(high).toHaveLength(10)
    expect(massAt(high, 10, 7).map((m) => m.h)).toEqual([30])
    expect(massAt(high, 30, 7).map((m) => m.h)).toEqual([30])
    expect(massAt(high, 50, 7).map((m) => m.h)).toEqual([12])
    expect(massAt(high, 6, 46).map((m) => m.h)).toEqual([9]) // NULL → default
    expect(massAt(high, 110, 47).map((m) => m.h)).toEqual([9]) // 0 → default
    expect(massAt(high, 33, 43).map((m) => m.h)).toEqual([9]) // 30 ft
    expect(massAt(high, 70, 45).map((m) => m.h)).toEqual([5]) // 16 ft
  })

  it('drops footprints whose centroid is outside the circle', () => {
    for (const tier of QUALITY_TIERS) expect(massAt(byTier[tier], 410, 10)).toEqual([])
  })

  it('merges touching footprints of the same bin and keeps different bins apart', () => {
    for (const tier of ['low', 'mid'] as const) {
      const twins = massAt(byTier[tier], 10, 7).filter((m) => m.h === 30)
      expect(twins).toHaveLength(1)
      expect(twins[0]?.box.minX).toBeLessThanOrEqual(1)
      expect(twins[0]?.box.maxX).toBeGreaterThanOrEqual(39)
      expect(near(twins[0]?.area ?? 0, 600, 40)).toBe(true)
      expect(massAt(byTier[tier], 50, 7).map((m) => m.h)).toEqual([12])
    }
    // High never merges: the twins stay two masses.
    expect(byTier.high.filter((m) => m.h === 30)).toHaveLength(2)
  })

  it('applies each tier’s area and height filters', () => {
    // 144 m² with no height: under low's 150 m² (alone, so no merge saves it); kept on mid.
    expect(massAt(byTier.low, 6, 46)).toEqual([])
    expect(massAt(byTier.mid, 6, 46).map((m) => m.h)).toEqual([9])
    // 49 m²: high only.
    expect(massAt(byTier.mid, 33, 43)).toEqual([])
    expect(massAt(byTier.low, 33, 43)).toEqual([])
    // 5 m tall: under low's 8 m; mid rounds it into the 6 m bin.
    expect(massAt(byTier.low, 70, 45)).toEqual([])
    expect(massAt(byTier.mid, 70, 45).map((m) => m.h)).toEqual([6])
    expect(byTier.low).toHaveLength(6)
    expect(byTier.mid).toHaveLength(8)
  })

  it('keeps a courtyard as a clockwise hole inside a counter-clockwise outer ring', () => {
    for (const tier of QUALITY_TIERS) {
      const [courtyard] = massAt(byTier[tier], -195, 25)
      expect(courtyard?.rings).toHaveLength(2)
      expect(signedArea(courtyard?.rings[0] ?? [])).toBeGreaterThan(0)
      expect(signedArea(courtyard?.rings[1] ?? [])).toBeLessThan(0)
      expect(near(courtyard?.area ?? 0, 2500 - 400, 60)).toBe(true)
    }
  })

  it('simplifies within the tier tolerance (plus half a metre of grid snapping per axis)', () => {
    const exact = FIXTURE_FOOTPRINTS.wiggly.geometry.coordinates[0]
      ?.slice(0, -1)
      .map(([lng = 0, lat = 0]) => project({ lat, lng }))
    for (const tier of QUALITY_TIERS) {
      const [wiggly] = massAt(byTier[tier], 130, 15)
      const outer = wiggly?.rings[0] ?? []
      const closed = [...outer, outer[0] ?? { x: 0, y: 0 }]
      for (const vertex of exact ?? []) {
        const snapped = { x: Math.round(vertex.x), y: Math.round(vertex.y) }
        expect(distanceToPolyline(snapped, closed)).toBeLessThanOrEqual(tiers.tiers[tier].simplifyM)
        expect(distanceToPolyline(vertex, closed)).toBeLessThanOrEqual(
          tiers.tiers[tier].simplifyM + Math.SQRT1_2,
        )
      }
      // The 0.4 m and 0.8 m zig-zags are gone even at 1 m: a plain rectangle is left.
      expect(outer).toHaveLength(4)
    }
  })

  it('gets no bigger from low to mid to high: masses, triangles and bytes', () => {
    const stats = QUALITY_TIERS.map((tier) => {
      const stat = result.districtStats.find((s) => s.tier === tier)
      return {
        masses: byTier[tier].length,
        triangles: stat?.triangles ?? 0,
        bytes: result.files.get(districtFilePath(FIXTURE_DISTRICT.id, tier))?.length ?? 0,
      }
    })
    const [low, mid, high] = stats
    for (const key of ['masses', 'triangles', 'bytes'] as const) {
      expect(low?.[key]).toBeLessThanOrEqual(mid?.[key] ?? 0)
      expect(mid?.[key]).toBeLessThanOrEqual(high?.[key] ?? 0)
    }
    for (const tier of QUALITY_TIERS) {
      const stat = result.districtStats.find((s) => s.tier === tier)
      expect(stat?.triangles).toBe(
        byTier[tier].reduce((sum, mass) => sum + massTriangles(mass.rings), 0),
      )
      expect(stat?.downloaded).toBe(FIXTURE_BUILDING_COUNT)
      expect(stat?.inCircle).toBe(FIXTURE_BUILDING_COUNT - 1)
    }
  })

  it('writes numbers only past the header: the only strings are header fields', () => {
    for (const tier of QUALITY_TIERS) {
      const text = result.files.get(districtFilePath(FIXTURE_DISTRICT.id, tier)) ?? ''
      const strings: string[] = []
      const walk = (value: unknown, path: string): void => {
        if (typeof value === 'string') strings.push(path)
        else if (Array.isArray(value)) value.forEach((item) => walk(item, `${path}[]`))
        else if (value !== null && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key)
        }
      }
      walk(JSON.parse(text), '')
      expect([...new Set(strings)].sort()).toEqual(
        ['district', 'format', 'notice', 'projection.id', 'sources[]', 'tier'].sort(),
      )
      expect(Object.keys(JSON.parse(text) as object)).toEqual([
        'format',
        'derived',
        'notice',
        'sources',
        'projection',
        'district',
        'tier',
        'origin',
        'h',
        'r',
      ])
    }
  })

  it('the output schema rejects any extra field or a string among the numbers', () => {
    const valid = files.high
    expect(BuildingsFileSchema.safeParse({ ...valid, names: ['Some Tower'] }).success).toBe(false)
    expect(BuildingsFileSchema.safeParse({ ...valid, h: [...valid.h.slice(1), 'x'] }).success).toBe(
      false,
    )
    expect(BuildingsFileSchema.safeParse({ ...valid, h: valid.h.slice(1) }).success).toBe(false)
  })

  it('is deterministic', () => {
    const again = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
    for (const tier of QUALITY_TIERS) {
      const path = districtFilePath(FIXTURE_DISTRICT.id, tier)
      expect(again.files.get(path)).toBe(result.files.get(path))
    }
  })
})

describe('reading footprint pages', () => {
  const read = (pages: readonly unknown[], count = FIXTURE_BUILDING_COUNT) =>
    readDistrictFootprints(FIXTURE_DISTRICT, pages, count, { tiers, exclusions: [] })

  it('fails on a feature carrying any property besides HEIGHT_ROOF (a NAME would)', () => {
    const [first, second] = FIXTURE_BUILDING_PAGES as { features: { properties: object }[] }[]
    const named = {
      ...first,
      features: first?.features.map((f) => ({ ...f, properties: { ...f.properties, NAME: 'X' } })),
    }
    expect(() => read([named, second])).toThrow(/Invalid oti-buildings-midtown page 0/)
  })

  it('fails when the pages do not hold the lock count', () => {
    expect(() => read(FIXTURE_BUILDING_PAGES, FIXTURE_BUILDING_COUNT + 1)).toThrow(
      /expected 12 footprints \(lock count\), got 11/,
    )
  })

  it('fails when a page is missing (the truncation flags no longer line up)', () => {
    expect(() => read(FIXTURE_BUILDING_PAGES.slice(0, 1))).toThrow(/wrong truncation flag/)
  })
})

describe('landmark exclusions (INT-7, INT-8)', () => {
  const read = (exclusions: readonly LandmarkExclusion[]) =>
    readDistrictFootprints(FIXTURE_DISTRICT, FIXTURE_BUILDING_PAGES, FIXTURE_BUILDING_COUNT, {
      tiers,
      exclusions,
    })
  const centroidOf = (footprint: { readonly rings: readonly (readonly LocalPoint[])[] }) => {
    const outer = footprint.rings[0] ?? []
    return {
      x: outer.reduce((sum, p) => sum + p.x, 0) / outer.length,
      y: outer.reduce((sum, p) => sum + p.y, 0) / outer.length,
    }
  }

  it('reads the exclusion of every entry of landmarks[] in a frames file', () => {
    const frames = { landmarks: [{ id: 'some-landmark', exclusion: FIXTURE_EXCLUSION }] }
    expect(readLandmarkExclusions(frames)).toEqual([FIXTURE_EXCLUSION])
  })

  it('drops footprints whose centroid falls inside a landmark exclusion rectangle', () => {
    const kept = read([])
    const excluded = read([FIXTURE_EXCLUSION])
    expect(kept.excluded).toBe(0)
    expect(excluded.excluded).toBe(1)
    expect(excluded.footprints).toHaveLength(kept.footprints.length - 1)
    expect(
      excluded.footprints.some((f) => insideAnyExclusion(centroidOf(f), [FIXTURE_EXCLUSION])),
    ).toBe(false)
  })

  it('the build excludes the ground of the landmark frames it derives in the same run', () => {
    const result = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
    const rects = readLandmarkExclusions(
      JSON.parse(result.files.get(OUTPUT_FILES.landmarkFrames) ?? 'null'),
    )
    expect(rects.length).toBeGreaterThan(0)
    for (const tier of QUALITY_TIERS) {
      for (const mass of masses(fileOf(result, tier))) {
        expect(insideAnyExclusion(centroidOf(mass), rects)).toBe(false)
      }
    }
  })

  it('a frames file that does not match fails the build instead of excluding nothing', () => {
    expect(() => readLandmarkExclusions({ frames: [{ exclusion: FIXTURE_EXCLUSION }] })).toThrow(
      /frames\.derived\.json \(INT-7\)/,
    )
    expect(() => readLandmarkExclusions({ landmarks: [{ exclusion: { x: 0, y: 0 } }] })).toThrow(
      /INT-7/,
    )
  })
})
