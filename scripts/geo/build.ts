/**
 * `npm run geo:build`: downloads the pinned geo sources into `.cache/geo/` and writes the
 * derived layers to data/geo, data/zones and data/landmarks.
 *
 *   npm run geo:build                 use the cache, download what is missing (must match lock)
 *   npm run geo:build -- --update     download everything, accept new upstream files, rewrite lock
 *   npm run geo:build -- --offline    never touch the network
 *   npm run geo:build -- --check      rebuild in memory and fail if committed files differ
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import {
  GeoConfigSchema,
  PerfConfigSchema,
  QUALITY_TIERS,
  type PerfConfig,
  type QualityTier,
} from '../../src/lib/data/schemas/config.ts'
import { landmarkModelsFileSchemaFor } from '../../src/lib/data/schemas/landmarkModels.ts'
import { LION_SOURCE_IDS } from '../../src/lib/geo/sources.ts'
import type { FramePlace } from './landmarks.ts'
import {
  LockSchema,
  PartialLockSchema,
  buildingSourceDefinitions,
  pageFile,
  type Lock,
} from './lock.ts'
import { ensureSources, type SourceMode } from './sources.ts'
import {
  buildGeoOutputs,
  type GeoBoundsInput,
  type GeoBuildParams,
  type GeoBuildResult,
  type RawGeoInputs,
} from './transform.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const DATA = join(ROOT, 'data')
export const CACHE_DIR = join(ROOT, '.cache/geo')
export const LOCK_PATH = join(ROOT, 'scripts/geo/sources.lock.json')

/**
 * Upstream sanity counts: 5 boroughs; 262 NTAs (the ArcGIS layer's maxRecordCount too); 59
 * community districts with lots in MapPLUTO. Building pages are checked against the lock's
 * returnCountOnly total instead.
 */
export const EXPECTED_COUNTS = { boroughs: 5, ntas: 262, communityDistricts: 59 } as const

/** Per-tier outputs live here; files the build no longer writes are removed (or fail --check). */
const DISTRICTS_DIR = 'geo/districts'

/** Superseded by zones/zones.derived.json; removed on write so it cannot linger. */
const RETIRED_FILES = ['zones/zones.json']

// Only the fields used; data/geo/bounds.json is fully validated by src/lib/data/data.test.ts.
const BoundsSchema = z.object({
  west: z.number(),
  south: z.number(),
  east: z.number(),
  north: z.number(),
})

// Only the fields the frames need; landmarks.json is fully validated by src/lib/data/data.test.ts.
const PlacesSchema = z.object({
  landmarks: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      location: z.object({ lat: z.number(), lng: z.number() }),
      spans: z.array(z.string()).optional(),
    }),
  ),
})

const write = (line: string) => process.stdout.write(`${line}\n`)

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * The committed lock. `partial` (for --update) also accepts a lock that lacks some sources or
 * lists them out of order: update rewrites it in full.
 */
