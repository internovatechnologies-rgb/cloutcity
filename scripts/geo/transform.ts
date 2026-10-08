/**
 * The pure half of `npm run geo:build`: raw upstream files in, the text of every derived file
 * out. No I/O, clock or randomness, inputs sorted by their codes and integer coordinates only,
 * so the same inputs always give byte-identical outputs (checked by the rebuild tests).
 *
 * Polygons go through one TopoJSON topology per source with no quantization, so neighbours
 * share exact arcs; arcs are simplified (Visvalingam, square metres) and then rounded to whole
 * metres while still shared, so adjacent boroughs and zones never open gaps between them.
 * Subway paths use Douglas-Peucker for a hard error bound. District buildings (buildings.ts)
 * and procedural blocks (blocks.ts) are built from the same pass, per quality tier.
 */
import { createHash } from 'node:crypto'
import type * as GeoJSON from 'geojson'
import { merge, feature } from 'topojson-client'
import { topology } from 'topojson-server'
import { planarTriangleArea, presimplify, simplify } from 'topojson-simplify'
import type {
  GeometryCollection,
  MultiPolygon as TopoMultiPolygon,
  Polygon as TopoPolygon,
  Topology,
} from 'topojson-specification'
import { z } from 'zod'
import {
  QUALITY_TIERS,
  type GeoConfig,
  type QualityTier,
} from '../../src/lib/data/schemas/config.ts'
import type { LandmarkModel } from '../../src/lib/data/schemas/landmarkModels.ts'
import { encodePath, encodeRing, type DeltaPolygon } from '../../src/lib/geo/codec.ts'
import { areaAt, nearestArea, prepareAreas, type PreparedArea } from '../../src/lib/geo/lookup.ts'
import {
  distanceToPolyline,
  interiorPoint,
  polygonArea,
  signedArea,
} from '../../src/lib/geo/polygon.ts'
import {
  ORIGIN,
  PROJECTION_ID,
  distanceM,
  project,
  type LocalPoint,
} from '../../src/lib/geo/projection.ts'
import { buildingSourceId, type GeoSourceId, type LionSourceId } from '../../src/lib/geo/sources.ts'
import { blocksFileText, buildBlocks, readDensity } from './blocks.ts'
import { buildingsFileText, districtTier, readDistrictFootprints } from './buildings.ts'
import { douglasPeucker } from './douglas-peucker.ts'
import { readGtfsSubway } from './gtfs.ts'
import { readLandmarkExclusions } from './landmark-exclusions.ts'
import { buildLandmarkFrames, type FramePlace } from './landmarks.ts'
import type { Lock } from './lock.ts'
import { renderSourcesMd, type TerminalExtension } from './sources-md.ts'

