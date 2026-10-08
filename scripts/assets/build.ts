/**
 * `npm run assets:build`: builds the hand-made 3D models (S04h, DEC-24/25/26) listed in
 * data/assets/catalog.json from pinned CC0 packs and our committed Blender outputs.
 *
 *   npm run assets:build                     use the cache (.cache/assets), download what is missing
 *   npm run assets:build -- --update         download what the catalog needs, rewrite the lock
 *   npm run assets:build -- --offline        never touch the network
 *   npm run assets:build -- --check          rebuild in memory and fail if any committed output
 *                                            (GLBs, manifest, lock, SOURCES.md) differs
 *
 * Writes public/models/<id>.<tier>.<sha8>.glb, data/assets/manifest.json,
 * scripts/assets/sources.lock.json and data/assets/SOURCES.md. Fails when a model breaks its
 * perf.json `models` cap and prints the pressure on every cap; it never edits perf.json.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { format, resolveConfig } from 'prettier'
import { z } from 'zod'
import {
  PerfConfigSchema,
  ThemeConfigSchema,
  type PerfConfig,
} from '../../src/lib/data/schemas/config.ts'
import {
  MODEL_TIERS,
  type ModelCategory,
  type ModelManifest,
} from '../../src/lib/data/schemas/assets.ts'
import { checkBlenderOutputs, readBlenderLock, type BlenderLock } from '../blender/build.ts'
import { ensurePacks, type FetchMode } from './fetch.ts'
import { buildManifest } from './manifest.ts'
import { buildModel, type BuiltModel } from './pipeline.ts'
import { CatalogSchema, SourcesLockSchema, type Catalog, type SourcesLock } from './schema.ts'
import { renderSourcesMd } from './sources-md.ts'

const ROOT = resolve(import.meta.dirname, '../..')
export const CATALOG_PATH = join(ROOT, 'data/assets/catalog.json')
export const MANIFEST_PATH = join(ROOT, 'data/assets/manifest.json')
export const SOURCES_MD_PATH = join(ROOT, 'data/assets/SOURCES.md')
export const LOCK_PATH = join(ROOT, 'scripts/assets/sources.lock.json')
export const CACHE_DIR = join(ROOT, '.cache/assets')
export const PUBLIC_DIR = join(ROOT, 'public')
export const MODELS_DIR = join(PUBLIC_DIR, 'models')
const THEME_PATH = join(ROOT, 'data/config/theme.json')
const PERF_PATH = join(ROOT, 'data/config/perf.json')
const MODEL_COPY_PATH = join(ROOT, 'data/copy/models/base.json')

const write = (line: string) => process.stdout.write(`${line}\n`)

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function parseFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readJson(path))
  if (!result.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export const readCatalog = (path = CATALOG_PATH) => parseFile(path, CatalogSchema)

export async function readSourcesLock(path = LOCK_PATH): Promise<SourcesLock | undefined> {
  try {
    return await parseFile(path, SourcesLockSchema)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Cross-file rules the catalog schema alone cannot see. */
export function catalogProblems(
  catalog: Catalog,
  palette: Readonly<Record<string, string>>,
  copyKeys: ReadonlySet<string>,
  blender: BlenderLock,
): string[] {
  const problems: string[] = []
  for (const model of catalog.models) {
    const tokens = [
      ...model.swatches,
      ...Object.values(model.remap ?? {}),
      ...model.emissive,
      ...Object.values(model.glow ?? {}),
      ...model.slots.flatMap((slot) => slot.tokens),
    ]
    for (const token of new Set(tokens)) {
      if (!(token in palette)) problems.push(`${model.id}: ${token} is not a theme models token`)
    }
    if (!copyKeys.has(model.nameKey))
      problems.push(`${model.id}: copy key ${model.nameKey} is missing`)
    const source = catalog.sources.find((entry) => entry.id === model.source)
    if (source?.download.kind === 'local') {
      for (const entry of model.entries) {
        if (!blender.models.some((built) => `${built.id}.glb` === entry.path)) {
          problems.push(`${model.id}: ${entry.path} is not a model in scripts/blender/lock.json`)
        }
      }
    }
  }
  return problems
}

export interface CapViolation {
  readonly id: string
  readonly tier: string
  readonly message: string
}

