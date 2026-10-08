/** The geo download cache, with an injected fetch and a temp dir: no network in npm test. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILDING_OUT_FIELDS,
  LockSchema,
  PartialLockSchema,
  SOURCE_DEFINITIONS,
  buildingSourceDefinition,
  buildingSourceDefinitions,
  pageFile,
  pageUrl,
  type Lock,
} from './lock'
import { GeoConfigSchema } from '../../src/lib/data/schemas/config'
import {
  MAX_DOWNLOAD_BYTES,
  USER_AGENT,
  download,
  ensureSources,
  sha256Hex,
  type FetchLike,
} from './sources'

const ROOT = join(import.meta.dirname, '../..')
const bytesFor = (id: string, version = 1) => new TextEncoder().encode(`${id} v${version}`)

function lockFor(version = 1): Lock {
  return {
    version: 1,
    sources: SOURCE_DEFINITIONS.map((definition) => {
      const bytes = bytesFor(definition.id, version)
      return {
        ...definition,
        retrieved: '2026-01-01',
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      }
    }),
    pagedSources: [],
  }
}

/** Serves `bytesFor(id, version)` for each source URL and records the calls. */
function fakeFetch(version = 1) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const definition = SOURCE_DEFINITIONS.find((d) => d.url === url)
    if (definition === undefined) return new Response('nope', { status: 404 })
    return new Response(bytesFor(definition.id, version), { status: 200 })
  }
  return { fetch, calls }
}

const noSleep = async () => undefined

let cacheDir: string
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'cc-geo-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(cacheDir, { recursive: true, force: true })
})

async function seedCache(version = 1) {
  const { fetch } = fakeFetch(version)
  await ensureSources({ cacheDir, lock: lockFor(version), mode: 'default', today: 'x', fetch })
}

