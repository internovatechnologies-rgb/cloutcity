import { describe, expect, it } from 'vitest'
import { appendPath, locateOnPath, measurePath, pointAtArc, subPath } from './polyline'

// An L: 100 m east, then 50 m north.
const L = measurePath([
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
])

describe('polyline', () => {
  it('measures cumulative length', () => {
    expect(L.cumulative).toEqual([0, 100, 150])
    expect(L.lengthM).toBe(150)
  })

  it('locates a point by its offset and distance along the path', () => {
    expect(locateOnPath({ x: 40, y: 3 }, L)).toEqual({ offsetM: 3, arcM: 40 })
    expect(locateOnPath({ x: 104, y: 20 }, L)).toEqual({ offsetM: 4, arcM: 120 })
  })

  it('places points along the path, clamped to its ends', () => {
    expect(pointAtArc(L, 125)).toEqual({ x: 100, y: 25 })
    expect(pointAtArc(L, -10)).toEqual({ x: 0, y: 0 })
    expect(pointAtArc(L, 999)).toEqual({ x: 100, y: 50 })
  })

  it('cuts a stretch out, keeping the corner and both interpolated ends', () => {
    expect(subPath(L, 50, 125)).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 25 },
    ])
  })

  it('reverses the stretch when travelling backwards along the path', () => {
    expect(subPath(L, 125, 50)).toEqual([
      { x: 100, y: 25 },
      { x: 100, y: 0 },
      { x: 50, y: 0 },
    ])
  })

  it('joins paths without repeating the shared point', () => {
    const into = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]
    appendPath(into, [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
    expect(into).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
  })
})
