import { withSerwist } from '@serwist/turbopack'
import type { NextConfig } from 'next'

/**
 * The service worker script (S04e): never cached, so a deploy is found on the next update
 * check, and locked to same-origin scripts (Next.js PWA guide, "Securing your application").
 */
const SERVICE_WORKER_HEADERS = [
  { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
  { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // No source maps for client code in production (the default, stated so it stays that way): the
  // bundles players download carry no map URL and no map is served. The service worker's bundle
  // has none either (src/app/serwist/[path]/route.ts). Server maps stay: they never leave the
  // server and keep stack traces readable in its logs.
  productionBrowserSourceMaps: false,
  // The e2e suite builds into its own directory (playwright.config.ts), so a test build with
  // the scene test hooks never sits where `npm run start` and `npm run budget` read.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  env: {
    // Always defined, so it is inlined into every build and the hook code is removed as dead
    // code unless the build opts in (an unset NEXT_PUBLIC_ variable stays a runtime lookup).
    NEXT_PUBLIC_TEST_HOOKS: process.env.NEXT_PUBLIC_TEST_HOOKS === '1' ? '1' : '0',
  },
  async headers() {
    return [
      { source: '/serwist/sw.js', headers: SERVICE_WORKER_HEADERS },
      {
        // Geo is addressed by its content version (/geo/base?v=<geoVersion>), so a versioned
        // URL never changes. The fallback map is left out: its ?v= is the geo version, but it
        // also renders the palette and copy, which can change without it.
        source: '/geo/:path((?!fallback$).+)',
        has: [{ type: 'query', key: 'v' }],
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },
}

// withSerwist keeps esbuild (which bundles the worker in the route handler) out of the server
// bundle.
export default withSerwist(nextConfig)
