/**
 * The client geo schemas (zod/mini) must accept and reject exactly what the classic schemas in
 * src/lib/data/schemas/world.ts do, on the real files and on malformed variants.
 */
import { describe, expect, it } from 'vitest'
import landJson from '@data/geo/land.derived.json'
import parksJson from '@data/geo/parks.derived.json'
import subwayJson from '@data/geo/subway.derived.json'
import waterJson from '@data/geo/water.derived.json'
import { BOROUGHS } from '@/lib/data/schemas/content'
import {
  LandFileSchema,
  ParksFileSchema,
  SubwayFileSchema,
  WaterFileSchema,
} from '@/lib/data/schemas/world'
import { ARCHETYPES } from '@/lib/data/schemas/landmarkModels'
import { landmarksLayer } from '@/lib/world/landmarksLayer'
import { placesLayer } from '@/lib/world/placesLayer'
import {
  BOROUGH_IDS,
  GEO_BASE_FORMAT,
  LANDMARK_ARCHETYPES,
  LandMiniSchema,
  PlacesMiniSchema,
  ParksMiniSchema,
  SubwayMiniSchema,
  WaterMiniSchema,
  parseGeoBase,
  safeParseGeoBase,
} from './schema'

type Json = Record<string, unknown>
const clone = <T>(value: T): T => structuredClone(value)

const land = landJson as Json
const water = waterJson as Json
const parks = parksJson as Json
const subway = subwayJson as Json

/** Each pair: classic and mini schema for one file, plus malformed variants of the real file. */
const CASES = [
  {
    name: 'land',
    classic: LandFileSchema,
    mini: LandMiniSchema,
    file: land,
    bad: [
      { ...land, derived: false },
      { ...land, format: 'cc-geo-v0' },
      { ...land, extra: 1 },
      { ...land, boroughs: (land.boroughs as unknown[]).slice(1) },
      (() => {
        const copy = clone(land) as { boroughs: { id: string }[] }
        if (copy.boroughs[1] && copy.boroughs[0]) copy.boroughs[1].id = copy.boroughs[0].id
        return copy
      })(),
      (() => {
        const copy = clone(land) as { boroughs: { polygons: number[][][] }[] }
        copy.boroughs[0]?.polygons[0]?.[0]?.push(5)
        return copy
      })(),
      (() => {
        const copy = clone(land) as { boroughs: { polygons: number[][][] }[] }
        const ring = copy.boroughs[0]?.polygons[0]?.[0]
        if (ring) ring[0] = 0.5
        return copy
      })(),
    ],
  },
  {
    name: 'water',
    classic: WaterFileSchema,
    mini: WaterMiniSchema,
    file: water,
    bad: [
      { ...water, sea: [] },
      { ...water, sea: [[1, 2, 3, 4]] },
      { ...water, projection: { id: 'other', originLat: 40.7, originLng: -73.98 } },
      { ...water, sources: ['osm'] },
    ],
  },
  {
    name: 'parks',
    classic: ParksFileSchema,
    mini: ParksMiniSchema,
    file: parks,
    bad: [
      (() => {
        const copy = clone(parks) as { parks: { kind: string }[] }
        if (copy.parks[0]) copy.parks[0].kind = 'garden'
        return copy
      })(),
      (() => {
        const copy = clone(parks) as { parks: { ntaCode: string }[] }
        if (copy.parks[0]) copy.parks[0].ntaCode = 'Q1'
        return copy
      })(),
    ],
  },
  {
    name: 'subway',
    classic: SubwayFileSchema,
    mini: SubwayMiniSchema,
    file: subway,
    bad: [
      { ...subway, lines: [] },
      (() => {
        const copy = clone(subway) as { lines: { paths: number[][] }[] }
        if (copy.lines[0]) copy.lines[0].paths = [[1, 2]]
        return copy
      })(),
      (() => {
        const copy = clone(subway) as { stations: { lines: string[] }[] }
        if (copy.stations[0]) copy.stations[0].lines = []
        return copy
      })(),
      (() => {
        const copy = clone(subway) as { stations: { borough: string }[] }
        if (copy.stations[0]) copy.stations[0].borough = 'jersey'
        return copy
      })(),
      (() => {
        const copy = clone(subway) as { terminalExtensions: { gapM: number }[] }
        copy.terminalExtensions.push({ lineId: 'a', stationId: 'b', gapM: -1 } as never)
        return copy
      })(),
    ],
  },
] as const

