/** Save v7 (S13): the clout ledger and flex state, the v6 upgrade and repairs on load. */
import { describe, expect, it } from 'vitest'
import {
  cloutSums,
  initialCloutState,
  legacyCloutState,
  recordClout,
  totalClout,
  type CloutState,
} from './clout'
import { engineConfig as config } from './config'
import { initialFlexState } from './game'
import { workShift } from './jobs'
import { SAVE_VERSION, createSaveSchema, initialSave, loadSave, migrateSave } from './save'

const schema = createSaveSchema(config)
const DAY = 24 * 60
const base = { ...initialSave(config), clock: { minute: 10 * DAY, remainderMs: 0 } }
const eventSource = (eventId: string) => ({ type: 'event', eventId, choiceId: 'a' }) as const

/** A v6 save: clout is one number, no flex state, pending effects may hold clout. */
function v6Save(clout: number, extra: { inventory?: unknown; events?: unknown } = {}) {
  const player: Record<string, unknown> = {
    ...base.player,
    clout,
    inventory: { wearables: [], gifts: [], outfit: {} },
  }
  delete player.flex
  delete player.visited
  delete player.apartment
  delete player.location
  delete player.transit
  if (extra.inventory !== undefined) player.inventory = extra.inventory
  const v6: Record<string, unknown> = { ...base, player, events: extra.events ?? base.events }
  delete v6.goals
  delete v6.grants
  delete v6.prestige
  delete v6.actions
  return v6
}

const level = (id: string) => config.clout.levels.findIndex((entry) => entry.id === id)
const minOf = (id: string) => config.clout.levels[level(id)]?.minClout ?? Number.NaN

describe('save v7', () => {
  it('is version 11 (S18c after S08 and S16) and a fresh save has an empty ledger and no flexes', () => {
    expect(SAVE_VERSION).toBe(11)
    expect(initialSave(config).player.clout).toEqual(initialCloutState)
    expect(initialSave(config).player.flex).toEqual(initialFlexState)
    expect(schema.safeParse(initialSave(config)).success).toBe(true)
  })

  it('round-trips a ledger, folded totals and flexes through JSON', () => {
    let snapshot: { clock: typeof base.clock; player: typeof base.player } = base
    for (const amount of [5, -2, 9]) {
      const change = { source: 'event', amount, ref: { eventId: 'e', choiceId: 'c' } } as const
      snapshot = { ...snapshot, player: recordClout(snapshot, change, config).player }
    }
    const save = {
      ...base,
      player: {
        ...snapshot.player,
        clout: { ...snapshot.player.clout, compacted: { entries: 3, bySource: { legacy: 40 } } },
        flex: { rngState: 0xffffffff, byPlace: { 'brooklyn-bridge': 11 } },
      },
    }
    expect(loadSave(JSON.parse(JSON.stringify(save)), config)).toEqual({
      ok: true,
      save,
      repaired: [],
    })
    expect(schema.safeParse(save).success).toBe(true)
  })
})

