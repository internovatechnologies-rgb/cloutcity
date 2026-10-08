/**
 * Procedural low blocks for everywhere outside the building districts (S04d): one jittered grid
 * per quality tier and borough, rotated to the borough's street grid. A grid point gets a block
 * with a chance set by its community district's floor-area ratio (MapPLUTO), and a height from
 * the district's average floors. Points in a district circle, a park or cemetery, the water, or
 * a joint interest area (airports, big parks) get none, and neither does a block that would touch
 * a landmark's exclusion rectangle (INT-7).
 *
 * Randomness comes only from src/engine/rng.ts, seeded per tier, borough and grid cell, so a
 * block never moves when an unrelated part of the city changes.
 */
import { z } from 'zod'
import { createRng, mixSeed } from '../../src/engine/rng.ts'
import {
  QUALITY_TIERS,
  type BlocksConfig,
  type GeoDistrict,
  type QualityTier,
} from '../../src/lib/data/schemas/config.ts'
import { decodeRing, encodePath } from '../../src/lib/geo/codec.ts'
import { areaAt, prepareAreas, type EncodedArea } from '../../src/lib/geo/lookup.ts'
import { pointInPolygon } from '../../src/lib/geo/polygon.ts'
import {
  ORIGIN,
  PROJECTION_ID,
  distanceM,
  project,
  type LocalPoint,
} from '../../src/lib/geo/projection.ts'
import type { DerivedSourceId } from '../../src/lib/geo/sources.ts'
import { insideAnyExclusion, type LandmarkExclusion } from './landmark-exclusions.ts'

export const BLOCKS_NOTICE =
  'Procedural artwork whose density follows NYC Department of City Planning MapPLUTO statistics; not the original data.'

/** Triangles of one block: a box without its bottom face. */
export const BLOCK_TRIANGLES = 10

// ---- MapPLUTO density -------------------------------------------------------------------

const CDTA_PREFIX: Readonly<Record<number, string>> = {
  1: 'MN',
  2: 'BX',
  3: 'BK',
  4: 'QN',
  5: 'SI',
}
/** Community districts are numbered 1-18; joint interest areas 26 and up (as in transform.ts). */
const FIRST_JIA_NUMBER = 26

/** MapPLUTO's `CD` (borough digit + two-digit district, e.g. 401) → CDTA code (QN01). */
export function cdToCdta(cd: number): string | undefined {
  const prefix = CDTA_PREFIX[Math.floor(cd / 100)]
  const number = cd % 100
  if (prefix === undefined || !Number.isInteger(cd) || number === 0) return undefined
  return `${prefix}${String(number).padStart(2, '0')}`
}

const DensitySchema = z.object({
  features: z.array(
    z.object({
      attributes: z.strictObject({
        lots: z.int().nonnegative(),
        bldgArea: z.number().nonnegative().nullable(),
        lotArea: z.number().nonnegative().nullable(),
        avgFloors: z.number().nonnegative().nullable(),
        CD: z.int().nullable(),
      }),
    }),
  ),
  exceededTransferLimit: z.literal(false).optional(),
})

export interface ZoneDensity {
  /** Floor-area ratio: total building floor area over total lot area. */
  readonly far: number
  /** Mean NumFloors over the district's lots. */
  readonly avgFloors: number
}

/**
 * Zone id (lower-case CDTA code) → density, for community districts only. Fails unless exactly
 * `expectedCommunityDistricts` districts carry lot area (a partial response must not build).
 */
export function readDensity(
  json: unknown,
  expectedCommunityDistricts: number,
): Map<string, ZoneDensity> {
  const result = DensitySchema.safeParse(json)
  if (!result.success) {
    throw new Error(`Invalid MapPLUTO density:\n${z.prettifyError(result.error)}`)
  }
  const density = new Map<string, ZoneDensity>()
  for (const { attributes } of result.data.features) {
    const { CD, bldgArea, lotArea, avgFloors } = attributes
    if (CD === null || CD % 100 >= FIRST_JIA_NUMBER) continue
    const cdta = cdToCdta(CD)
    if (cdta === undefined) throw new Error(`MapPLUTO: unexpected community district ${CD}`)
    if (lotArea === null || lotArea <= 0) continue
    density.set(cdta.toLowerCase(), {
      far: (bldgArea ?? 0) / lotArea,
      avgFloors: avgFloors ?? 1,
    })
  }
  if (density.size !== expectedCommunityDistricts) {
    throw new Error(
      `MapPLUTO: expected ${expectedCommunityDistricts} community districts, got ${density.size}`,
    )
  }
  return density
}

/** Chance that a grid point gets a block: rises with FAR, full at `fullFar`. */
export const fillChance = (far: number, fullFar: number) => Math.min(1, Math.max(0, far / fullFar))

// ---- the grid ----------------------------------------------------------------------------

export interface BlocksInputs {
  readonly land: readonly (EncodedArea & { readonly boroCode: number })[]
  readonly parks: readonly EncodedArea[]
  readonly zoneShapes: readonly EncodedArea[]
  /** Zone ids of kind `district` (community districts). */
  readonly districtZoneIds: ReadonlySet<string>
  readonly density: ReadonlyMap<string, ZoneDensity>
  readonly districts: readonly GeoDistrict[]
  /** Landmark grounds (frames.derived.json `landmarks[].exclusion`) no block may touch. */
  readonly exclusions: readonly LandmarkExclusion[]
}