export interface GeoBoundsInput {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

export interface RawGeoInputs {
  /** Parsed JSON of the borough boundaries GeoJSON. */
  readonly boroughs: unknown
  /** Parsed JSON of the 2020 NTA GeoJSON. */
  readonly ntas: unknown
  /** The MTA subway GTFS zip, byte for byte as downloaded. */
  readonly gtfsZip: Uint8Array
  /** Parsed JSON of the MapPLUTO per-community-district statistics. */
  readonly density: unknown
  /** Paged source id (`oti-buildings-<district>`) → parsed JSON of each page, in order. */
  readonly buildings: ReadonlyMap<string, readonly unknown[]>
  /** Parsed NYC DCP LION GeoJSON, one exact-street query per source. */
  readonly lion: ReadonlyMap<LionSourceId, unknown>
}

export interface GeoBuildParams {
  readonly config: GeoConfig
  readonly bounds: GeoBoundsInput
  readonly lock: Lock
  /** Sanity counts for the upstream files: a partial download must fail the build. */
  readonly expected: {
    readonly boroughs: number
    readonly ntas: number
    /** Community districts with lot area in the MapPLUTO statistics. */
    readonly communityDistricts: number
  }
  /** data/landmarks/models.json and the landmarks.json places they model. */
  readonly landmarks: {
    readonly models: readonly LandmarkModel[]
    readonly places: readonly FramePlace[]
  }
}

/** One district at one tier, for the build log and the budget check. */
export interface DistrictStat {
  readonly district: string
  readonly tier: QualityTier
  readonly path: string
  /** Features downloaded for the district's bounding box. */
  readonly downloaded: number
  /** Footprint parts inside the circle and outside every landmark exclusion. */
  readonly inCircle: number
  /** Footprint parts dropped by a landmark exclusion (INT-7). */
  readonly excluded: number
  /** Footprints that passed the tier's area and height filters. */
  readonly footprints: number
  readonly masses: number
  readonly triangles: number
}

export interface BlockStat {
  readonly tier: QualityTier
  readonly path: string
  readonly instances: number
  readonly triangles: number
}

export interface GeoBuildResult {
  /** Path relative to data/ → file text. Sorted by path. */
  readonly files: ReadonlyMap<string, string>
  readonly terminalExtensions: readonly TerminalExtension[]
  /** Stations snapped to their nearest borough or zone (they sat just outside the shapes). */
  readonly stationFallbacks: readonly string[]
  /** Parks whose every ring was smaller than parkMinRingAreaM2. */
  readonly droppedParks: readonly string[]
  readonly districtStats: readonly DistrictStat[]
  readonly blockStats: readonly BlockStat[]
}

export const OUTPUT_FILES = {
  land: 'geo/land.derived.json',
  water: 'geo/water.derived.json',
  parks: 'geo/parks.derived.json',
  subway: 'geo/subway.derived.json',
  zones: 'zones/zones.derived.json',
  zoneShapes: 'zones/zone-shapes.derived.json',
  landmarkFrames: 'landmarks/frames.derived.json',
  manifest: 'geo/manifest.derived.json',
  sources: 'geo/SOURCES.md',
} as const

/** Per district and tier: counted against perf.json districtBuildingsGzKB (manifest group `district`). */
export const districtFilePath = (districtId: string, tier: QualityTier) =>
  `geo/districts/${districtId}.${tier}.derived.json`
/** Per tier: counted with the districts (manifest group `blocks`). */
export const blocksFilePath = (tier: QualityTier) => `geo/blocks.${tier}.derived.json`

/** Every per-tier output the config asks for, district files first. */
export function tieredOutputPaths(config: GeoConfig): { path: string; tier: QualityTier }[] {
  return [
    ...config.districts.flatMap((district) =>
      QUALITY_TIERS.map((tier) => ({ path: districtFilePath(district.id, tier), tier })),
    ),
    ...QUALITY_TIERS.map((tier) => ({ path: blocksFilePath(tier), tier })),
  ]
}

/** Shipped with the map (counted against perf.json baseGeoGzKB). Everything else is docs. */
const BASE_FILES: readonly string[] = [
  OUTPUT_FILES.land,
  OUTPUT_FILES.water,
  OUTPUT_FILES.parks,
  OUTPUT_FILES.subway,
  OUTPUT_FILES.zones,
  OUTPUT_FILES.zoneShapes,
  OUTPUT_FILES.landmarkFrames,
]

const DCP_NOTICE =
  'Simplified artwork derived from NYC Department of City Planning data; not the original data.'
const MTA_NOTICE = 'Simplified artwork derived from MTA static GTFS; not the original data.'
const LION_NOTICE =
  'Placements derived from NYC Department of City Planning LION street centerlines and ' +
  'borough boundaries; not the original data.'

const BOROUGH_IDS = {
  Manhattan: 'manhattan',
  Bronx: 'bronx',
  Brooklyn: 'brooklyn',
  Queens: 'queens',
  'Staten Island': 'staten-island',
} as const
type BoroName = keyof typeof BOROUGH_IDS
const BORO_NAMES = Object.keys(BOROUGH_IDS) as [BoroName, ...BoroName[]]

const CDTA_BOROUGH = {
  BK: 'brooklyn',
  BX: 'bronx',
  MN: 'manhattan',
  QN: 'queens',
  SI: 'staten-island',
} as const

/** "BK08 Crown Heights (North) (CD 8 Approximation)" → "Crown Heights (North)". */
const CDTA_NAME = /^[A-Z]{2}\d{2} (.+?) \((?:CD|JIA) \d+ (?:Equivalent|Approximation)\)$/
/** Community districts are numbered 1-18; joint interest areas 26 and up. */
const FIRST_JIA_NUMBER = 26

// ---- raw input validation ---------------------------------------------------------------

const PositionSchema = z.array(z.number()).min(2)
const PolygonCoordsSchema = z.array(z.array(PositionSchema).min(4)).min(1)
const GeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: PolygonCoordsSchema }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(PolygonCoordsSchema).min(1) }),
])
type RawGeometry = z.infer<typeof GeometrySchema>

