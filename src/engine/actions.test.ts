import { describe, expect, it } from 'vitest'
import {
  applyAction,
  effectiveDuration,
  performAction,
  validateAction,
  type ActionDef,
} from './actions'
import { calendar } from './clock'
import { engineConfig, type EngineConfig } from './config'
import { initialSnapshot, type GameSnapshot } from './game'

/** Fixed numbers so these tests do not move when balance.json is tuned. */
const config: EngineConfig = {
  ...engineConfig,
  startCash: 150,
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
  actions: {
    maxDurationMin: 1440,
    catalog: {
      shift: { durationMin: 240, cashCost: 0, energyCost: 20, statEffects: { mood: -5 } },
      breakfast: { durationMin: 20, cashCost: 6, energyCost: 0, statEffects: { hunger: 40 } },
    },
  },
}

const DAY = 24 * 60

function snapshotWith(overrides: {
  minute?: number
  cash?: number
  stats?: Partial<GameSnapshot['player']['stats']>
}): GameSnapshot {
  const base = initialSnapshot(config)
  return {
    clock: { minute: overrides.minute ?? base.clock.minute, remainderMs: 0 },
    player: {
      ...base.player,
      cash: overrides.cash ?? base.player.cash,
      stats: { ...base.player.stats, ...overrides.stats },
    },
  }
}

