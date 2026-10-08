/**
 * The service worker (S04e, DEC-23). Bundled by @serwist/turbopack into /serwist/sw.js
 * (src/app/serwist/[path]/route.ts) and type-checked against the webworker lib by
 * src/sw/tsconfig.json. Every rule it applies lives in ./policy.ts.
 *
 * - Precache: the build's static assets, the pages and the versioned geo, served cache-first;
 *   entries a new build dropped are deleted when it activates.
 * - Runtime: versioned geo, our own audio and the content-named 3D models, cache-first, each in
 *   a versioned `cc-` cache (models are never precached: they load on demand, per tier); the
 *   build chunks the precache leaves out (PERF-7), cache-first in `cc-chunks-<revision>`;
 *   page navigations network-only with `/offline` when the network fails. Nothing else is
 *   handled, so `/api`, `/mod`, other origins and non-GET requests never touch a cache.
 * - Tier warm: once the map is playable a page sends CC_WARM_TIER with its quality tier, and the
 *   worker fetches that tier's district and block URLs (baked in at build time, never taken from
 *   the message) through the geo route, one at a time, then replies on the message's port.
 * - Updates wait (no skipWaiting): the page shows an update banner and sends SKIP_WAITING when
 *   the player taps it, so a running game never swaps code under the player.
 *
 * No navigation preload, background sync, default runtime cache or CACHE_URLS handler: the
 * worker caches only what the routes below allow.
 */
import { CacheFirst, NetworkOnly, Serwist, type PrecacheEntry, type SerwistPlugin } from 'serwist'
import {
  WARM_TIER_DONE,
  isBuildChunk,
  isOwnAudio,
  isPageNavigation,
  isVersionedGeo,
  isVersionedModel,
  PRECACHE_IGNORED_PARAMS,
  geoVersionsOf,
  parseWarmTierMessage,
  refuseSensitive,
  staleCacheNames,
  warmTierUrls,
  withoutDeploymentId,
  type RequestFacts,
  type ServiceWorkerConfig,
  type WarmTier,
  type WarmTierDone,
} from './policy'

declare const self: ServiceWorkerGlobalScope & {
  readonly __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
}
/** Baked in at build time by the route handler (src/server/pwa/revision.ts). */
declare const __CC_SW_CONFIG__: ServiceWorkerConfig

const config = __CC_SW_CONFIG__

const neverCacheSensitive: SerwistPlugin = {
  cacheWillUpdate: ({ request, response }) => refuseSensitive({ request, response }),
}

/** Build assets are cached under their URL without Skew Protection's `?dpl=` (F1). */
const dropDeploymentId: SerwistPlugin = {
  cacheKeyWillBeUsed: ({ request }) => withoutDeploymentId(request.url),
}

const geoVersions = geoVersionsOf(config)

function facts({
  request,
  url,
  sameOrigin,
}: {
  request: Request
  url: URL
  sameOrigin: boolean
}): RequestFacts {
  return { url, method: request.method, mode: request.mode, sameOrigin }
}

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    // Serwist's defaults plus `dpl` (F1): with NEXT_DEPLOYMENT_ID every asset URL carries it.
    ignoreURLParametersMatching: [...PRECACHE_IGNORED_PARAMS],
  },
  skipWaiting: false,
  clientsClaim: false,
  navigationPreload: false,
  runtimeCaching: [
    {
      matcher: (options) => isVersionedGeo(facts(options), geoVersions),
      handler: new CacheFirst({ cacheName: config.geoCache, plugins: [neverCacheSensitive] }),
    },
    {
      matcher: (options) => isOwnAudio(facts(options)),
      handler: new CacheFirst({ cacheName: config.audioCache, plugins: [neverCacheSensitive] }),
    },
    {
      matcher: (options) => isVersionedModel(facts(options)),
      handler: new CacheFirst({ cacheName: config.modelsCache, plugins: [neverCacheSensitive] }),
    },
    {
      // PERF-7: chunks the precache leaves out (src/lib/pwa/lazyChunks.ts), once they load.
      matcher: (options) => isBuildChunk(facts(options)),
      handler: new CacheFirst({
        cacheName: config.chunksCache,
        plugins: [neverCacheSensitive, dropDeploymentId],
      }),
    },
    {
      matcher: (options) => isPageNavigation(facts(options)),
      handler: new NetworkOnly(),
    },
  ],
  fallbacks: {
    entries: [{ url: '/offline', matcher: ({ request }) => request.mode === 'navigate' }],
  },
})

self.addEventListener('install', serwist.handleInstall)
self.addEventListener('activate', serwist.handleActivate)
self.addEventListener('fetch', serwist.handleFetch)

// Versioned runtime caches from older builds are deleted once this worker takes over.
self.addEventListener('activate', (event) => {
  const current = [config.geoCache, config.audioCache, config.modelsCache, config.chunksCache]
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(staleCacheNames(names, current).map((name) => caches.delete(name))),
      ),
  )
})

/**
 * Fetches one tier's district assets through the routes above (so the geo route's cache-first
 * strategy and never-cache rules apply), one at a time to stay gentle on a phone's connection.
 */
async function warmTier(tier: WarmTier, event: ExtendableMessageEvent): Promise<WarmTierDone> {
  let cached = 0
  let failed = 0
  for (const url of warmTierUrls(config, tier, self.location.origin)) {
    try {
      const response = await serwist.handleRequest({ request: new Request(url), event })
      if (response?.ok === true) cached += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { type: WARM_TIER_DONE, tier, cached, failed }
}

// A page asks for its quality tier's district assets once the map is playable and the browser
// is idle (src/components/offline/OfflineSupport.tsx). Anything but a known tier is ignored.
self.addEventListener('message', (event) => {
  const message = parseWarmTierMessage(event.data)
  if (message === null) return
  event.waitUntil(
    warmTier(message.tier, event).then((done) => {
      event.ports[0]?.postMessage(done)
    }),
  )
})
