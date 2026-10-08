/**
 * District building masses (S04d): NYC OTI building footprints with roof heights in, one
 * `cc-buildings-v1` file per district and quality tier out. Pure and deterministic like the rest
 * of the geo build.
 *
 * Per district: footprints whose centroid lies in the district circle (and outside every
 * landmark's exclusion rectangle, INT-7) are projected and snapped to the metre grid. Per tier:
 * small and (on low) short footprints are dropped, heights are rounded into bins, touching
 * footprints of one bin are merged through a shared-arc topology (holes allowed), and every
 * ring is simplified with Douglas-Peucker. Only geometry and heights are kept: the source query
 * never asks for a name and the output schema allows numbers only.
 */
import type * as GeoJSON from 'geojson'
import { merge } from 'topojson-client'
import { topology } from 'topojson-server'
import type {
  GeometryCollection,
  MultiPolygon as TopoMultiPolygon,
  Polygon as TopoPolygon,
  Topology,
} from 'topojson-specification'
import { z } from 'zod'
import type {
  BuildingTier,
  BuildingTiers,
  GeoDistrict,
  QualityTier,
} from '../../src/lib/data/schemas/config.ts'
import { encodeRing, type DeltaPolygon } from '../../src/lib/geo/codec.ts'
import { bboxOf, polygonArea, polygonCentroid, signedArea } from '../../src/lib/geo/polygon.ts'
import {
  ORIGIN,
  PROJECTION_ID,
  distanceM,
  project,
  type LocalPoint,
} from '../../src/lib/geo/projection.ts'
import { buildingSourceId } from '../../src/lib/geo/sources.ts'
import { douglasPeuckerRing } from './douglas-peucker.ts'
import { insideAnyExclusion, type LandmarkExclusion } from './landmark-exclusions.ts'

export const FEET_TO_METRES = 0.3048

export const OTI_NOTICE =
  'Simplified artwork derived from NYC OTI building footprints; not the original data.'

const PositionSchema = z.array(z.number()).min(2)
const RingSchema = z.array(PositionSchema).min(4)
const FootprintGeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(RingSchema).min(1) }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(RingSchema).min(1)).min(1),
  }),
])
/** One page of the OTI query. Properties are strict: anything but HEIGHT_ROOF fails the build. */
const FootprintPageSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      properties: z.strictObject({ HEIGHT_ROOF: z.number().nullable() }),
      geometry: FootprintGeometrySchema,
    }),
  ),
  properties: z.object({ exceededTransferLimit: z.boolean().optional() }).optional(),
  exceededTransferLimit: z.boolean().optional(),
})
type FootprintGeometry = z.infer<typeof FootprintGeometrySchema>

/** HEIGHT_ROOF (feet) → whole metres; missing, zero or negative → the configured default. */
export function heightMetres(heightRoofFt: number | null, defaultHeightM: number): number {
  if (heightRoofFt === null || !(heightRoofFt > 0)) return defaultHeightM
  return Math.max(1, Math.round(heightRoofFt * FEET_TO_METRES))
}

/** Rounds a height to its bin (never below one bin, so no mass is flat). */
export const binHeight = (heightM: number, binM: number) =>
  Math.max(binM, Math.round(heightM / binM) * binM)

/** A footprint part in local metres, snapped to the grid: outer ring CCW, holes CW. */
export interface Footprint {
  readonly rings: readonly (readonly LocalPoint[])[]
  readonly heightM: number
  readonly areaM2: number
}

export interface DistrictFootprints {
  readonly footprints: readonly Footprint[]
  /** Features in the downloaded pages (they cover the circle's bounding box). */
  readonly downloaded: number
  /** Footprint parts whose centroid fell inside the circle but inside a landmark exclusion. */
  readonly excluded: number
}

/** Drops consecutive duplicates and the closing vertex. */
function openRing(points: readonly LocalPoint[]): LocalPoint[] {
  const out: LocalPoint[] = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last === undefined || last.x !== point.x || last.y !== point.y) out.push(point)
  }
  const first = out[0]
  const last = out[out.length - 1]
  if (out.length > 1 && first !== undefined && last !== undefined) {
    if (first.x === last.x && first.y === last.y) out.pop()
  }
  return out
}

const orient = (ring: LocalPoint[], counterClockwise: boolean) =>
  signedArea(ring) > 0 === counterClockwise ? ring : [...ring].reverse()