describe('ensureSources', () => {
  it('downloads missing files into the cache, read-only, with the user agent and a timeout', async () => {
    const { fetch, calls } = fakeFetch()
    const result = await ensureSources({
      cacheDir,
      lock: lockFor(),
      mode: 'default',
      today: 'x',
      fetch,
    })
    expect(calls.map((c) => c.url)).toEqual(SOURCE_DEFINITIONS.map((d) => d.url))
    for (const call of calls) {
      expect(new Headers(call.init.headers).get('user-agent')).toBe(USER_AGENT)
      expect(call.init.signal).toBeInstanceOf(AbortSignal)
    }
    for (const definition of SOURCE_DEFINITIONS) {
      const path = join(cacheDir, definition.file)
      expect(new Uint8Array(await readFile(path))).toEqual(bytesFor(definition.id))
      expect((await stat(path)).mode & 0o777).toBe(0o444)
      expect(result.files.get(definition.id)).toEqual(bytesFor(definition.id))
    }
    expect((await readdir(cacheDir)).filter((f) => f.endsWith('.part'))).toEqual([])
    expect(result.lock).toEqual(lockFor())
  })

  it('uses a cache that matches the lock without fetching', async () => {
    await seedCache()
    const { fetch, calls } = fakeFetch()
    const result = await ensureSources({
      cacheDir,
      lock: lockFor(),
      mode: 'default',
      today: 'x',
      fetch,
    })
    expect(calls).toEqual([])
    expect(result.files.size).toBe(SOURCE_DEFINITIONS.length)
  })

  it('fails when upstream changed and leaves the old cache untouched', async () => {
    await seedCache()
    const stale = join(cacheDir, SOURCE_DEFINITIONS[0]?.file ?? '')
    // Simulate a corrupt cache entry so the build has to download.
    await chmod(stale, 0o644)
    await writeFile(stale, 'corrupt')
    const { fetch } = fakeFetch(2)
    await expect(
      ensureSources({ cacheDir, lock: lockFor(), mode: 'default', today: 'x', fetch }),
    ).rejects.toThrow(/upstream changed .*rerun with --update/)
    expect(await readFile(stale, 'utf8')).toBe('corrupt')
    expect((await readdir(cacheDir)).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('--update downloads everything, accepts new hashes and dates only what changed', async () => {
    await seedCache()
    const { fetch, calls } = fakeFetch(2)
    const result = await ensureSources({
      cacheDir,
      lock: lockFor(),
      mode: 'update',
      today: '2026-10-06',
      fetch,
    })
    expect(calls).toHaveLength(SOURCE_DEFINITIONS.length)
    expect(result.lock).toEqual({
      version: 1,
      sources: lockFor(2).sources.map((s) => ({ ...s, retrieved: '2026-10-06' })),
      pagedSources: [],
    })
    expect(LockSchema.safeParse(result.lock).success).toBe(true)
    const definition = SOURCE_DEFINITIONS[2]
    expect(new Uint8Array(await readFile(join(cacheDir, definition?.file ?? '')))).toEqual(
      bytesFor(definition?.id ?? '', 2),
    )

    const same = await ensureSources({
      cacheDir,
      lock: result.lock,
      mode: 'update',
      today: '2026-12-31',
      fetch,
    })
    expect(same.lock.sources.map((s) => s.retrieved)).toEqual(
      SOURCE_DEFINITIONS.map(() => '2026-10-06'),
    )
  })

  it('--update from a lock missing a new source keeps the old dates and adds the new one', async () => {
    await seedCache()
    const { fetch } = fakeFetch()
    const partial = { ...lockFor(), sources: lockFor().sources.slice(0, 3) }
    expect(LockSchema.safeParse(partial).success).toBe(false)
    expect(PartialLockSchema.safeParse(partial).success).toBe(true)
    const result = await ensureSources({
      cacheDir,
      lock: partial,
      mode: 'update',
      today: '2026-10-07',
      fetch,
    })
    expect(result.lock.sources.map((s) => s.retrieved)).toEqual(
      SOURCE_DEFINITIONS.map((_, i) => (i < 3 ? '2026-01-01' : '2026-10-07')),
    )
    expect(LockSchema.safeParse(result.lock).success).toBe(true)
  })

  it('--update works without a lock; other modes need one', async () => {
    const { fetch } = fakeFetch()
    const created = await ensureSources({
      cacheDir,
      lock: undefined,
      mode: 'update',
      today: '2026-10-06',
      fetch,
    })
    expect(created.lock.sources).toHaveLength(SOURCE_DEFINITIONS.length)
    await expect(
      ensureSources({ cacheDir, lock: undefined, mode: 'default', today: 'x', fetch }),
    ).rejects.toThrow(/missing or out of date .*--update/)
  })

  it('a lock whose URL no longer matches the definitions must be updated', async () => {
    const lock = lockFor()
    const moved = { ...lock, sources: lock.sources.map((s) => ({ ...s, url: `${s.url}&x=1` })) }
    const { fetch } = fakeFetch()
    await expect(
      ensureSources({ cacheDir, lock: moved, mode: 'default', today: 'x', fetch }),
    ).rejects.toThrow(/out of date/)
  })

  it('--offline never fetches and fails without a valid cache', async () => {
    const { fetch, calls } = fakeFetch()
    await expect(
      ensureSources({ cacheDir, lock: lockFor(), mode: 'offline', today: 'x', fetch }),
    ).rejects.toThrow(/offline/)
    expect(calls).toEqual([])
    await seedCache()
    const result = await ensureSources({
      cacheDir,
      lock: lockFor(),
      mode: 'offline',
      today: 'x',
      fetch,
    })
    expect(result.files.size).toBe(SOURCE_DEFINITIONS.length)
    expect(calls).toEqual([])
  })
})

describe('download', () => {
  const url = 'https://example.org/file.zip'
  const log = () => undefined

  it('refuses plain http', async () => {
    const { fetch } = fakeFetch()
    await expect(download('http://example.org/x', fetch, noSleep, log)).rejects.toThrow(/https/)
  })

  it('retries network errors and 5xx, then succeeds', async () => {
    let attempt = 0
    const fetch: FetchLike = async () => {
      attempt++
      if (attempt === 1) throw new TypeError('fetch failed')
      if (attempt === 2) return new Response('busy', { status: 503 })
      return new Response('ok', { status: 200 })
    }
    const sleeps: number[] = []
    const bytes = await download(url, fetch, async (ms) => void sleeps.push(ms), log)
    expect(new TextDecoder().decode(bytes)).toBe('ok')
    expect(sleeps).toEqual([1000, 2000])
  })

  it('gives up after three retries', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('down', { status: 500 }))
    await expect(download(url, fetch, noSleep, log)).rejects.toThrow(/HTTP 500/)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('does not retry a 4xx', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('gone', { status: 403 }))
    await expect(download(url, fetch, noSleep, log)).rejects.toThrow(/HTTP 403/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a body over the size cap', async () => {
    const big = new Response(new Uint8Array(8), {
      status: 200,
      headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) },
    })
    await expect(download(url, async () => big, noSleep, log)).rejects.toThrow(/too large/)
  })
})

