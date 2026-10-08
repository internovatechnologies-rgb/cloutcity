import { describe, expect, it } from 'vitest'
import modelManifestJson from '@data/assets/manifest.json'
import { SAME_ORIGIN_AUDIO, audioManifest } from '@/lib/audio/manifest'
import { ModelManifestSchema } from '@/lib/data/schemas/assets'
import {
  AUDIO_PATH,
  MODEL_PATH,
  NAVIGATION_DENYLIST,
  WARM_TIER_MESSAGE,
  isBuildChunk,
  isOwnAudio,
  isPageNavigation,
  isSensitive,
  isVersionedGeo,
  isVersionedModel,
  PRECACHE_IGNORED_PARAMS,
  geoVersionsOf,
  hasOnlyDeploymentQuery,
  parseWarmTierMessage,
  refuseSensitive,
  runtimeCacheName,
  staleCacheNames,
  warmTierUrls,
  withoutDeploymentId,
  type CacheCandidate,
  type RequestFacts,
  type ServiceWorkerConfig,
} from './policy'

const ORIGIN = 'https://cloutcity.example'

function facts(path: string, overrides: Partial<Omit<RequestFacts, 'url'>> = {}): RequestFacts {
  return {
    url: new URL(path, ORIGIN),
    method: 'GET',
    mode: 'cors',
    sameOrigin: true,
    ...overrides,
  }
}

describe('runtime cache names', () => {
  it('carry the kind and the content version', () => {
    expect(runtimeCacheName('geo', '57ef63e13a99')).toBe('cc-geo-57ef63e13a99')
    expect(runtimeCacheName('audio', 'abc123')).toBe('cc-audio-abc123')
    expect(runtimeCacheName('models', '2f59d8d46a436cef')).toBe('cc-models-2f59d8d46a436cef')
  })

  it('refuse a version that could name another cache', () => {
    for (const version of ['', 'ABC', 'a-b', 'a/b', 'x'.repeat(65)]) {
      expect(() => runtimeCacheName('geo', version), version).toThrow(/Invalid geo cache version/)
    }
  })
})

describe('staleCacheNames', () => {
  it('lists every app-owned cache that is not current, and nothing else', () => {
    const existing = [
      'cc-geo-new',
      'cc-geo-old',
      'cc-audio-new',
      'cc-audio-old',
      'cc-something-unknown',
      'serwist-precache-v2-https://cloutcity.example/',
      'another-app',
    ]
    expect(staleCacheNames(existing, ['cc-geo-new', 'cc-audio-new'])).toEqual([
      'cc-geo-old',
      'cc-audio-old',
      'cc-something-unknown',
    ])
  })

  it('keeps everything when nothing is stale', () => {
    expect(staleCacheNames(['cc-geo-a', 'serwist-precache-v2-x'], ['cc-geo-a'])).toEqual([])
    expect(staleCacheNames([], ['cc-geo-a'])).toEqual([])
  })
})

/** The geo versions of a small build: the base geo's and one district file's. */
const GEO_VERSIONS: ReadonlySet<string> = new Set(['57ef63e13a99', 'abc123def456'])

describe('isVersionedGeo', () => {
  const geo = (path: string, overrides: Partial<Omit<RequestFacts, 'url'>> = {}) =>
    isVersionedGeo(facts(path, overrides), GEO_VERSIONS)

  it('matches same-origin GET geo fetches at a version this build serves', () => {
    expect(geo('/geo/base?v=57ef63e13a99')).toBe(true)
    expect(geo('/geo/districts/low/qn01?v=abc123def456')).toBe(true)
    expect(geo('/geo/districts/low/qn01?v=abc123def456', { mode: 'same-origin' })).toBe(true)
  })

  it('refuses unversioned, other paths, other origins and other methods', () => {
    expect(geo('/geo/base')).toBe(false)
    expect(geo('/geo/base?v=')).toBe(false)
    expect(geo('/geography?v=57ef63e13a99')).toBe(false)
    expect(geo('/api/geo?v=57ef63e13a99')).toBe(false)
    expect(geo('/geo/base?v=57ef63e13a99', { sameOrigin: false })).toBe(false)
    expect(geo('/geo/base?v=57ef63e13a99', { method: 'POST' })).toBe(false)
  })

  it('refuses junk versions, extra parameters and navigations, so the cache stays bounded (F4)', () => {
    // A well-formed version this build does not serve, and malformed ones.
    expect(geo('/geo/base?v=0123456789ab')).toBe(false)
    for (const v of ['junk0', '57EF63E13A99', '57ef63e13a9', '57ef63e13a99a', 'probe-ok']) {
      expect(geo(`/geo/base?v=${v}`), v).toBe(false)
    }
    expect(geo('/geo/base?v=57ef63e13a99&x=1')).toBe(false)
    expect(geo('/geo/base?x=1&v=57ef63e13a99')).toBe(false)
    expect(geo('/geo/base?v=57ef63e13a99&v=abc123def456')).toBe(false)
    expect(geo('/geo/base?v=57ef63e13a99', { mode: 'navigate' })).toBe(false)
  })

  it("knows the base geo's version and every baked-in district file's", () => {
    const versions = geoVersionsOf({
      geoVersion: '57ef63e13a99',
      districtUrls: {
        low: ['/geo/districts/low/qn01?v=abc123def456', '/geo/blocks/low?v=0000aaaa1111'],
        mid: ['/geo/blocks/mid?v=not-a-version'],
        high: [],
      },
    })
    expect([...versions].sort()).toEqual(['0000aaaa1111', '57ef63e13a99', 'abc123def456'])
  })
})

