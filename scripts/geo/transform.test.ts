import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ParksFileSchema,
  SubwayFileSchema,
  WaterFileSchema,
  ZoneShapesFileSchema,
  ZonesFileSchema,
  GeoManifestSchema,
  LandmarkFramesFileSchema,
} from '../../src/lib/data/schemas/world'
import { decodePath, decodeRing } from '../../src/lib/geo/codec'
import { distanceToPolyline, pointInPolygon, signedArea } from '../../src/lib/geo/polygon'
import { project } from '../../src/lib/geo/projection'
import { FIXTURE_BOROUGHS, FIXTURE_NTAS, FIXTURE_PARAMS, fixtureInputs } from './fixtures/synthetic'
import { OUTPUT_FILES, buildGeoOutputs, tieredOutputPaths, type GeoBuildResult } from './transform'

/** sha256 over every output (path, newline, text) in path order. Update only on purpose. */
const FIXTURE_GOLDEN = 'a48fbad71e939f8635dcf16cae1d24a3f67e3f40df73dd2c33e2cf4cf8316dc8'

function digest(result: GeoBuildResult): string {
  const hash = createHash('sha256')
  for (const [path, text] of result.files) hash.update(`${path}\n${text}`)
  return hash.digest('hex')
}

const json = (result: GeoBuildResult, path: string): unknown =>
  JSON.parse(result.files.get(path) ?? 'null')

