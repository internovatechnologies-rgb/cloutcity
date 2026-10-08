import { describe, expect, it } from 'vitest'
import { median, medianMarks, type LoadTimings } from './measure'

const load = (playableMs: number, scene: Record<string, number>): LoadTimings => ({
  shellInteractiveMs: 1,
  playableMs,
  scene,
})

describe('perf run medians', () => {
  it('takes the middle value of an odd run count, in any order', () => {
    expect(median([5_000, 3_000, 9_000])).toBe(5_000)
    expect(median([7])).toBe(7)
    expect(() => median([])).toThrow()
  })

  it('medians each start-up step reached by every run, and drops the others', () => {
    const runs = [
      load(1, { 'cc:3d:start': 100, 'cc:3d:built': 900 }),
      load(1, { 'cc:3d:start': 300, 'cc:3d:built': 700 }),
      load(1, { 'cc:3d:start': 200 }),
    ]
    expect(medianMarks(runs)).toEqual({ 'cc:3d:start': 200 })
  })
})