describe('isOwnAudio', () => {
  it('agrees with the audio manifest rule and matches every manifest file', () => {
    expect(AUDIO_PATH.source).toBe(SAME_ORIGIN_AUDIO.source)
    const files = audioManifest.tracks.flatMap((track) => track.sources.map((s) => s.file))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(isOwnAudio(facts(file)), file).toBe(true)
  })

  it('refuses other origins, queries, other types and other methods', () => {
    expect(isOwnAudio(facts('/audio/music/a.webm', { sameOrigin: false }))).toBe(false)
    expect(isOwnAudio(facts('/audio/music/a.webm?x=1'))).toBe(false)
    expect(isOwnAudio(facts('/audio/music/a.mp3'))).toBe(false)
    expect(isOwnAudio(facts('/audio/../api/a.webm'))).toBe(false)
    expect(isOwnAudio(facts('/audio/music/a.webm', { method: 'POST' }))).toBe(false)
  })
})

describe('isVersionedModel', () => {
  const modelFiles = ModelManifestSchema.parse(modelManifestJson).models.flatMap((model) =>
    Object.values(model.tiers).map((tier) => tier.file),
  )

  it('agrees with the model manifest rule and matches every manifest file', () => {
    expect(modelFiles.length).toBeGreaterThan(0)
    for (const file of modelFiles) {
      expect(MODEL_PATH.test(file), file).toBe(true)
      expect(isVersionedModel(facts(file)), file).toBe(true)
    }
  })

  it('refuses unversioned names, queries, other origins, other methods and other paths', () => {
    const file = modelFiles[0] ?? ''
    for (const path of [
      '/models/taxi.glb',
      '/models/taxi.low.glb',
      '/models/taxi.ultra.752dce5e.glb',
      '/models/taxi.low.752DCE5E.glb',
      '/models/taxi.low.752dce5.glb',
      '/models/taxi.low.752dce5e.gltf',
      '/models/sub/taxi.low.752dce5e.glb',
      '/models/../api/x.low.752dce5e.glb',
      '/api/models/taxi.low.752dce5e.glb',
      '/mod/models/taxi.low.752dce5e.glb',
      '/models/',
    ]) {
      expect(isVersionedModel(facts(path)), path).toBe(false)
    }
    expect(isVersionedModel(facts(`${file}?v=1`))).toBe(false)
    expect(isVersionedModel(facts(file, { sameOrigin: false }))).toBe(false)
    expect(isVersionedModel(facts(file, { method: 'POST' }))).toBe(false)
    expect(isVersionedModel(facts(file, { method: 'PUT' }))).toBe(false)
  })

  it('never overlaps the geo, audio or navigation rules', () => {
    for (const file of modelFiles) {
      expect(isVersionedGeo(facts(file), GEO_VERSIONS), file).toBe(false)
      expect(isOwnAudio(facts(file)), file).toBe(false)
    }
  })
})

