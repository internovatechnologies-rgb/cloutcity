/**
 * A tiny synthetic city for the geo build tests: two square boroughs sharing an edge; three
 * NTAs in two CDTAs (one a park); one subway route with two shapes (the second a duplicate) and
 * three stations, the last 50 m past the end of the shapes; one building district in Queens
 * (fixtures/buildings.ts) and MapPLUTO density for both community districts; one bridge running
 * west to east from Brooklyn into Queens (plus a ramp that must be ignored) and one hall facing a
 * north-south street.
 */
import { strToU8, zipSync } from 'fflate'
import type { GeoConfig } from '../../../src/lib/data/schemas/config.ts'
import type { LandmarkModel } from '../../../src/lib/data/schemas/landmarkModels.ts'
import { buildingSourceId, type LionSourceId } from '../../../src/lib/geo/sources.ts'
import type { FramePlace } from '../landmarks.ts'
import { SOURCE_DEFINITIONS, buildingSourceDefinition, type Lock } from '../lock.ts'
import type { GeoBuildParams, RawGeoInputs } from '../transform.ts'
import {
  FIXTURE_BUILDING_COUNT,
  FIXTURE_BUILDING_PAGES,
  FIXTURE_DENSITY,
  FIXTURE_DISTRICT,
} from './buildings.ts'

type Ring = [number, number][]

/** A closed lng/lat rectangle ring (counter-clockwise), with a midpoint on every side. */
function rectangle(west: number, south: number, east: number, north: number): Ring {
  const midLng = (west + east) / 2
  const midLat = (south + north) / 2
  return [
    [west, south],
    [midLng, south],
    [east, south],
    [east, midLat],
    [east, north],
    [midLng, north],
    [west, north],
    [west, midLat],
    [west, south],
  ]
}

const polygon = (ring: Ring) => ({ type: 'Polygon', coordinates: [ring] })

export const FIXTURE_BOROUGHS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { BoroCode: 4, BoroName: 'Queens' },
      geometry: polygon(rectangle(-73.99, 40.7, -73.98, 40.71)),
    },
    {
      type: 'Feature',
      properties: { BoroCode: 3, BoroName: 'Brooklyn' },
      geometry: polygon(rectangle(-74.0, 40.7, -73.99, 40.71)),
    },
  ],
}

export const FIXTURE_NTAS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        BoroCode: 4,
        BoroName: 'Queens',
        NTA2020: 'QN0101',
        NTAName: 'Sample Side',
        NTAType: '0',
        CDTA2020: 'QN01',
        CDTAName: 'QN01 Sample Side (CD 1 Approximation)',
      },
      geometry: polygon(rectangle(-73.99, 40.7, -73.98, 40.71)),
    },
    {
      type: 'Feature',
      properties: {
        BoroCode: 3,
        BoroName: 'Brooklyn',
        NTA2020: 'BK0102',
        NTAName: 'Test Green',
        NTAType: '9',
        CDTA2020: 'BK01',
        CDTAName: 'BK01 Test Heights-Test Green (CD 1 Equivalent)',
      },
      geometry: polygon(rectangle(-73.995, 40.7, -73.99, 40.71)),
    },
    {
      type: 'Feature',
      properties: {
        BoroCode: 3,
        BoroName: 'Brooklyn',
        NTA2020: 'BK0101',
        NTAName: 'Test Heights',
        NTAType: '0',
        CDTA2020: 'BK01',
        CDTAName: 'BK01 Test Heights-Test Green (CD 1 Equivalent)',
      },
      geometry: polygon(rectangle(-74.0, 40.7, -73.995, 40.71)),
    },
  ],
}

const LINE_LAT = 40.705
/** The shapes run from -73.999 to -73.983; station P3 sits 50 m further east. */
const shapePoints = (fromLng: number, toLng: number, steps: number) =>
  Array.from({ length: steps + 1 }, (_, i) => fromLng + ((toLng - fromLng) * i) / steps)

function csv(rows: (string | number)[][]): string {
  return `${rows.map((row) => row.join(',')).join('\n')}\n`
}