function featureCollection<T extends z.ZodType>(properties: T) {
  return z.object({
    type: z.literal('FeatureCollection'),
    // ArcGIS sets this when a query hits maxRecordCount: the file would be silently partial.
    exceededTransferLimit: z.literal(false).optional(),
    features: z.array(
      z.object({ type: z.literal('Feature'), properties, geometry: GeometrySchema }),
    ),
  })
}

const BoroughsSchema = featureCollection(
  z.object({ BoroCode: z.int().min(1).max(5), BoroName: z.enum(BORO_NAMES) }),
)
const NtasSchema = featureCollection(
  z.object({
    BoroCode: z.int().min(1).max(5),
    BoroName: z.enum(BORO_NAMES),
    NTA2020: z.string().regex(/^(?:BK|BX|MN|QN|SI)\d{4}$/),
    NTAName: z.string().min(1),
    NTAType: z.enum(['0', '5', '6', '7', '8', '9']),
    CDTA2020: z.string().regex(/^(?:BK|BX|MN|QN|SI)\d{2}$/),
    CDTAName: z.string().regex(CDTA_NAME),
  }),
)

function parseRaw<T extends z.ZodType>(name: string, schema: T, json: unknown): z.output<T> {
  const result = schema.safeParse(json)
  if (!result.success) throw new Error(`Invalid ${name}:\n${z.prettifyError(result.error)}`)
  return result.data
}

// ---- helpers ----------------------------------------------------------------------------

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function header(sources: readonly GeoSourceId[], notice: string) {
  return {
    format: 'cc-geo-v1',
    derived: true,
    notice,
    sources,
    projection: { id: PROJECTION_ID, originLat: ORIGIN.lat, originLng: ORIGIN.lng },
  }
}

const toText = (value: unknown) => `${JSON.stringify(value)}\n`

function projectGeometry(geometry: RawGeometry): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  const ring = (positions: number[][]) =>
    positions.map(([lng = 0, lat = 0]) => {
      const { x, y } = project({ lat, lng })
      return [x, y]
    })
  return geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: geometry.coordinates.map(ring) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map(ring)) }
}

type ShapeTopology = Topology<{ shapes: GeometryCollection<{ key: string }> }>

/** A shared-arc topology, simplified, with arcs rounded to the output grid. */
function simplifiedTopology(
  shapes: readonly { key: string; geometry: RawGeometry }[],
  minWeightM2: number,
  quantumM: number,
): ShapeTopology {
  const collection: GeoJSON.FeatureCollection<
    GeoJSON.Polygon | GeoJSON.MultiPolygon,
    { key: string }
  > = {
    type: 'FeatureCollection',
    features: shapes.map((shape) => ({
      type: 'Feature',
      properties: { key: shape.key },
      geometry: projectGeometry(shape.geometry),
    })),
  }
  const built = topology({ shapes: collection }) as ShapeTopology
  const simplified = simplify(presimplify(built, planarTriangleArea), minWeightM2)
  const snap = (value: number) => Math.round(value / quantumM) * quantumM
  return {
    ...simplified,
    arcs: simplified.arcs.map((arc) => arc.map(([x = 0, y = 0]) => [snap(x), snap(y)])),
  }
}

/** GeoJSON rings (closed) → open, de-duplicated, oriented integer rings; tiny rings dropped. */
function cleanPolygons(geometry: GeoJSON.Geometry | null, minRingAreaM2: number): LocalPoint[][][] {
  if (geometry === null) return []
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : []
  const out: LocalPoint[][][] = []
  const big = (ring: LocalPoint[]) =>
    ring.length >= 3 && Math.abs(signedArea(ring)) >= minRingAreaM2
  for (const [outerPositions, ...holePositions] of polygons) {
    if (outerPositions === undefined) continue
    const outer = openRing(outerPositions)
    // A collapsed or tiny outer ring takes its holes with it.
    if (!big(outer)) continue
    const holes = holePositions.map(openRing).filter(big)
    out.push([orient(outer, true), ...holes.map((hole) => orient(hole, false))])
  }
  return out
}

function openRing(positions: GeoJSON.Position[]): LocalPoint[] {
  const points: LocalPoint[] = []
  for (const [x = 0, y = 0] of positions) {
    const last = points[points.length - 1]
    if (last !== undefined && last.x === x && last.y === y) continue
    points.push({ x, y })
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length > 1 && first !== undefined && last !== undefined) {
    if (first.x === last.x && first.y === last.y) points.pop()
  }
  return points
}