describe('isBuildChunk (PERF-7)', () => {
  it('matches same-origin GET build chunks', () => {
    expect(isBuildChunk(facts('/_next/static/chunks/0dl6_4ojh8p_-.js'))).toBe(true)
    expect(isBuildChunk(facts('/_next/static/chunks/app/page-1a2b.js'))).toBe(true)
  })

  it('refuses queries, other origins, other methods, other types and other paths', () => {
    expect(isBuildChunk(facts('/_next/static/chunks/a.js?v=1'))).toBe(false)
    expect(isBuildChunk(facts('/_next/static/chunks/a.js', { sameOrigin: false }))).toBe(false)
    expect(isBuildChunk(facts('/_next/static/chunks/a.js', { method: 'POST' }))).toBe(false)
    expect(isBuildChunk(facts('/_next/static/chunks/a.css'))).toBe(false)
    expect(isBuildChunk(facts('/_next/static/media/a.js'))).toBe(false)
    expect(isBuildChunk(facts('/api/_next/static/chunks/a.js'))).toBe(false)
    expect(isBuildChunk(facts('/_next/static/chunks/../../api/a.js'))).toBe(false)
  })

  it('never overlaps the geo, audio, model or navigation rules', () => {
    const chunk = facts('/_next/static/chunks/a.js')
    expect(
      isVersionedGeo(chunk, GEO_VERSIONS) || isOwnAudio(chunk) || isVersionedModel(chunk),
    ).toBe(false)
    expect(isPageNavigation(chunk)).toBe(false)
  })

  it('accepts a Skew Protection deployment id and caches under the URL without it (F1)', () => {
    const chunk = '/_next/static/chunks/0prcds_0rkht5.js'
    expect(isBuildChunk(facts(`${chunk}?dpl=dpl_hunt123`))).toBe(true)
    expect(hasOnlyDeploymentQuery(new URL(`${chunk}?dpl=dpl_hunt123`, ORIGIN))).toBe(true)
    expect(withoutDeploymentId(`${ORIGIN}${chunk}?dpl=dpl_hunt123`)).toBe(`${ORIGIN}${chunk}`)
    expect(withoutDeploymentId(`${ORIGIN}${chunk}`)).toBe(`${ORIGIN}${chunk}`)
    // Anything beyond one well-formed dpl is still refused.
    expect(isBuildChunk(facts(`${chunk}?dpl=a&x=1`))).toBe(false)
    expect(isBuildChunk(facts(`${chunk}?dpl=a&dpl=b`))).toBe(false)
    expect(isBuildChunk(facts(`${chunk}?dpl=`))).toBe(false)
    expect(isBuildChunk(facts(`${chunk}?dpl=a%2Fb`))).toBe(false)
  })

  it("has the precache ignore dpl as well as Serwist's default utm_ and fbclid (F1)", () => {
    const ignored = (name: string) => PRECACHE_IGNORED_PARAMS.some((pattern) => pattern.test(name))
    expect(ignored('dpl')).toBe(true)
    expect(ignored('utm_source')).toBe(true)
    expect(ignored('fbclid')).toBe(true)
    expect(ignored('v')).toBe(false)
    expect(ignored('dplx')).toBe(false)
  })

  it('has a per-build cache the activate cleanup removes once a newer build takes over', () => {
    expect(runtimeCacheName('chunks', '0123456789abcdef')).toBe('cc-chunks-0123456789abcdef')
    expect(staleCacheNames(['cc-chunks-old', 'cc-chunks-new'], ['cc-chunks-new'])).toEqual([
      'cc-chunks-old',
    ])
  })
})

describe('warmTierUrls', () => {
  const config: ServiceWorkerConfig = {
    revision: 'r',
    geoVersion: '57ef63e13a99',
    geoCache: 'cc-geo-a',
    audioCache: 'cc-audio-a',
    modelsCache: 'cc-models-a',
    chunksCache: 'cc-chunks-a',
    districtUrls: {
      low: [
        '/geo/districts/low/queens?v=abc123def456',
        '/geo/blocks/low?v=0000aaaa1111',
        // A malformed version is never warmed.
        '/geo/blocks/low?v=def',
        // Never baked in by the build; filtered all the same.
        '/geo/districts/low/x',
        '/api/save',
        'https://evil.example/geo/districts/low/queens?v=abc123def456',
      ],
      mid: ['/geo/blocks/mid?v=111122223333'],
      high: [],
    },
  }

  it("keeps only the tier's same-origin versioned geo", () => {
    expect(warmTierUrls(config, 'low', ORIGIN)).toEqual([
      '/geo/districts/low/queens?v=abc123def456',
      '/geo/blocks/low?v=0000aaaa1111',
    ])
    expect(warmTierUrls(config, 'mid', ORIGIN)).toEqual(['/geo/blocks/mid?v=111122223333'])
    expect(warmTierUrls(config, 'high', ORIGIN)).toEqual([])
  })
})