describe('v6 -> v7', () => {
  it('carries clout as one folded legacy entry, with no level-up and the first paycheck still due', () => {
    const migrated = migrateSave(v6Save(minOf('local') + 20), 6, config)
    expect(migrated.outcome).toBe('carried')
    expect(migrated.save.player.clout).toEqual(
      legacyCloutState(minOf('local') + 20, level('local')),
    )
    expect(migrated.save.player.flex).toEqual(initialFlexState)
    expect(totalClout(migrated.save.player, config)).toBe(minOf('local') + 20)
    expect(schema.safeParse(migrated.save).success).toBe(true)

    // The first paycheck lands once for a migrated player too, and reports no replayed level.
    const first = workShift(
      { ...migrated.save, clock: { minute: 10 * DAY + 8 * 60, remainderMs: 0 } },
      'barista',
      config,
    )
    if (!first.ok) throw new Error(first.error.code)
    expect(first.cloutGained).toBe(config.clout.sources.firstPaycheck)
    expect(first.levelUp).toBeNull()
    const second = workShift(first.snapshot, 'barista', config)
    expect(second.ok && second.cloutGained).toBe(0)
  })

  it('peakLevel counts owned wearables too', () => {
    const inventory = {
      wearables: [{ itemId: 'designer-puffer', acquiredMinute: 0, worn: false }],
      gifts: [],
      outfit: {},
    }
    const migrated = migrateSave(v6Save(minOf('local') - 1, { inventory }), 6, config)
    expect(migrated.save.player.clout.peakLevel).toBe(level('local'))
  })

  it('drains pending event clout into the ledger at face value and keeps item effects', () => {
    const events = {
      active: null,
      history: {},
      pending: [
        { kind: 'clout', amount: 6, source: eventSource('a') },
        { kind: 'item', itemId: 'tee', op: 'grant', source: eventSource('b') },
        { kind: 'clout', amount: -100, source: eventSource('c') },
        { kind: 'clout', amount: 4, source: eventSource('d') },
      ],
      rngState: 9,
    }
    const migrated = migrateSave(v6Save(50, { events }), 6, config)
    expect(migrated.outcome).toBe('carried')
    expect(migrated.save.events.pending).toEqual([events.pending[1]])
    expect(migrated.save.events.rngState).toBe(9)
    const { ledger } = migrated.save.player.clout
    expect(ledger.map((entry) => [entry.source, entry.amount, entry.ref])).toEqual([
      ['event', 6, { eventId: 'a', choiceId: 'a' }],
      // 50 + 6 = 56 earned: the -100 is clamped to -56.
      ['event', -56, { eventId: 'c', choiceId: 'a' }],
      ['event', 4, { eventId: 'd', choiceId: 'a' }],
    ])
    expect(totalClout(migrated.save.player, config)).toBe(4)
    expect(schema.safeParse(migrated.save).success).toBe(true)
  })

  it('every version v1 to v6 lands in the current form', () => {
    const v3 = {
      clock: base.clock,
      player: {
        cash: 3,
        stats: base.player.stats,
        clout: 33,
        home: 'queens-room',
        rent: base.player.rent,
      },
      speed: 1,
    }
    for (const [persisted, version] of [
      [{ player: { cash: 1 } }, 1],
      [{ clock: base.clock, player: { cash: 2, stats: base.player.stats }, speed: 1 }, 2],
      [v3, 3],
      [v6Save(66), 6],
    ] as const) {
      const migrated = migrateSave(persisted, version, config)
      expect(migrated.outcome, `v${version}`).toBe('carried')
      expect(schema.safeParse(migrated.save).success, `v${version}`).toBe(true)
    }
    expect(totalClout(migrateSave(v3, 3, config).save.player, config)).toBe(33)
  })

  it('a v6 save with unusable events still migrates (event state starts over)', () => {
    const migrated = migrateSave(v6Save(7, { events: 'junk' }), 6, config)
    expect(migrated.outcome).toBe('carried')
    expect(totalClout(migrated.save.player, config)).toBe(7)
    expect(migrated.save.events.pending).toEqual([])
  })

  it('a v6 save with structural damage starts fresh', () => {
    expect(migrateSave({ ...v6Save(1), admin: true }, 6, config).outcome).toBe('fresh')
    expect(migrateSave(v6Save(-1), 6, config).outcome).toBe('fresh')
  })
})

