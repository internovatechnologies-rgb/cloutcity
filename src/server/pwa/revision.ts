/**
 * Build-time inputs of the service worker (S04e): the build revision, the versioned runtime
 * cache names and the precache entries the route handler adds to the build's static files
 * (src/app/serwist/[path]/route.ts). Server-only: it reads git, the build directory and the
 * classic-zod geo data, and runs only while the worker route is prerendered.
 */
import 'server-only'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import audioManifestJson from '@data/audio/manifest.json'
import modelManifestJson from '@data/assets/manifest.json'
import { districtAssetUrls } from '@/lib/data/districts'
import { geoVersion } from '@/lib/data/geo'
import { isChunkPath, optionalChunkMarkers } from '@/lib/pwa/lazyChunks'
import { runtimeCacheName, type ServiceWorkerConfig } from '@/sw/policy'

export interface RevisionInputs {
  /** The commit being built, when known. */
  readonly commit: string | null
  /** Every file under the build's `static/` directory (content-hashed names), any order. */
  readonly staticFiles: readonly string[]
  readonly geoVersion: string
  readonly audioVersion: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * One revision per build: it changes whenever the code (commit, chunk names), the geo or the
 * audio changes, so the HTML precache entries (`/`, `/offline`, legal pages, manifest) are
 * fetched again exactly when they may have changed. Deterministic for the same inputs.
 */
export function buildRevision(inputs: RevisionInputs): string {
  return sha256(
    [
      `commit:${inputs.commit ?? ''}`,
      `geo:${inputs.geoVersion}`,
      `audio:${inputs.audioVersion}`,
      ...[...inputs.staticFiles].sort(),
    ].join('\n'),
  ).slice(0, 16)
}

/** Content version of the audio files: their sha256s from data/audio/manifest.json. */
export function audioVersionOf(manifest: {
  readonly tracks: readonly { readonly sources: readonly { readonly sha256: string }[] }[]
}): string {
  const hashes = manifest.tracks.flatMap((track) => track.sources.map((source) => source.sha256))
  return sha256(hashes.sort().join('\n')).slice(0, 12)
}

const COMMIT = /^[0-9a-f]{7,64}$/

/** The commit: Vercel's build variable, else `git rev-parse HEAD`, else unknown. */
function currentCommit(): string | null {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA
  if (fromEnv !== undefined && COMMIT.test(fromEnv)) return fromEnv
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  const head = git.status === 0 ? git.stdout.trim() : ''
  return COMMIT.test(head) ? head : null
}

/** The build directory, as next.config.ts sets it. */
export function distDir(): string {
  return process.env.NEXT_DIST_DIR ?? '.next'
}

function staticFiles(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'static'), { recursive: true, encoding: 'utf8' })
  } catch {
    // `next dev` before the first compile has no static directory yet; the revision still
    // changes with the commit, geo and audio.
    return []
  }
}

/** The worker's build-time configuration, baked into sw.js by the route handler. */
export function serviceWorkerConfig(): ServiceWorkerConfig {
  const audioVersion = audioVersionOf(audioManifestJson)
  const revision = buildRevision({
    commit: currentCommit(),
    staticFiles: staticFiles(distDir()),
    geoVersion,
    audioVersion,
  })
  return {
    revision,
    geoVersion,
    geoCache: runtimeCacheName('geo', geoVersion),
    audioCache: runtimeCacheName('audio', audioVersion),
    // The model manifest's own content hash (S04h): a rebuilt model set gets a new cache, and the
    // old one is deleted when the worker that knows the new set takes over.
    modelsCache: runtimeCacheName('models', modelManifestJson.assetVersion),
    // PERF-7: chunks left out of the precache, one cache per build; older builds' are deleted
    // when the next worker takes over (their chunk names are gone with the build).
    chunksCache: runtimeCacheName('chunks', revision),
    districtUrls: {
      low: districtAssetUrls('low'),
      mid: districtAssetUrls('mid'),
      high: districtAssetUrls('high'),
    },
  }
}

/**
 * What the worker precaches from the build and `public/` (globs relative to the project root).
 * Only code, styles, vector art and fonts from the build, and the app icons from `public/`:
 * never `public/audio` (it loads after the player's audio choice) and never `public/models`
 * (models load on demand, per tier, and the worker caches them then).
 */
export function precacheGlobs(dir: string = distDir()): string[] {
  return [`${dir}/static/**/*.{js,css,svg,woff2}`, 'public/icons/**/*']
}

/** A precache entry as Serwist's manifest transforms see it (url relative to the project root). */
export interface ManifestFileEntry {
  url: string
  revision?: string | null
  size: number
}

/**
 * PERF-7: drops the large optional chunks (src/lib/pwa/lazyChunks.ts) from the install
 * precache, matching each built chunk's content, so the precache stays within `precacheGzKB`
 * without raising it. The worker caches them at runtime when they first load (`cc-chunks-`).
 * Runs before Serwist rewrites the URLs, so an entry's URL is its path under the project root.
 */
export function dropOptionalChunks(
  // turbopackIgnore: a path built from process.cwd() makes Turbopack trace the whole project into
  // the worker route's server bundle (F3); these are build outputs read at prerender time only.
  read: (path: string) => string = (path) =>
    readFileSync(
      /* turbopackIgnore: true */ join(/* turbopackIgnore: true */ process.cwd(), path),
      'utf8',
    ),
) {
  return async <E extends ManifestFileEntry>(
    entries: E[],
  ): Promise<{ manifest: E[]; warnings: string[] }> => ({
    manifest: entries.filter(
      (entry) => !isChunkPath(entry.url) || optionalChunkMarkers(read(entry.url)).length === 0,
    ),
    warnings: [],
  })
}

/** Pages precached as they were built, refreshed whenever the build revision changes. */
export const PRECACHED_PAGES = [
  '/',
  '/offline',
  '/terms',
  '/privacy',
  '/credits',
  '/manifest.webmanifest',
] as const

export interface PrecacheEntry {
  readonly url: string
  readonly revision: string | null
}

/**
 * The precache entries beyond the build's static files: the pages above at the build revision,
 * and the geo at its `?v=` version. Base geo needs no revision (its URL is its version); the
 * fallback map also depends on the palette and copy, so it is refreshed with every build.
 */
export function additionalPrecacheEntries(
  revision: string,
  version: string = geoVersion,
): PrecacheEntry[] {
  return [
    ...PRECACHED_PAGES.map((url) => ({ url, revision })),
    { url: `/geo/base?v=${version}`, revision: null },
    { url: `/geo/fallback?v=${version}`, revision },
  ]
}
