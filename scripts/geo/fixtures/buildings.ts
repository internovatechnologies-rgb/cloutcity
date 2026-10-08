/**
 * Building and density fixtures for the S04d tests, laid out in local metres around the
 * fixture district's centre (inside the synthetic Queens rectangle) and served as lng/lat with
 * 6 decimals, like the OTI query (geometryPrecision=6). Two pages, as the paging would cut them.
 */
import type { GeoDistrict } from '../../../src/lib/data/schemas/config.ts'
import { project, unproject } from '../../../src/lib/geo/projection.ts'
import type { LandmarkExclusion } from '../landmark-exclusions.ts'

export const FIXTURE_DISTRICT: GeoDistrict = {
  id: 'midtown',
  label: 'Fixture Midtown',
  borough: 'queens',
  center: { lat: 40.705, lng: -73.985 },
  radiusM: 300,
}

const CENTRE = project(FIXTURE_DISTRICT.center)
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/** Local metres relative to the district centre → a closed lng/lat ring. */
function ring(points: readonly (readonly [number, number])[]): number[][] {
  const out = points.map(([dx, dy]) => {
    const { lat, lng } = unproject({ x: CENTRE.x + dx, y: CENTRE.y + dy })
    return [round6(lng), round6(lat)]
  })
  const first = out[0]
  return first === undefined ? out : [...out, first]
}

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  ring([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ])

const feature = (heightFt: number | null, ...rings: number[][][]) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: rings },
  properties: { HEIGHT_ROOF: heightFt },
})

/** Each footprint by role, so tests can find what became of it. Offsets in metres. */
export const FIXTURE_FOOTPRINTS = {
  /** 100 ft → 30 m; shares its east wall with `twinB`. */
  twinA: feature(100, rect(0, 0, 20, 15)),
  /** 98 ft → 30 m: the same bin as twinA on every tier. */
  twinB: feature(98, rect(20, 0, 40, 15)),
  /** 40 ft → 12 m: touches twinB but sits in another bin. */
  lowNeighbour: feature(40, rect(40, 0, 60, 15)),
  /** No height: the default (9 m); 144 m², under low's 150 m². */
  noHeight: feature(null, rect(0, 40, 12, 52)),
  /** 49 m²: high only (mid needs 60 m²). */
  small: feature(30, rect(30, 40, 37, 47)),
  /** 16 ft → 5 m: under low's 8 m. */
  short: feature(16, rect(60, 40, 80, 50)),
  /** Zero height: the default. */
  zeroHeight: feature(0, rect(100, 40, 120, 55)),
  /** Centroid 410 m out, past the 300 m radius. */
  outside: feature(50, rect(400, 0, 420, 20)),
  /** A 60 × 30 m block whose south wall zig-zags by 0.4 and 0.8 m (simplification fodder). */
  wiggly: feature(
    60,
    ring([
      [100, 0],
      [110, 0.4],
      [120, 0],
      [130, 0.8],
      [140, 0],
      [150, 0.4],
      [160, 0],
      [160, 30],
      [100, 30],
    ]),
  ),
  /** 50 × 50 m with a 20 × 20 m courtyard. */
  courtyard: feature(60, rect(-200, 0, -150, 50), rect(-185, 15, -165, 35)),
  /** Sits where FIXTURE_EXCLUSION is. */
  landmarkSite: feature(50, rect(-100, -100, -80, -80)),
} as const

const features = Object.values(FIXTURE_FOOTPRINTS)

/** Two pages: the first truncated (more follow), the second the last. */
export const FIXTURE_BUILDING_PAGES: readonly unknown[] = [
  {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'EPSG:4326' } },
    features: features.slice(0, 6),
    properties: { exceededTransferLimit: true },
  },
  {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'EPSG:4326' } },
    features: features.slice(6),
  },
]
export const FIXTURE_BUILDING_COUNT = features.length

/** A 30 × 30 m landmark exclusion over `landmarkSite`, rotated 10°. */
export const FIXTURE_EXCLUSION: LandmarkExclusion = {
  x: CENTRE.x - 90,
  y: CENTRE.y - 90,
  halfLengthM: 15,
  halfWidthM: 15,
  angleDeg: 10,
}

/** MapPLUTO statistics: QN01 dense (FAR 3), BK01 lighter (FAR 1.5), and the null-CD row. */
export const FIXTURE_DENSITY = {
  features: [
    { attributes: { lots: 0, bldgArea: 413, lotArea: 56079, avgFloors: 1, CD: null } },
    { attributes: { lots: 50, bldgArea: 1_500_000, lotArea: 1_000_000, avgFloors: 3, CD: 301 } },
    { attributes: { lots: 80, bldgArea: 3_000_000, lotArea: 1_000_000, avgFloors: 6, CD: 401 } },
  ],
}
