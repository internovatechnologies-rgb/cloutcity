import { describe, expect, it } from 'vitest'
import { scene } from '@/lib/data/config'
import { project } from '@/lib/geo/projection'
import { landmarkPinLifts, landmarksLayer } from './landmarksLayer'
import { boroughRenderState, boroughs, findPlace, mapPlaces } from './places'
import { buildPlacesLayer, placesLayer } from './placesLayer'

describe('places layer (S04c)', () => {
  it('has one pin per venue and landmark, at its real coordinates to the metre', () => {
    expect(placesLayer.pins.map((pin) => pin.id)).toEqual(mapPlaces().map((place) => place.id))
    for (const pin of placesLayer.pins) {
      const place = findPlace(pin.id)
      if (place === undefined) throw new Error(`no place ${pin.id}`)
      const at = project(place.location)
      expect(Math.abs(pin.x - at.x), pin.id).toBeLessThanOrEqual(0.5)
      expect(Math.abs(pin.y - at.y), pin.id).toBeLessThanOrEqual(0.5)
      expect(Number.isInteger(pin.x) && Number.isInteger(pin.y)).toBe(true)
    }
  })

  it('lifts each modelled landmark pin clear of its model as a badge (S07a); others stay put', () => {
    const lifts = landmarkPinLifts()
    const landTop = scene.land.heightM - scene.land.baseM
    for (const pin of placesLayer.pins) {
      const lift = lifts.get(pin.id)
      if (lift === undefined || pin.kind !== 'landmark') {
        expect(pin.liftM, pin.id).toBeUndefined()
        expect(pin.badge, pin.id).toBeUndefined()
        continue
      }
      expect(pin.badge, pin.id).toBe(true)
      expect(pin.liftM ?? 0, pin.id).toBe(lift)
      const entry = landmarksLayer.models.find((m) => m.id === pin.id)
      if (entry === undefined) throw new Error(`no model ${pin.id}`)
      // The pin's base sits at or above the model's top.
      const base = entry.model.archetype.endsWith('Bridge') ? 0 : landTop
      const top = base + entry.frame.pinLiftM * scene.landmarks.heightScale
      expect(landTop + (pin.liftM ?? 0), pin.id).toBeGreaterThanOrEqual(top)
    }
    expect(placesLayer.pins.filter((pin) => pin.badge === true)).toHaveLength(
      landmarksLayer.models.length,
    )
  })

  it('lists every borough in boroughs.json order with its render state', () => {
    expect(placesLayer.boroughs.map((b) => b.id)).toEqual(boroughs.map((b) => b.id))
    for (const render of placesLayer.boroughs) {
      const state = boroughRenderState(render.id)
      expect(render.render).toBe(state.state)
      expect(render.teaserIds).toEqual(state.teaserLandmarkIds)
    }
  })

  it('styles teaser pins on dimmed land, memorials muted, everything else normal', () => {
    const teaserIds = placesLayer.boroughs.flatMap((b) => b.teaserIds)
    expect(teaserIds).toEqual(['bronx-ballpark', 'staten-island-ferry'])
    const styled = (style: string) =>
      placesLayer.pins.filter((pin) => pin.style === style).map((pin) => pin.id)
    // Every pin on dimmed land is one of its borough's teasers (data guard).
    expect(styled('teaser').sort()).toEqual([...teaserIds].sort())
    expect(styled('memorial')).toEqual(['september-11-memorial'])
    expect(styled('normal')).toHaveLength(placesLayer.pins.length - 3)
  })

  it('is deterministic', () => {
    expect(JSON.stringify(buildPlacesLayer())).toBe(JSON.stringify(placesLayer))
  })
})
