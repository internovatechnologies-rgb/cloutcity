import { describe, expect, it } from 'vitest'
import { scene } from '@/lib/data/config'
import { distanceToDistrict, districtsWithin, drawDistances } from './view'

const districts = [
  { id: 'a', centre: { x: 0, y: 0 }, radiusM: 500 },
  { id: 'b', centre: { x: 5000, y: 0 }, radiusM: 500 },
  { id: 'c', centre: { x: 2000, y: 0 }, radiusM: 1000 },
]

describe('building view rules', () => {
  it('measures from the camera to the nearest ground point of the circle', () => {
    expect(distanceToDistrict({ x: 0, y: 0, altitude: 300 }, districts[0] ?? districts[1]!)).toBe(
      300,
    )
    expect(
      distanceToDistrict(
        { x: 3000, y: 4000, altitude: 0 },
        { id: 'x', centre: { x: 0, y: 0 }, radiusM: 1000 },
      ),
    ).toBeCloseTo(4000, 6)
  })

  it('scales draw distances by the tier', () => {
    const base = drawDistances(scene.buildings, 1)
    expect(drawDistances(scene.buildings, 0.5).districts).toBe(base.districts / 2)
    expect(base.blocks).toBe(scene.buildings.viewM.blocks)
  })

  it('lists districts within range, nearest first', () => {
    const camera = { x: 0, y: 0, altitude: 0 }
    expect(districtsWithin(districts, camera, 1500).map((d) => d.id)).toEqual(['a', 'c'])
    expect(districtsWithin(districts, camera, 10_000).map((d) => d.id)).toEqual(['a', 'c', 'b'])
  })
})