function expectOk(result: ReturnType<typeof applyAction>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`)
  return result
}

describe('action fast-forward', () => {
  it('moves the personal clock instantly by the duration and charges decay on the way', () => {
    const result = expectOk(performAction(snapshotWith({}), 'shift', config))
    expect(result.durationMin).toBe(240)
    expect(result.snapshot.clock.minute).toBe(480 + 240)
    // energy 100 - 20 cost - 4h x 3; hunger 80 - 4h x 5; mood 70 - 4h x 2 - 5 effect.
    expect(result.snapshot.player.stats).toEqual({ energy: 68, hunger: 60, mood: 57 })
    expect(result.rollovers).toEqual({ days: 0, weeks: 0 })
  })

  it('applies stat effects after the time has passed, clamped to the max', () => {
    const result = expectOk(
      performAction(snapshotWith({ stats: { hunger: 90 } }), 'breakfast', config),
    )
    expect(result.snapshot.player).toEqual({
      ...initialSnapshot(config).player,
      cash: 144,
      stats: { energy: 100, hunger: 100, mood: 70 },
    })
  })

  it('crosses midnight and the rent week inside one action', () => {
    const lateOnDay7 = 7 * DAY - 60
    const result = expectOk(performAction(snapshotWith({ minute: lateOnDay7 }), 'shift', config))
    expect(result.rollovers).toEqual({ days: 1, weeks: 1 })
    expect(calendar(result.snapshot.clock.minute, config)).toMatchObject({
      day: 8,
      week: 2,
      hour: 3,
    })
  })

  it('takes longer while exhausted or miserable (rounded up)', () => {
    const tired = snapshotWith({ stats: { energy: 0 } })
    expect(effectiveDuration(config.actions.catalog.breakfast!, tired, config)).toBe(30)
    const both = snapshotWith({ stats: { energy: 0, mood: 0 } })
    const result = expectOk(performAction(both, 'breakfast', config))
    expect(result.durationMin).toBe(Math.ceil(20 * 1.5 * 1.25))
    expect(result.snapshot.clock.minute).toBe(480 + 38)
  })

  it('does not mutate the input snapshot', () => {
    const before = snapshotWith({})
    const copy = structuredClone(before)
    performAction(before, 'shift', config)
    expect(before).toEqual(copy)
  })
})

describe('action costs are validated', () => {
  it('refuses with INSUFFICIENT_FUNDS and changes nothing', () => {
    const broke = snapshotWith({ cash: 5 })
    expect(performAction(broke, 'breakfast', config)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: 6, available: 5 },
    })
  })

  it('allows spending down to exactly zero', () => {
    const result = expectOk(performAction(snapshotWith({ cash: 6 }), 'breakfast', config))
    expect(result.snapshot.player.cash).toBe(0)
  })

  it('refuses with INSUFFICIENT_ENERGY', () => {
    expect(performAction(snapshotWith({ stats: { energy: 19 } }), 'shift', config)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_ENERGY', required: 20, available: 19 },
    })
  })

  it('checks funds before energy', () => {
    const def: ActionDef = { durationMin: 10, cashCost: 10, energyCost: 10, statEffects: {} }
    const result = applyAction(snapshotWith({ cash: 0, stats: { energy: 0 } }), def, config)
    expect(result.ok === false && result.error.code).toBe('INSUFFICIENT_FUNDS')
  })

  it('refuses an unknown action id, including inherited object keys', () => {
    for (const id of ['teleport', 'toString', '__proto__']) {
      expect(performAction(snapshotWith({}), id, config)).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_ACTION', actionId: id },
      })
    }
  })

  it.each([
    ['a negative cash cost', { durationMin: 10, cashCost: -5, energyCost: 0, statEffects: {} }],
    ['fractional minutes', { durationMin: 1.5, cashCost: 0, energyCost: 0, statEffects: {} }],
    ['a duration over the max', { durationMin: 1441, cashCost: 0, energyCost: 0, statEffects: {} }],
    [
      'an energy cost over the max',
      { durationMin: 1, cashCost: 0, energyCost: 101, statEffects: {} },
    ],
    ['an unknown stat', { durationMin: 1, cashCost: 0, energyCost: 0, statEffects: { clout: 5 } }],
    [
      'an unknown field',
      { durationMin: 1, cashCost: 0, energyCost: 0, statEffects: {}, free: true },
    ],
    ['a missing field', { durationMin: 1, cashCost: 0, statEffects: {} }],
    ['not an object', 'sleep'],
  ])('refuses %s as INVALID_ACTION', (_label, def) => {
    const result = applyAction(snapshotWith({}), def, config)
    expect(result.ok === false && result.error.code).toBe('INVALID_ACTION')
  })

  it('accepts every action in the shipped catalog', () => {
    for (const [id, def] of Object.entries(engineConfig.actions.catalog)) {
      expect(validateAction(def, engineConfig).ok, id).toBe(true)
    }
  })
})

describe('action edge cases', () => {
  it('spends exactly all cash and exactly all energy in one action', () => {
    const def: ActionDef = { durationMin: 30, cashCost: 25, energyCost: 40, statEffects: {} }
    const result = expectOk(
      applyAction(snapshotWith({ cash: 25, stats: { energy: 40 } }), def, config),
    )
    expect(result.snapshot.player.cash).toBe(0)
    expect(result.snapshot.player.stats.energy).toBe(0)
  })

  it('one dollar short refuses with required/available and leaves the snapshot untouched', () => {
    const before = snapshotWith({ cash: 5, minute: 7 * DAY - 1 })
    const copy = structuredClone(before)
    const result = performAction(before, 'breakfast', config)
    expect(result).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: 6, available: 5 },
    })
    expect(before).toEqual(copy)
  })

  it('judges the slowdown on the stats before paying the energy cost', () => {
    // Shift costs 20 energy: paying it takes energy to 0, but the player started rested.
    const result = expectOk(performAction(snapshotWith({ stats: { energy: 20 } }), 'shift', config))
    expect(result.durationMin).toBe(240)
    expect(result.snapshot.clock.minute).toBe(480 + 240)
  })

  it.each(['constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'toString', ''])(
    'refuses the id %j as UNKNOWN_ACTION',
    (id) => {
      expect(performAction(snapshotWith({}), id, config)).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_ACTION', actionId: id },
      })
    },
  )

  it('refuses a tampered catalog entry as INVALID_ACTION without changing anything', () => {
    const tampered = {
      ...config,
      actions: {
        ...config.actions,
        catalog: {
          ...config.actions.catalog,
          free: { durationMin: 10, cashCost: -1000, energyCost: 0, statEffects: {} },
        },
      },
    } as EngineConfig
    const before = snapshotWith({})
    const result = performAction(before, 'free', tampered)
    expect(result.ok === false && result.error.code).toBe('INVALID_ACTION')
    expect(
      result.ok === false && result.error.code === 'INVALID_ACTION' && result.error.issues,
    ).toContain('cashCost')
    expect(before).toEqual(snapshotWith({}))
  })

  it('reports a day rollover without a week rollover when crossing an ordinary midnight', () => {
    const result = expectOk(
      performAction(snapshotWith({ minute: 2 * DAY - 10 }), 'breakfast', config),
    )
    expect(result.rollovers).toEqual({ days: 1, weeks: 0 })
    expect(calendar(result.snapshot.clock.minute, config)).toMatchObject({ day: 3, hour: 0 })
  })

  it('a max-length action from just before the week boundary rolls one week and one day', () => {
    const def: ActionDef = { durationMin: 1440, cashCost: 0, energyCost: 0, statEffects: {} }
    const result = expectOk(applyAction(snapshotWith({ minute: 7 * DAY - 1 }), def, config))
    expect(result.rollovers).toEqual({ days: 1, weeks: 1 })
  })

  it('keeps the passive remainder through an action', () => {
    const base = snapshotWith({})
    const withRemainder = { ...base, clock: { minute: base.clock.minute, remainderMs: 4200 } }
    const result = expectOk(performAction(withRemainder, 'breakfast', config))
    expect(result.snapshot.clock).toEqual({ minute: 500, remainderMs: 4200 })
  })
})