export function fixtureGtfsZip(p3Lng = -73.98240847): Uint8Array {
  const shapes: (string | number)[][] = [
    ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'],
  ]
  shapePoints(-73.999, -73.983, 16).forEach((lng, i) =>
    shapes.push(['S1', i, LINE_LAT, lng.toFixed(6)]),
  )
  shapePoints(-73.999, -73.99, 9).forEach((lng, i) =>
    shapes.push(['S2', i, LINE_LAT, lng.toFixed(6)]),
  )
  const stops = [
    ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station'],
    ['P1', 'First St', LINE_LAT, -73.998, 1, ''],
    ['P1N', 'First St', LINE_LAT, -73.998, '', 'P1'],
    ['P2', 'Second St', LINE_LAT, -73.993, 1, ''],
    ['P2N', 'Second St', LINE_LAT, -73.993, '', 'P2'],
    ['P3', 'End Av', LINE_LAT, p3Lng, 1, ''],
    ['P3N', 'End Av', LINE_LAT, p3Lng, '', 'P3'],
  ]
  return zipSync({
    'agency.txt': strToU8('agency_id,agency_name\nT,Test\n'),
    'routes.txt': strToU8(
      csv([
        ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
        ['X', 'T', 'X', '"Test Line, Local"', 1],
      ]),
    ),
    'trips.txt': strToU8(
      csv([
        ['route_id', 'trip_id', 'service_id', 'shape_id'],
        ['X', 't1', 'Weekday', 'S1'],
        ['X', 't2', 'Weekday', 'S2'],
      ]),
    ),
    'shapes.txt': strToU8(csv(shapes)),
    'stops.txt': strToU8(csv(stops)),
    'stop_times.txt': strToU8(
      csv([
        ['trip_id', 'stop_id', 'arrival_time', 'departure_time', 'stop_sequence'],
        ['t1', 'P1N', '00:00:00', '00:00:00', 1],
        ['t1', 'P2N', '00:02:00', '00:02:00', 2],
        ['t1', 'P3N', '00:04:00', '00:04:00', 3],
        ['t2', 'P1N', '00:00:00', '00:00:00', 1],
        ['t2', 'P2N', '00:02:00', '00:02:00', 2],
      ]),
    ),
  })
}

export const FIXTURE_CONFIG: GeoConfig = {
  quantumM: 1,
  landMinWeightM2: 20,
  landMinRingAreaM2: 2000,
  zoneMinWeightM2: 150,
  zoneMinRingAreaM2: 5000,
  parkMinRingAreaM2: 2000,
  subwayToleranceM: 3,
  subwayDedupCoverM: 5,
  stationOnLineToleranceM: 10,
  terminalGapMaxM: 150,
  stationAreaFallbackM: 300,
  waterMarginM: 2000,
  districts: [FIXTURE_DISTRICT],
  buildingTiers: {
    defaultHeightM: 9,
    quantumM: 1,
    tiers: {
      low: { simplifyM: 4, minAreaM2: 150, minHeightM: 8, heightBinM: 6, merge: true },
      mid: { simplifyM: 2, minAreaM2: 60, minHeightM: 0, heightBinM: 3, merge: true },
      high: { simplifyM: 1, minAreaM2: 40, minHeightM: 0, heightBinM: 1, merge: false },
    },
  },
  blocks: {
    seed: 7,
    floorM: 3.3,
    jitter: 0.25,
    heightJitter: 0.4,
    fullFar: 3,
    footprintFraction: 0.55,
    spacingM: { low: 250, mid: 160, high: 110 },
    maxInstances: { low: 100, mid: 200, high: 400 },
    gridAngleDeg: { manhattan: 29, bronx: 0, brooklyn: 0, queens: 0, 'staten-island': 0 },
  },
  landmarkFrontMaxM: 80,
  landmarkExclusionMarginM: 10,
}

export const FIXTURE_LOCK: Lock = {
  version: 1,
  sources: SOURCE_DEFINITIONS.map((definition, index) => ({
    ...definition,
    retrieved: '2026-01-02',
    sha256: String(index).repeat(64),
    bytes: 1000 + index,
  })),
  pagedSources: [
    {
      ...buildingSourceDefinition(FIXTURE_DISTRICT),
      retrieved: '2026-01-03',
      count: FIXTURE_BUILDING_COUNT,
      pages: FIXTURE_BUILDING_PAGES.map((_, index) => ({
        sha256: String(index + 5).repeat(64),
        bytes: 2000 + index,
      })),
    },
  ],
}

