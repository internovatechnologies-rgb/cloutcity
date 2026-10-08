/**
 * District buildings and procedural blocks (S04d) as the server sees them: which per-tier files
 * exist, their versioned URLs, and the district circles the scene loads and culls by. Server
 * only (classic zod, node:fs): the scene receives `districtAssets(tier)` as props and fetches
 * the files from the prerendered routes /geo/districts/<tier>/<id> and /geo/blocks/<tier>.
 *
 * Every URL carries `?v=` with its file's content hash (data/geo/manifest.derived.json), so a
 * rebuilt district gets a new URL and the long-lived caches (next.config.ts headers, the service
 * worker's geo cache, S04e) never serve a stale copy.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import geoConfigJson from '@data/config/geo.json'
import { project } from '@/lib/geo/projection'
import type { BuildingDistrictId } from '@/lib/geo/sources'
import { geoManifest } from './geo'
import { parseDataFile } from './parse'
import { GeoConfigSchema, QUALITY_TIERS, type QualityTier } from './schemas/config'
import {
  BlocksFileSchema,
  BuildingsFileSchema,
  type BlocksFile,
  type BuildingsFile,
} from './schemas/world'

export const geoConfig = parseDataFile('config/geo.json', GeoConfigSchema, geoConfigJson)

/** data/ path of one district's buildings for one tier (as scripts/geo/transform.ts writes it). */
export const districtDataPath = (id: string, tier: QualityTier) =>
  `geo/districts/${id}.${tier}.derived.json`
/** data/ path of one tier's procedural blocks. */
export const blocksDataPath = (tier: QualityTier) => `geo/blocks.${tier}.derived.json`

/** The first 12 hex digits of a data file's sha256 in the geo manifest. */
function fileVersion(path: string): string {
  const entry = geoManifest.files.find((file) => file.path === path)
  if (entry === undefined) throw new Error(`geo manifest has no ${path}: run npm run geo:build`)
  return entry.sha256.slice(0, 12)
}

export interface DistrictAsset {
  readonly id: BuildingDistrictId
  /** /geo/districts/<tier>/<id>?v=<hash>. */
  readonly url: string
  /** The district circle in local metres: footprints were kept inside it. */
  readonly centre: { readonly x: number; readonly y: number }
  readonly radiusM: number
}

export interface DistrictAssets {
  readonly tier: QualityTier
  /** In data/config/geo.json order. */
  readonly districts: readonly DistrictAsset[]
  /** /geo/blocks/<tier>?v=<hash>. */
  readonly blocksUrl: string
}

/** Everything the scene loads for one tier's buildings. */
export function districtAssets(tier: QualityTier): DistrictAssets {
  return {
    tier,
    districts: geoConfig.districts.map((district) => {
      const centre = project(district.center)
      return {
        id: district.id,
        url: `/geo/districts/${tier}/${district.id}?v=${fileVersion(districtDataPath(district.id, tier))}`,
        centre: { x: Math.round(centre.x), y: Math.round(centre.y) },
        radiusM: district.radiusM,
      }
    }),
    blocksUrl: `/geo/blocks/${tier}?v=${fileVersion(blocksDataPath(tier))}`,
  }
}

/**
 * Every building URL of one tier, districts first then the blocks: what the scene can fetch for
 * that tier, and what the service worker warms for it (S04e part 2).
 */
export function districtAssetUrls(tier: QualityTier): string[] {
  const assets = districtAssets(tier)
  return [...assets.districts.map((district) => district.url), assets.blocksUrl]
}

/** Route params of every prerendered district body. */
export function districtRouteParams(): { tier: QualityTier; id: BuildingDistrictId }[] {
  return QUALITY_TIERS.flatMap((tier) => geoConfig.districts.map(({ id }) => ({ tier, id })))
}

const isTier = (tier: string): tier is QualityTier =>
  (QUALITY_TIERS as readonly string[]).includes(tier)

async function readDataJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(process.cwd(), 'data', path), 'utf8')) as unknown
}

/**
 * One district's buildings for one tier, validated, or null for an unknown tier or district.
 * Read from disk while the route is prerendered, so the ~2 MB of building JSON never sits in a
 * server bundle.
 */
export async function readDistrictBuildings(
  tier: string,
  id: string,
): Promise<BuildingsFile | null> {
  if (!isTier(tier) || !geoConfig.districts.some((district) => district.id === id)) return null
  const path = districtDataPath(id, tier)
  return parseDataFile(path, BuildingsFileSchema, await readDataJson(path))
}

/** One tier's procedural blocks, validated, or null for an unknown tier. */
export async function readBlocks(tier: string): Promise<BlocksFile | null> {
  if (!isTier(tier)) return null
  const path = blocksDataPath(tier)
  return parseDataFile(path, BlocksFileSchema, await readDataJson(path))
}