describe('buildGeoOutputs on the synthetic fixture', () => {
  const result = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)

  it('is deterministic: two builds are byte-identical and match the golden hash', () => {
    const again = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
    expect([...again.files.entries()]).toEqual([...result.files.entries()])
    expect(digest(result)).toBe(FIXTURE_GOLDEN)
  })

  it('writes every output, each derived file valid against its schema', () => {
    const tiered = tieredOutputPaths(FIXTURE_PARAMS.config).map(({ path }) => path)
    expect(tiered).toEqual([
      'geo/districts/midtown.low.derived.json',
      'geo/districts/midtown.mid.derived.json',
      'geo/districts/midtown.high.derived.json',
      'geo/blocks.low.derived.json',
      'geo/blocks.mid.derived.json',
      'geo/blocks.high.derived.json',
    ])
    expect([...result.files.keys()]).toEqual([...Object.values(OUTPUT_FILES), ...tiered].sort())
    // Land is checked below: its schema requires all five real boroughs.
    expect(json(result, OUTPUT_FILES.land)).toMatchObject({ derived: true, format: 'cc-geo-v1' })
    expect(WaterFileSchema.parse(json(result, OUTPUT_FILES.water)).derived).toBe(true)
    expect(ParksFileSchema.parse(json(result, OUTPUT_FILES.parks)).derived).toBe(true)
    expect(SubwayFileSchema.parse(json(result, OUTPUT_FILES.subway)).derived).toBe(true)
    expect(ZonesFileSchema.parse(json(result, OUTPUT_FILES.zones)).derived).toBe(true)
    expect(ZoneShapesFileSchema.parse(json(result, OUTPUT_FILES.zoneShapes)).derived).toBe(true)
    const manifest = GeoManifestSchema.parse(json(result, OUTPUT_FILES.manifest))
    expect(manifest.files).toHaveLength(14)
    expect(
      manifest.files.filter((f) => f.group === 'district').map((f) => [f.path, f.tier]),
    ).toEqual([
      ['geo/districts/midtown.high.derived.json', 'high'],
      ['geo/districts/midtown.low.derived.json', 'low'],
      ['geo/districts/midtown.mid.derived.json', 'mid'],
    ])
    expect(manifest.files.filter((f) => f.group === 'blocks').map((f) => f.tier)).toEqual([
      'high',
      'low',
      'mid',
    ])
    expect(LandmarkFramesFileSchema.parse(json(result, OUTPUT_FILES.landmarkFrames)).derived).toBe(
      true,
    )
  })

  it('neighbouring boroughs share their edge vertex for vertex (no gaps)', () => {
    const land = json(result, OUTPUT_FILES.land) as {
      boroughs: { id: string; polygons: number[][][] }[]
    }
    expect(land.boroughs.map((b) => b.id)).toEqual(['brooklyn', 'queens'])
    const [brooklyn, queens] = land.boroughs.map((b) =>
      (b.polygons[0]?.[0] ? decodeRing(b.polygons[0][0]) : []).map((p) => `${p.x},${p.y}`),
    )
    const shared = (brooklyn ?? []).filter((v) => (queens ?? []).includes(v))
    expect(shared.length).toBeGreaterThanOrEqual(2)
  })

  it('merges the NTAs of one CDTA into a zone with no interior edge', () => {
    const shapes = json(result, OUTPUT_FILES.zoneShapes) as {
      zones: { id: string; polygons: number[][][] }[]
    }
    const bk01 = shapes.zones.find((z) => z.id === 'bk01')
    expect(bk01?.polygons).toHaveLength(1)
    expect(bk01?.polygons[0]).toHaveLength(1)
    const ring = decodeRing(bk01?.polygons[0]?.[0] ?? [])
    const xs = ring.map((p) => p.x)
    const ys = ring.map((p) => p.y)
    const [minX, maxX, minY, maxY] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ]
    // Every vertex is on the outer rectangle: the shared NTA edge is gone.
    for (const p of ring) {
      expect(p.x === minX || p.x === maxX || p.y === minY || p.y === maxY).toBe(true)
    }
    const zones = json(result, OUTPUT_FILES.zones) as { zones: Record<string, unknown>[] }
    expect(zones.zones.map((z) => [z.id, z.name, z.borough, z.ntaCodes, z.kind])).toEqual([
      ['bk01', 'Test Heights-Test Green', 'brooklyn', ['BK0101', 'BK0102'], 'district'],
      ['qn01', 'Sample Side', 'queens', ['QN0101'], 'district'],
    ])
  })

  it('keeps NTA type 9 as a park without its name', () => {
    const parks = json(result, OUTPUT_FILES.parks) as { parks: Record<string, unknown>[] }
    expect(
      parks.parks.map(({ id, ntaCode, kind, borough }) => ({ id, ntaCode, kind, borough })),
    ).toEqual([{ id: 'park-bk0102', ntaCode: 'BK0102', kind: 'park', borough: 'brooklyn' }])
  })

  it('drops the duplicate shape and extends the path to the terminal station', () => {
    const subway = SubwayFileSchema.parse(json(result, OUTPUT_FILES.subway))
    expect(subway.lines).toHaveLength(1)
    expect(subway.lines[0]?.paths).toHaveLength(1)
    expect(result.terminalExtensions).toHaveLength(1)
    expect(result.terminalExtensions[0]).toMatchObject({ lineId: 'x', stationId: 'p3' })
    expect(result.terminalExtensions[0]?.gapM).toBeGreaterThanOrEqual(49)
    expect(result.terminalExtensions[0]?.gapM).toBeLessThanOrEqual(51)
    expect(subway.terminalExtensions).toEqual(result.terminalExtensions)
    const path = decodePath(subway.lines[0]?.paths[0] ?? [])
    for (const station of subway.stations) {
      expect(distanceToPolyline(station, path)).toBeLessThanOrEqual(10)
    }
    expect(subway.stations.map((s) => [s.id, s.borough, s.zoneId, s.lines])).toEqual([
      ['p1', 'brooklyn', 'bk01', ['x']],
      ['p2', 'brooklyn', 'bk01', ['x']],
      ['p3', 'queens', 'qn01', ['x']],
    ])
    expect(result.files.get(OUTPUT_FILES.sources)).toContain('Line `x` extended')
  })

  it('fails when a station is farther than terminalGapMaxM from its line', () => {
    expect(() => buildGeoOutputs(fixtureInputs(-73.981), FIXTURE_PARAMS)).toThrow(
      /station P3 .* route X/,
    )
  })

  it('fails on a partial upstream file', () => {
    const params = { ...FIXTURE_PARAMS, expected: { ...FIXTURE_PARAMS.expected, boroughs: 5 } }
    expect(() => buildGeoOutputs(fixtureInputs(), params)).toThrow(/Expected 5 boroughs, got 2/)
    const truncated = { ...fixtureInputs(), ntas: { ...FIXTURE_NTAS, exceededTransferLimit: true } }
    expect(() => buildGeoOutputs(truncated, FIXTURE_PARAMS)).toThrow(/Invalid NTA 2020/)
    const badName = {
      ...fixtureInputs(),
      boroughs: {
        ...FIXTURE_BOROUGHS,
        features: FIXTURE_BOROUGHS.features.map((f) => ({
          ...f,
          properties: { ...f.properties, BoroName: 'Atlantis' },
        })),
      },
    }
    expect(() => buildGeoOutputs(badName, FIXTURE_PARAMS)).toThrow(/Invalid borough boundaries/)
  })

  it('keeps a large hole (clockwise), drops a tiny one, and drops a tiny island with its hole', () => {
    // Closed lng/lat rectangles, counter-clockwise: holes deliberately wound the wrong way.
    const rect = (west: number, south: number, east: number, north: number) => [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ]
    const queens = {
      type: 'MultiPolygon',
      coordinates: [
        [
          rect(-73.99, 40.7, -73.98, 40.71),
          // ~100 m lake: kept (well over landMinRingAreaM2 2000 m²).
          rect(-73.9856, 40.7045, -73.9844, 40.7054),
          // ~20 m pond: 400 m², dropped.
          rect(-73.988, 40.702, -73.98776, 40.70218),
        ],
        // ~30 m islet east of Queens with its own hole: 900 m², dropped with its hole.
        [
          rect(-73.979, 40.705, -73.97864, 40.70527),
          rect(-73.97888, 40.70509, -73.97876, 40.70518),
        ],
      ],
    }
    const boroughs = {
      ...FIXTURE_BOROUGHS,
      features: FIXTURE_BOROUGHS.features.map((f) =>
        f.properties.BoroName === 'Queens' ? { ...f, geometry: queens } : f,
      ),
    }
    const built = buildGeoOutputs({ ...fixtureInputs(), boroughs }, FIXTURE_PARAMS)
    const land = json(built, OUTPUT_FILES.land) as {
      boroughs: { id: string; polygons: number[][][] }[]
    }
    const polygons = land.boroughs.find((b) => b.id === 'queens')?.polygons ?? []
    expect(polygons).toHaveLength(1)
    const rings = (polygons[0] ?? []).map(decodeRing)
    expect(rings).toHaveLength(2)
    expect(signedArea(rings[0] ?? [])).toBeGreaterThan(0)
    const lakeArea = signedArea(rings[1] ?? [])
    expect(lakeArea).toBeLessThan(0)
    expect(-lakeArea).toBeGreaterThan(8000)
    expect(-lakeArea).toBeLessThan(12_000)
    const lakeCentre = project({ lat: 40.70495, lng: -73.985 })
    expect(pointInPolygon(lakeCentre, rings)).toBe(false)
    const islet = project({ lat: 40.70513, lng: -73.97882 })
    expect(pointInPolygon(islet, rings)).toBe(false)
    expect(Math.max(...rings.flat().map((p) => p.x))).toBeLessThan(islet.x - 50)
  })
})
