import { describe, expect, it } from 'vitest'
import { encodeRing } from '@/lib/geo/codec'
import type { LocalPoint } from '@/lib/geo/projection'
import { createRng } from '../rng'
import {
  buildLandMask,
  crossesWater,
  isOnLand,
  longestWaterRunM,
  snapToLand,
  type LandMask,
} from './land'
import { PLACES, testWorld } from './test-fixtures'

/** Reference: sample the segment every `stepM` and measure the longest off-land run. */
function sampledWaterRunM(a: LocalPoint, b: LocalPoint, mask: LandMask, stepM: number): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(1, Math.ceil(length / stepM))
  let longest = 0
  let run = 0
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps
    const point = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
    if (isOnLand(point, mask)) run = 0
    else longest = Math.max(longest, (run += length / steps))
  }
  return longest
}

// Two 100 m squares 50 m apart, the second with a 20 m hole.
const square = (x: number, size: number) => [
  { x, y: 0 },
  { x: x + size, y: 0 },
  { x: x + size, y: size },
  { x, y: size },
]
const toy = buildLandMask({
  boroughs: [
    {
      id: 'toy',
      polygons: [
        [encodeRing(square(0, 100))],
        [
          encodeRing(square(150, 100)),
          encodeRing(square(190, 20).map((p) => ({ ...p, y: p.y + 40 }))),
        ],
      ],
    },
  ],
})

describe('land mask', () => {
  it('measures the gap between two islands and the hole in one', () => {
    expect(longestWaterRunM({ x: 10, y: 50 }, { x: 90, y: 50 }, toy)).toBe(0)
    expect(longestWaterRunM({ x: 10, y: 50 }, { x: 180, y: 50 }, toy)).toBeCloseTo(50, 6)
    expect(longestWaterRunM({ x: 160, y: 50 }, { x: 240, y: 50 }, toy)).toBeCloseTo(20, 6)
    expect(crossesWater({ x: 10, y: 50 }, { x: 180, y: 50 }, toy, 50)).toBe(false)
    expect(crossesWater({ x: 10, y: 50 }, { x: 180, y: 50 }, toy, 49)).toBe(true)
  })

  it('counts water at either end of the segment', () => {
    expect(longestWaterRunM({ x: -30, y: 50 }, { x: 50, y: 50 }, toy)).toBeCloseTo(30, 6)
    expect(longestWaterRunM({ x: 50, y: 50 }, { x: 50, y: 130 }, toy)).toBeCloseTo(30, 6)
  })

  it('is not fooled by a segment passing exactly through a vertex', () => {
    // Along the line y = x, through the square's corners (0, 0) and (100, 100): two separate
    // 14.1 m water runs, one at each end.
    expect(longestWaterRunM({ x: -10, y: -10 }, { x: 110, y: 110 }, toy)).toBeCloseTo(
      Math.hypot(10, 10),
      6,
    )
    expect(longestWaterRunM({ x: 50, y: 50 }, { x: 110, y: 110 }, toy)).toBeCloseTo(
      Math.hypot(10, 10),
      6,
    )
    // Along an edge.
    expect(longestWaterRunM({ x: -10, y: 0 }, { x: 50, y: 0 }, toy)).toBeLessThanOrEqual(
      Math.hypot(60, 0),
    )
  })

  it('matches dense sampling on random segments across the real land layer', () => {
    const { land } = testWorld()
    const rng = createRng(8)
    for (let i = 0; i < 60; i++) {
      const a = { x: -15_000 + rng.next() * 30_000, y: -15_000 + rng.next() * 35_000 }
      const b = { x: a.x + (rng.next() - 0.5) * 8000, y: a.y + (rng.next() - 0.5) * 8000 }
      const exact = longestWaterRunM(a, b, land)
      const sampled = sampledWaterRunM(a, b, land, 5)
      expect(Math.abs(exact - sampled), `segment ${i}`).toBeLessThan(15)
    }
  })

  it('sees the East River between Times Square and Flushing, and none along Manhattan', () => {
    const { land } = testWorld()
    expect(longestWaterRunM(PLACES.timesSquare, PLACES.flushingMainSt, land)).toBeGreaterThan(200)
    expect(longestWaterRunM(PLACES.timesSquare, PLACES.unionSquare, land)).toBe(0)
  })

  it('tests a long segment quickly', () => {
    const { land } = testWorld()
    const start = performance.now()
    for (let i = 0; i < 50; i++) longestWaterRunM(PLACES.stGeorge, PLACES.flushingMainSt, land)
    expect((performance.now() - start) / 50).toBeLessThan(10)
  })

  it('counts the shoreline as land: walking along any edge of a square in either direction is dry', () => {
    const corners = square(0, 100)
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!
      const b = corners[(i + 1) % 4]!
      expect(longestWaterRunM(a, b, toy), `edge ${i}`).toBe(0)
      expect(longestWaterRunM(b, a, toy), `edge ${i} reversed`).toBe(0)
    }
  })

  it('snaps a point off the shore to land just inside it, within the limit only', () => {
    expect(snapToLand({ x: 50, y: 50 }, toy, 30)).toEqual({ x: 50, y: 50 })
    const snapped = snapToLand({ x: 50, y: -20 }, toy, 30)
    expect(snapped).toBeDefined()
    if (snapped === undefined) return
    expect(isOnLand(snapped, toy)).toBe(true)
    expect(snapped.y).toBeGreaterThan(0)
    expect(snapped.y).toBeLessThan(6)
    expect(snapToLand({ x: 50, y: -40 }, toy, 30)).toBeUndefined()
  })
})
