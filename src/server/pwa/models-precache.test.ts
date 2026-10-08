/**
 * Hand-made models (public/models/**, S04h) are never precached on install: they load on
 * demand and the worker caches them at runtime. `npm run budget` checks the built worker's
 * precache list; this guards the inputs that feed it.
 */
import { describe, expect, it } from 'vitest'
import { additionalPrecacheEntries, precacheGlobs } from './revision'

describe('service-worker precache and model files', () => {
  it('lists no model file among the extra precache entries', () => {
    const urls = additionalPrecacheEntries('rev').map((entry) => entry.url)
    expect(urls.filter((url) => url.startsWith('/models/'))).toEqual([])
  })

  it('globs nothing under public/ but the icons, and no .glb anywhere', () => {
    // The route passes these to Serwist (src/app/serwist/[path]/route.ts `globPatterns`).
    const patterns = precacheGlobs('.next')
    expect(patterns.length).toBeGreaterThan(0)
    for (const pattern of patterns) {
      expect(pattern).not.toMatch(/glb|models/)
      if (pattern.startsWith('public/')) expect(pattern).toMatch(/^public\/icons\//)
    }
  })
})
