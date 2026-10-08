/**
 * The service worker's caching policy (S04e, DEC-23), as pure functions so every rule is unit
 * tested without a browser. src/sw/sw.ts wires them into Serwist; nothing here touches
 * `self`, `caches` or the network.
 *
 * What the worker may keep:
 *  - the precache: the build's static JS/CSS/SVG/fonts, the icons, `/`, `/offline`, the legal
 *    pages, the manifest and the versioned base geo and fallback map (src/app/serwist/[path]);
 *  - `cc-geo-<version>`: other versioned geo (`/geo/...?v=`), cache-first, only at a content
 *    version this build knows ({@link geoVersionsOf}), so junk `v` values cannot grow it;
 *  - `cc-audio-<version>`: our own audio files, cache-first, only once the runtime fetches them
 *    (after the player's audio choice); never precached;
 *  - `cc-models-<version>`: the hand-made 3D models (S04h), cache-first, only once the scene
 *    loads them; never precached (they load on demand, tier by tier, after the map is playable);
 *  - `cc-chunks-<revision>`: the build's JS chunks the precache leaves out (PERF-7: the model
 *    runtime, the model showcase, the apartment's decor models, the /mod console, supabase-js), cache-first
 *    once they load; precached chunks are answered by the precache before this route.
 * Everything else goes to the network untouched. Same-origin only, GET only, and a response
 * that is private, personalised or not a plain 200 is never stored ({@link refuseSensitive}).
 */

/** Prefix of every runtime cache this app owns; anything else (Serwist's precache) is left alone. */
export const CACHE_PREFIX = 'cc-'

/** The runtime caches, by kind. Each name carries the content version it holds. */
export const RUNTIME_CACHE_KINDS = ['geo', 'audio', 'models', 'chunks'] as const
export type RuntimeCacheKind = (typeof RUNTIME_CACHE_KINDS)[number]

const VERSION = /^[a-z0-9]{1,64}$/

/** `cc-<kind>-<version>`. The version is a content hash, so new data never mixes with old. */
export function runtimeCacheName(kind: RuntimeCacheKind, version: string): string {
  if (!VERSION.test(version)) throw new Error(`Invalid ${kind} cache version: ${version}`)
  return `${CACHE_PREFIX}${kind}-${version}`
}

/**
 * The app-owned caches to delete on activate: every `cc-` cache that is not one of the current
 * worker's caches. Caches without the prefix (Serwist's precache, which cleans itself) are kept.
 */
export function staleCacheNames(existing: readonly string[], current: readonly string[]): string[] {
  const keep = new Set(current)
  return existing.filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
}

/** What a route matcher sees of a request. */
export interface RequestFacts {
  readonly url: URL
  readonly method: string
  readonly mode: RequestMode
  /** Serwist's `sameOrigin`: the request's origin is the worker's. */
  readonly sameOrigin: boolean
}

/** A geo content version: the first 12 hex digits of a sha256 (src/lib/data/geo.ts). */
export const GEO_VERSION = /^[0-9a-f]{12}$/

/**
 * The geo content versions this build serves: the base geo's and every district and block file's
 * (the `?v=` of each baked-in district URL). The geo route caches nothing else (F4).
 */
export function geoVersionsOf(
  config: Pick<ServiceWorkerConfig, 'geoVersion' | 'districtUrls'>,
): ReadonlySet<string> {
  const versions = new Set([config.geoVersion])
  for (const url of Object.values(config.districtUrls).flat()) {
    const version = new URL(url, 'https://x.invalid').searchParams.get('v')
    if (version !== null) versions.add(version)
  }
  return new Set([...versions].filter((version) => GEO_VERSION.test(version)))
}

/**
 * Geo the worker caches: a same-origin GET `/geo/...` fetch (never a navigation) whose only query
 * is `?v=` set to one of `versions` ({@link geoVersionsOf}). Each geo route ignores `v`, so
 * anything looser would let any `v` value (or extra parameter) add another entry (F4).
 */
export function isVersionedGeo(
  { url, method, mode, sameOrigin }: RequestFacts,
  versions: ReadonlySet<string>,
): boolean {
  if (!sameOrigin || method !== 'GET' || mode === 'navigate') return false
  if (!url.pathname.startsWith('/geo/')) return false
  const keys = [...url.searchParams.keys()]
  const version = url.searchParams.get('v') ?? ''
  return keys.length === 1 && keys[0] === 'v' && GEO_VERSION.test(version) && versions.has(version)
}