describe('cache writes and download edge cases', () => {
  const url = 'https://example.org/file.zip'
  const log = () => undefined
  const parts = async () => (await readdir(cacheDir)).filter((f) => f.endsWith('.part'))

  /** A body stream of `chunks` copies of `chunk`, optionally failing after `failAfter` chunks. */
  function streamOf(chunk: Uint8Array, chunks: number, failAfter?: number) {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (failAfter !== undefined && sent === failAfter) {
          controller.error(new TypeError('terminated'))
          return
        }
        if (sent === chunks) {
          controller.close()
          return
        }
        sent++
        controller.enqueue(chunk)
      },
    })
  }

  it('a stale read-only .part left by a crashed run is replaced, and none is left behind', async () => {
    const definition = SOURCE_DEFINITIONS[0]
    if (definition === undefined) throw new Error('no sources')
    const part = join(cacheDir, `${definition.file}.part`)
    await writeFile(part, 'half a download')
    await chmod(part, 0o444)
    const { fetch } = fakeFetch()
    await ensureSources({ cacheDir, lock: lockFor(), mode: 'default', today: 'x', fetch })
    expect(await parts()).toEqual([])
    expect(new Uint8Array(await readFile(join(cacheDir, definition.file)))).toEqual(
      bytesFor(definition.id),
    )
  })

  it('a failed download writes nothing: no .part and the old cache file is untouched', async () => {
    await seedCache()
    const stale = join(cacheDir, SOURCE_DEFINITIONS[0]?.file ?? '')
    await chmod(stale, 0o644)
    await writeFile(stale, 'corrupt')
    const fetch: FetchLike = async () => new Response('forbidden', { status: 403 })
    await expect(
      ensureSources({ cacheDir, lock: lockFor(), mode: 'default', today: 'x', fetch }),
    ).rejects.toThrow(/HTTP 403/)
    expect(await readFile(stale, 'utf8')).toBe('corrupt')
    expect(await parts()).toEqual([])
  })

  it('--update replaces read-only (0444) cache files and leaves them read-only', async () => {
    await seedCache()
    for (const definition of SOURCE_DEFINITIONS) {
      expect((await stat(join(cacheDir, definition.file))).mode & 0o777).toBe(0o444)
    }
    const { fetch } = fakeFetch(2)
    await ensureSources({ cacheDir, lock: lockFor(), mode: 'update', today: '2026-10-06', fetch })
    for (const definition of SOURCE_DEFINITIONS) {
      const path = join(cacheDir, definition.file)
      expect(new Uint8Array(await readFile(path))).toEqual(bytesFor(definition.id, 2))
      expect((await stat(path)).mode & 0o777).toBe(0o444)
    }
    expect(await parts()).toEqual([])
  })

  it('a content-length that understates the body does not truncate it (the hash decides)', async () => {
    const body = new Uint8Array(100).fill(7)
    const fetch: FetchLike = async () =>
      new Response(body, { status: 200, headers: { 'content-length': '5' } })
    expect(await download(url, fetch, noSleep, log)).toEqual(body)
  })

  it('a content-length that overstates a small body is not trusted either', async () => {
    const body = new Uint8Array(3).fill(1)
    const fetch: FetchLike = async () =>
      new Response(body, { status: 200, headers: { 'content-length': '1000' } })
    expect(await download(url, fetch, noSleep, log)).toEqual(body)
  })

  it('stops reading a body that grows past the cap without a content-length, and does not retry', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const fetch = vi.fn<FetchLike>(
      async () => new Response(streamOf(chunk, MAX_DOWNLOAD_BYTES / chunk.byteLength + 1)),
    )
    await expect(download(url, fetch, noSleep, log)).rejects.toThrow(/more than 52428800 bytes/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts a body of exactly the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const fetch: FetchLike = async () =>
      new Response(streamOf(chunk, MAX_DOWNLOAD_BYTES / chunk.byteLength))
    expect((await download(url, fetch, noSleep, log)).byteLength).toBe(MAX_DOWNLOAD_BYTES)
  })

  it('retries a timeout (fresh signal each attempt) and gives up after three retries', async () => {
    const signals: (AbortSignal | null | undefined)[] = []
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      signals.push(init.signal)
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const sleeps: number[] = []
    await expect(download(url, fetch, async (ms) => void sleeps.push(ms), log)).rejects.toThrow(
      /timeout/,
    )
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([1000, 2000, 4000])
    expect(new Set(signals).size).toBe(4)
  })

  it('retries a body that breaks off mid-stream, then succeeds', async () => {
    let attempt = 0
    const fetch: FetchLike = async () => {
      attempt++
      if (attempt === 1) return new Response(streamOf(new Uint8Array(10), 5, 2))
      return new Response('whole', { status: 200 })
    }
    expect(new TextDecoder().decode(await download(url, fetch, noSleep, log))).toBe('whole')
    expect(attempt).toBe(2)
  })

  it('a 5xx followed by success returns the successful body', async () => {
    const statuses = [502, 504, 200]
    const fetch: FetchLike = async () => {
      const status = statuses.shift() ?? 200
      return new Response(status === 200 ? 'fine' : 'bad gateway', { status })
    }
    expect(new TextDecoder().decode(await download(url, fetch, noSleep, log))).toBe('fine')
    expect(statuses).toEqual([])
  })

  it.each(['http://example.org/x', 'ftp://example.org/x', 'file:///etc/passwd'])(
    'refuses %s without fetching',
    async (bad) => {
      const fetch = vi.fn<FetchLike>()
      await expect(download(bad, fetch, noSleep, log)).rejects.toThrow(/non-https/)
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})

