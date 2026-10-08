/**
 * GET /serwist/sw.js: the service worker (S04e, DEC-23), bundled from
 * src/sw/sw.ts by @serwist/turbopack at build time and prerendered (force-static). next.config.ts
 * serves it with no-cache and a strict CSP, so a deploy is picked up on the next update check.
 *
 * The precache is the build's static JS, CSS, SVG and fonts, the icons, and
 * {@link additionalPrecacheEntries} (pages, manifest, versioned geo), as {@link precacheGlobs}
 * lists, less the optional chunks {@link dropOptionalChunks} filters out. Audio and the 3D models are never precached: they load later (audio after the player's
 * audio choice, models on demand per tier), and the worker caches them then.
 */
import { createSerwistRoute } from '@serwist/turbopack'
import {
  additionalPrecacheEntries,
  dropOptionalChunks,
  precacheGlobs,
  serviceWorkerConfig,
} from '@/server/pwa/revision'

const config = serviceWorkerConfig()

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute(
  {
    swSrc: 'src/sw/sw.ts',
    useNativeEsbuild: true,
    globPatterns: precacheGlobs(),
    // PERF-7: large optional chunks (the model runtime, the model showcase, the apartment's decor
    // models, the /mod console, supabase-js) are cached at runtime instead (src/lib/pwa/lazyChunks.ts).
    manifestTransforms: [dropOptionalChunks()],
    additionalPrecacheEntries: additionalPrecacheEntries(config.revision),
    esbuildOptions: {
      // A classic script: registered without `type: 'module'`, so every browser that supports
      // service workers runs it (the bundle has no imports left).
      format: 'iife',
      // No source map: production ships none for client code, and without one there is no
      // /serwist/sw.js.map route (the bundle's sources stay private).
      sourcemap: false,
      define: { __CC_SW_CONFIG__: JSON.stringify(config) },
    },
  },
)
