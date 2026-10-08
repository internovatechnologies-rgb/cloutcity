/**
 * `npm run budget`: checks the built bundle in `.next` against data/config/perf.json.
 *
 * - Shell JS of route `/`: every script the prerendered `/` HTML makes a modern browser run
 *   (external chunks plus inline scripts; `nomodule` polyfills excluded), gzipped, against
 *   `shellJsGzKB`.
 * - 3D chunk JS: the files Turbopack's loader in the shell fetches for the scene's lazy import,
 *   minus files the shell already loads, gzipped, against `sceneChunkJsGzKB`. The import is found
 *   by the scene's feature marker (`cc-feature:city-scene`), cross-checked against the route's
 *   react-loadable-manifest.json, and must hold the build's only copy of three.
 * - Total JS to playable: the shell, the boot islands ({@link BOOT_ISLAND_FEATURES}) and the 3D
 *   chunk, each file once, against `totalJsToPlayableGzKB`.
 * - Base geo: the prerendered `/geo/base` body, gzipped, against `baseGeoGzKB`.
 * - District buildings: once the build prerenders `/geo/districts/<tier>/<id>` (S04d), each
 *   tier's districts plus its `/geo/blocks/<tier>` body against `districtBuildingsGzKB`.
 * - PERF-3: modules Turbopack copies into more than one chunk, reported only.
 * - Apartment chunk JS (S16): the files only the apartment's `next/dynamic` import adds (the
 *   manifest entry whose code renders `cc-feature:apartment-scene`, minus the city's 3D chunk
 *   and the shell), gzipped, against `apartmentChunkJsGzKB`. It loads when the Home panel opens,
 *   so it is left out of the 3D chunk above. A build without that marker fails, so the split
 *   can never silently fold the apartment into the city figure or drop it.
 * - Service worker (S04e): the prerendered /serwist/sw.js, gzipped, against `serviceWorkerGzKB`,
 *   and every file it precaches on install, gzipped and summed, against `precacheGzKB`. The
 *   precache must hold every file of the path to playable (shell, boot islands, 3D chunk) and the
 *   versioned base geo, and must never hold models, audio, source maps or server routes; once the
 *   build has district routes, the worker must carry each tier's warm list (S04e part 2).
 *
 * `--perf=<file>` reads the limits from another file instead of data/config/perf.json: a
 * positive control that proves, on a real build, that a limit below the measured size fails
 * (perf.json itself is never edited for that).
 *
 * - Hand-made models (S04h): bytes per tier and load phase from data/assets/manifest.json, the
 *   glTF loader kept out of the shell JS, and the model runtime's own lazy chunk reported
 *   (scripts/budget-models.ts).
 *
 * - Optional chunks (PERF-7): the large optional chunks src/lib/pwa/lazyChunks.ts names (the model
 *   runtime, the model showcase, the apartment's decor models, the /mod console, supabase-js) exist in the
 *   build and none is precached; the worker caches them at runtime.
 *
 * Every lookup has a positive control: a marker, loader or manifest entry that cannot be found
 * fails the run, so a change in the build format cannot turn a check into a silent pass.
 * scripts/shell-guard.ts runs next and checks the boot path and that no test hook ships.
 * Run after `npm run build`. Sizes use KB = 1000 bytes, the stricter reading of the budget.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import { PerfConfigSchema, QUALITY_TIERS } from '../src/lib/data/schemas/config.ts'
import { loaderLeaks, modelBudgetLines } from './budget-models.ts'
import { OPTIONAL_CHUNK_MARKERS } from '../src/lib/pwa/lazyChunks.ts'

export interface ScriptRefs {
  /** `src` values of external scripts, in document order, deduplicated. */
  readonly external: readonly string[]
  /** Bodies of inline scripts. */
  readonly inline: readonly string[]
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const SRC_ATTR = /\bsrc\s*=\s*["']([^"']+)["']/i
const TYPE_ATTR = /\btype\s*=\s*["']([^"']+)["']/i
const NOMODULE_ATTR = /\bnomodule\b/i
const JS_TYPES = new Set(['', 'text/javascript', 'module', 'application/javascript'])

export function extractScripts(html: string): ScriptRefs {
  const external: string[] = []
  const inline: string[] = []
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match[1] ?? ''
    const body = match[2] ?? ''
    const type = (TYPE_ATTR.exec(attrs)?.[1] ?? '').toLowerCase()
    // JSON-LD and other data blocks are not executed JS.
    if (!JS_TYPES.has(type)) continue
    // Legacy polyfills: browsers that support ES modules (every target device) never fetch them.
    if (NOMODULE_ATTR.test(attrs)) continue
    const src = SRC_ATTR.exec(attrs)?.[1]
    if (src !== undefined) {
      if (!external.includes(src)) external.push(src)
    } else if (body.trim() !== '') {
      inline.push(body)
    }
  }
  return { external, inline }
}

