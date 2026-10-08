/**
 * Pinned downloads for the asset build. Packs land byte for byte in the gitignored
 * `.cache/assets/` and are re-verified against scripts/assets/sources.lock.json on every build,
 * so a changed upstream file fails instead of silently changing a model (NOTE-22: Kenney zip URLs
 * move on re-upload; --update re-pins them). Zips are read in memory with fflate, never extracted.
 *
 * Modes (as in scripts/geo/sources.ts):
 * - default: use the cache when it matches the lock, else download; a mismatch fails.
 * - update: download what the catalog needs and accept it, rewriting the lock.
 * - offline: never fetch; a missing or stale cache fails.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { unzipSync } from 'fflate'
import { download, sha256Hex, type FetchLike } from '../geo/sources.ts'
import type { Catalog, LockedFile, Source, SourcesLock } from './schema.ts'

export type FetchMode = 'default' | 'update' | 'offline'

/** A pack's files by path (zip entry or repository path), plus its lock record. */
export interface Pack {
  readonly source: Source
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly lock: SourcesLock['sources'][number] | undefined
}

export interface EnsurePacksOptions {
  readonly root: string
  readonly cacheDir: string
  readonly catalog: Catalog
  readonly lock: SourcesLock | undefined
  readonly mode: FetchMode
  readonly today: string
  readonly fetch?: FetchLike
  readonly log?: (line: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

export interface GltfContainer {
  readonly json: GltfJson
  /** The GLB binary chunk, if any. */
  readonly bin: Uint8Array | undefined
}

/** The parts of glTF JSON the pipeline reads before handing it to glTF Transform. */
export interface GltfJson {
  buffers?: { uri?: string }[]
  images?: { uri?: string }[]
  [key: string]: unknown
}

/** Splits a .glb into its JSON and BIN chunks, or parses a .gltf. */
export function readGltfContainer(bytes: Uint8Array): GltfContainer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    return { json: JSON.parse(new TextDecoder().decode(bytes)) as GltfJson, bin: undefined }
  }
  let json: GltfJson | undefined
  let bin: Uint8Array | undefined
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson
    else if (type === CHUNK_BIN) bin = chunk
    offset += 8 + length
  }
  if (json === undefined) throw new Error('glb has no JSON chunk')
  return { json, bin }
}

/** External buffer and image URIs (data: URIs excluded), as written in the file. */
export function externalUris(json: GltfJson): string[] {
  const uris = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((resource) => resource.uri)
    .filter((uri): uri is string => uri !== undefined && !uri.startsWith('data:'))
  return [...new Set(uris)]
}

/** Resolves a URI from a glTF file against that file's folder; refuses to leave the pack. */
export function resolveUri(fromPath: string, uri: string): string {
  const resolved = posix.normalize(posix.join(posix.dirname(fromPath), decodeURIComponent(uri)))
  if (resolved.startsWith('../') || resolved.startsWith('/')) {
    throw new Error(`${fromPath}: ${uri} points outside the pack`)
  }
  return resolved
}

export function remoteUrl(source: Source, path: string): string {
  const { download: dl } = source
  if (dl.kind === 'zip') return dl.url
  if (dl.kind === 'github-raw') {
    return `https://raw.githubusercontent.com/${dl.repo}/${dl.commit}/${path.split('/').map(encodeURIComponent).join('/')}`
  }
  throw new Error(`${source.id}: local sources are not downloaded`)
}

/** Pack paths (relative to the zip or repository root) of every model entry from a source. */
export function entryPaths(catalog: Catalog, source: Source): string[] {
  const root = source.download.root
  return catalog.models
    .filter((model) => model.source === source.id)
    .flatMap((model) => model.entries.map((entry) => posix.join(root, entry.path)))
}

async function readIfExists(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Writes through a .part file and renames, so a crash never leaves a truncated cache file. */
async function writeCache(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const part = `${path}.part`
  await rm(part, { force: true })
  await writeFile(part, bytes)
  await chmod(part, 0o444)
  await rename(part, path)
}

const cachePath = (cacheDir: string, source: Source, path: string) =>
  source.download.kind === 'zip'
    ? join(cacheDir, source.download.file)
    : join(cacheDir, source.id, ...path.split('/'))

interface Fetcher {
  readonly mode: FetchMode
  readonly cacheDir: string
  readonly fetchImpl: FetchLike
  readonly sleep: (ms: number) => Promise<void>
  readonly log: (line: string) => void
}

/** One pinned file: from the cache when it matches, else downloaded and checked. */
async function ensureFile(f: Fetcher, source: Source, pinned: LockedFile): Promise<Uint8Array> {
  const path = cachePath(f.cacheDir, source, pinned.path)
  const cached = await readIfExists(path)
  if (cached !== undefined && sha256Hex(cached) === pinned.sha256) return cached
  if (f.mode === 'offline') {
    throw new Error(
      `${source.id}: ${pinned.path} has no cached copy matching the lock (offline); run npm run assets:build once with network`,
    )
  }
  f.log(`download ${pinned.url}`)
  const bytes = await download(pinned.url, f.fetchImpl, f.sleep, f.log)
  const sha256 = sha256Hex(bytes)
  if (sha256 !== pinned.sha256 || bytes.byteLength !== pinned.bytes) {
    throw new Error(
      `${source.id}: ${pinned.path} changed upstream (expected sha256 ${pinned.sha256}, got ${sha256}); rerun with --update`,
    )
  }
  await writeCache(path, bytes)
  return bytes
}

/** Update mode: downloads a file and records whatever arrives. */
async function pinFile(f: Fetcher, source: Source, path: string) {
  const url = remoteUrl(source, path)
  f.log(`download ${url}`)
  const bytes = await download(url, f.fetchImpl, f.sleep, f.log)
  await writeCache(cachePath(f.cacheDir, source, path), bytes)
  const file: LockedFile = { path, url, sha256: sha256Hex(bytes), bytes: bytes.byteLength }
  return { bytes, file }
}

function unzip(source: Source, bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (!name.endsWith('/')) files.set(name, data)
  }
  if (files.size === 0) throw new Error(`${source.id}: the zip is empty`)
  return files
}