/** Every model tier over its category's perf.json cap. */
export function capViolations(manifest: ModelManifest, caps: PerfConfig['models']): CapViolation[] {
  const violations: CapViolation[] = []
  for (const model of manifest.models) {
    const cap = caps[model.category]
    for (const tier of MODEL_TIERS) {
      const file = model.tiers[tier]
      if (file.triangles > cap.trianglesMax[tier]) {
        violations.push({
          id: model.id,
          tier,
          message: `${file.triangles} triangles > ${cap.trianglesMax[tier]} (${model.category})`,
        })
      }
      if (file.gzBytes > cap.gzKBMax * 1000) {
        violations.push({
          id: model.id,
          tier,
          message: `${(file.gzBytes / 1000).toFixed(1)} KB gz > ${cap.gzKBMax} KB (${model.category})`,
        })
      }
    }
  }
  return violations
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1)
const pct = (used: number, cap: number) =>
  cap === 0 ? (used === 0 ? '—' : 'over') : `${Math.round((used / cap) * 100)}%`

/** Measured table, per-category pressure on the perf.json caps, and per-set totals. */
export function pressureReport(manifest: ModelManifest, caps: PerfConfig['models']): string[] {
  const lines = ['model                      tier  triangles   gz KB   raw KB']
  for (const model of manifest.models) {
    for (const tier of MODEL_TIERS) {
      const file = model.tiers[tier]
      lines.push(
        `${model.id.padEnd(26)} ${tier.padEnd(5)} ${String(file.triangles).padStart(9)} ${kb(file.gzBytes).padStart(7)} ${kb(file.bytes).padStart(8)}`,
      )
    }
  }
  lines.push('', 'cap pressure (largest model per category vs perf.json models)')
  for (const [category, cap] of Object.entries(caps) as [
    ModelCategory,
    PerfConfig['models'][ModelCategory],
  ][]) {
    const members = manifest.models.filter((model) => model.category === category)
    if (members.length === 0) {
      lines.push(`  ${category.padEnd(17)} no models yet`)
      continue
    }
    const tris = MODEL_TIERS.map((tier) => {
      const max = Math.max(...members.map((model) => model.tiers[tier].triangles))
      return `${tier} ${max}/${cap.trianglesMax[tier]} (${pct(max, cap.trianglesMax[tier])})`
    })
    const gz = Math.max(
      ...members.flatMap((model) => MODEL_TIERS.map((tier) => model.tiers[tier].gzBytes)),
    )
    lines.push(
      `  ${category.padEnd(17)} tris ${tris.join(', ')}; gz ${kb(gz)}/${cap.gzKBMax} KB (${pct(gz, cap.gzKBMax * 1000)})`,
    )
  }
  lines.push('', 'set totals (gz KB per tier, each file counted once)')
  const sets: [string, (category: ModelCategory) => boolean][] = [
    ['street props', (c) => c === 'vehicle' || c === 'street-prop' || c === 'tree'],
    ['buildings', (c) => c === 'building' || c === 'building-detail'],
    ['apartment', (c) => c === 'furniture' || c === 'room-shell'],
    [
      'creator parts',
      (c) => c === 'avatar-head' || c === 'avatar-body' || c === 'avatar-accessory',
    ],
  ]
  const total = (models: ModelManifest['models'], tier: (typeof MODEL_TIERS)[number]) => {
    const files = new Map(
      models.map((model) => [model.tiers[tier].file, model.tiers[tier].gzBytes]),
    )
    return [...files.values()].reduce((sum, bytes) => sum + bytes, 0)
  }
  for (const [name, test] of sets) {
    const members = manifest.models.filter((model) => test(model.category))
    lines.push(
      `  ${name.padEnd(14)} ${MODEL_TIERS.map((tier) => `${tier} ${kb(total(members, tier))}`).join(', ')}`,
    )
  }
  const largest = (category: ModelCategory) =>
    manifest.models
      .filter((model) => model.category === category)
      .sort((a, b) => b.tiers.high.gzBytes - a.tiers.high.gzBytes)[0]
  const avatar = [largest('avatar-rig'), largest('avatar-head'), largest('avatar-body')].filter(
    (model) => model !== undefined,
  )
  lines.push(
    `  ${'avatar'.padEnd(14)} ${MODEL_TIERS.map((tier) => `${tier} ${kb(total(avatar, tier))}`).join(', ')} (rig + largest head + largest body; ${MODEL_TIERS.map((tier) => `${tier} ${avatar.reduce((sum, model) => sum + model.tiers[tier].triangles, 0)} tris`).join(', ')})`,
  )
  return lines
}

async function formatted(path: string, text: string): Promise<string> {
  const options = await resolveConfig(path)
  return format(text, { ...options, filepath: path })
}

export interface BuildResult {
  readonly texts: ReadonlyMap<string, string>
  /** Absolute path under public/models → bytes. */
  readonly models: ReadonlyMap<string, Uint8Array>
  readonly manifest: ModelManifest
  readonly violations: readonly CapViolation[]
  readonly report: readonly string[]
}

