import { describe, expect, it } from 'vitest'
import { geoBaseLayers, geoManifest, geoVersion, geoVersionOf } from '@/lib/data/geo'
import { boroughs, mapPlaces } from '@/lib/world/places'
import { landmarksLayer } from '@/lib/world/landmarksLayer'
import { placesLayer } from '@/lib/world/placesLayer'
import { parseGeoBase } from '@/scene/geo/schema'
import { GET, dynamic } from './route'

describe('GET /geo/base', () => {
  it('is prerendered at build time', () => {
    expect(dynamic).toBe('force-static')
  })

  it('serves every base layer and the places layer in the format the scene validates', async () => {
    const response = GET()
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    const body = parseGeoBase(await response.json())
    expect(body.version).toBe(geoVersion)
    expect(body.land.boroughs.length).toBeGreaterThan(0)
    expect(body.subway.stations.length).toBeGreaterThan(0)
    expect(body.places.pins.map((pin) => pin.id)).toEqual(mapPlaces().map((place) => place.id))
    // data/boroughs/boroughs.json order (the Places panel groups in the same order).
    expect(body.places.boroughs.map((borough) => borough.id)).toEqual(
      boroughs.map((borough) => borough.id),
    )
    // v3 (S07a): every modelled landmark with its model and frame.
    expect(body.landmarks.models.map((entry) => entry.id)).toEqual(
      landmarksLayer.models.map((entry) => entry.id),
    )
    expect(body.landmarks).toEqual(JSON.parse(JSON.stringify(landmarksLayer)))
  })
})

describe('geoVersion', () => {
  it('is a 12-hex hash of the base files and the server-built layers', () => {
    expect(geoVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(geoVersionOf(geoManifest.files, geoBaseLayers)).toBe(geoVersion)
  })

  it('changes when a base file hash changes', () => {
    const base = geoManifest.files.findIndex((file) => file.group === 'base')
    const changed = geoManifest.files.map((file, i) =>
      i === base ? { ...file, sha256: '0'.repeat(64) } : file,
    )
    expect(geoVersionOf(changed, geoBaseLayers)).not.toBe(geoVersion)
  })

  it('changes when a pin moves or changes style', () => {
    const [first, ...rest] = placesLayer.pins
    if (first === undefined) throw new Error('no pins')
    const moved = { ...placesLayer, pins: [{ ...first, x: first.x + 1 }, ...rest] }
    expect(geoVersionOf(geoManifest.files, { ...geoBaseLayers, places: moved })).not.toBe(
      geoVersion,
    )
    const restyled = { ...placesLayer, pins: [{ ...first, style: 'teaser' }, ...rest] }
    expect(geoVersionOf(geoManifest.files, { ...geoBaseLayers, places: restyled })).not.toBe(
      geoVersion,
    )
  })

  it('changes when a landmark model changes (S07a)', () => {
    const [first, ...rest] = landmarksLayer.models
    if (first === undefined) throw new Error('no models')
    const turned = { models: [{ ...first, frame: { ...first.frame, headingDeg: 1 } }, ...rest] }
    expect(geoVersionOf(geoManifest.files, { ...geoBaseLayers, landmarks: turned })).not.toBe(
      geoVersion,
    )
  })

  it('ignores non-base files', () => {
    const extra = [...geoManifest.files, { path: 'x', group: 'other', sha256: '1'.repeat(64) }]
    expect(geoVersionOf(extra, geoBaseLayers)).toBe(geoVersion)
  })
})