describe('repairs on load', () => {
  const entry = (seq: number, at: number, amount = 5) => ({
    seq,
    at,
    amount,
    currency: 'cash',
    source: 'event',
    ref: { eventId: 'e', choiceId: 'c' },
  })
  const load = (clout: unknown, flex: unknown = initialFlexState) => {
    const result = loadSave({ ...base, player: { ...base.player, clout, flex } }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(schema.safeParse(result.save).success).toBe(true)
    return result
  }
  const valid = (patch: Partial<CloutState>): CloutState => ({ ...initialCloutState, ...patch })

  it('drops malformed entries, entries from the future and out-of-order seqs', () => {
    const now = base.clock.minute
    const result = load(
      valid({
        ledger: [
          entry(1, 10) as never,
          { ...entry(2, 20), currency: 'usd' } as never,
          entry(3, now + 1) as never,
          entry(4, 30) as never,
          entry(4, 40) as never,
          entry(2, 50) as never,
          { ...entry(5, 60), extra: true } as never,
        ],
        nextSeq: 9,
      }),
    )
    expect(result.repaired).toEqual(['player.clout'])
    expect(result.save.player.clout.ledger.map((e) => e.seq)).toEqual([1, 4])
    expect(result.save.player.clout.nextSeq).toBe(9)
  })

  it('moves nextSeq past the last entry', () => {
    const result = load(valid({ ledger: [entry(7, 1) as never], nextSeq: 3 }))
    expect(result.save.player.clout.nextSeq).toBe(8)
  })

  it('clamps peakLevel into the levels; a non-number becomes the current level', () => {
    // Clamped to the top level, then (S15 fix cycle 1, "Icon is earned") down to the level
    // below it: this ledger has no earned clout to hold Icon.
    expect(load(valid({ peakLevel: 99 })).save.player.clout.peakLevel).toBe(
      config.clout.levels.length - 2,
    )
    const earnedIcon = legacyCloutState(minOf('icon'), 0)
    expect(load({ ...earnedIcon, peakLevel: 99 }).save.player.clout.peakLevel).toBe(
      config.clout.levels.length - 1,
    )
    expect(load(valid({ peakLevel: -4 })).save.player.clout.peakLevel).toBe(0)
    const current = load({ ...legacyCloutState(minOf('known'), 0), peakLevel: 'x' })
    expect(current.save.player.clout.peakLevel).toBe(level('known'))
  })

  it('a negative earned sum gets a repair entry back to 0; negative premium is folded to 0', () => {
    const result = load(valid({ compacted: { entries: 2, bySource: { event: -30, premium: -5 } } }))
    const sums = cloutSums(result.save.player.clout)
    expect(sums.earned).toBe(0)
    expect(sums.premium).toBe(0)
    expect(result.save.player.clout.ledger.at(-1)).toMatchObject({
      source: 'repair',
      amount: 30,
      ref: {},
    })
  })

  it('a non-boolean firstPaycheckPaid becomes true; garbage clout keeps nothing but stays loadable', () => {
    expect(
      load(valid({ firstPaycheckPaid: 'no' as never })).save.player.clout.firstPaycheckPaid,
    ).toBe(true)
    const junk = load(42)
    expect(junk.repaired).toEqual(['player.clout'])
    expect(totalClout(junk.save.player, config)).toBe(0)
  })

  it('drops flexes at unknown places or on future days, and a bad generator state', () => {
    const today = 11
    const result = load(initialCloutState, {
      rngState: -1,
      byPlace: {
        'brooklyn-bridge': today,
        'no-such-place': today,
        dumbo: today + 1,
        'high-line': 2.5,
      },
    })
    expect(result.repaired).toEqual(['player.flex'])
    expect(result.save.player.flex).toEqual({ rngState: 0, byPlace: { 'brooklyn-bridge': today } })
    expect(load(initialCloutState, undefined).save.player.flex).toEqual(initialFlexState)
  })

  it('a "__proto__" flex key from JSON is dropped without polluting anything', () => {
    const persisted = JSON.parse(
      JSON.stringify({ ...base, player: { ...base.player } }).replace(
        '"byPlace":{}',
        '"byPlace":{"__proto__":{"polluted":1}}',
      ),
    ) as unknown
    const result = loadSave(persisted, config)
    expect(result.ok && result.save.player.flex.byPlace).toEqual({})
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
