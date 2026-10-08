import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { initialPersistedState } from './store'
import { hudView, nextSpeed } from './hudView'

const fresh = initialPersistedState()
const input = {
  cash: fresh.player.cash,
  minute: fresh.clock.minute,
  speed: fresh.speed,
  stats: fresh.player.stats,
}

describe('hudView (S05)', () => {
  it('shows a new player $150, Day 1, 8:00 AM, 1x and the start stats', () => {
    expect(hudView(input, engineConfig)).toEqual({
      money: '$150',
      day: 1,
      time: '8:00 AM',
      speed: 1,
      nextSpeed: 2,
      stats: [
        { id: 'energy', value: 100, max: 100 },
        { id: 'hunger', value: 80, max: 100 },
        { id: 'mood', value: 70, max: 100 },
      ],
    })
  })

  it('rolls the day and the time of day with the clock', () => {
    const view = hudView({ ...input, minute: 24 * 60 * 2 + 13 * 60 + 5 }, engineConfig)
    expect(view.day).toBe(3)
    expect(view.time).toBe('1:05 PM')
  })

  it('rounds fractional stats to whole points within 0..max', () => {
    const view = hudView(
      { ...input, stats: { energy: 79.6, hunger: 0.4, mood: 100.2 } },
      engineConfig,
    )
    expect(view.stats.map((stat) => stat.value)).toEqual([80, 0, 100])
  })

  it('formats cash in whole dollars', () => {
    expect(hudView({ ...input, cash: 1100 }, engineConfig).money).toBe('$1,100')
  })
})

describe('nextSpeed', () => {
  it('cycles through the configured speeds', () => {
    expect(engineConfig.time.speeds).toEqual([1, 2])
    expect(nextSpeed(1, [1, 2])).toBe(2)
    expect(nextSpeed(2, [1, 2])).toBe(1)
    expect(nextSpeed(3, [1, 2])).toBe(1)
    expect(() => nextSpeed(1, [])).toThrow()
  })
})