const usable = (ring: readonly LocalPoint[]) => ring.length >= 3 && signedArea(ring) !== 0

function snapRing(positions: readonly number[][], quantumM: number): LocalPoint[] {
  const snap = (value: number) => Math.round(value / quantumM) * quantumM
  return openRing(
    positions.map(([lng = 0, lat = 0]) => {
      const { x, y } = project({ lat, lng })
      return { x: snap(x), y: snap(y) }
    }),
  )
}

function parts(geometry: FootprintGeometry): number[][][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
}

/**
 * Validates the pages of one district's download and turns them into snapped footprints.
 * `expectedCount` is the lock's returnCountOnly total: a partial download fails the build.
 */
export function readDistrictFootprints(
  district: GeoDistrict,
  pages: readonly unknown[],
  expectedCount: number,
  params: { readonly tiers: BuildingTiers; readonly exclusions: readonly LandmarkExclusion[] },
): DistrictFootprints {
  const id = buildingSourceId(district.id)
  const centre = project(district.center)
  const footprints: Footprint[] = []
  let downloaded = 0
  let excluded = 0
  pages.forEach((json, index) => {
    const result = FootprintPageSchema.safeParse(json)
    if (!result.success) {
      throw new Error(`Invalid ${id} page ${index}:\n${z.prettifyError(result.error)}`)
    }
    const page = result.data
    const more =
      page.properties?.exceededTransferLimit === true || page.exceededTransferLimit === true
    if (more !== index < pages.length - 1) {
      throw new Error(`${id}: page ${index} of ${pages.length} has the wrong truncation flag`)
    }
    downloaded += page.features.length
    for (const feature of page.features) {
      const heightM = heightMetres(feature.properties.HEIGHT_ROOF, params.tiers.defaultHeightM)
      for (const [outerPositions, ...holePositions] of parts(feature.geometry)) {
        if (outerPositions === undefined) continue
        const exact = outerPositions.map(([lng = 0, lat = 0]) => project({ lat, lng }))
        const centroid = polygonCentroid([exact])
        if (distanceM(centroid, centre) > district.radiusM) continue
        if (insideAnyExclusion(centroid, params.exclusions)) {
          excluded++
          continue
        }
        const outer = snapRing(outerPositions, params.tiers.quantumM)
        if (!usable(outer)) continue
        const holes = holePositions
          .map((positions) => snapRing(positions, params.tiers.quantumM))
          .filter(usable)
          .map((hole) => orient(hole, false))
        const rings = [orient(outer, true), ...holes]
        footprints.push({ rings, heightM, areaM2: polygonArea(rings) })
      }
    }
  })
  if (downloaded !== expectedCount) {
    throw new Error(`${id}: expected ${expectedCount} footprints (lock count), got ${downloaded}`)
  }
  return { footprints, downloaded, excluded }
}

/** Roof (earcut: vertices + 2 × holes − 2) plus two triangles per wall segment. */
export function massTriangles(rings: readonly (readonly LocalPoint[])[]): number {
  const vertices = rings.reduce((sum, ring) => sum + ring.length, 0)
  const holes = rings.length - 1
  return vertices + 2 * holes - 2 + 2 * vertices
}

interface Mass {
  readonly heightM: number
  readonly rings: readonly (readonly LocalPoint[])[]
}

/** Simplifies a polygon's rings; holes smaller than `minAreaM2` after simplifying are dropped. */
function simplifyPolygon(
  rings: readonly (readonly LocalPoint[])[],
  tier: BuildingTier,
): LocalPoint[][] | undefined {
  const [outer, ...holes] = rings
  if (outer === undefined) return undefined
  const simplifiedOuter = douglasPeuckerRing(outer, tier.simplifyM)
  if (!usable(simplifiedOuter)) return undefined
  const kept = holes
    .map((hole) => douglasPeuckerRing(hole, tier.simplifyM))
    .filter((hole) => usable(hole) && Math.abs(signedArea(hole)) >= tier.minAreaM2)
  return [orient(simplifiedOuter, true), ...kept.map((hole) => orient(hole, false))]
}

type BinTopology = Topology<{ shapes: GeometryCollection<{ bin: number }> }>

