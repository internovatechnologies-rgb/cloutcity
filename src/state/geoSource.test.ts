/** S08 part 2: travel's geo layers come from the shared base geo body, validated first. */
import { describe, expect, it } from 'vitest'
import { land, subway } from '@/lib/data/geo'
import type { GeoDownload } from '@/scene/geo/load'
import { loadTransitGeo } from './geoSource'

const serve = (download: GeoDownload) => () => Promise.resolve(download)

describe('loadTransitGeo', () => {
  it('reads the subway and land layers from the base body', async () => {
    const result = await loadTransitGeo(serve({ ok: true, body: { subway, land } }), '/geo/base')
    expect(result.ok).toBe(true)
  })

  it('needs the URL the scene registered', async () => {
    expect(await loadTransitGeo(serve({ ok: true, body: {} }), null)).toEqual({
      ok: false,
      failure: { reason: 'geo-no-url' },
    })
  })

  it('passes a failed download through', async () => {
    const failure = { reason: 'geo-network' } as const
    expect(await loadTransitGeo(serve({ ok: false, failure }), '/geo/base')).toEqual({
      ok: false,
      failure,
    })
  })

  it('refuses an invalid body, naming the layer and never the payload', async () => {
    const result = await loadTransitGeo(
      serve({ ok: true, body: { subway: { lines: 'nope' }, land } }),
      '/geo/base',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.reason).toBe('geo-invalid')
    if (result.failure.reason !== 'geo-invalid') return
    expect(result.failure.paths.every((path) => path.startsWith('subway'))).toBe(true)
    expect(await loadTransitGeo(serve({ ok: true, body: null }), '/geo/base')).toMatchObject({
      ok: false,
    })
  })
})