/**
 * Our own audio files (the same rule as SAME_ORIGIN_AUDIO in src/lib/audio/manifest.ts, kept
 * here so the worker bundle does not pull in the manifest; policy.test.ts checks they agree).
 */
export const AUDIO_PATH = /^\/audio\/[a-z0-9/_-]+\.(?:webm|m4a)$/

export function isOwnAudio({ url, method, sameOrigin }: RequestFacts): boolean {
  return sameOrigin && method === 'GET' && url.search === '' && AUDIO_PATH.test(url.pathname)
}

/**
 * A served model file (the same rule as the `file` field of data/assets/manifest.json, kept here
 * so the worker bundle does not pull in the schema; policy.test.ts checks they agree). The name
 * carries the first 8 hex digits of the file's sha256, so a URL never changes content.
 */
export const MODEL_PATH = /^\/models\/[a-z0-9-]+\.(?:low|mid|high)\.[0-9a-f]{8}\.glb$/

/** A versioned model file: same-origin GET, no query (the name is the version). */
export function isVersionedModel({ url, method, sameOrigin }: RequestFacts): boolean {
  return sameOrigin && method === 'GET' && url.search === '' && MODEL_PATH.test(url.pathname)
}

/**
 * Vercel Skew Protection (NEXT_DEPLOYMENT_ID) makes Next add `?dpl=<deployment id>` to every
 * build asset URL. The precache entries carry no query, so the precache ignores it when matching
 * (`ignoreURLParametersMatching`, with Serwist's default `utm_`/`fbclid`), and the chunk route
 * accepts it and caches under the URL without it (F1). The request itself keeps it, so the CDN
 * still serves the right deployment.
 */
export const DEPLOYMENT_PARAM = 'dpl'
export const PRECACHE_IGNORED_PARAMS: readonly RegExp[] = [/^utm_/, /^fbclid$/, /^dpl$/]
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** True when the URL has no query, or only a single well-formed `dpl` deployment id. */
export function hasOnlyDeploymentQuery(url: URL): boolean {
  if (url.search === '') return true
  const keys = [...url.searchParams.keys()]
  return (
    keys.length === 1 &&
    keys[0] === DEPLOYMENT_PARAM &&
    DEPLOYMENT_ID.test(url.searchParams.get(DEPLOYMENT_PARAM) ?? '')
  )
}

/** The URL without its `dpl` deployment id: the cache key of a build asset. */
export function withoutDeploymentId(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(DEPLOYMENT_PARAM)
  return url.href
}

/** A build JS chunk: content-hashed, so its URL never changes content. */
export const CHUNK_PATH = /^\/_next\/static\/chunks\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\.js$/

/**
 * A same-origin build chunk the precache does not hold (PERF-7): GET, no query but a `dpl`
 * deployment id ({@link hasOnlyDeploymentQuery}). Precached chunks never reach this route
 * (Serwist answers them from the precache first).
 */
export function isBuildChunk({ url, method, sameOrigin }: RequestFacts): boolean {
  return (
    sameOrigin && method === 'GET' && hasOnlyDeploymentQuery(url) && CHUNK_PATH.test(url.pathname)
  )
}

/**
 * Navigations the worker never touches: server endpoints, the moderator area, the worker
 * itself, data routes and share images. They always go straight to the network, with no
 * offline page in their place.
 */
export const NAVIGATION_DENYLIST: readonly RegExp[] = [/^\/(?:api|mod|serwist|geo|og)(?:\/|$)/]

/** A page navigation the worker handles: network only, with `/offline` when that fails. */
export function isPageNavigation({ url, method, mode, sameOrigin }: RequestFacts): boolean {
  return (
    sameOrigin &&
    method === 'GET' &&
    mode === 'navigate' &&
    !NAVIGATION_DENYLIST.some((pattern) => pattern.test(url.pathname))
  )
}

/** The parts of a request and response {@link refuseSensitive} judges. */
export interface CacheCandidate {
  readonly request: { readonly headers: Pick<Headers, 'has'> }
  readonly response: {
    readonly status: number
    readonly type: ResponseType
    readonly headers: Pick<Headers, 'get'>
  }
}