export interface BlockGroup {
  readonly borough: string
  readonly angleDeg: number
  /** Block centres in integer metres, delta-encoded as one path. */
  readonly p: readonly number[]
  /** Block heights, whole metres. */
  readonly h: readonly number[]
}

export interface TierBlocks {
  readonly sizeM: number
  readonly groups: readonly BlockGroup[]
  readonly instances: number
  readonly triangles: number
}

type BoroughId = keyof BlocksConfig['gridAngleDeg']
const isBoroughId = (id: string, config: BlocksConfig): id is BoroughId => id in config.gridAngleDeg

const blockSize = (spacing: number, config: BlocksConfig) =>
  Math.max(1, Math.round(spacing * config.footprintFraction))

export function buildBlocks(
  inputs: BlocksInputs,
  config: BlocksConfig,
  tier: QualityTier,
): TierBlocks {
  const spacing = config.spacingM[tier]
  const tierIndex = QUALITY_TIERS.indexOf(tier)
  const parkAreas = prepareAreas(inputs.parks)
  const zoneAreas = prepareAreas(inputs.zoneShapes)
  const circles = inputs.districts.map((d) => ({ centre: project(d.center), radiusM: d.radiusM }))
  const inDistrict = (point: LocalPoint) =>
    circles.some((circle) => distanceM(point, circle.centre) <= circle.radiusM)
  const sizeM = blockSize(spacing, config)
  // A block touches a rectangle when its centre lies within the rectangle grown by the block's
  // half diagonal (conservative for every rotation of the block).
  const reach = (sizeM * Math.SQRT2) / 2
  const grown = inputs.exclusions.map((rect) => ({
    ...rect,
    halfLengthM: rect.halfLengthM + reach,
    halfWidthM: rect.halfWidthM + reach,
  }))

  const groups: BlockGroup[] = []
  for (const borough of inputs.land) {
    if (!isBoroughId(borough.id, config)) throw new Error(`blocks: unknown borough ${borough.id}`)
    const angleDeg = config.gridAngleDeg[borough.id]
    const angle = (angleDeg * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const [land] = prepareAreas([borough])
    if (land === undefined) continue

    // The borough's extent in grid coordinates (u along the rotated x axis, v across).
    let minU = Infinity
    let minV = Infinity
    let maxU = -Infinity
    let maxV = -Infinity
    for (const polygon of borough.polygons) {
      for (const point of decodeRing(polygon[0] ?? [])) {
        const u = point.x * cos + point.y * sin
        const v = -point.x * sin + point.y * cos
        minU = Math.min(minU, u)
        maxU = Math.max(maxU, u)
        minV = Math.min(minV, v)
        maxV = Math.max(maxV, v)
      }
    }

    const points: LocalPoint[] = []
    const heights: number[] = []
    const columns = Math.ceil((maxU - minU) / spacing)
    const rows = Math.ceil((maxV - minV) / spacing)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const rng = createRng(
          mixSeed(mixSeed(mixSeed(config.seed, borough.boroCode * 3 + tierIndex), i), j),
        )
        // Every cell draws all four numbers so the stream never depends on earlier outcomes.
        const jitterU = (rng.next() - 0.5) * 2 * config.jitter * spacing
        const jitterV = (rng.next() - 0.5) * 2 * config.jitter * spacing
        const fill = rng.next()
        const spread = rng.next()
        const u = minU + (i + 0.5) * spacing + jitterU
        const v = minV + (j + 0.5) * spacing + jitterV
        const point = { x: Math.round(u * cos - v * sin), y: Math.round(u * sin + v * cos) }
        if (!land.polygons.some(({ rings, bbox }) => pointInPolygon(point, rings, bbox))) continue
        if (inDistrict(point)) continue
        if (insideAnyExclusion(point, grown)) continue
        if (areaAt(point, parkAreas) !== undefined) continue
        const zone = areaAt(point, zoneAreas)
        if (zone === undefined || !inputs.districtZoneIds.has(zone)) continue
        const density = inputs.density.get(zone)
        if (density === undefined) continue
        if (fill >= fillChance(density.far, config.fullFar)) continue
        const floors = Math.max(
          1,
          Math.round(density.avgFloors * (1 + config.heightJitter * (2 * spread - 1))),
        )
        points.push(point)
        heights.push(Math.max(1, Math.round(floors * config.floorM)))
      }
    }
    if (points.length === 0) continue
    groups.push({ borough: borough.id, angleDeg, p: encodePath(points), h: heights })
  }
  const instances = groups.reduce((sum, group) => sum + group.h.length, 0)
  return {
    sizeM,
    groups,
    instances,
    triangles: instances * BLOCK_TRIANGLES,
  }
}

const BLOCK_SOURCES: readonly DerivedSourceId[] = [
  'dcp-borough-boundaries',
  'dcp-nta-2020',
  'dcp-mappluto-density',
]

/** The text of `geo/blocks.<tier>.derived.json`. */
export function blocksFileText(tier: QualityTier, blocks: TierBlocks): string {
  return `${JSON.stringify({
    format: 'cc-blocks-v1',
    derived: true,
    notice: BLOCKS_NOTICE,
    sources: BLOCK_SOURCES,
    projection: { id: PROJECTION_ID, originLat: ORIGIN.lat, originLng: ORIGIN.lng },
    tier,
    sizeM: blocks.sizeM,
    groups: blocks.groups,
  })}\n`
}
