import { describe, expect, it } from 'vitest'
import { copy } from '@/lib/copy'
import '@/lib/copy/all'

// MTA terms (data/geo/SOURCES.md): never imply endorsement or that the data is accurate.
describe('map attribution copy', () => {
  it('the in-map MTA line says not endorsed and may be inaccurate', () => {
    const text = copy('map.attribution.mta')
    expect(text).toMatch(/not endorsed by the MTA/)
    expect(text).toMatch(/may be inaccurate/)
  })

  it('the credits MTA text disclaims endorsement, licensing and accuracy', () => {
    const text = copy('credits.mta.body')
    expect(text).toMatch(/not endorsed by, licensed by or affiliated with the MTA/)
    expect(text).toMatch(/may not be accurate, complete, timely or real time/)
  })

  it('credits NYC Open Data and the DCP, and says OpenStreetMap is not used', () => {
    expect(copy('map.attribution.nyc')).toMatch(/NYC Open Data/)
    expect(copy('credits.nyc.body')).toMatch(/NYC Department of City Planning/)
    expect(copy('credits.nyc.disclaimer')).toMatch(/can not vouch for the accuracy/)
    expect(copy('credits.osm.body')).toMatch(/not used/)
  })
})
