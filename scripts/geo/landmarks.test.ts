/**
 * Landmark frames from LION: the principal axis, bearings, the synthetic city and a golden
 * excerpt of the real LION Brooklyn Bridge main roadway (scripts/geo/fixtures).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LandmarkFramesFileSchema, LandFileSchema } from '../../src/lib/data/schemas/world'
import { prepareAreas } from '../../src/lib/geo/lookup'
import {
  FIXTURE_CONFIG,
  FIXTURE_MODELS,
  FIXTURE_PARAMS,
  FIXTURE_PLACES,
  fixtureInputs,
  fixtureLion,
} from './fixtures/synthetic'
import { bearingDeg, buildLandmarkFrames, principalAxis } from './landmarks'
import { OUTPUT_FILES, buildGeoOutputs } from './transform'

const ROOT = join(import.meta.dirname, '../..')
const realLand = prepareAreas(
  LandFileSchema.parse(JSON.parse(readFileSync(join(ROOT, 'data/geo/land.derived.json'), 'utf8')))
    .boroughs,
)

const segment = (ax: number, ay: number, bx: number, by: number) => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  segmentType: 'G',
  roadwayType: '3',
})

describe('principal axis and bearings', () => {
  it('bearings run clockwise from north', () => {
    expect(bearingDeg(0, 1)).toBe(0)
    expect(bearingDeg(1, 0)).toBe(90)
    expect(bearingDeg(0, -1)).toBe(180)
    expect(bearingDeg(-1, 0)).toBe(270)
  })

  it('finds the axis of a line split into uneven pieces, weighted by length', () => {
    const angle = (30 * Math.PI) / 180
    const at = (t: number) => [t * Math.sin(angle), t * Math.cos(angle)] as const
    const [a, b, c] = [at(-500), at(100), at(500)]
    const { centre, axis } = principalAxis([
      segment(a[0], a[1], b[0], b[1]),
      segment(b[0], b[1], c[0], c[1]),
      // A short stub off the line barely moves it.
      segment(0, 0, 5, 0),
    ])
    expect(bearingDeg(axis.x, axis.y) % 180).toBeCloseTo(30, 0)
    expect(Math.hypot(centre.x, centre.y)).toBeLessThan(5)
  })
})

describe('frames on the synthetic city', () => {
  const land = (() => {
    const built = buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS)
    return LandmarkFramesFileSchema.parse(
      JSON.parse(built.files.get(OUTPUT_FILES.landmarkFrames) ?? 'null'),
    )
  })()

  it('orients the bridge first borough to second and ignores the ramp', () => {
    const bridge = land.landmarks.find((f) => f.id === 'test-bridge')
    expect(bridge?.headingDeg).toBe(90)
    expect(bridge?.base).toBe('water')
    const [first, second] = bridge?.ends ?? []
    expect(first?.x).toBeLessThan(second?.x ?? 0)
    expect(bridge?.spanM).toBe(Math.round((second?.x ?? 0) - (first?.x ?? 0)))
    expect(bridge?.anchor).toEqual({
      x: Math.round(((first?.x ?? 0) + (second?.x ?? 0)) / 2),
      y: first?.y,
    })
    expect(bridge?.pinLiftM).toBe(80)
    expect(bridge?.exclusion).toMatchObject({ angleDeg: 0, halfWidthM: 25 })
    expect(land.sources).toEqual([
      'dcp-borough-boundaries',
      'dcp-lion-5-avenue',
      'dcp-lion-brooklyn-bridge',
    ])
  })

  it('turns a fronted model by faceDeg from its street', () => {
    const hall = land.landmarks.find((f) => f.id === 'test-hall')
    // The street runs north-south (0°); faceDeg 90 faces east.
    expect(hall?.headingDeg).toBe(90)
    expect(hall?.base).toBe('land')
    expect(hall?.lion).toMatchObject({ street: '5 AVENUE' })
    expect('frontM' in (hall?.lion ?? {}) ? hall?.lion : undefined).toMatchObject({
      frontM: expect.closeTo(17, 0),
    })
  })
})

describe('frames fail fast', () => {
  const builtLand = JSON.parse(
    buildGeoOutputs(fixtureInputs(), FIXTURE_PARAMS).files.get(OUTPUT_FILES.land) ?? 'null',
  ) as { boroughs: { id: string; polygons: number[][][] }[] }
  const land = prepareAreas(builtLand.boroughs)
  const run = (overrides: Partial<Parameters<typeof buildLandmarkFrames>[0]>) =>
    buildLandmarkFrames(
      { lion: fixtureLion(), models: FIXTURE_MODELS, places: FIXTURE_PLACES, ...overrides },
      land,
      FIXTURE_CONFIG,
    )

  it('passes on the fixture', () => {
    expect(run({}).frames).toHaveLength(2)
  })

  it('on a street with no features', () => {
    const lion = fixtureLion()
    lion.set('dcp-lion-5-avenue', { type: 'FeatureCollection', features: [] })
    expect(() => run({ lion })).toThrow(/no features/)
  })

  it('on a response cut short by the server', () => {
    const lion = fixtureLion()
    const full = lion.get('dcp-lion-5-avenue') as Record<string, unknown>
    lion.set('dcp-lion-5-avenue', { ...full, exceededTransferLimit: true })
    expect(() => run({ lion })).toThrow(/Invalid LION 5 AVENUE/)
    lion.set('dcp-lion-5-avenue', { ...full, properties: { exceededTransferLimit: true } })
    expect(() => run({ lion })).toThrow(/Invalid LION 5 AVENUE/)
  })

  it('on a missing LION source', () => {
    const lion = fixtureLion()
    lion.delete('dcp-lion-brooklyn-bridge')
    expect(() => run({ lion })).toThrow(/LION source dcp-lion-brooklyn-bridge missing/)
  })

  it('when the bridge ends are not in the boroughs it spans', () => {
    const places = FIXTURE_PLACES.map((p) =>
      p.id === 'test-bridge' ? { ...p, spans: ['brooklyn', 'manhattan'] } : p,
    )
    expect(() => run({ places })).toThrow(/axis ends are in brooklyn and queens/)
  })

  it('when the fronting street is too far away', () => {
    const places = FIXTURE_PLACES.map((p) =>
      p.id === 'test-hall' ? { ...p, location: { lat: 40.708, lng: -73.99 } } : p,
    )
    expect(() => run({ places })).toThrow(/more than 80 m away/)
  })

  it('when a model has no landmark', () => {
    expect(() => run({ places: FIXTURE_PLACES.slice(0, 1) })).toThrow(/test-hall: not in/)
  })
})

describe('golden LION excerpt: the real Brooklyn Bridge main roadway', () => {
  const lion = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/lion-brooklyn-bridge-main.json'), 'utf8'),
  ) as unknown
  const model = {
    ...FIXTURE_MODELS[0],
    id: 'brooklyn-bridge',
  } as (typeof FIXTURE_MODELS)[number]

  it('heads 136.0° from Manhattan to Brooklyn, both ends on land', () => {
    const { frames } = buildLandmarkFrames(
      {
        lion: new Map([['dcp-lion-brooklyn-bridge', lion]]),
        models: [
          { ...model, frame: { ...model.frame, segmentTypes: ['B', 'G', 'U'] } } as typeof model,
        ],
        places: [
          {
            id: 'brooklyn-bridge',
            category: 'bridge',
            location: { lat: 40.70567, lng: -73.99633 },
            spans: ['manhattan', 'brooklyn'],
          },
        ],
      },
      realLand,
      FIXTURE_CONFIG,
    )
    const [frame] = frames
    expect(frame?.headingDeg).toBe(136)
    expect(frame?.ends).toEqual([
      { x: -2123, y: 1398 },
      { x: -947, y: 182 },
    ])
    expect(frame?.spanM).toBe(1692)
    expect(frame?.lion).toEqual({
      street: 'BROOKLYN BRIDGE',
      segments: 33,
      axisCentre: { x: -1510, y: 765 },
    })
  })
})
