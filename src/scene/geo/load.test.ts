import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGeoBase } from './load'

afterEach(() => {
  vi.unstubAllGlobals()
})

let n = 0
/** A fresh URL per test: the loader caches one request per URL. */
const url = () => `/geo/base?v=test${++n}`

describe('loadGeoBase', () => {
  it('resolves the JSON body, and reuses one request per URL', async () => {
    const fetchMock = vi.fn(async () => Response.json({ format: 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    const target = url()
    expect(await loadGeoBase(target)).toEqual({ ok: true, body: { format: 'x' } })
    await loadGeoBase(target)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports an HTTP error, a network error and a non-JSON body without rejecting', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }))
    expect(await loadGeoBase(url())).toEqual({
      ok: false,
      failure: { reason: 'geo-http', status: 500 },
    })

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await loadGeoBase(url())).toEqual({ ok: false, failure: { reason: 'geo-network' } })

    vi.stubGlobal('fetch', async () => new Response('{"format":', { status: 200 }))
    expect(await loadGeoBase(url())).toEqual({ ok: false, failure: { reason: 'geo-json' } })
  })

  it('forgets a failed download, so the next call tries again (TRV-1)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockImplementation(async () => Response.json({ format: 'x' }))
    vi.stubGlobal('fetch', fetchMock)
    const target = url()
    expect((await loadGeoBase(target)).ok).toBe(false)
    expect(await loadGeoBase(target)).toEqual({ ok: true, body: { format: 'x' } })
    // A body that arrived is kept.
    await loadGeoBase(target)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps one request in flight: callers during a failing download share it', async () => {
    let fail: (response: Response) => void = () => undefined
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          fail = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const target = url()
    const first = loadGeoBase(target)
    const second = loadGeoBase(target)
    expect(second).toBe(first)
    fail(new Response('boom', { status: 500 }))
    expect((await second).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