describe('client geo schemas match the classic schemas', () => {
  it('use the same borough ids', () => {
    expect([...BOROUGH_IDS]).toEqual([...BOROUGHS])
  })

  for (const { name, classic, mini, file, bad } of CASES) {
    it(`${name}: both accept the real file`, () => {
      expect(classic.safeParse(file).success).toBe(true)
      expect(mini.safeParse(file).success).toBe(true)
    })

    it(`${name}: both reject every malformed variant`, () => {
      for (const [index, variant] of bad.entries()) {
        expect(classic.safeParse(variant).success, `classic #${index}`).toBe(false)
        expect(mini.safeParse(variant).success, `mini #${index}`).toBe(false)
      }
    })
  }
})

describe('parseGeoBase', () => {
  const body = {
    format: GEO_BASE_FORMAT,
    version: '0123456789ab',
    land,
    water,
    parks,
    subway,
    places: placesLayer,
    landmarks: JSON.parse(JSON.stringify(landmarksLayer)) as unknown,
  }

  it('returns the layers of a valid body', () => {
    expect(parseGeoBase(body).land.boroughs).toHaveLength(BOROUGH_IDS.length)
    expect(parseGeoBase(body).landmarks.models.map((m) => m.id)).toEqual(
      landmarksLayer.models.map((m) => m.id),
    )
  })

  it('rejects a landmarks layer whose entries are malformed (S07a)', () => {
    type Entry = { model: Json; frame: Json; style: string }
    const models = () => clone(body.landmarks) as { models: Entry[] }
    const swapped = models()
    if (swapped.models[0]) swapped.models[0].model = { ...swapped.models[0].model, id: 'other' }
    const archetype = models()
    if (archetype.models[0])
      archetype.models[0].model = { ...archetype.models[0].model, archetype: 'castle' }
    const heading = models()
    if (heading.models[0]) heading.models[0].frame = { ...heading.models[0].frame, headingDeg: 360 }
    const style = models()
    if (style.models[0]) style.models[0].style = 'glowing'
    for (const landmarks of [swapped, archetype, heading, style, undefined]) {
      expect(safeParseGeoBase({ ...body, landmarks }).ok).toBe(false)
    }
  })

  it('lists the same archetypes as the classic models schema', () => {
    expect([...LANDMARK_ARCHETYPES]).toEqual([...ARCHETYPES])
  })

  it('rejects a wrong format, a bad version or a missing layer, naming the path only', () => {
    expect(() => parseGeoBase({ ...body, format: 'other' })).toThrow(/format/)
    expect(() => parseGeoBase({ ...body, version: 'nope' })).toThrow(/version/)
    expect(() => parseGeoBase({ ...body, subway: undefined })).toThrow(/subway/)
    expect(() => parseGeoBase({ ...body, places: undefined })).toThrow(/places/)
    expect(() => parseGeoBase(null)).toThrow(/root/)
  })

  it('safeParseGeoBase reports at most three failing paths and never throws', () => {
    expect(safeParseGeoBase(body)).toMatchObject({ ok: true })
    const result = safeParseGeoBase({ format: 'cc-geo-base-v1', land: { boroughs: [] } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.paths.length).toBeGreaterThan(0)
      expect(result.paths.length).toBeLessThanOrEqual(3)
    }
    expect(safeParseGeoBase(undefined)).toEqual({ ok: false, paths: ['(root)'] })
  })
})

describe('places layer schema (S04c)', () => {
  type Places = { pins: Record<string, unknown>[]; boroughs: Record<string, unknown>[] }
  const real = (): Places => clone(placesLayer) as unknown as Places
  const withPin = (patch: Record<string, unknown>): Places => {
    const copy = real()
    copy.pins[0] = { ...copy.pins[0], ...patch }
    return copy
  }

  it('accepts the layer the route serves, with and without a per-pin liftM', () => {
    expect(PlacesMiniSchema.safeParse(placesLayer).success).toBe(true)
    expect(PlacesMiniSchema.safeParse(withPin({ liftM: 0 })).success).toBe(true)
    expect(PlacesMiniSchema.safeParse(withPin({ liftM: 42.5 })).success).toBe(true)
  })

  it('rejects malformed pins and borough states', () => {
    const duplicate = real()
    duplicate.pins.push({ ...duplicate.pins[0] })
    const missingBorough = real()
    missingBorough.boroughs.pop()
    for (const variant of [
      withPin({ liftM: -1 }),
      withPin({ x: 1.5 }),
      withPin({ style: 'glowing' }),
      withPin({ kind: 'player' }),
      withPin({ borough: 'jersey' }),
      withPin({ extra: true }),
      duplicate,
      missingBorough,
      { ...real(), boroughs: real().boroughs.map((b) => ({ ...b, render: 'hidden' })) },
    ]) {
      expect(PlacesMiniSchema.safeParse(variant).success).toBe(false)
    }
  })
})