async function ensureRemotePack(
  f: Fetcher,
  catalog: Catalog,
  source: Source,
  previous: SourcesLock['sources'][number] | undefined,
  today: string,
): Promise<Pack> {
  const { download: dl } = source
  if (f.mode !== 'update') {
    if (previous === undefined) {
      throw new Error(`${source.id}: not in scripts/assets/sources.lock.json; rerun with --update`)
    }
    const expectedUrl = dl.kind === 'zip' ? dl.url : undefined
    if (expectedUrl !== undefined && previous.files[0]?.url !== expectedUrl) {
      throw new Error(`${source.id}: the catalog URL differs from the lock; rerun with --update`)
    }
    const files = new Map<string, Uint8Array>()
    for (const pinned of previous.files) {
      if (dl.kind === 'github-raw' && pinned.url !== remoteUrl(source, pinned.path)) {
        throw new Error(
          `${source.id}: ${pinned.path} is pinned to another commit; rerun with --update`,
        )
      }
      files.set(pinned.path, await ensureFile(f, source, pinned))
    }
    if (dl.kind === 'zip') {
      const zip = files.get(previous.files[0]?.path ?? '')
      if (zip === undefined) throw new Error(`${source.id}: the lock names no zip`)
      return { source, files: unzip(source, zip), lock: previous }
    }
    for (const path of [source.licenceEvidence.entry, ...entryPaths(catalog, source)]) {
      if (!files.has(path)) {
        throw new Error(`${source.id}: ${path} is not pinned in the lock; rerun with --update`)
      }
    }
    return { source, files, lock: previous }
  }

  let lockFiles: LockedFile[]
  let files: Map<string, Uint8Array>
  if (dl.kind === 'zip') {
    const { bytes, file } = await pinFile(f, source, dl.file)
    lockFiles = [file]
    files = unzip(source, bytes)
  } else {
    // Each glTF names its buffers and textures; follow them so the lock holds the full closure.
    files = new Map()
    const pinned = new Map<string, LockedFile>()
    const queue = [source.licenceEvidence.entry, ...entryPaths(catalog, source)]
    while (queue.length > 0) {
      const path = queue.shift() ?? ''
      if (pinned.has(path)) continue
      const { bytes, file } = await pinFile(f, source, path)
      pinned.set(path, file)
      files.set(path, bytes)
      if (/\.(?:gltf|glb)$/.test(path)) {
        for (const uri of externalUris(readGltfContainer(bytes).json)) {
          queue.push(resolveUri(path, uri))
        }
      }
    }
    lockFiles = [...pinned.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  }
  const unchanged =
    previous !== undefined && JSON.stringify(previous.files) === JSON.stringify(lockFiles)
  return {
    source,
    files,
    lock: { id: source.id, retrieved: unchanged ? previous.retrieved : today, files: lockFiles },
  }
}

/** Committed Blender outputs (their hashes are checked against scripts/blender/lock.json). */
async function readLocalPack(root: string, catalog: Catalog, source: Source): Promise<Pack> {
  const files = new Map<string, Uint8Array>()
  for (const path of [source.licenceEvidence.entry, ...entryPaths(catalog, source)]) {
    const bytes = await readIfExists(join(root, ...path.split('/')))
    if (bytes === undefined) throw new Error(`${source.id}: ${path} is missing`)
    files.set(path, bytes)
  }
  return { source, files, lock: undefined }
}

/** Fails unless the pack's licence file contains every phrase the catalog expects. */
export function checkLicence(pack: Pack): void {
  const { entry, mustContain } = pack.source.licenceEvidence
  const bytes = pack.files.get(entry)
  if (bytes === undefined) throw new Error(`${pack.source.id}: licence file ${entry} is missing`)
  const text = new TextDecoder().decode(bytes)
  const missing = mustContain.filter((phrase) => !text.includes(phrase))
  if (missing.length > 0) {
    throw new Error(
      `${pack.source.id}: ${entry} does not contain ${missing.map((p) => JSON.stringify(p)).join(', ')}`,
    )
  }
}

export async function ensurePacks(options: EnsurePacksOptions): Promise<{
  packs: Map<string, Pack>
  lock: SourcesLock
}> {
  const f: Fetcher = {
    mode: options.mode,
    cacheDir: options.cacheDir,
    fetchImpl: options.fetch ?? ((url, init) => fetch(url, init)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log: options.log ?? (() => undefined),
  }
  const packs = new Map<string, Pack>()
  const lockSources: SourcesLock['sources'] = []
  for (const source of options.catalog.sources) {
    const previous = options.lock?.sources.find((entry) => entry.id === source.id)
    const pack =
      source.download.kind === 'local'
        ? await readLocalPack(options.root, options.catalog, source)
        : await ensureRemotePack(f, options.catalog, source, previous, options.today)
    checkLicence(pack)
    packs.set(source.id, pack)
    if (pack.lock !== undefined) lockSources.push(pack.lock)
  }
  return { packs, lock: { version: 1, sources: lockSources } }
}