const BRIDGE_LAT = 40.7035
const HALL = { lat: 40.708, lng: -73.996 }
/** About 17 m west of the hall. */
const STREET_LNG = -73.9962

function lionFeature(
  street: string,
  segmentId: string,
  segmentType: string,
  roadwayType: string,
  coordinates: [number, number][],
) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {
      Street: street,
      SegmentID: segmentId,
      SegmentTyp: segmentType,
      RW_TYPE: ` ${roadwayType}`,
      FeatureTyp: '0',
    },
  }
}

export function fixtureLion(): Map<LionSourceId, unknown> {
  return new Map<LionSourceId, unknown>([
    [
      'dcp-lion-brooklyn-bridge',
      {
        type: 'FeatureCollection',
        features: [
          lionFeature('BROOKLYN BRIDGE', '0000001', 'G', '3', [
            [-73.997, BRIDGE_LAT],
            [-73.99, BRIDGE_LAT],
          ]),
          lionFeature('BROOKLYN BRIDGE', '0000002', 'G', '3', [
            [-73.99, BRIDGE_LAT],
            [-73.983, BRIDGE_LAT],
          ]),
          // A ramp heading north: ignored, or it would tilt the axis.
          lionFeature('BROOKLYN BRIDGE', '0000003', 'E', '9', [
            [-73.99, BRIDGE_LAT],
            [-73.99, 40.709],
          ]),
        ],
      },
    ],
    [
      'dcp-lion-5-avenue',
      {
        type: 'FeatureCollection',
        features: [
          lionFeature('5 AVENUE', '0000010', 'U', '1', [
            [STREET_LNG, 40.701],
            [STREET_LNG, 40.709],
          ]),
        ],
      },
    ],
  ])
}

export const FIXTURE_PLACES: FramePlace[] = [
  {
    id: 'test-bridge',
    category: 'bridge',
    location: { lat: BRIDGE_LAT, lng: -73.99 },
    spans: ['brooklyn', 'queens'],
  },
  { id: 'test-hall', category: 'government', location: HALL },
]

export const FIXTURE_MODELS: LandmarkModel[] = [
  {
    id: 'test-bridge',
    archetype: 'suspensionBridge',
    depiction: 'stylised',
    params: {
      deck: { widthM: 20, clearanceM: 40, thicknessM: 4 },
      towers: {
        offsetsM: [-150, 150],
        heightM: 80,
        widthM: 30,
        depthM: 12,
        legWidthM: 6,
        openings: 1,
        pierHeightM: 10,
      },
      cables: { perSide: 1, hangerSpacingM: 30 },
      roles: { deck: 'steel', tower: 'stone', cable: 'accent' },
    },
    frame: {
      kind: 'lion-bridge',
      street: 'BROOKLYN BRIDGE',
      segmentTypes: ['G'],
      roadwayTypes: ['3'],
    },
  },
  {
    id: 'test-hall',
    archetype: 'civicHall',
    depiction: 'stylised',
    params: {
      widthM: 40,
      depthM: 20,
      heightM: 15,
      floors: 2,
      windowColumns: 6,
      portico: { columns: 4, widthM: 16, depthM: 5, heightM: 12 },
      roles: { body: 'stone', trim: 'accent', roof: 'roof' },
    },
    frame: { kind: 'lion-front', street: '5 AVENUE', faceDeg: 90 },
  },
]

export function fixtureInputs(p3Lng?: number): RawGeoInputs {
  return {
    boroughs: FIXTURE_BOROUGHS,
    ntas: FIXTURE_NTAS,
    gtfsZip: fixtureGtfsZip(p3Lng),
    density: FIXTURE_DENSITY,
    buildings: new Map([[buildingSourceId(FIXTURE_DISTRICT.id), FIXTURE_BUILDING_PAGES]]),
    lion: fixtureLion(),
  }
}

export const FIXTURE_PARAMS: GeoBuildParams = {
  config: FIXTURE_CONFIG,
  bounds: { west: -74.01, south: 40.69, east: -73.97, north: 40.72 },
  lock: FIXTURE_LOCK,
  expected: { boroughs: 2, ntas: 3, communityDistricts: 2 },
  landmarks: { models: FIXTURE_MODELS, places: FIXTURE_PLACES },
}