/** Touching footprints of one bin become one polygon (shared arcs dissolve; holes may appear). */
function mergeByBin(footprints: readonly { rings: Footprint['rings']; bin: number }[]): Mass[] {
  const collection: GeoJSON.FeatureCollection<GeoJSON.Polygon, { bin: number }> = {
    type: 'FeatureCollection',
    features: footprints.map((footprint) => ({
      type: 'Feature',
      properties: { bin: footprint.bin },
      geometry: {
        type: 'Polygon',
        coordinates: footprint.rings.map((ring) => {
          const closed = [...ring, ring[0] ?? { x: 0, y: 0 }]
          return closed.map((point) => [point.x, point.y])
        }),
      },
    })),
  }
  const topo = topology({ shapes: collection }) as BinTopology
  const byBin = new Map<number, (TopoPolygon | TopoMultiPolygon)[]>()
  for (const geometry of topo.objects.shapes.geometries) {
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      throw new Error(`geo build: unexpected ${geometry.type} in a building topology`)
    }
    const bin = geometry.properties?.bin
    if (bin === undefined) throw new Error('geo build: building topology lost its height bin')
    const list = byBin.get(bin) ?? []
    list.push(geometry)
    byBin.set(bin, list)
  }
  const masses: Mass[] = []
  for (const bin of [...byBin.keys()].sort((a, b) => a - b)) {
    const merged = merge(topo, byBin.get(bin) ?? [])
    for (const polygon of merged.coordinates) {
      const rings = polygon.map((ring) => openRing(ring.map(([x = 0, y = 0]) => ({ x, y }))))
      if (rings[0] === undefined || !usable(rings[0])) continue
      masses.push({ heightM: bin, rings })
    }
  }
  return masses
}

export interface TierBuildings {
  /** Heights in whole metres, one per mass. */
  readonly h: number[]
  /** [outer, ...holes] per mass, delta-encoded relative to `origin`. */
  readonly r: DeltaPolygon[]
  readonly origin: LocalPoint
  /** Footprints that passed the tier's area and height filters. */
  readonly footprints: number
  readonly triangles: number
}

/** One district at one tier. Masses are sorted by position, then height, for stable output. */
export function districtTier(
  district: GeoDistrict,
  footprints: readonly Footprint[],
  tier: BuildingTier,
): TierBuildings {
  const centre = project(district.center)
  const origin = { x: Math.round(centre.x), y: Math.round(centre.y) }
  // On merging tiers the area filter applies to the merged mass, so a terrace of small row
  // houses survives as one block instead of vanishing house by house.
  const kept = footprints
    .filter((f) => f.heightM >= tier.minHeightM && (tier.merge || f.areaM2 >= tier.minAreaM2))
    .map((f) => ({ rings: f.rings, bin: binHeight(f.heightM, tier.heightBinM) }))
  const raw: Mass[] = tier.merge
    ? mergeByBin(kept).filter((mass) => polygonArea(mass.rings) >= tier.minAreaM2)
    : kept.map((f) => ({ heightM: f.bin, rings: f.rings }))

  const masses: Mass[] = []
  for (const mass of raw) {
    const rings = simplifyPolygon(mass.rings, tier)
    if (rings !== undefined) masses.push({ heightM: mass.heightM, rings })
  }
  const keyed = masses.map((mass) => ({ mass, box: bboxOf(mass.rings[0] ?? []) }))
  keyed.sort(
    (a, b) =>
      a.box.minY - b.box.minY ||
      a.box.minX - b.box.minX ||
      a.mass.heightM - b.mass.heightM ||
      a.box.maxY - b.box.maxY ||
      a.box.maxX - b.box.maxX,
  )
  const relative = (ring: readonly LocalPoint[]) =>
    ring.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y }))
  return {
    h: keyed.map(({ mass }) => mass.heightM),
    r: keyed.map(({ mass }) => mass.rings.map((ring) => encodeRing(relative(ring)))),
    origin,
    footprints: kept.length,
    triangles: keyed.reduce((sum, { mass }) => sum + massTriangles(mass.rings), 0),
  }
}

/** The text of `geo/districts/<id>.<tier>.derived.json`. */
export function buildingsFileText(
  district: GeoDistrict,
  tier: QualityTier,
  buildings: TierBuildings,
): string {
  return `${JSON.stringify({
    format: 'cc-buildings-v1',
    derived: true,
    notice: OTI_NOTICE,
    sources: [buildingSourceId(district.id)],
    projection: { id: PROJECTION_ID, originLat: ORIGIN.lat, originLng: ORIGIN.lng },
    district: district.id,
    tier,
    origin: buildings.origin,
    h: buildings.h,
    r: buildings.r,
  })}\n`
}
