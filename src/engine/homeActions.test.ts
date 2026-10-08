/**
 * B1: the home actions (sleep, nap, a home-cooked meal) are offered only at home (DEC-22),
 * with funds and energy checked like any place action, and sleep fast-forwards the personal
 * clock through midnight and rent day like a shift does.
 */
import { describe, expect, it } from 'vitest'
import { engineConfig as config } from './config'
import { HOME_LOCATION, initialSnapshot, type GameSnapshot } from './game'
import { homeActions, performHomeAction } from './placeActions'

const MIN_PER_DAY = 24 * 60

function at(minute: number, patch: Partial<GameSnapshot['player']> = {}): GameSnapshot {
  const base = initialSnapshot(config)
  return { clock: { minute, remainderMs: 0 }, player: { ...base.player, ...patch } }
}

const away = { location: { kind: 'place', placeId: 'glowmatic' } } as const

describe('homeActions', () => {
  it('lists place.homeActions in order with their catalog definitions', () => {
    const actions = homeActions(at(22 * 60), config)
    expect(actions.map((action) => action.id)).toEqual(config.place.homeActions)
    expect(actions.map((action) => action.id)).toEqual(['sleep', 'nap', 'home-meal'])
    for (const action of actions) {
      expect(action.kind).toBe('consume')
      expect(action.def).toEqual(config.actions.catalog[action.id])
      expect(action.block).toBeNull()
    }
  })

  it('away from home every one is blocked "away", and performing one changes nothing', () => {
    const snapshot = at(22 * 60, away)
    for (const action of homeActions(snapshot, config)) {
      expect(action.block).toEqual({ code: 'away' })
      expect(performHomeAction(snapshot, action.id, config)).toEqual({
        ok: false,
        error: { code: 'BLOCKED', block: { code: 'away' } },
      })
    }
  })

  it('checks funds, then energy, at home', () => {
    const meal = config.actions.catalog['home-meal']
    if (meal === undefined) throw new Error('no home-meal')
    const broke = homeActions(at(12 * 60, { cash: meal.cashCost - 1 }), config)
    expect(broke.find((a) => a.id === 'home-meal')?.block).toEqual({
      code: 'funds',
      required: meal.cashCost,
      available: meal.cashCost - 1,
    })
    const base = initialSnapshot(config).player.stats
    const tired = homeActions(at(12 * 60, { stats: { ...base, energy: 0 } }), config)
    expect(tired.find((a) => a.id === 'home-meal')?.block).toEqual({
      code: 'energy',
      required: meal.energyCost,
      available: 0,
    })
    // Sleep and nap cost nothing, so a player at zero energy can always rest.
    expect(tired.find((a) => a.id === 'sleep')?.block).toBeNull()
    expect(tired.find((a) => a.id === 'nap')?.block).toBeNull()
  })

  it('refuses an id that is not a home action', () => {
    expect(performHomeAction(at(0), 'bodega-breakfast', config)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_PLACE_ACTION', actionId: 'bodega-breakfast' },
    })
  })
})

describe('sleeping', () => {
  const sleep = config.actions.catalog.sleep
  if (sleep === undefined) throw new Error('no sleep')

  it('fast-forwards through midnight to the morning and brings energy back', () => {
    const base = initialSnapshot(config).player.stats
    const snapshot = at(23 * 60, { stats: { ...base, energy: 5 } })
    const done = performHomeAction(snapshot, 'sleep', config)
    if (!done.ok) throw new Error(done.error.code)
    expect(done.durationMin).toBe(sleep.durationMin)
    expect(done.snapshot.clock.minute).toBe(23 * 60 + sleep.durationMin)
    expect(done.rollovers.days).toBe(1)
    expect(done.snapshot.clock.minute % MIN_PER_DAY).toBe(7 * 60)
    expect(done.snapshot.player.stats.energy).toBeGreaterThan(5)
    expect(done.snapshot.player.stats.energy).toBeGreaterThanOrEqual(
      config.jobs.energyCostPerShift.barista,
    )
    expect(done.snapshot.player.location).toEqual(HOME_LOCATION)
  })

  it('charges rent that falls due overnight, like any action', () => {
    const rentDay = config.time.rentPeriodGameDays
    // 23:00 on the day before rent day: the sleep crosses the rent midnight.
    const snapshot = at((rentDay - 1) * MIN_PER_DAY + 23 * 60, { cash: 1000 })
    const done = performHomeAction(snapshot, 'sleep', config)
    if (!done.ok) throw new Error(done.error.code)
    expect(done.rollovers.weeks).toBe(1)
    expect(done.rent.map((event) => event.kind)).toEqual(['paid'])
    expect(done.snapshot.player.cash).toBe(1000 - config.rentPerWeek[config.startHome])
  })

  it('a missed rent overnight is reported, not hidden', () => {
    const rentDay = config.time.rentPeriodGameDays
    const snapshot = at((rentDay - 1) * MIN_PER_DAY + 23 * 60, { cash: 0 })
    const done = performHomeAction(snapshot, 'sleep', config)
    if (!done.ok) throw new Error(done.error.code)
    expect(done.rent.map((event) => event.kind)).toEqual(['missed'])
  })

  it('reports the energy that really landed when it is capped at the max', () => {
    const done = performHomeAction(at(8 * 60), 'nap', config)
    if (!done.ok) throw new Error(done.error.code)
    const { energy } = done.snapshot.player.stats
    expect(energy).toBeLessThanOrEqual(config.stats.max)
    expect(done.statEffects.energy).toBeLessThanOrEqual(
      config.actions.catalog.nap?.statEffects.energy ?? 0,
    )
  })
})