function headerTokens(value: string | null): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(',')
    .map((token) => token.trim().split('=')[0] ?? '')
    .filter((token) => token !== '')
}

/**
 * Whether a response must never be stored (DEC-23): a request that carried credentials in an
 * Authorization header, anything but a plain same-origin 200 (opaque, CORS, redirects, partial
 * and error responses), `Cache-Control: no-store` or `private`, or a response that varies by
 * cookie or credentials (personalised).
 */
export function isSensitive({ request, response }: CacheCandidate): boolean {
  if (request.headers.has('authorization')) return true
  if (response.status !== 200 || response.type !== 'basic') return true
  const cacheControl = headerTokens(response.headers.get('cache-control'))
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return true
  const vary = headerTokens(response.headers.get('vary'))
  return vary.includes('*') || vary.includes('cookie') || vary.includes('authorization')
}

/**
 * A Serwist `cacheWillUpdate` callback: the response when it may be stored, `null` to refuse.
 * Every runtime strategy carries it.
 */
export function refuseSensitive<R extends CacheCandidate['response']>(candidate: {
  readonly request: CacheCandidate['request']
  readonly response: R
}): R | null {
  return isSensitive(candidate) ? null : candidate.response
}

/** The detected quality tiers (CLAUDE.md "Quality tiers"). */
export const WARM_TIERS = ['low', 'mid', 'high'] as const
export type WarmTier = (typeof WARM_TIERS)[number]

/** Message type a page sends to have the worker cache its tier's district assets. */
export const WARM_TIER_MESSAGE = 'CC_WARM_TIER'

export interface WarmTierMessage {
  readonly type: typeof WARM_TIER_MESSAGE
  readonly tier: WarmTier
}

/** The worker's reply on the message's port once a tier's assets are in its cache. */
export const WARM_TIER_DONE = 'CC_WARM_TIER_DONE'

export interface WarmTierDone {
  readonly type: typeof WARM_TIER_DONE
  readonly tier: WarmTier
  /** URLs now in the cache (from before, or fetched now). */
  readonly cached: number
  /** URLs that could not be fetched (offline, or refused by {@link refuseSensitive}). */
  readonly failed: number
}

/** A page's message, validated: a warm request for a known tier, or null for anything else. */
export function parseWarmTierMessage(data: unknown): WarmTierMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, tier } = data as { type?: unknown; tier?: unknown }
  if (type !== WARM_TIER_MESSAGE) return null
  if (!(WARM_TIERS as readonly unknown[]).includes(tier)) return null
  return { type: WARM_TIER_MESSAGE, tier: tier as WarmTier }
}

/** What the route handler bakes into the worker at build time (src/server/pwa/revision.ts). */
export interface ServiceWorkerConfig {
  /** Build revision: precache revisions of the HTML entries. */
  readonly revision: string
  /** The base geo's content version (`/geo/base?v=`, src/lib/data/geo.ts). */
  readonly geoVersion: string
  readonly geoCache: string
  readonly audioCache: string
  readonly modelsCache: string
  /** `cc-chunks-<revision>`: chunks left out of the precache, per build (PERF-7). */
  readonly chunksCache: string
  /**
   * Per tier, the district and block URLs the worker fetches on a warm request
   * (`districtAssetUrls(tier)`, src/lib/data/districts.ts): the same versioned URLs the scene
   * loads, so a warm entry is exactly what the next load asks for.
   */
  readonly districtUrls: Readonly<Record<WarmTier, readonly string[]>>
}

/**
 * The URLs to fetch for a warm request: the tier's baked-in list, keeping only versioned geo, so
 * a warm can never reach anything the geo route would not cache anyway.
 */
export function warmTierUrls(
  config: ServiceWorkerConfig,
  tier: WarmTier,
  origin: string,
): string[] {
  const versions = geoVersionsOf(config)
  return config.districtUrls[tier].filter((url) => {
    const parsed = new URL(url, origin)
    const sameOrigin = parsed.origin === origin
    return isVersionedGeo({ url: parsed, method: 'GET', mode: 'cors', sameOrigin }, versions)
  })
}
