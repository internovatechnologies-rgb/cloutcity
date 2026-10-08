import { describe, expect, it } from 'vitest'
import { STAT_KEYS as SCHEMA_STAT_KEYS } from '@/lib/data/schemas/config'
import { engineConfig, type EngineConfig } from './config'
import {
  STAT_KEYS,
  applyStatChanges,
  decayStats,
  durationMultiplier,
  hoursCrossed,
  type Stats,
} from './stats'

/** Fixed numbers so these tests do not move when balance.json is tuned. */
const config: EngineConfig = {
  ...engineConfig,
  stats: {
    max: 100,
    start: { energy: 100, hunger: 80, mood: 70 },
    decayPerGameHour: { energy: 3, hunger: 5, mood: 2 },
    atZero: {
      energy: { extraDecayPerGameHour: { mood: 3 }, durationMultiplier: 1.5 },
      hunger: { extraDecayPerGameHour: { energy: 3, mood: 4 }, durationMultiplier: 1 },
      mood: { extraDecayPerGameHour: {}, durationMultiplier: 1.25 },
    },
  },
}

const stats = (energy: number, hunger: number, mood: number): Stats => ({ energy, hunger, mood })

describe('stat decay', () => {
  it('matches the schema stat keys', () => {
    expect([...STAT_KEYS]).toEqual([...SCHEMA_STAT_KEYS])
  })

  it('decays once per game hour boundary crossed', () => {
    expect(hoursCrossed(480, 539)).toBe(0)
    expect(hoursCrossed(539, 540)).toBe(1)
    expect(hoursCrossed(479, 720)).toBe(5)
    expect(decayStats(stats(100, 80, 70), 480, 539, config)).toEqual(stats(100, 80, 70))
    expect(decayStats(stats(100, 80, 70), 480, 540, config)).toEqual(stats(97, 75, 68))
    expect(decayStats(stats(100, 80, 70), 480, 720, config)).toEqual(stats(88, 60, 62))
  })

  it('does not depend on how the time was split', () => {
    const whole = decayStats(stats(90, 50, 40), 500, 1700, config)
    let split = stats(90, 50, 40)
    for (let minute = 500; minute < 1700; minute += 7) {
      split = decayStats(split, minute, Math.min(minute + 7, 1700), config)
    }
    expect(split).toEqual(whole)
  })

  it('clamps at zero and never goes negative', () => {
    expect(decayStats(stats(2, 4, 1), 0, 60, config)).toEqual(stats(0, 0, 0))
  })

  it('a long stretch with every stat at zero stays at zero', () => {
    expect(decayStats(stats(0, 0, 0), 0, 60 * 24 * 365, config)).toEqual(stats(0, 0, 0))
  })
})

describe('penalties at zero', () => {
  it('starving (hunger 0) drains energy and mood faster', () => {
    expect(decayStats(stats(50, 0, 50), 0, 60, config)).toEqual(stats(44, 0, 44))
  })

  it('exhausted (energy 0) drains mood faster', () => {
    expect(decayStats(stats(0, 50, 50), 0, 60, config)).toEqual(stats(0, 45, 45))
  })

  it('a stat that hits zero starts its penalty from the next hour', () => {
    // Hour 1: hunger 5 -> 0 at normal decay. Hour 2: starving extras apply.
    expect(decayStats(stats(50, 5, 50), 0, 60, config)).toEqual(stats(47, 0, 48))
    expect(decayStats(stats(50, 5, 50), 0, 120, config)).toEqual(stats(41, 0, 42))
  })

  it('slows actions while energy or mood is at zero, stacking', () => {
    expect(durationMultiplier(stats(50, 50, 50), config)).toBe(1)
    expect(durationMultiplier(stats(0, 50, 50), config)).toBe(1.5)
    expect(durationMultiplier(stats(50, 50, 0), config)).toBe(1.25)
    expect(durationMultiplier(stats(0, 0, 0), config)).toBe(1.875)
  })
})

describe('applyStatChanges', () => {
  it('adds and clamps to 0..max', () => {
    expect(applyStatChanges(stats(90, 10, 50), { energy: 30, hunger: -20 }, config)).toEqual(
      stats(100, 0, 50),
    )
  })
})

describe('decay is split-invariant across day and week boundaries', () => {
  const DAY = 24 * 60
  const WEEK = 7 * DAY
  it.each([
    ['inside one day', 480, 700, 1000],
    ['across midnight', DAY - 61, DAY - 1, DAY + 59],
    ['exactly on midnight', DAY - 60, DAY, DAY + 60],
    ['across the week boundary', WEEK - 200, WEEK, WEEK + 133],
    ['over several days', 480, 3 * DAY + 7, 9 * DAY + 13],
  ])('A->C equals A->B->C %s', (_label, a, b, c) => {
    for (const start of [stats(100, 80, 70), stats(10, 3, 6), stats(0, 0, 40), stats(1, 1, 1)]) {
      const whole = decayStats(start, a, c, config)
      const split = decayStats(decayStats(start, a, b, config), b, c, config)
      expect(split).toEqual(whole)
      for (const key of STAT_KEYS) {
        expect(whole[key]).toBeGreaterThanOrEqual(0)
        expect(whole[key]).toBeLessThanOrEqual(100)
      }
    }
  })

  it('penalties apply only while a stat is at zero and stack', () => {
    // Starving and exhausted: mood drains 2 + 4 (hunger) + 3 (energy) = 9 per hour.
    expect(decayStats(stats(0, 0, 50), 0, 60, config)).toEqual(stats(0, 0, 41))
    // Once fed again, the starving extras stop.
    const fed = applyStatChanges(stats(20, 0, 50), { hunger: 40 }, config)
    expect(decayStats(fed, 0, 60, config)).toEqual(stats(17, 35, 48))
  })

  it('applyStatChanges clamps big swings both ways', () => {
    expect(applyStatChanges(stats(0, 100, 50), { energy: 500, hunger: -500 }, config)).toEqual(
      stats(100, 0, 50),
    )
  })
})