/** Maps a `/_next/static/...` URL to its file under the build dir; other URLs are rejected. */
export function staticFilePath(src: string, distDir: string): string {
  return join(distDir, staticChunkName(src))
}

/**
 * A `/_next/static/...` script URL as a path relative to the build dir (`static/chunks/a.js`),
 * the form Turbopack's loaders and the loadable manifest use. Other URLs are rejected.
 */
export function staticChunkName(src: string): string {
  const path = src.split(/[?#]/)[0] ?? ''
  const prefix = '/_next/static/'
  if (!path.startsWith(prefix)) {
    throw new Error(`Unexpected script source outside ${prefix}: ${src}`)
  }
  const relativePath = decodeURIComponent(path.slice(prefix.length))
  if (relativePath.split('/').includes('..')) throw new Error(`Refusing path traversal: ${src}`)
  return `static/${relativePath}`
}

export function gzipBytes(content: string | Uint8Array): number {
  return gzipSync(content, { level: 9 }).byteLength
}

export interface BudgetResult {
  readonly name: string
  readonly actualKB: number
  readonly limitKB: number
  readonly ok: boolean
}

export function checkBudget(name: string, actualBytes: number, limitKB: number): BudgetResult {
  const actualKB = Math.round((actualBytes / 1000) * 10) / 10
  return { name, actualKB, limitKB, ok: actualBytes <= limitKB * 1000 }
}

// Only the fields this script enforces are read, through the shared perf.json schema; the whole
// file is validated by src/lib/data/data.test.ts.
const LimitsSchema = z.object({
  shellJsGzKB: PerfConfigSchema.shape.shellJsGzKB,
  sceneChunkJsGzKB: PerfConfigSchema.shape.sceneChunkJsGzKB,
  totalJsToPlayableGzKB: PerfConfigSchema.shape.totalJsToPlayableGzKB,
  baseGeoGzKB: PerfConfigSchema.shape.baseGeoGzKB,
  districtBuildingsGzKB: PerfConfigSchema.shape.districtBuildingsGzKB,
})
export type BudgetLimits = z.infer<typeof LimitsSchema>

/** The limits from perf.json; throws naming every invalid field. */
export function readLimits(perf: unknown): BudgetLimits {
  const result = LimitsSchema.safeParse(perf)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error(`data/config/perf.json: invalid or missing ${fields.join(', ')}`)
  }
  return result.data
}

/**
 * True when `marker` appears whole: not as the start of a longer id (`cc-feature:event` inside
 * `cc-feature:event-sheet`), which would report the wrong feature or hide a missing one.
 */
export function hasMarker(text: string, marker: string): boolean {
  let at = text.indexOf(marker)
  while (at !== -1) {
    if (!/^-?[a-z0-9]/.test(text.slice(at + marker.length, at + marker.length + 2))) return true
    at = text.indexOf(marker, at + 1)
  }
  return false
}

/** Every static JS chunk of a build, by name relative to the build dir (`static/chunks/a.js`). */
export type Chunks = ReadonlyMap<string, string>

/** The feature marker the 3D scene's root renders (src/scene/CityCanvas.tsx). */
export const SCENE_FEATURE = 'cc-feature:city-scene'

export interface BootIsland {
  /** A feature marker in the island's chunk, or for `nested`, in a chunk the island loads. */
  readonly marker: string
  /** The module the island's `lazyIsland(..., { eager: true })` imports (checked by a test). */
  readonly module: string
  /**
   * The island renders no marker of its own (it renders nothing until it has something to show),
   * so it is found as the boot chunk that lazily loads the marked feature.
   */
  readonly nested?: true
}

/**
 * The islands that load as soon as the shell runs (`lazyIsland` with `eager: true`). They count
 * toward total JS to playable. scripts/budget.test.ts checks this list against src.
 */
export const BOOT_ISLAND_FEATURES: readonly BootIsland[] = [
  { marker: 'cc-feature:welcome', module: 'src/components/welcome/WelcomeGate.tsx' },
  { marker: 'cc-feature:sound-control', module: 'src/components/audio/SoundControl.tsx' },
  { marker: 'cc-feature:clout-hud', module: 'src/components/hud/HudLive.tsx' },
  { marker: 'cc-feature:hud-panel-buttons', module: 'src/components/hud/HudPanelButtons.tsx' },
  { marker: 'cc-feature:level-up', module: 'src/components/hud/LevelUpToast.tsx' },
  {
    marker: 'cc-feature:event-sheet',
    module: 'src/components/events/EventSheetHost.tsx',
    nested: true,
  },
]

/** A Turbopack chunk loader: the files one dynamic import fetches before it runs. */
export interface Loader {
  /** The chunk the loader is in. */
  readonly chunk: string
  readonly files: readonly string[]
}

// Turbopack (Next 16) compiles `import()` to `<r>.v(t=>Promise.all([<files>].map(t=><r>.l(t)))
// .then(()=>t(<module id>)))`, with the files as JSON strings relative to the build dir.
const LOADER = /\.v\(\s*[\w$]+\s*=>\s*Promise\.all\(\s*(\[[^\]]*\])\s*\.map\(/g
const LoaderFilesSchema = z.array(z.string().regex(/^static\/[\w\-./]+$/))

/** The chunk loaders in a chunk; throws on a loader whose file list cannot be read. */
export function findLoaders(chunk: string, text: string): Loader[] {
  const loaders: Loader[] = []
  for (const match of text.matchAll(LOADER)) {
    let files: unknown
    try {
      files = JSON.parse(match[1] ?? '')
    } catch {
      files = undefined
    }
    const result = LoaderFilesSchema.safeParse(files)
    if (!result.success || result.data.some((file) => file.split('/').includes('..'))) {
      throw new Error(`${chunk}: unreadable chunk loader (has the Turbopack format changed?)`)
    }
    loaders.push({ chunk, files: result.data })
  }
  return loaders
}

function chunksWithMarker(chunks: Chunks, marker: string): string[] {
  return [...chunks].filter(([, text]) => hasMarker(text, marker)).map(([name]) => name)
}

function onlyOne<T>(items: readonly T[], what: string): T {
  if (items.length !== 1 || items[0] === undefined) {
    throw new Error(`expected exactly one ${what}, found ${items.length}`)
  }
  return items[0]
}

function jsFiles(files: readonly string[], exclude: ReadonlySet<string>): string[] {
  return [...new Set(files)].filter((file) => file.endsWith('.js') && !exclude.has(file)).sort()
}

/** `REVISION` as three's bundled module exports it (`"REVISION",0,"182"`). */
const THREE_REVISION = /"REVISION",\s*0,\s*"(\d+)"/g

/**
 * Every copy of three in the build, as [chunk, revision]: one per chunk and revision. A chunk
 * holds a module once, but can export three's namespace more than once (the apartment's imports
 * re-export it, S16), so a repeated `REVISION` export in one chunk is not a second copy.
 */
export function threeRevisions(chunks: Chunks): [string, string][] {
  const found: [string, string][] = []
  for (const [name, text] of chunks) {
    const revisions = new Set([...text.matchAll(THREE_REVISION)].map((match) => match[1] ?? ''))
    for (const revision of revisions) found.push([name, revision])
  }
  return found
}

const ApartmentLimitSchema = z.object({
  apartmentChunkJsGzKB: PerfConfigSchema.shape.apartmentChunkJsGzKB,
})

export function readApartmentChunkLimit(perf: unknown): number {
  const result = ApartmentLimitSchema.safeParse(perf)
  if (!result.success) {
    throw new Error('data/config/perf.json: apartmentChunkJsGzKB must be a positive number')
  }
  return result.data.apartmentChunkJsGzKB
}

/** The feature marker the apartment's 3D chunk renders (src/scene/apartment/ApartmentCanvas.tsx). */
export const APARTMENT_MARKER = 'cc-feature:apartment-scene'

/**
 * True when `marker` appears whole in `text`, not as the start of a longer id (the same rule as
 * scripts/shell-guard.ts).
 */
export function containsMarker(text: string, marker: string): boolean {
  let at = text.indexOf(marker)
  while (at !== -1) {
    if (!/^-?[a-z0-9]/.test(text.slice(at + marker.length, at + marker.length + 2))) return true
    at = text.indexOf(marker, at + 1)
  }
  return false
}

/** `server/app/page/react-loadable-manifest.json` as Turbopack writes it (Next 16). */
const LoadableManifestSchema = z.record(z.string(), z.object({ files: z.array(z.string().min(1)) }))

export interface LazyChunks {
  /** The city's 3D chunk: loaded before the map is playable. */
  readonly scene: readonly string[]
  /** What only the apartment's import adds (S16): loaded when the Home panel opens. */
  readonly apartment: readonly string[]
}

/**
 * The lazily loaded JS of route `/`, split in two: every `.js` file of every dynamic import in
 * the manifest except the apartment's (deduplicated, minus files the shell already loads: they
 * count once, in the shell), and the files only the apartment's import adds. The apartment's
 * entry is the one whose files `isApartment` (the marker check) accepts. Paths are relative to
 * the build directory (`static/chunks/...`). Fails fast on an unexpected format, no apartment
 * entry or more than one, or an empty result, so a build change cannot turn a check into a
 * silent pass.
 */
export function lazyChunkFiles(
  manifest: unknown,
  shellScripts: readonly string[],
  isApartment: (file: string) => boolean,
): LazyChunks {
  const result = LoadableManifestSchema.safeParse(manifest)
  if (!result.success) throw new Error('react-loadable-manifest.json: unexpected format')
  const shell = new Set(shellScripts.map((src) => src.split(/[?#]/)[0]?.replace(/^\/_next\//, '')))
  const entries = Object.values(result.data).map((entry) =>
    entry.files.filter((file) => {
      if (file.split('/').includes('..')) throw new Error(`Refusing path traversal: ${file}`)
      return file.endsWith('.js') && !shell.has(file)
    }),
  )
  if (entries.every((files) => files.length === 0)) {
    throw new Error('react-loadable-manifest.json lists no lazy JS for /: is the 3D scene mounted?')
  }
  const apartmentEntries = entries.filter((files) => files.some(isApartment))
  if (apartmentEntries.length !== 1) {
    throw new Error(
      `expected one lazy import rendering ${APARTMENT_MARKER}, found ${apartmentEntries.length}: is the apartment mounted with next/dynamic?`,
    )
  }
  const scene = new Set(
    entries.filter((files) => !files.some(isApartment)).flatMap((files) => files),
  )
  if (scene.size === 0) {
    throw new Error('react-loadable-manifest.json lists no lazy JS for /: is the 3D scene mounted?')
  }
  const apartment = new Set((apartmentEntries[0] ?? []).filter((file) => !scene.has(file)))
  return { scene: [...scene].sort(), apartment: [...apartment].sort() }
}

const ServiceWorkerLimitsSchema = z.object({
  serviceWorkerGzKB: PerfConfigSchema.shape.serviceWorkerGzKB,
  precacheGzKB: PerfConfigSchema.shape.precacheGzKB,
})

export function readServiceWorkerLimits(perf: unknown): {
  serviceWorkerGzKB: number
  precacheGzKB: number
} {
  const result = ServiceWorkerLimitsSchema.safeParse(perf)
  if (!result.success) {
    throw new Error(
      'data/config/perf.json: serviceWorkerGzKB and precacheGzKB must be positive numbers',
    )
  }
  return result.data
}

/** Where the build keeps the prerendered service worker (src/app/serwist/[path]/route.ts). */
export const SERVICE_WORKER_BODY = 'server/app/serwist/sw.js.body'

const PRECACHE_URL = /\burl:\s*"([^"]+)"/g

/**
 * The URLs the service worker precaches, read from its injected manifest, deduplicated. Fails
 * fast when there are none, so a changed bundle format cannot pass as an empty precache.
 */
export function precacheUrls(swSource: string): string[] {
  const urls = [...new Set([...swSource.matchAll(PRECACHE_URL)].map((match) => match[1] ?? ''))]
  if (urls.length === 0) throw new Error('sw.js lists no precache entries: unexpected format')
  return urls
}

/**
 * Candidate files for a precached URL: build assets under `static/`, prerendered pages and
 * route bodies under `server/app/`, then `public/`. The first that exists is the one served.
 */
export function precacheFileCandidates(url: string, root: string, distDir: string): string[] {
  if (url.startsWith('/_next/static/')) return [staticFilePath(url, distDir)]
  const path = decodeURIComponent(url.split(/[?#]/)[0] ?? '')
  if (!path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`Refusing precache URL: ${url}`)
  }
  const page = path === '/' ? 'index' : path.slice(1)
  return [
    join(distDir, 'server/app', `${page}.html`),
    join(distDir, 'server/app', `${page}.body`),
    join(root, 'public', path.slice(1)),
  ]
}

async function precacheFileBytes(url: string, root: string, distDir: string): Promise<number> {
  for (const file of precacheFileCandidates(url, root, distDir)) {
    const content = await readFile(file).catch(() => null)
    if (content !== null) return gzipBytes(content)
  }
  throw new Error(`No built file for precached URL ${url}`)
}

/**
 * URLs the precache must never hold (S04e): the 3D models and audio (they load on demand and are
 * cached by the worker then), source maps, and server, moderator, worker and share-image routes.
 */
export const PRECACHE_FORBIDDEN =
  /^\/(?:models|audio|api|mod|serwist|og)(?:\/|$)|\.(?:glb|map)(?:[?#]|$)/

/**
 * Problems with the precache list: a forbidden URL, or a required one missing. `required` is the
 * path to playable (`static/...` chunk names) plus the versioned base geo URL prefix.
 */
export function precacheProblems(
  urls: readonly string[],
  requiredChunks: readonly string[],
): string[] {
  const problems = urls
    .filter((url) => PRECACHE_FORBIDDEN.test(url))
    .map((url) => `precaches ${url}, which must load on demand or never be cached`)
  const listed = new Set(urls)
  for (const chunk of requiredChunks) {
    if (!listed.has(`/_next/${chunk}`)) problems.push(`does not precache ${chunk}`)
  }
  if (!urls.some((url) => /^\/geo\/base\?v=[0-9a-f]+$/.test(url))) {
    problems.push('does not precache the versioned base geo (/geo/base?v=)')
  }
  return problems
}

/**
 * PERF-7 positive control: every optional-chunk marker (src/lib/pwa/lazyChunks.ts) is found in
 * at least one built chunk (so a renamed marker or a changed build cannot pass silently), and no
 * chunk carrying one is precached. Returns the PASS/FAIL line and whether it passed.
 */
export function optionalChunkLine(
  chunks: ReadonlyMap<string, string>,
  urls: readonly string[],
): { readonly ok: boolean; readonly text: string } {
  const precached = new Set(urls)
  const counts: string[] = []
  const problems: string[] = []
  for (const { id, marker } of OPTIONAL_CHUNK_MARKERS) {
    const files = [...chunks].filter(([, text]) => text.includes(marker)).map(([name]) => name)
    if (files.length === 0) problems.push(`no built chunk carries the ${id} marker`)
    for (const file of files) {
      if (precached.has(`/_next/${file}`)) problems.push(`precaches ${file} (${id})`)
    }
    counts.push(`${id} ${files.length}`)
  }
  return problems.length === 0
    ? {
        ok: true,
        text: `PASS Optional chunks left out of the precache (PERF-7): ${counts.join(', ')} chunks, cached at runtime`,
      }
    : { ok: false, text: `FAIL Optional chunks (PERF-7): ${problems.join('; ')}` }
}

const WARM_URL = /"(\/geo\/(?:districts|blocks)\/(low|mid|high)\b[^"]*\?v=[0-9a-f]+)"/g

/** The tier-warm URLs baked into the worker (src/server/pwa/revision.ts), per tier. */
export function workerWarmUrls(swSource: string): Map<string, string[]> {
  const perTier = new Map<string, string[]>()
  for (const match of swSource.matchAll(WARM_URL)) {
    const [, url = '', tier = ''] = match
    const urls = perTier.get(tier) ?? []
    if (!urls.includes(url)) urls.push(url)
    perTier.set(tier, urls)
  }
  return perTier
}

/** Reads `--perf=<file>` (a limits file used instead of data/config/perf.json), if given. */
export function perfOverridePath(argv: readonly string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith('--perf='))
  if (flag === undefined) return null
  const path = flag.slice('--perf='.length)
  if (path === '') throw new Error('--perf= needs a file path')
  return path
}

export interface BuildInput {
  readonly chunks: Chunks
  /** The shell's external scripts, as chunk names. */
  readonly shell: readonly string[]
}

export interface SceneSet {
  /** The 3D chunk's files, minus the shell's. */
  readonly files: readonly string[]
  readonly threeRevision: string
}

/**
 * The files of the scene's lazy import. Fails unless exactly one chunk renders the scene marker,
 * the shell loaders fetching it (at least one) all fetch the same files, the loadable manifest lists the same JS for that import,
 * and the build holds exactly one copy of three, inside this set.
 */
export function sceneSet(input: BuildInput, manifest: unknown): SceneSet {
  try {
    return findSceneSet(input, manifest)
  } catch (error) {
    throw new Error(`3D chunk: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function fail(message: string): never {
  throw new Error(message)
}

function findSceneSet(input: BuildInput, manifest: unknown): SceneSet {
  const shell = new Set(input.shell)
  const markerChunk = onlyOne(
    chunksWithMarker(input.chunks, SCENE_FEATURE),
    `chunk with ${SCENE_FEATURE}`,
  )
  const loaders = input.shell
    .flatMap((name) => findLoaders(name, input.chunks.get(name) ?? ''))
    .filter((loader) => loader.files.includes(markerChunk))
  // The scene mount also preloads the canvas chunk with its own import() (S04b, PERF-4): every
  // loader of the marker chunk must then fetch the same files.
  const fileSets = [...new Set(loaders.map((loader) => jsFiles(loader.files, new Set()).join()))]
  if (fileSets.length > 1) {
    fail(`shell chunk loaders fetching ${markerChunk} disagree: ${fileSets.join(' | ')}`)
  }
  const loader = onlyOne(loaders.slice(0, 1), `shell chunk loader fetching ${markerChunk}`)

  const parsed = LoadableManifestSchema.safeParse(manifest)
  if (!parsed.success) fail('react-loadable-manifest.json has an unexpected format')
  const entries = Object.values(parsed.data).filter((entry) => entry.files.includes(markerChunk))
  if (entries.length === 0) {
    fail(`expected a react-loadable-manifest.json entry for ${markerChunk}, found 0`)
  }
  // Another lazy import can share the scene's files (the apartment's, S16): the scene's entry is
  // the one listing exactly what the shell loader fetches.
  const fromLoader = jsFiles(loader.files, new Set())
  const matching = entries.filter(
    (entry) => jsFiles(entry.files, new Set()).join() === fromLoader.join(),
  )
  if (matching.length === 0) {
    fail(`the shell loader (${fromLoader.join(', ')}) and the loadable manifest disagree`)
  }

  const revisions = threeRevisions(input.chunks)
  if (revisions.length === 0) fail("three's REVISION not found: has the bundle format changed?")
  if (revisions.length > 1) {
    fail(`three is bundled more than once: ${revisions.map(([name, r]) => `${name} r${r}`)}`)
  }
  const [threeChunk, threeRevision] = onlyOne(revisions, 'copy of three')
  const files = jsFiles(loader.files, shell)
  if (!files.includes(threeChunk)) fail(`three (${threeChunk}) is outside the 3D chunk`)
  for (const file of files) {
    if (!input.chunks.has(file)) fail(`${file} is missing from the build`)
  }
  return { files, threeRevision }
}

/**
 * The files each boot island's loader in the shell fetches, minus the shell's. Fails unless every
 * island's marker is in exactly one chunk and exactly one shell loader fetches that chunk (for a
 * nested island: the chunk holding the marked feature's loader).
 */
export function bootIslandFiles(
  input: BuildInput,
  islands: readonly BootIsland[] = BOOT_ISLAND_FEATURES,
): Map<string, string[]> {
  const shell = new Set(input.shell)
  const shellLoaders = input.shell.flatMap((name) =>
    findLoaders(name, input.chunks.get(name) ?? ''),
  )
  const result = new Map<string, string[]>()
  for (const island of islands) {
    const label = `boot island ${island.module}`
    try {
      const markerChunk = onlyOne(
        chunksWithMarker(input.chunks, island.marker),
        `chunk with ${island.marker}`,
      )
      let target = markerChunk
      if (island.nested === true) {
        const hosts = [...input.chunks.keys()].filter((name) =>
          findLoaders(name, input.chunks.get(name) ?? '').some((loader) =>
            loader.files.includes(markerChunk),
          ),
        )
        target = onlyOne(hosts, `chunk whose loader fetches ${markerChunk}`)
      }
      const loader = onlyOne(
        shellLoaders.filter((candidate) => candidate.files.includes(target)),
        `shell chunk loader fetching ${target}`,
      )
      const files = jsFiles(loader.files, shell)
      for (const file of files) {
        if (!input.chunks.has(file)) throw new Error(`${file} is missing from the build`)
      }
      result.set(island.module, files)
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

/** The `/geo/base` body's top-level layers (src/app/geo/base/route.ts). */
const GeoBaseBodySchema = z.looseObject({
  format: z.string().min(1),
  land: z.unknown(),
  water: z.unknown(),
  parks: z.unknown(),
  subway: z.unknown(),
})

/** Checks that `body` is the base geo route's JSON, so the budget measures the right file. */
export function assertGeoBaseBody(body: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  const result = GeoBaseBodySchema.safeParse(parsed)
  const layers = ['land', 'water', 'parks', 'subway'] as const
  if (!result.success || layers.some((layer) => !(layer in result.data))) {
    throw new Error('/geo/base body is not the base geo JSON (format, land, water, parks, subway)')
  }
}

export interface DuplicateReport {
  /** Modules found with the same id and code in more than one chunk. */
  readonly modules: number
  /** Gzipped bytes of every copy past the first, each module compressed on its own. */
  readonly extraGzBytes: number
  /** The largest duplicates: [module id, chunk count, extra gz bytes]. */
  readonly top: readonly (readonly [string, number, number])[]
}

// A module in a Turbopack chunk: `,<id>,<factory>` inside the chunk's `.push([...])`.
const MODULE_START = /[,[](\d+),(?=(?:[\w$]+|\([\w$,]*\))=>|function\b)/g

/** The modules of a chunk by id, each with its code (up to the next module). */
export function chunkModules(text: string): Map<string, string> {
  const starts = [...text.matchAll(MODULE_START)]
  const modules = new Map<string, string>()
  starts.forEach((match, index) => {
    // The last module ends where the chunk's `.push([...])` closes.
    const close = text.lastIndexOf('])')
    const end = starts[index + 1]?.index ?? (close > match.index ? close : text.length)
    modules.set(match[1] ?? '', text.slice(match.index + match[0].length, end))
  })
  return modules
}

/** PERF-3: modules copied into more than one chunk. Report only; it never fails the budget. */
export function duplicateModules(chunks: Chunks): DuplicateReport {
  const copies = new Map<string, { code: string; count: number }>()
  for (const text of chunks.values()) {
    for (const [id, code] of chunkModules(text)) {
      const key = `${id}\u0000${code}`
      const seen = copies.get(key)
      copies.set(key, { code, count: (seen?.count ?? 0) + 1 })
    }
  }
  const duplicates = [...copies]
    .filter(([, entry]) => entry.count > 1)
    .map(([key, entry]) => {
      const id = key.split('\u0000')[0] ?? ''
      return [id, entry.count, gzipBytes(entry.code) * (entry.count - 1)] as const
    })
    .sort((a, b) => b[2] - a[2])
  return {
    modules: duplicates.length,
    extraGzBytes: duplicates.reduce((sum, [, , bytes]) => sum + bytes, 0),
    top: duplicates.slice(0, 3),
  }
}

function report(result: BudgetResult, detail: string): string {
  const status = result.ok ? 'PASS' : 'FAIL'
  return `${status} ${result.name}: ${result.actualKB} KB gz (limit ${result.limitKB} KB)\n  ${detail}`
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1)

async function readOrExplain(path: string, missing: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new Error(missing)
  }
}

async function readChunks(distDir: string): Promise<Map<string, string>> {
  const staticDir = join(distDir, 'static')
  const entries = await readdir(staticDir, { recursive: true, withFileTypes: true })
  const chunks = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const path = join(entry.parentPath, entry.name)
    chunks.set(relative(distDir, path).split('\\').join('/'), await readFile(path, 'utf8'))
  }
  return chunks
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

/** Per tier: the gzipped district and block bodies, or null before S04d's routes exist. */
async function districtBytes(appDir: string): Promise<Map<string, [number, number]> | null> {
  const districtsDir = join(appDir, 'geo/districts')
  if (!(await isDirectory(districtsDir))) return null
  const perTier = new Map<string, [number, number]>()
  for (const tier of QUALITY_TIERS) {
    const tierDir = join(districtsDir, tier)
    const bodies = (await isDirectory(tierDir))
      ? (await readdir(tierDir)).filter((name) => name.endsWith('.body'))
      : []
    if (bodies.length === 0) {
      throw new Error(`/geo/districts is built but has no ${tier} district bodies in ${tierDir}`)
    }
    let bytes = 0
    for (const name of bodies) bytes += gzipBytes(await readFile(join(tierDir, name)))
    const blocks = await readFile(join(appDir, 'geo/blocks', `${tier}.body`)).catch(() => null)
    if (blocks !== null) bytes += gzipBytes(blocks)
    perTier.set(tier, [bytes, bodies.length])
  }
  return perTier
}

async function main(): Promise<void> {
  const root = process.cwd()
  const distDir = join(root, '.next')
  const appDir = join(distDir, 'server/app')
  const override = perfOverridePath(process.argv.slice(2))
  const perfPath = override === null ? join(root, 'data/config/perf.json') : resolve(root, override)
  const perf: unknown = JSON.parse(await readOrExplain(perfPath, `No limits file at ${perfPath}`))
  const limits = readLimits(perf)

  const html = await readOrExplain(
    join(appDir, 'index.html'),
    'No prerendered / found in .next/server/app/index.html. Run `npm run build`.',
  )
  const { external, inline } = extractScripts(html)
  if (external.length === 0) throw new Error('No external scripts found for /: unexpected build')
  const shellFiles = external.map(staticChunkName)

  const chunks = await readChunks(distDir)
  const gz = new Map<string, number>()
  const gzOf = (file: string) => {
    const text = chunks.get(file)
    if (text === undefined) throw new Error(`${file} is referenced but missing from the build`)
    const bytes = gz.get(file) ?? gzipBytes(text)
    gz.set(file, bytes)
    return bytes
  }
  const sum = (files: Iterable<string>) => [...files].reduce((total, f) => total + gzOf(f), 0)

  const externalBytes = sum(shellFiles)
  const inlineBytes = gzipBytes(inline.join('\n'))
  const shell = checkBudget('Shell JS (/)', externalBytes + inlineBytes, limits.shellJsGzKB)

  const manifest: unknown = JSON.parse(
    await readOrExplain(
      join(appDir, 'page/react-loadable-manifest.json'),
      'No .next/server/app/page/react-loadable-manifest.json. Run `npm run build`.',
    ),
  )
  const input = { chunks, shell: shellFiles }
  const scene3d = sceneSet(input, manifest)
  const scene = checkBudget('3D chunk JS (lazy)', sum(scene3d.files), limits.sceneChunkJsGzKB)

  // The apartment's import (S16): only what it adds beyond the city's 3D chunk and the shell.
  const lazy = lazyChunkFiles(manifest, external, (file) =>
    containsMarker(chunks.get(file) ?? '', APARTMENT_MARKER),
  )
  const apartmentFiles = lazy.apartment.filter((file) => !scene3d.files.includes(file))
  const apartment = checkBudget(
    'Apartment chunk JS (lazy, Home panel)',
    sum(apartmentFiles),
    readApartmentChunkLimit(perf),
  )

  const boot = bootIslandFiles(input)
  const playable = new Set([...shellFiles, ...[...boot.values()].flat(), ...scene3d.files])
  const bootOnly = [...new Set([...boot.values()].flat())].filter(
    (file) => !scene3d.files.includes(file),
  )
  const total = checkBudget(
    'Total JS to playable',
    sum(playable) + inlineBytes,
    limits.totalJsToPlayableGzKB,
  )

  const geoBody = await readOrExplain(
    join(appDir, 'geo/base.body'),
    'No prerendered /geo/base found in .next/server/app/geo/base.body. Run `npm run build`.',
  )
  assertGeoBaseBody(geoBody)
  const geo = checkBudget('Base geo (/geo/base)', gzipBytes(geoBody), limits.baseGeoGzKB)

  const swLimits = readServiceWorkerLimits(perf)
  const swSource = await readOrExplain(
    join(distDir, SERVICE_WORKER_BODY),
    `No ${SERVICE_WORKER_BODY} in .next. Run \`npm run build\`.`,
  )
  const worker = checkBudget(
    'Service worker (/serwist/sw.js)',
    gzipBytes(swSource),
    swLimits.serviceWorkerGzKB,
  )
  const urls = precacheUrls(swSource)
  const problems = precacheProblems(
    urls,
    [...playable].filter((file) => file.endsWith('.js')),
  )
  if (problems.length > 0) throw new Error(`service worker: ${problems.join('; ')}`)
  let precacheBytes = 0
  for (const url of urls) precacheBytes += await precacheFileBytes(url, root, distDir)
  const precache = checkBudget('Precache (install)', precacheBytes, swLimits.precacheGzKB)

  const results = [shell, scene, apartment, total, geo, worker, precache]
  const lines = [
    report(
      shell,
      `${external.length} chunks: ${kb(externalBytes)} KB gz; inline: ${kb(inlineBytes)} KB gz`,
    ),
    report(scene, `three r${scene3d.threeRevision}; ${scene3d.files.join(', ')}`),
    report(apartment, `${apartmentFiles.length} chunks: ${apartmentFiles.join(', ')}`),
    report(
      total,
      `shell ${shell.actualKB} KB + ${boot.size} boot islands ${kb(sum(bootOnly))} KB + 3D ${scene.actualKB} KB (shared files counted once); ${playable.size} files`,
    ),
    report(geo, `${kb(geoBody.length)} KB raw`),
    report(worker, `${SERVICE_WORKER_BODY}`),
    report(precache, `${urls.length} entries`),
  ]

  const districts = await districtBytes(appDir)
  if (districts === null) {
    lines.push('SKIP District buildings: this build has no /geo/districts routes yet (S04d)')
  } else {
    // S04e part 2: the worker can warm every tier the build serves.
    const warm = workerWarmUrls(swSource)
    const empty = QUALITY_TIERS.filter((tier) => (warm.get(tier) ?? []).length === 0)
    if (empty.length > 0) {
      throw new Error(`service worker: no tier-warm URLs for ${empty.join(', ')}`)
    }
    lines.push(
      `INFO Tier warm: ${QUALITY_TIERS.map((tier) => `${tier} ${warm.get(tier)?.length ?? 0} URLs`).join(', ')}`,
    )
    for (const [tier, [bytes, count]] of districts) {
      const limit =
        limits.districtBuildingsGzKB[tier as keyof BudgetLimits['districtBuildingsGzKB']]
      const result = checkBudget(`District buildings (${tier})`, bytes, limit)
      results.push(result)
      lines.push(report(result, `${count} districts plus /geo/blocks/${tier}`))
    }
  }

  const optional = optionalChunkLine(chunks, urls)
  lines.push(optional.text)
  if (!optional.ok) process.exitCode = 1

  const readJson = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(join(root, file), 'utf8'))
  const shellCode = new Map(shellFiles.map((file) => [file, chunks.get(file) ?? '']))
  shellCode.set('(inline)', inline.join('\n'))
  const models = modelBudgetLines(
    await readJson('data/assets/manifest.json'),
    perf,
    await readJson('data/config/scene.json'),
    shellCode,
  )
  lines.push(...models.map((line) => line.text))
  if (models.some((line) => !line.ok)) process.exitCode = 1
  // The model runtime's lazy chunk(s), loaded once the city has drawn (or the apartment or the
  // showcase opens): outside the shell and 3D chunk budgets, reported so growth stays visible.
  const runtime = loaderLeaks(chunks)
  lines.push(
    `INFO Model runtime JS (lazy, after the map draws): ${kb(sum(runtime))} KB gz in ${runtime.length} chunks`,
  )

  const duplicates = duplicateModules(chunks)
  const top = duplicates.top.map(([id, count, bytes]) => `#${id} ×${count} +${kb(bytes)} KB`)
  lines.push(
    `INFO PERF-3 duplicate modules (report only): ${duplicates.modules} modules in more than one chunk, about ${kb(duplicates.extraGzBytes)} KB gz extra${top.length > 0 ? `; largest ${top.join(', ')}` : ''}`,
  )

  if (override !== null) lines.unshift(`NOTE limits read from ${override}, not perf.json`)
  process.stdout.write(`${lines.join('\n')}\n`)
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`budget: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