describe('lock schema', () => {
  const entry = lockFor().sources[0]
  if (entry === undefined) throw new Error('no sources')
  const withEntry = (patch: Record<string, unknown>) => ({
    ...lockFor(),
    sources: [{ ...entry, ...patch }, ...lockFor().sources.slice(1)],
  })

  it.each([
    '../escape.zip',
    '../../etc/passwd.geojson',
    'sub/dir.zip',
    '/abs.zip',
    'UPPER.zip',
    'file.zip.part',
    'file.exe',
    '.zip',
  ])('rejects the cache file name %s', (file) => {
    expect(LockSchema.safeParse(withEntry({ file })).success).toBe(false)
  })

  it.each(['http://example.org/a.zip', 'ftp://example.org/a.zip', 'not a url'])(
    'rejects the download url %s',
    (url) => {
      expect(LockSchema.safeParse(withEntry({ url })).success).toBe(false)
    },
  )

  it('accepts .json cache files and rejects paged sources out of order or repeated', () => {
    expect(LockSchema.safeParse(withEntry({ file: 'density.json' })).success).toBe(true)
    const paged = (id: string) => ({
      ...buildingSourceDefinition({
        id: id as 'midtown',
        label: id,
        borough: 'manhattan',
        center: { lat: 40.75, lng: -73.98 },
        radiusM: 100,
      }),
      retrieved: '2026-10-07',
      count: 1,
      pages: [{ sha256: 'a'.repeat(64), bytes: 1 }],
    })
    const lock = lockFor()
    const ordered = { ...lock, pagedSources: [paged('midtown'), paged('astoria')] }
    expect(LockSchema.safeParse(ordered).success).toBe(true)
    const reversed = { ...lock, pagedSources: [paged('astoria'), paged('midtown')] }
    expect(LockSchema.safeParse(reversed).success).toBe(false)
    const twice = { ...lock, pagedSources: [paged('midtown'), paged('midtown')] }
    expect(LockSchema.safeParse(twice).success).toBe(false)
    const noPages = { ...lock, pagedSources: [{ ...paged('midtown'), pages: [] }] }
    expect(LockSchema.safeParse(noPages).success).toBe(false)
  })

  it('rejects a bad hash, date or size, sources out of order, and unknown keys', () => {
    expect(LockSchema.safeParse(withEntry({ sha256: 'ABC' })).success).toBe(false)
    expect(LockSchema.safeParse(withEntry({ retrieved: '6 Oct 2026' })).success).toBe(false)
    expect(LockSchema.safeParse(withEntry({ bytes: 0 })).success).toBe(false)
    expect(LockSchema.safeParse(withEntry({ extra: true })).success).toBe(false)
    const lock = lockFor()
    expect(LockSchema.safeParse({ ...lock, sources: [...lock.sources].reverse() }).success).toBe(
      false,
    )
    expect(LockSchema.safeParse(lock).success).toBe(true)
  })
})