export async function readLock(path = LOCK_PATH, partial = false): Promise<Lock | undefined> {
  let json: unknown
  try {
    json = await readJson(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const result = (partial ? PartialLockSchema : LockSchema).safeParse(json)
  if (!result.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export const lockText = (lock: Lock) => `${JSON.stringify(lock, null, 2)}\n`

export async function readBuildParams(): Promise<{
  config: z.infer<typeof GeoConfigSchema>
  bounds: GeoBoundsInput
  landmarks: GeoBuildParams['landmarks']
}> {
  const places: FramePlace[] = PlacesSchema.parse(
    await readJson(join(DATA, 'landmarks/landmarks.json')),
  ).landmarks
  const models = landmarkModelsFileSchemaFor(places).safeParse(
    await readJson(join(DATA, 'landmarks/models.json')),
  )
  if (!models.success) {
    throw new Error(`Invalid data/landmarks/models.json:\n${z.prettifyError(models.error)}`)
  }
  return {
    config: GeoConfigSchema.parse(await readJson(join(DATA, 'config/geo.json'))),
    bounds: BoundsSchema.parse(await readJson(join(DATA, 'geo/bounds.json'))),
    landmarks: { models: models.data.models, places },
  }
}

export interface CachedSources {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly pages: ReadonlyMap<string, readonly Uint8Array[]>
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Reads every cached raw file the lock lists, without the network. `valid` is true only when
 * each one exists and matches its lock hash (tests skip the real-data rebuild otherwise).
 */
export async function readCache(
  lock: Lock,
  cacheDir = CACHE_DIR,
): Promise<CachedSources & { valid: boolean }> {
  const read = (file: string) =>
    readFile(join(cacheDir, file)).then(
      (buffer) => new Uint8Array(buffer),
      () => undefined,
    )
  let valid = true
  const files = new Map<string, Uint8Array>()
  for (const entry of lock.sources) {
    const bytes = await read(entry.file)
    if (bytes === undefined || sha256(bytes) !== entry.sha256) valid = false
    if (bytes !== undefined) files.set(entry.id, bytes)
  }
  const pages = new Map<string, readonly Uint8Array[]>()
  for (const entry of lock.pagedSources) {
    const list: Uint8Array[] = []
    for (const [page, expected] of entry.pages.entries()) {
      const bytes = await read(pageFile(entry.id, page))
      if (bytes === undefined || sha256(bytes) !== expected.sha256) valid = false
      if (bytes !== undefined) list.push(bytes)
    }
    pages.set(entry.id, list)
  }
  return { files, pages, valid }
}

/** Builds from cached raw bytes (shared by the CLI and the rebuild test). */
export async function buildFromSources(
  lock: Lock,
  sources: CachedSources,
): Promise<GeoBuildResult> {
  const raw = (id: string) => {
    const bytes = sources.files.get(id)
    if (bytes === undefined) throw new Error(`geo build: source ${id} missing`)
    return bytes
  }
  const parse = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))
  const buildings = new Map<string, readonly unknown[]>()
  for (const [id, pages] of sources.pages) buildings.set(id, pages.map(parse))
  const inputs: RawGeoInputs = {
    boroughs: parse(raw('dcp-borough-boundaries')),
    ntas: parse(raw('dcp-nta-2020')),
    gtfsZip: raw('mta-gtfs-subway'),
    density: parse(raw('dcp-mappluto-density')),
    buildings,
    lion: new Map(LION_SOURCE_IDS.map((id) => [id, parse(raw(id))])),
  }
  return buildGeoOutputs(inputs, { ...(await readBuildParams()), lock, expected: EXPECTED_COUNTS })
}

export interface TierTotal {
  readonly tier: QualityTier
  readonly gzBytes: number
  readonly triangles: number
}

const gzBytes = (text: string) => gzipSync(text, { level: 9 }).byteLength

/** gzip -9 bytes and triangles per tier: every district file plus the tier's blocks. */
export function tierTotals(result: GeoBuildResult): TierTotal[] {
  return QUALITY_TIERS.map((tier) => {
    const paths = [
      ...result.districtStats.filter((s) => s.tier === tier).map((s) => s.path),
      ...result.blockStats.filter((s) => s.tier === tier).map((s) => s.path),
    ]
    return {
      tier,
      gzBytes: paths.reduce((sum, path) => sum + gzBytes(result.files.get(path) ?? ''), 0),
      triangles:
        result.districtStats.filter((s) => s.tier === tier).reduce((n, s) => n + s.triangles, 0) +
        result.blockStats.filter((s) => s.tier === tier).reduce((n, s) => n + s.triangles, 0),
    }
  })
}

/** Budget failures (perf.json districtBuildingsGzKB, buildingTrianglesMax); empty when within. */
export function budgetErrors(totals: readonly TierTotal[], perf: PerfConfig): string[] {
  return totals.flatMap(({ tier, gzBytes: bytes, triangles }) => [
    ...(bytes > perf.districtBuildingsGzKB[tier] * 1000
      ? [
          `${tier}: buildings ${kb(bytes)} gz exceed districtBuildingsGzKB ${perf.districtBuildingsGzKB[tier]} KB`,
        ]
      : []),
    ...(triangles > perf.buildingTrianglesMax[tier]
      ? [
          `${tier}: ${triangles} building triangles exceed buildingTrianglesMax ${perf.buildingTrianglesMax[tier]}`,
        ]
      : []),
  ])
}

async function committedTieredFiles(): Promise<string[]> {
  const names = await readdir(join(DATA, DISTRICTS_DIR)).catch(() => [])
  const blocks = (await readdir(join(DATA, 'geo'))).filter((name) =>
    /^blocks\.[a-z]+\.derived\.json$/.test(name),
  )
  return [
    ...names.map((name) => `${DISTRICTS_DIR}/${name}`),
    ...blocks.map((name) => `geo/${name}`),
  ]
}

function parseArgs(argv: readonly string[]): { mode: SourceMode; check: boolean } {
  const known = new Set(['--update', '--offline', '--check'])
  const unknown = argv.filter((arg) => !known.has(arg))
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(' ')}`)
  const update = argv.includes('--update')
  const offline = argv.includes('--offline')
  const check = argv.includes('--check')
  if (update && (offline || check))
    throw new Error('--update cannot be combined with --offline or --check')
  return { mode: update ? 'update' : offline ? 'offline' : 'default', check }
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`

async function main(): Promise<void> {
  const { mode, check } = parseArgs(process.argv.slice(2))
  const today = new Date().toISOString().slice(0, 10)
  const { config } = await readBuildParams()
  const perf = PerfConfigSchema.parse(await readJson(join(DATA, 'config/perf.json')))
  const { lock, files, pages } = await ensureSources({
    cacheDir: CACHE_DIR,
    lock: await readLock(LOCK_PATH, mode === 'update'),
    mode,
    today,
    log: write,
    pagedDefinitions: buildingSourceDefinitions(config.districts),
  })
  const result = await buildFromSources(lock, { files, pages })

  for (const ext of result.terminalExtensions) {
    write(`terminal extension: line ${ext.lineId} +${ext.gapM} m to station ${ext.stationId}`)
  }
  for (const fallback of result.stationFallbacks) write(`area fallback: ${fallback}`)
  for (const park of result.droppedParks) write(`park dropped (too small): ${park}`)

  const tieredPaths = new Set([
    ...result.districtStats.map((s) => s.path),
    ...result.blockStats.map((s) => s.path),
  ])
  let baseGz = 0
  for (const [path, text] of result.files) {
    const gz = gzBytes(text)
    const isBase =
      path.endsWith('.derived.json') &&
      !path.endsWith('manifest.derived.json') &&
      !tieredPaths.has(path)
    if (isBase) baseGz += gz
    if (!tieredPaths.has(path)) write(`${path}: ${kb(Buffer.byteLength(text))} raw, ${kb(gz)} gz`)
  }
  write(`base geo total: ${kb(baseGz)} gz`)
  for (const stat of result.districtStats) {
    write(
      `${stat.path}: ${stat.downloaded} downloaded, ${stat.inCircle} in circle, ${stat.excluded} excluded, ${stat.footprints} kept → ${stat.masses} masses, ${stat.triangles} triangles, ${kb(gzBytes(result.files.get(stat.path) ?? ''))} gz`,
    )
  }
  for (const stat of result.blockStats) {
    write(
      `${stat.path}: ${stat.instances} blocks, ${stat.triangles} triangles, ${kb(gzBytes(result.files.get(stat.path) ?? ''))} gz`,
    )
  }
  const totals = tierTotals(result)
  for (const { tier, gzBytes: bytes, triangles } of totals) {
    write(
      `${tier} buildings total: ${kb(bytes)} gz of ${perf.districtBuildingsGzKB[tier]} KB, ${triangles} of ${perf.buildingTrianglesMax[tier]} triangles`,
    )
  }
  const overBudget = budgetErrors(totals, perf)
  if (overBudget.length > 0) throw new Error(`over budget:\n  ${overBudget.join('\n  ')}`)

  const stale = (await committedTieredFiles()).filter((path) => !result.files.has(path))
  if (check) {
    const differing: string[] = [...stale]
    for (const [path, text] of result.files) {
      const committed = await readFile(join(DATA, path), 'utf8').catch(() => undefined)
      if (committed !== text) differing.push(path)
    }
    if (differing.length > 0) {
      throw new Error(`Committed geo files differ from a rebuild: ${differing.join(', ')}`)
    }
    write('check: committed geo files match a rebuild')
    return
  }

  for (const [path, text] of result.files) {
    const target = join(DATA, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  for (const path of [...RETIRED_FILES, ...stale]) await rm(join(DATA, path), { force: true })
  if (mode === 'update') await writeFile(LOCK_PATH, lockText(lock))
  write(`wrote ${result.files.size} files`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`geo:build: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
