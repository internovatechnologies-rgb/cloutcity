/** TRV-1: Retry in "Get there" rebuilds the routes once the geo download works again. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { land, subway } from '@/lib/data/geo'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('transit world retry', () => {
  it('a failed build stays failed until Retry, which fetches again and builds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockImplementation(() => Promise.resolve(Response.json({ subway, land })))
    vi.stubGlobal('fetch', fetchMock)
    const { registerGeoBaseUrl } = await import('@/scene/geo/load')
    const { ensureTransitWorld, retryTransitWorld, transitWorldStore } =
      await import('./transitWorld')
    registerGeoBaseUrl('/geo/base?v=retry')
    expect(await ensureTransitWorld()).toBeNull()
    expect(transitWorldStore.getState().status).toBe('failed')
    // Without a Retry the failed build is kept (no refetch on every render).
    await ensureTransitWorld()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await retryTransitWorld()).not.toBeNull()
    expect(transitWorldStore.getState().status).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 60_000)
})
