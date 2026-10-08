import { describe, expect, it } from 'vitest'
import { scene } from '@/lib/data/config'
import { landmarks } from '@/lib/data/content'
import { landmarksLayer } from '@/lib/world/landmarksLayer'
import { mapPlaces, placeName } from '@/lib/world/places'
import { buildNameChipGeometry } from './nameChips'

describe('landmark name chips', () => {
  it('lies one flat quad per chip at its height, each sampling its own atlas row', () => {
    const chips = [
      { x: 0, y: 0, height: 50, text: 'a' },
      { x: 1000, y: 500, height: 80, text: 'b' },
    ]
    const geometry = buildNameChipGeometry(chips, scene.landmarkChips)
    const pos = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    expect(pos.count).toBe(8)
    expect(pos.getY(0)).toBe(50)
    expect(pos.getY(4)).toBe(80)
    // North is -z once laid flat.
    expect(pos.getZ(6)).toBeCloseTo(-(500 + scene.landmarkChips.heightM / 2), 6)
    expect([uv.getY(0), uv.getY(2)]).toEqual([0.5, 1])
    expect([uv.getY(4), uv.getY(6)]).toEqual([0, 0.5])
  })

  it('names generic-name landmarks only by their generic copy label (LEGAL-1)', () => {
    const modelled = new Set(landmarksLayer.models.map((m) => m.id))
    for (const place of mapPlaces().filter((p) => modelled.has(p.id))) {
      const landmark = landmarks.find((l) => l.id === place.id)
      expect(landmark?.nameMode, place.id).toBeDefined()
      // The chip text is the copy name; the model data carries none.
      expect(placeName(place).length).toBeGreaterThan(0)
      expect(JSON.stringify(landmarksLayer.models.find((m) => m.id === place.id))).not.toContain(
        placeName(place),
      )
    }
  })
})