/** Outer rings counter-clockwise (positive area with y north), holes clockwise. */
function orient(ring: LocalPoint[], counterClockwise: boolean): LocalPoint[] {
  return signedArea(ring) > 0 === counterClockwise ? ring : [...ring].reverse()
}

const encodePolygons = (polygons: readonly LocalPoint[][][]): DeltaPolygon[] =>
  polygons.map((polygon) => polygon.map(encodeRing))

type ShapeGeometry = TopoPolygon<{ key: string }> | TopoMultiPolygon<{ key: string }>

function shapesByKey(topo: ShapeTopology): Map<string, ShapeGeometry> {
  const map = new Map<string, ShapeGeometry>()
  for (const geometry of topo.objects.shapes.geometries) {
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      throw new Error(`geo build: unexpected ${geometry.type} in a polygon topology`)
    }
    const key = geometry.properties?.key
    if (key === undefined) throw new Error('geo build: topology geometry lost its key')
    map.set(key, geometry)
  }
  return map
}

/** The geometry's coordinates, rebuilt from the (simplified, rounded) shared arcs. */
function geometryFromTopology(topo: ShapeTopology, geometry: ShapeGeometry): GeoJSON.Geometry {
  return geometry.type === 'Polygon'
    ? feature(topo, geometry).geometry
    : feature(topo, geometry).geometry
}

function largestPolygon(polygons: readonly LocalPoint[][][]): LocalPoint[][] {
  let best: LocalPoint[][] | undefined
  let bestArea = -Infinity
  for (const polygon of polygons) {
    const area = polygonArea(polygon)
    if (area > bestArea) {
      best = polygon
      bestArea = area
    }
  }
  if (best === undefined) throw new Error('geo build: zone has no polygons')
  return best
}