describe('isPageNavigation', () => {
  const nav = (path: string, overrides: Partial<Omit<RequestFacts, 'url'>> = {}) =>
    isPageNavigation(facts(path, { mode: 'navigate', ...overrides }))

  it('handles same-origin page navigations', () => {
    for (const path of ['/', '/terms', '/privacy', '/credits', '/live', '/missing', '/apiary']) {
      expect(nav(path), path).toBe(true)
    }
  })

  it('never handles server, moderator, worker, data or share-image routes', () => {
    for (const path of [
      '/api',
      '/api/save',
      '/mod',
      '/mod/queue',
      '/serwist/sw.js',
      '/geo/base',
      '/og/card',
    ]) {
      expect(nav(path), path).toBe(false)
      expect(
        NAVIGATION_DENYLIST.some((pattern) => pattern.test(path)),
        path,
      ).toBe(true)
    }
  })

  it('ignores non-navigations, other origins and other methods', () => {
    expect(isPageNavigation(facts('/'))).toBe(false)
    expect(nav('/', { sameOrigin: false })).toBe(false)
    expect(nav('/', { method: 'POST' })).toBe(false)
  })
})

describe('refuseSensitive', () => {
  function candidate(
    response: Partial<{ status: number; type: ResponseType; headers: Record<string, string> }> = {},
    requestHeaders: Record<string, string> = {},
  ): CacheCandidate {
    return {
      request: { headers: new Headers(requestHeaders) },
      response: {
        status: response.status ?? 200,
        type: response.type ?? 'basic',
        headers: new Headers(response.headers ?? {}),
      },
    }
  }

  it('keeps a plain same-origin 200, including Next.js router Vary headers', () => {
    const ok = candidate({
      headers: {
        'cache-control': 'public, max-age=31536000, immutable',
        vary: 'rsc, next-router-state-tree, next-router-prefetch, Accept-Encoding',
      },
    })
    expect(isSensitive(ok)).toBe(false)
    expect(refuseSensitive(ok)).toBe(ok.response)
  })

  it('refuses credentialed requests', () => {
    expect(refuseSensitive(candidate({}, { Authorization: 'Bearer x' }))).toBeNull()
  })

  it('refuses anything but a basic 200', () => {
    for (const status of [201, 204, 206, 301, 304, 404, 500]) {
      expect(refuseSensitive(candidate({ status })), String(status)).toBeNull()
    }
    for (const type of ['opaque', 'cors', 'opaqueredirect', 'error'] as const) {
      expect(refuseSensitive(candidate({ type })), type).toBeNull()
    }
  })

  it('refuses no-store and private, in any case and position', () => {
    for (const value of [
      'no-store',
      'private',
      'Private, max-age=60',
      'max-age=0, NO-STORE',
      'private="set-cookie"',
    ]) {
      expect(refuseSensitive(candidate({ headers: { 'cache-control': value } })), value).toBeNull()
    }
    expect(refuseSensitive(candidate({ headers: { 'cache-control': 'no-cache' } }))).not.toBeNull()
  })

  it('refuses responses personalised by cookie or credentials', () => {
    for (const value of ['Cookie', 'accept-encoding, cookie', 'Authorization', '*']) {
      expect(refuseSensitive(candidate({ headers: { vary: value } })), value).toBeNull()
    }
  })
})

describe('parseWarmTierMessage', () => {
  it('accepts a warm request for each tier', () => {
    for (const tier of ['low', 'mid', 'high'] as const) {
      expect(parseWarmTierMessage({ type: WARM_TIER_MESSAGE, tier })).toEqual({
        type: WARM_TIER_MESSAGE,
        tier,
      })
    }
  })

  it('refuses anything else', () => {
    for (const data of [
      null,
      undefined,
      'CC_WARM_TIER',
      {},
      { type: WARM_TIER_MESSAGE },
      { type: WARM_TIER_MESSAGE, tier: 'ultra' },
      { type: WARM_TIER_MESSAGE, tier: ['low'] },
      { type: 'SKIP_WAITING', tier: 'low' },
      { type: 'CACHE_URLS', payload: { urlsToCache: ['/api/save'] } },
    ]) {
      expect(parseWarmTierMessage(data), JSON.stringify(data)).toBeNull()
    }
  })
})
