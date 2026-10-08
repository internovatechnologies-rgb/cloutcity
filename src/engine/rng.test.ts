import { describe, expect, it } from 'vitest'
import { createRng, mixSeed, rollInt } from './rng'

describe('seeded random source', () => {
  it('gives the same sequence for the same seed, on every run (golden values)', () => {
    const rng = createRng(42)
    // mulberry32(42): fixed forever, so a change to the generator is caught.
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
    ])
    expect(rng.state).toBe(1199730185)
  })

  it('continues the same sequence from a saved state', () => {
    const saved = createRng(7)
    saved.next()
    const resumed = createRng(saved.state)
    const uninterrupted = createRng(7)
    uninterrupted.next()
    expect([resumed.next(), resumed.next()]).toEqual([uninterrupted.next(), uninterrupted.next()])
  })

  it('stays in [0, 1) and is roughly uniform', () => {
    const rng = createRng(123)
    const buckets: number[] = Array.from({ length: 10 }, () => 0)
    const draws = 20_000
    for (let i = 0; i < draws; i++) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
      const bucket = Math.floor(value * 10)
      buckets[bucket] = (buckets[bucket] ?? 0) + 1
    }
    for (const count of buckets) expect(Math.abs(count - draws / 10)).toBeLessThan(draws * 0.01)
  })

  it('different seeds give different sequences', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next())
  })

  it('treats seeds as uint32 and rejects non-finite seeds', () => {
    expect(createRng(2 ** 32 + 5).next()).toBe(createRng(5).next())
    expect(createRng(-1).next()).toBe(createRng(0xffffffff).next())
    expect(() => createRng(Number.NaN)).toThrow(RangeError)
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('mixSeed is deterministic, a uint32, and spreads neighbouring inputs', () => {
    expect(mixSeed(42, 480)).toBe(2083466508)
    expect(mixSeed(42, 480)).toBe(mixSeed(42, 480))
    const seeds = new Set(Array.from({ length: 1000 }, (_, minute) => mixSeed(42, minute)))
    expect(seeds.size).toBe(1000)
    for (const seed of seeds) {
      expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff).toBe(true)
    }
  })

  it('rolls whole numbers inside the inclusive range, reaching both ends', () => {
    const rng = createRng(3)
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const value = rollInt(rng, 5, 8)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(5)
      expect(value).toBeLessThanOrEqual(8)
      seen.add(value)
    }
    expect([...seen].sort()).toEqual([5, 6, 7, 8])
  })
})