describe('committed lock and cache location', () => {
  it('scripts/geo/sources.lock.json is valid and matches the source definitions', () => {
    const lock = LockSchema.parse(
      JSON.parse(readFileSync(join(ROOT, 'scripts/geo/sources.lock.json'), 'utf8')),
    )
    expect(
      lock.sources.map(({ id, title, publisher, catalogUrl, url, file, terms }) => ({
        id,
        title,
        publisher,
        catalogUrl,
        url,
        file,
        terms,
      })),
    ).toEqual(SOURCE_DEFINITIONS)
  })

  it('the download cache is gitignored', () => {
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^\/\.cache\/$/m)
    if (!existsSync(join(ROOT, '.git'))) return
    const ignored = execFileSync('git', ['check-ignore', '.cache/geo/mta-gtfs-subway.zip'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(ignored.trim()).toBe('.cache/geo/mta-gtfs-subway.zip')
  })
})

describe('paged building sources', () => {
  const district = {
    id: 'astoria',
    label: 'Astoria',
    borough: 'queens',
    center: { lat: 40.764, lng: -73.923 },
    radiusM: 700,
  } as const
  const definition = buildingSourceDefinition(district)
  const feature = { type: 'Feature', properties: { HEIGHT_ROOF: 30 }, geometry: null }
  const pageBytes = (index: number, sizes: readonly number[], version = 1) =>
    new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from({ length: sizes[index] ?? 0 }, () => feature),
        ...(index < sizes.length - 1 ? { properties: { exceededTransferLimit: true } } : {}),
        version,
      }),
    )

  /** Serves the count and the pages of `sizes`; `count` can disagree on purpose. */
  function pagedFetch(sizes: readonly number[], count = sizes.reduce((a, b) => a + b, 0)) {
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      if (url === definition.countUrl) return new Response(JSON.stringify({ count }))
      const index = sizes.findIndex((_, i) => url === pageUrl(definition, i))
      if (index < 0) return new Response('nope', { status: 404 })
      return new Response(pageBytes(index, sizes))
    }
    return { fetch, calls }
  }
  const base = { lock: lockFor(), today: '2026-10-07', fetch: fakeFetch().fetch }

  it('--update fetches the count, then pages until one is not truncated, and locks each page', async () => {
    const { fetch: pages, calls } = pagedFetch([2000, 2000, 37])
    const files = fakeFetch()
    const result = await ensureSources({
      ...base,
      cacheDir,
      mode: 'update',
      fetch: async (url, init) =>
        SOURCE_DEFINITIONS.some((d) => d.url === url) ? files.fetch(url, init) : pages(url, init),
      pagedDefinitions: [definition],
    })
    expect(calls).toEqual([
      definition.countUrl,
      pageUrl(definition, 0),
      pageUrl(definition, 1),
      pageUrl(definition, 2),
    ])
    expect(pageUrl(definition, 2)).toMatch(/&resultOffset=4000&resultRecordCount=2000$/)
    const entry = result.lock.pagedSources[0]
    expect(entry).toMatchObject({
      id: 'oti-buildings-astoria',
      count: 4037,
      retrieved: '2026-10-07',
    })
    expect(entry?.pages).toEqual(
      [0, 1, 2].map((i) => {
        const bytes = pageBytes(i, [2000, 2000, 37])
        return { sha256: sha256Hex(bytes), bytes: bytes.byteLength }
      }),
    )
    for (const i of [0, 1, 2]) {
      const path = join(cacheDir, pageFile(definition.id, i))
      expect(new Uint8Array(await readFile(path))).toEqual(pageBytes(i, [2000, 2000, 37]))
      expect((await stat(path)).mode & 0o777).toBe(0o444)
    }
    expect(result.pages.get(definition.id)).toHaveLength(3)
    expect(LockSchema.safeParse(result.lock).success).toBe(true)

    // A second update with identical bytes keeps the first retrieval date.
    const again = await ensureSources({
      ...base,
      cacheDir,
      lock: result.lock,
      mode: 'update',
      today: '2026-12-31',
      fetch: async (url, init) =>
        SOURCE_DEFINITIONS.some((d) => d.url === url) ? files.fetch(url, init) : pages(url, init),
      pagedDefinitions: [definition],
    })
    expect(again.lock.pagedSources[0]?.retrieved).toBe('2026-10-07')

    // Offline then reads every page from the cache.
    const offline = await ensureSources({
      ...base,
      cacheDir,
      lock: result.lock,
      mode: 'offline',
      fetch: vi.fn<FetchLike>(),
      pagedDefinitions: [definition],
    })
    expect(offline.pages.get(definition.id)?.map((p) => p.byteLength)).toEqual(
      entry?.pages.map((p) => p.bytes),
    )
  })

  it('--update fails when the pages do not add up to the count', async () => {
    const { fetch } = pagedFetch([2000, 5], 2004)
    const files = fakeFetch()
    await expect(
      ensureSources({
        ...base,
        cacheDir,
        mode: 'update',
        fetch: async (url, init) =>
          SOURCE_DEFINITIONS.some((d) => d.url === url) ? files.fetch(url, init) : fetch(url, init),
        pagedDefinitions: [definition],
      }),
    ).rejects.toThrow(/2005 features but the query counts 2004/)
  })

  it('--update fails on an ArcGIS error body served with HTTP 200', async () => {
    const files = fakeFetch()
    await expect(
      ensureSources({
        ...base,
        cacheDir,
        mode: 'update',
        fetch: async (url, init) =>
          SOURCE_DEFINITIONS.some((d) => d.url === url)
            ? files.fetch(url, init)
            : new Response(JSON.stringify({ error: { code: 400, message: 'Invalid query' } })),
        pagedDefinitions: [definition],
      }),
    ).rejects.toThrow(/oti-buildings-astoria count: unexpected response/)
  })

  it('default mode re-downloads a missing page and fails if it changed; offline never fetches', async () => {
    const sizes = [2000, 3]
    const lock: Lock = {
      ...lockFor(),
      pagedSources: [
        {
          ...definition,
          retrieved: '2026-10-07',
          count: 2003,
          pages: sizes.map((_, i) => {
            const bytes = pageBytes(i, sizes)
            return { sha256: sha256Hex(bytes), bytes: bytes.byteLength }
          }),
        },
      ],
    }
    await seedCache()
    const { fetch, calls } = pagedFetch(sizes)
    const files = fakeFetch()
    const both: FetchLike = async (url, init) =>
      SOURCE_DEFINITIONS.some((d) => d.url === url) ? files.fetch(url, init) : fetch(url, init)
    await expect(
      ensureSources({ ...base, cacheDir, lock, mode: 'offline', pagedDefinitions: [definition] }),
    ).rejects.toThrow(/no cached page 0 .*offline/)
    const result = await ensureSources({
      ...base,
      cacheDir,
      lock,
      mode: 'default',
      fetch: both,
      pagedDefinitions: [definition],
    })
    expect(calls).toEqual([pageUrl(definition, 0), pageUrl(definition, 1)])
    expect(result.lock.pagedSources).toEqual(lock.pagedSources)

    const changed: Lock = {
      ...lock,
      pagedSources: lock.pagedSources.map((entry) => ({
        ...entry,
        pages: entry.pages.map((page) => ({ ...page, sha256: 'a'.repeat(64) })),
      })),
    }
    await expect(
      ensureSources({
        ...base,
        cacheDir,
        lock: changed,
        mode: 'default',
        fetch: both,
        pagedDefinitions: [definition],
      }),
    ).rejects.toThrow(/upstream changed \(page 0/)
  })

  it('a lock entry whose query no longer matches the district must be updated', async () => {
    const moved = buildingSourceDefinition({ ...district, radiusM: 800 })
    const lock: Lock = {
      ...lockFor(),
      pagedSources: [
        {
          ...definition,
          retrieved: '2026-10-07',
          count: 1,
          pages: [{ sha256: 'a'.repeat(64), bytes: 1 }],
        },
      ],
    }
    await seedCache()
    await expect(
      ensureSources({ ...base, cacheDir, lock, mode: 'offline', pagedDefinitions: [moved] }),
    ).rejects.toThrow(/out of date for oti-buildings-astoria/)
  })
})