export async function buildAssets(
  mode: FetchMode,
  log: (line: string) => void = write,
): Promise<BuildResult> {
  const catalog = await readCatalog()
  const theme = await parseFile(THEME_PATH, ThemeConfigSchema)
  const perf = await parseFile(PERF_PATH, PerfConfigSchema)
  const blender = await readBlenderLock()
  const copy = z
    .object({ strings: z.record(z.string(), z.string()) })
    .parse(await readJson(MODEL_COPY_PATH))
  const problems = [
    ...catalogProblems(catalog, theme.models, new Set(Object.keys(copy.strings)), blender),
    ...(await checkBlenderOutputs(blender, ROOT)),
  ]
  if (problems.length > 0) throw new Error(`catalog problems:\n  ${problems.join('\n  ')}`)

  const { packs, lock } = await ensurePacks({
    root: ROOT,
    cacheDir: CACHE_DIR,
    catalog,
    lock: await readSourcesLock(),
    mode,
    today: new Date().toISOString().slice(0, 10),
    log,
  })

  const built: BuiltModel[] = []
  for (const model of catalog.models) {
    const pack = packs.get(model.source)
    const source = catalog.sources.find((entry) => entry.id === model.source)
    if (pack === undefined || source === undefined) throw new Error(`${model.id}: unknown source`)
    const result = await buildModel(model, pack, {
      palette: theme.models,
      maxDeltaE: catalog.maxDeltaE,
      grade: source.grade,
    })
    for (const warning of result.warnings) log(`warn ${model.id}: ${warning}`)
    const colours = [...result.colours.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([label, count]) => `${label}×${count}`)
      .join(' ')
    log(`built ${model.id}: ${colours}`)
    built.push(result)
  }

  const { manifest, files } = buildManifest(built)
  const texts = new Map<string, string>([
    [MANIFEST_PATH, await formatted(MANIFEST_PATH, JSON.stringify(manifest))],
    [LOCK_PATH, await formatted(LOCK_PATH, JSON.stringify(lock))],
    [SOURCES_MD_PATH, await formatted(SOURCES_MD_PATH, renderSourcesMd(catalog, lock, blender))],
  ])
  const models = new Map(
    [...files.entries()].map(([file, bytes]) => [join(PUBLIC_DIR, ...file.split('/')), bytes]),
  )
  return {
    texts,
    models,
    manifest,
    violations: capViolations(manifest, perf.models),
    report: pressureReport(manifest, perf.models),
  }
}

async function listModelFiles(): Promise<string[]> {
  try {
    return (await readdir(MODELS_DIR)).map((name) => join(MODELS_DIR, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Committed outputs that differ from a rebuild (or are missing, or are stale extras). */
export async function differingOutputs(result: BuildResult): Promise<string[]> {
  const differing: string[] = []
  for (const [path, text] of result.texts) {
    const committed = await readFile(path, 'utf8').catch(() => undefined)
    if (committed !== text) differing.push(path)
  }
  for (const [path, bytes] of result.models) {
    const committed = await readFile(path).catch(() => undefined)
    if (committed === undefined || !Buffer.from(bytes).equals(committed)) differing.push(path)
  }
  for (const path of await listModelFiles()) {
    if (!result.models.has(path)) differing.push(`${path} (not in the manifest)`)
  }
  return differing.map((path) => path.replace(`${ROOT}/`, ''))
}

function parseArgs(argv: readonly string[]): { mode: FetchMode; check: boolean } {
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

async function main(): Promise<void> {
  const { mode, check } = parseArgs(process.argv.slice(2))
  const result = await buildAssets(mode)
  for (const line of result.report) write(line)
  for (const violation of result.violations)
    write(`OVER ${violation.id} ${violation.tier}: ${violation.message}`)
  if (result.violations.length > 0) {
    throw new Error(`${result.violations.length} model tier(s) over their perf.json cap`)
  }
  if (check) {
    const differing = await differingOutputs(result)
    if (differing.length > 0) {
      throw new Error(`Committed model outputs differ from a rebuild:\n  ${differing.join('\n  ')}`)
    }
    write('check: committed model outputs match a rebuild')
    return
  }
  await mkdir(MODELS_DIR, { recursive: true })
  for (const path of await listModelFiles()) {
    if (!result.models.has(path)) await rm(path)
  }
  for (const [path, bytes] of result.models) await writeFile(path, bytes)
  for (const [path, text] of result.texts) await writeFile(path, text)
  write(`wrote ${result.models.size} model files, the manifest, the lock and SOURCES.md`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `assets:build: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