/** Area lookup for a station, snapping to the nearest area within the fallback distance. */
function locate(
  point: LocalPoint,
  areas: readonly PreparedArea[],
  maxM: number,
  label: string,
  fallbacks: string[],
): string {
  const inside = areaAt(point, areas)
  if (inside !== undefined) return inside
  const nearest = nearestArea(point, areas)
  if (nearest === undefined || nearest.distanceM > maxM) {
    throw new Error(`geo build: ${label} is more than ${maxM} m from any area`)
  }
  fallbacks.push(`${label} → ${nearest.id} (${Math.round(nearest.distanceM)} m)`)
  return nearest.id
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// ---- the build --------------------------------------------------------------------------

export function buildGeoOutputs(raw: RawGeoInputs, params: GeoBuildParams): GeoBuildResult {
  const { config, bounds, lock, expected } = params
  const boroughs = parseRaw('borough boundaries', BoroughsSchema, raw.boroughs)
  const ntas = parseRaw('NTA 2020', NtasSchema, raw.ntas)
  if (boroughs.features.length !== expected.boroughs) {
    throw new Error(`Expected ${expected.boroughs} boroughs, got ${boroughs.features.length}`)
  }
  if (ntas.features.length !== expected.ntas) {
    throw new Error(`Expected ${expected.ntas} NTAs, got ${ntas.features.length}`)
  }

  // 1. Land: one entry per borough, by BoroCode.
  const boroughFeatures = [...boroughs.features].sort(
    (a, b) => a.properties.BoroCode - b.properties.BoroCode,
  )
  const boroughTopo = simplifiedTopology(
    boroughFeatures.map((f) => ({ key: String(f.properties.BoroCode), geometry: f.geometry })),
    config.landMinWeightM2,
    config.quantumM,
  )
  const boroughGeometries = shapesByKey(boroughTopo)
  const land = boroughFeatures.map((f) => {
    const geometry = boroughGeometries.get(String(f.properties.BoroCode))
    if (geometry === undefined) throw new Error(`geo build: borough ${f.properties.BoroCode} lost`)
    const polygons = cleanPolygons(
      geometryFromTopology(boroughTopo, geometry),
      config.landMinRingAreaM2,
    )
    if (polygons.length === 0)
      throw new Error(`geo build: ${f.properties.BoroName} has no land left`)
    return {
      id: BOROUGH_IDS[f.properties.BoroName],
      boroCode: f.properties.BoroCode,
      polygons: encodePolygons(polygons),
    }
  })
  if (new Set(land.map((b) => b.id)).size !== land.length) {
    throw new Error('geo build: duplicate borough')
  }

  // 2. Zones (one per CDTA) and 3. parks, from one NTA topology so they line up exactly.
  const ntaFeatures = [...ntas.features].sort((a, b) =>
    byString(a.properties.NTA2020, b.properties.NTA2020),
  )
  // An NTA's own BoroName can differ from its CDTA's borough (Rikers Island is in the Bronx
  // but in Queens CD 1), so zones take their borough from the CDTA code.
  for (const { NTA2020, CDTA2020 } of ntaFeatures.map((f) => f.properties)) {
    if (!NTA2020.startsWith(CDTA2020)) throw new Error(`NTA ${NTA2020} is not in CDTA ${CDTA2020}`)
  }
  const ntaTopo = simplifiedTopology(
    ntaFeatures.map((f) => ({ key: f.properties.NTA2020, geometry: f.geometry })),
    config.zoneMinWeightM2,
    config.quantumM,
  )
  const ntaGeometries = shapesByKey(ntaTopo)
  const geometryOf = (code: string) => {
    const geometry = ntaGeometries.get(code)
    if (geometry === undefined) throw new Error(`geo build: NTA ${code} lost`)
    return geometry
  }

  const cdtaCodes = [...new Set(ntaFeatures.map((f) => f.properties.CDTA2020))].sort(byString)
  const zoneMeta = []
  const zoneShapes = []
  for (const cdta of cdtaCodes) {
    const members = ntaFeatures.filter((f) => f.properties.CDTA2020 === cdta)
    const first = members[0]
    if (first === undefined) continue
    const names = new Set(members.map((f) => f.properties.CDTAName))
    if (names.size !== 1) throw new Error(`CDTA ${cdta} has more than one name`)
    const name = CDTA_NAME.exec(first.properties.CDTAName)?.[1]
    if (name === undefined) throw new Error(`CDTA ${cdta}: unexpected name format`)
    const merged = merge(
      ntaTopo,
      members.map((f) => geometryOf(f.properties.NTA2020)),
    )
    const polygons = cleanPolygons(merged, config.zoneMinRingAreaM2)
    if (polygons.length === 0) throw new Error(`geo build: zone ${cdta} has no area left`)
    const id = cdta.toLowerCase()
    zoneShapes.push({ id, polygons: encodePolygons(polygons) })
    zoneMeta.push({
      id,
      cdtaCode: cdta,
      kind: Number(cdta.slice(2)) < FIRST_JIA_NUMBER ? 'district' : 'joint-interest-area',
      name,
      borough: CDTA_BOROUGH[cdta.slice(0, 2) as keyof typeof CDTA_BOROUGH],
      ntaCodes: members.map((f) => f.properties.NTA2020),
      centroid: interiorPoint(largestPolygon(polygons)),
    })
  }

  const parks = []
  const droppedParks: string[] = []
  for (const f of ntaFeatures) {
    const kind =
      f.properties.NTAType === '9' ? 'park' : f.properties.NTAType === '7' ? 'cemetery' : undefined
    if (kind === undefined) continue
    const code = f.properties.NTA2020
    const polygons = cleanPolygons(
      geometryFromTopology(ntaTopo, geometryOf(code)),
      config.parkMinRingAreaM2,
    )
    if (polygons.length === 0) {
      droppedParks.push(code)
      continue
    }
    parks.push({
      id: `park-${code.toLowerCase()}`,
      ntaCode: code,
      kind,
      borough: BOROUGH_IDS[f.properties.BoroName],
      polygons: encodePolygons(polygons),
    })
  }

  // 4. Water: the sea is the extent (plus a margin), drawn under the land.
  const southWest = project({ lat: bounds.south, lng: bounds.west })
  const northEast = project({ lat: bounds.north, lng: bounds.east })
  const minX = Math.floor(southWest.x - config.waterMarginM)
  const minY = Math.floor(southWest.y - config.waterMarginM)
  const maxX = Math.ceil(northEast.x + config.waterMarginM)
  const maxY = Math.ceil(northEast.y + config.waterMarginM)
  const sea = [
    encodeRing([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]),
  ]

  // 5. Subway.
  const gtfs = readGtfsSubway(raw.gtfsZip)
  const snap = (point: LocalPoint) => ({
    x: Math.round(point.x / config.quantumM) * config.quantumM,
    y: Math.round(point.y / config.quantumM) * config.quantumM,
  })
  const routePaths = new Map<string, LocalPoint[][]>()
  for (const route of gtfs.routes) {
    const candidates = route.shapeIds
      .map((id) => ({ id, points: gtfs.shapes.get(id) ?? [] }))
      .sort((a, b) => b.points.length - a.points.length || byString(a.id, b.id))
    const kept: LocalPoint[][] = []
    for (const candidate of candidates) {
      const simplified = douglasPeucker(candidate.points.map(project), config.subwayToleranceM)
      const path = openPath(simplified.map(snap))
      if (path.length < 2) continue
      const covered =
        kept.length > 0 &&
        path.every((vertex) =>
          kept.some((other) => distanceToPolyline(vertex, other) <= config.subwayDedupCoverM),
        )
      if (!covered) kept.push(path)
    }
    if (kept.length === 0) throw new Error(`geo build: route ${route.routeId} has no shape`)
    routePaths.set(route.routeId, kept)
  }

  const stationPoints = gtfs.stations.map((station) => ({
    station,
    point: snap(project(station.location)),
  }))
  const terminalExtensions: TerminalExtension[] = []
  for (const route of gtfs.routes) {
    const paths = routePaths.get(route.routeId) ?? []
    for (const { station, point } of stationPoints) {
      if (!station.routeIds.includes(route.routeId)) continue
      const gap = Math.min(...paths.map((path) => distanceToPolyline(point, path)))
      if (gap <= config.stationOnLineToleranceM) continue
      // Some shapes stop short of the last station (the Q at 96 St): extend the nearest end.
      let best: { path: LocalPoint[]; atStart: boolean; distance: number } | undefined
      for (const path of paths) {
        const start = path[0]
        const end = path[path.length - 1]
        if (start === undefined || end === undefined) continue
        for (const [endpoint, atStart] of [
          [start, true],
          [end, false],
        ] as const) {
          const distance = distanceM(point, endpoint)
          if (best === undefined || distance < best.distance) best = { path, atStart, distance }
        }
      }
      if (best === undefined || best.distance > config.terminalGapMaxM) {
        throw new Error(
          `geo build: station ${station.stopId} is ${Math.round(gap)} m from route ${route.routeId} and not near a terminal`,
        )
      }
      if (best.atStart) best.path.unshift(point)
      else best.path.push(point)
      terminalExtensions.push({
        lineId: route.routeId.toLowerCase(),
        stationId: station.stopId.toLowerCase(),
        gapM: Math.round(best.distance),
      })
    }
  }

  const landAreas = prepareAreas(land)
  const zoneAreas = prepareAreas(zoneShapes)
  const stationFallbacks: string[] = []
  const stations = stationPoints.map(({ station, point }) => {
    if (station.routeIds.length === 0) {
      throw new Error(`geo build: station ${station.stopId} is served by no route`)
    }
    const label = `station ${station.stopId}`
    const maxM = config.stationAreaFallbackM
    return {
      id: station.stopId.toLowerCase(),
      gtfsStopId: station.stopId,
      name: station.name,
      x: point.x,
      y: point.y,
      borough: locate(point, landAreas, maxM, `${label} borough`, stationFallbacks),
      zoneId: locate(point, zoneAreas, maxM, `${label} zone`, stationFallbacks),
      lines: station.routeIds.map((id) => id.toLowerCase()),
    }
  })
  const lines = gtfs.routes.map((route) => ({
    id: route.routeId.toLowerCase(),
    gtfsRouteId: route.routeId,
    label: route.shortName,
    paths: (routePaths.get(route.routeId) ?? []).map(encodePath),
  }))

  const dcpBoroughs: GeoSourceId[] = ['dcp-borough-boundaries']
  const dcpNtas: GeoSourceId[] = ['dcp-nta-2020']

  // 6. Landmark frames, oriented by LION streets and checked against the land just built.
  const landmarkFrames = buildLandmarkFrames(
    { lion: raw.lion, ...params.landmarks },
    landAreas,
    config,
  )
  const landmarkFramesFile = {
    ...header([...dcpBoroughs, ...landmarkFrames.sources], LION_NOTICE),
    landmarks: landmarkFrames.frames,
  }

  // 7. District buildings, per district and tier, clear of every landmark's ground (INT-7).
  const exclusions = readLandmarkExclusions(landmarkFramesFile)
  const tiered = new Map<string, { group: 'district' | 'blocks'; tier: QualityTier }>()
  const tieredFiles = new Map<string, string>()
  const districtStats: DistrictStat[] = []
  for (const district of config.districts) {
    const sourceId = buildingSourceId(district.id)
    const entry = lock.pagedSources.find((source) => source.id === sourceId)
    const pages = raw.buildings.get(sourceId)
    if (entry === undefined || pages === undefined) {
      throw new Error(`geo build: no building footprints for district ${district.id}`)
    }
    const read = readDistrictFootprints(district, pages, entry.count, {
      tiers: config.buildingTiers,
      exclusions,
    })
    for (const tier of QUALITY_TIERS) {
      const buildings = districtTier(district, read.footprints, config.buildingTiers.tiers[tier])
      const path = districtFilePath(district.id, tier)
      tieredFiles.set(path, buildingsFileText(district, tier, buildings))
      tiered.set(path, { group: 'district', tier })
      districtStats.push({
        district: district.id,
        tier,
        path,
        downloaded: read.downloaded,
        inCircle: read.footprints.length,
        excluded: read.excluded,
        footprints: buildings.footprints,
        masses: buildings.h.length,
        triangles: buildings.triangles,
      })
    }
  }

  // 8. Procedural blocks everywhere else, per tier.
  const density = readDensity(raw.density, expected.communityDistricts)
  const blockInputs = {
    land,
    parks,
    zoneShapes,
    districtZoneIds: new Set(zoneMeta.filter((z) => z.kind === 'district').map((z) => z.id)),
    density,
    districts: config.districts,
    exclusions,
  }
  const blockStats: BlockStat[] = []
  for (const tier of QUALITY_TIERS) {
    const blocks = buildBlocks(blockInputs, config.blocks, tier)
    if (blocks.instances > config.blocks.maxInstances[tier]) {
      throw new Error(
        `geo build: ${blocks.instances} ${tier} blocks exceed blocks.maxInstances.${tier} (${config.blocks.maxInstances[tier]})`,
      )
    }
    const path = blocksFilePath(tier)
    tieredFiles.set(path, blocksFileText(tier, blocks))
    tiered.set(path, { group: 'blocks', tier })
    blockStats.push({ tier, path, instances: blocks.instances, triangles: blocks.triangles })
  }

  // 9. Files, manifest and SOURCES.md.
  const files = new Map<string, string>([
    [OUTPUT_FILES.land, toText({ ...header(dcpBoroughs, DCP_NOTICE), boroughs: land })],
    [OUTPUT_FILES.water, toText({ ...header(dcpBoroughs, DCP_NOTICE), sea })],
    [OUTPUT_FILES.parks, toText({ ...header(dcpNtas, DCP_NOTICE), parks })],
    [
      OUTPUT_FILES.subway,
      toText({ ...header(['mta-gtfs-subway'], MTA_NOTICE), lines, stations, terminalExtensions }),
    ],
    [OUTPUT_FILES.zones, toText({ ...header(dcpNtas, DCP_NOTICE), zones: zoneMeta })],
    [OUTPUT_FILES.zoneShapes, toText({ ...header(dcpNtas, DCP_NOTICE), zones: zoneShapes })],
    [OUTPUT_FILES.landmarkFrames, toText(landmarkFramesFile)],
    [OUTPUT_FILES.sources, renderSourcesMd(lock, config, terminalExtensions)],
    ...tieredFiles,
  ])
  const manifestFiles = [...files.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([path, text]) => {
      const tier = tiered.get(path)
      return {
        path,
        group: tier?.group ?? (BASE_FILES.includes(path) ? 'base' : 'docs'),
        ...(tier === undefined ? {} : { tier: tier.tier }),
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
      }
    })
  files.set(OUTPUT_FILES.manifest, toText({ format: 'cc-geo-manifest-v1', files: manifestFiles }))

  return {
    files: new Map([...files.entries()].sort(([a], [b]) => byString(a, b))),
    terminalExtensions,
    stationFallbacks,
    droppedParks,
    districtStats,
    blockStats,
  }
}

/** Drops consecutive duplicate vertices (rounding can merge neighbours). */
function openPath(points: readonly LocalPoint[]): LocalPoint[] {
  const out: LocalPoint[] = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last === undefined || last.x !== point.x || last.y !== point.y) out.push(point)
  }
  return out
}