describe('building source queries', () => {
  const config = GeoConfigSchema.parse(
    JSON.parse(readFileSync(join(ROOT, 'data/config/geo.json'), 'utf8')),
  )
  const definitions = buildingSourceDefinitions(config.districts)

  it('one per configured district, in source-id order', () => {
    expect(definitions.map((d) => d.id)).toEqual([
      'oti-buildings-midtown',
      'oti-buildings-lower-manhattan',
      'oti-buildings-downtown-brooklyn-dumbo',
      'oti-buildings-williamsburg',
      'oti-buildings-long-island-city',
      'oti-buildings-astoria',
      'oti-buildings-flushing',
      'oti-buildings-jamaica',
    ])
  })

  it.each(definitions.map((d) => [d.id, d] as const))(
    '%s requests HEIGHT_ROOF and nothing else (never NAME)',
    (_id, definition) => {
      expect(BUILDING_OUT_FIELDS).toBe('HEIGHT_ROOF')
      const params = new URL(definition.url).searchParams
      expect(params.getAll('outFields')).toEqual(['HEIGHT_ROOF'])
      expect(definition.url).not.toMatch(/NAME/i)
      expect(params.get('where')).toBe('FEATURE_CODE IN (2100,5100,1006) AND Shape__Area>=40')
      expect(params.get('f')).toBe('geojson')
      expect(params.get('orderByFields')).toBe('OBJECTID')
      const count = new URL(definition.countUrl).searchParams
      expect(count.get('returnCountOnly')).toBe('true')
      expect(count.get('outFields')).toBeNull()
      expect(count.get('geometry')).toBe(params.get('geometry'))
    },
  )

  it('every committed lock page query also asks for HEIGHT_ROOF only', () => {
    const lock = LockSchema.parse(
      JSON.parse(readFileSync(join(ROOT, 'scripts/geo/sources.lock.json'), 'utf8')),
    )
    for (const entry of lock.pagedSources) {
      expect(new URL(entry.url).searchParams.getAll('outFields')).toEqual(['HEIGHT_ROOF'])
    }
  })

  it('the envelope covers the district circle', () => {
    for (const district of config.districts) {
      const definition = definitions.find((d) => d.id.endsWith(district.id))
      const [west, south, east, north] = (
        new URL(definition?.url ?? '').searchParams.get('geometry') ?? ''
      )
        .split(',')
        .map(Number)
      const { lat, lng } = district.center
      expect(west).toBeLessThan(lng)
      expect(east).toBeGreaterThan(lng)
      expect(south).toBeLessThan(lat)
      expect(north).toBeGreaterThan(lat)
      // Half the height in metres is at least the radius.
      expect((((north ?? 0) - (south ?? 0)) / 2) * 111_000).toBeGreaterThanOrEqual(
        district.radiusM * 0.999,
      )
    }
  })
})
