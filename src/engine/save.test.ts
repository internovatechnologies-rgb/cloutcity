import { describe, expect, it } from 'vitest'
import { initialCloutState, legacyCloutState } from './clout'
import { engineConfig as config } from './config'
import { emptyInventory } from './items'
import { initialEventsState } from './events'
import { initialFlexState } from './game'
import { initialGoalsState } from './goals'
import { initialGrantsState } from './grants'
import { initialApartment } from './home'
import { initialPrestigeState } from './prestige'
import { SAVE_VERSION, createSaveSchema, initialSave, loadSave, migrateSave } from './save'

const schema = createSaveSchema(config)

/** A v4 to v8 inventory: no decor (v9). */
const legacyInventory = { wearables: [], gifts: [], outfit: {} }

/** A v3 to v6 player: clout was one number and there was no flex state, visits (v8) or apartment (v9). */
function legacyPlayer(): Record<string, unknown> {
  const player: Record<string, unknown> = {
    ...initialSave(config).player,
    clout: 0,
    inventory: legacyInventory,
  }
  delete player.flex
  delete player.visited
  delete player.apartment
  delete player.location
  delete player.transit
  return player
}

/** A v7 player: everything but the first visits (v8), decor and the apartment (v9). */
function legacyV7Player(): Record<string, unknown> {
  const player: Record<string, unknown> = {
    ...initialSave(config).player,
    inventory: legacyInventory,
  }
  delete player.visited
  delete player.apartment
  delete player.location
  delete player.transit
  return player
}

/** A save before v8: no goals, grants or prestige. */
function legacyBase(): Record<string, unknown> {
  const save: Record<string, unknown> = { ...initialSave(config) }
  delete save.goals
  delete save.grants
  delete save.prestige
  delete save.actions
  return save
}

/**
 * What a migration adds for S15 (v8): no visits, fresh grants and prestige, goals as given; and
 * for S18c (v11): no actions counted.
 */
const S15_FIELDS = {
  goals: initialGoalsState,
  grants: initialGrantsState,
  prestige: initialPrestigeState,
  actions: 0,
} as const

describe('save schema', () => {
  it('accepts a fresh save', () => {
    expect(SAVE_VERSION).toBe(11)
    expect(schema.safeParse(initialSave(config)).success).toBe(true)
  })

  it('round-trips through JSON', () => {
    const save = {
      ...initialSave(config),
      clock: { minute: 12_345, remainderMs: 1234.5 },
      speed: 2,
    }
    const parsed = schema.safeParse(JSON.parse(JSON.stringify(save)))
    expect(parsed.success && parsed.data).toEqual(save)
  })

  it.each([
    ['a remainder of a whole game minute', { clock: { minute: 0, remainderMs: 6000 } }],
    ['a negative minute', { clock: { minute: -1, remainderMs: 0 } }],
    ['speed 0', { speed: 0 }],
  ])('rejects %s', (_label, patch) => {
    expect(schema.safeParse({ ...initialSave(config), ...patch }).success).toBe(false)
  })
})

describe('save migration', () => {
  it('v1 -> current keeps cash and starts the clock and stats fresh', () => {
    const migrated = migrateSave({ player: { cash: 420 } }, 1, config)
    expect(migrated.outcome).toBe('carried')
    expect(migrated.save).toEqual({
      ...initialSave(config),
      player: { ...initialSave(config).player, cash: 420 },
    })
    expect(schema.safeParse(migrated.save).success).toBe(true)
  })

  it.each([
    ['a malformed v1 save', { player: { cash: -3 } }, 1],
    ['a v1 save with unknown keys', { player: { cash: 3 }, admin: true }, 1],
    ['a pre-release v0 save', { money: 5 }, 0],
  ])('starts %s fresh', (_label, persisted, version) => {
    expect(migrateSave(persisted, version, config)).toEqual({
      save: initialSave(config),
      outcome: 'fresh',
    })
  })

  it('refuses a save from a newer build', () => {
    expect(() => migrateSave(initialSave(config), SAVE_VERSION + 1, config)).toThrow(/newer/)
  })
})

describe('save edge cases', () => {
  it.each([
    ['a negative remainder', { clock: { minute: 0, remainderMs: -0.5 } }],
    ['a remainder above one game minute', { clock: { minute: 0, remainderMs: 6000.5 } }],
    ['a fractional stat', { player: { cash: 1, stats: { energy: 1.5, hunger: 1, mood: 1 } } }],
    ['a missing stats object', { player: { cash: 1 } }],
  ])('rejects %s', (_label, patch) => {
    expect(schema.safeParse({ ...initialSave(config), ...patch }).success).toBe(false)
  })

  it('accepts a remainder just under one game minute', () => {
    const save = { ...initialSave(config), clock: { minute: 0, remainderMs: 5999.999 } }
    expect(schema.safeParse(save).success).toBe(true)
  })

  it('a speed the current config no longer offers fails validation', () => {
    const only1x = { ...config, time: { ...config.time, speeds: [1] } }
    expect(createSaveSchema(only1x).safeParse({ ...initialSave(config), speed: 2 }).success).toBe(
      false,
    )
  })

  it('starts a v1 save with an extra key inside player fresh', () => {
    expect(migrateSave({ player: { cash: 3, name: 'x' } }, 1, config).outcome).toBe('fresh')
  })

  it('v1 -> current round-trips through JSON with cash intact', () => {
    const { save } = migrateSave(JSON.parse('{"player":{"cash":9999}}'), 1, config)
    const parsed = schema.safeParse(JSON.parse(JSON.stringify(save)))
    expect(parsed.success && parsed.data.player.cash).toBe(9999)
  })

  it.each([null, undefined, 'junk', 42, []])('starts a v1 save of %j fresh', (persisted) => {
    expect(migrateSave(persisted, 1, config).outcome).toBe('fresh')
  })
})

describe('loading repairs individual fields', () => {
  const base = initialSave(config)

  it('loads a valid save unchanged', () => {
    expect(loadSave(base, config)).toEqual({ ok: true, save: base, repaired: [] })
  })

  it.each([
    ['a negative remainder', { clock: { minute: 900, remainderMs: -1 } }, 'clock.remainderMs'],
    [
      'a whole-minute remainder',
      { clock: { minute: 900, remainderMs: 6000 } },
      'clock.remainderMs',
    ],
    ['a non-numeric remainder', { clock: { minute: 900, remainderMs: null } }, 'clock.remainderMs'],
    ['an unsupported speed', { speed: 3 }, 'speed'],
    ['a speed of the wrong type', { speed: '2' }, 'speed'],
  ])('repairs %s and keeps the rest', (_label, patch, field) => {
    const result = loadSave({ ...base, player: { ...base.player, cash: 321 }, ...patch }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.repaired).toEqual([field])
    expect(result.save.player.cash).toBe(321)
    expect(result.save.speed).toBe(field === 'speed' ? 1 : base.speed)
    expect(result.save.clock.remainderMs).toBe(0)
    expect(schema.safeParse(result.save).success).toBe(true)
  })

  it('clamps out-of-range stats and rounds fractional ones', () => {
    const stats = { energy: 250, hunger: -4, mood: 49.5 }
    const result = loadSave({ ...base, player: { ...base.player, cash: 1, stats } }, config)
    expect(result.ok && result.save.player.stats).toEqual({ energy: 100, hunger: 0, mood: 50 })
    expect(result.ok && result.repaired).toEqual([
      'player.stats.energy',
      'player.stats.hunger',
      'player.stats.mood',
    ])
  })

  it.each([
    ['negative cash', { player: { ...base.player, cash: -1 } }],
    ['fractional cash', { player: { ...base.player, cash: 1.5 } }],
    ['cash of the wrong type', { player: { ...base.player, cash: '5' } }],
    ['a fractional minute', { clock: { minute: 1.5, remainderMs: 0 } }],
    ['a missing clock', { clock: undefined }],
    ['a missing stats object', { player: { cash: 1 } }],
    [
      'a stat of the wrong type',
      { player: { cash: 1, stats: { energy: 'x', hunger: 1, mood: 1 } } },
    ],
    ['an unknown key', { admin: true }],
  ])('refuses a structurally unusable save: %s', (_label, patch) => {
    expect(loadSave({ ...base, ...patch }, config).ok).toBe(false)
  })

  it.each([null, 'junk', 42, []])('refuses %j', (persisted) => {
    expect(loadSave(persisted, config).ok).toBe(false)
  })
})

describe('save v3: clout, home and rent', () => {
  const base = initialSave(config)

  it('a fresh save starts with no clout, the start home and nothing owed', () => {
    expect(base.player).toMatchObject({
      clout: initialCloutState,
      flex: initialFlexState,
      home: config.startHome,
      rent: { owed: 0, missed: 0 },
    })
  })

  it('v2 -> v3 keeps the clock, cash, stats and speed and adds the new fields', () => {
    const v2 = {
      clock: { minute: 9000, remainderMs: 12 },
      player: { cash: 420, stats: { energy: 50, hunger: 40, mood: 30 } },
      speed: 2,
    }
    const migrated = migrateSave(v2, 2, config)
    expect(migrated).toEqual({
      outcome: 'carried',
      save: {
        ...v2,
        player: {
          ...v2.player,
          clout: initialCloutState,
          flex: initialFlexState,
          home: config.startHome,
          rent: { owed: 0, missed: 0 },
          inventory: emptyInventory,
          clubNights: {},
          visited: {},
          apartment: initialApartment,
          location: { kind: 'home' },
          transit: { rngState: 0 },
        },
        events: initialEventsState(),
        ...S15_FIELDS,
      },
    })
    expect(schema.safeParse(migrated.save).success).toBe(true)
  })

  it('v2 -> v3 repairs out-of-range v2 fields on the way', () => {
    const v2 = {
      clock: { minute: 9000, remainderMs: -4 },
      player: { cash: 5, stats: { energy: 500, hunger: 40, mood: 30 } },
      speed: 7,
    }
    const { save, outcome } = migrateSave(v2, 2, config)
    expect(outcome).toBe('carried')
    expect(save.clock.remainderMs).toBe(0)
    expect(save.player.stats.energy).toBe(config.stats.max)
    expect(save.speed).toBe(1)
  })

  it.each([
    ['a malformed v2 save', { clock: { minute: -1, remainderMs: 0 }, player: {}, speed: 1 }],
    ['a v2 save that already has v3 keys', base],
    ['junk', 'junk'],
  ])('starts %s fresh', (_label, persisted) => {
    expect(migrateSave(persisted, 2, config)).toEqual({ save: base, outcome: 'fresh' })
  })

  it.each([
    ['an unknown home', { ...base.player, home: 'penthouse' }],
    ['negative clout', { ...base.player, clout: -1 }],
    ['negative rent owed', { ...base.player, rent: { owed: -1, missed: 0 } }],
    ['a missed count at the eviction step', { ...base.player, rent: { owed: 0, missed: 3 } }],
  ])('the schema rejects %s', (_label, player) => {
    const evictAt3 = { ...config, rent: { lateFees: [0, 30], evictAfterMissed: 3 } }
    expect(createSaveSchema(evictAt3).safeParse({ ...base, player }).success).toBe(false)
  })

  it('repairs an unknown home and an out-of-range missed count', () => {
    const player = { ...base.player, home: 'penthouse', rent: { owed: 90, missed: 99 } }
    const result = loadSave({ ...base, player }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.repaired).toEqual(['player.home', 'player.rent.missed'])
    expect(result.save.player.home).toBe(config.startHome)
    expect(result.save.player.rent).toEqual({ owed: 90, missed: config.rent.evictAfterMissed - 1 })
    expect(schema.safeParse(result.save).success).toBe(true)
  })

  it.each([
    [
      'a missing rent object',
      { cash: 1, stats: base.player.stats, clout: initialCloutState, home: 'queens-room' },
    ],
    ['fractional rent owed', { ...base.player, rent: { owed: 1.5, missed: 0 } }],
  ])('refuses a structurally unusable save: %s', (_label, player) => {
    expect(loadSave({ ...base, player }, config).ok).toBe(false)
  })
})

describe('save v3: tampered and edge saves', () => {
  const base = initialSave(config)
  const fromJson = (player: string) =>
    JSON.parse(
      `{"clock":{"minute":900,"remainderMs":0},"player":${player},"speed":1,"events":{"active":null,"history":{},"pending":[],"rngState":0}}`,
    ) as unknown

  it.each(['__proto__', 'constructor', 'hasOwnProperty', ''])(
    'a home of %j is repaired to the start home',
    (home) => {
      const clout = JSON.stringify(legacyCloutState(4, 0))
      const flex = JSON.stringify(initialFlexState)
      const persisted = fromJson(
        `{"cash":9,"stats":{"energy":1,"hunger":2,"mood":3},"clout":${clout},"flex":${flex},"home":${JSON.stringify(home)},"rent":{"owed":5,"missed":1},"inventory":{"wearables":[],"gifts":[],"outfit":{}},"clubNights":{}}`,
      )
      const result = loadSave(persisted, config)
      if (!result.ok) throw new Error('expected a repaired save')
      expect(result.repaired).toEqual(['player.home'])
      expect(result.save.player).toEqual({
        cash: 9,
        stats: { energy: 1, hunger: 2, mood: 3 },
        clout: legacyCloutState(4, 0),
        flex: initialFlexState,
        home: config.startHome,
        rent: { owed: 5, missed: 1 },
        inventory: emptyInventory,
        clubNights: {},
        visited: {},
        apartment: initialApartment,
        location: { kind: 'home' },
        transit: { rngState: 0 },
      })
      expect(schema.safeParse(result.save).success).toBe(true)
    },
  )

  it.each([
    ['a string', '2', 0],
    ['null', null, 0],
    ['negative', -3, 0],
    ['fractional', 0.6, 1],
  ])('a missed count that is %s is repaired', (_label, missed, expected) => {
    const result = loadSave(
      { ...base, player: { ...base.player, rent: { owed: 0, missed } } },
      config,
    )
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.repaired).toEqual(['player.rent.missed'])
    expect(result.save.player.rent.missed).toBe(expected)
  })

  it('a missed count saved before evictAfterMissed was lowered is clamped below it', () => {
    const tightened = { ...config, rent: { lateFees: [], evictAfterMissed: 1 } }
    const player = { ...base.player, rent: { owed: 280, missed: 2 } }
    const result = loadSave({ ...base, player }, tightened)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.player.rent).toEqual({ owed: 280, missed: 0 })
    expect(createSaveSchema(tightened).safeParse(result.save).success).toBe(true)
  })

  it.each([
    ['negative owed', { ...base.player, rent: { owed: -1, missed: 0 } }],
    ['owed as a string', { ...base.player, rent: { owed: '5', missed: 0 } }],
    ['a rent object with an extra key', { ...base.player, rent: { owed: 0, missed: 0, x: 1 } }],
    ['rent as null', { ...base.player, rent: null }],
  ])('refuses a structurally unusable save: %s', (_label, player) => {
    expect(loadSave({ ...base, player }, config).ok).toBe(false)
  })

  it('v2 -> v3 with a damaged remainder, fractional stats and an unknown speed is carried', () => {
    const v2 = {
      clock: { minute: 4321, remainderMs: 'later' },
      player: { cash: 77, stats: { energy: 12.4, hunger: -8, mood: 1e9 } },
      speed: '2',
    }
    const { save, outcome } = migrateSave(v2, 2, config)
    expect(outcome).toBe('carried')
    expect(save).toEqual({
      clock: { minute: 4321, remainderMs: 0 },
      player: {
        cash: 77,
        stats: { energy: 12, hunger: 0, mood: config.stats.max },
        clout: initialCloutState,
        flex: initialFlexState,
        home: config.startHome,
        rent: { owed: 0, missed: 0 },
        inventory: emptyInventory,
        clubNights: {},
        visited: {},
        apartment: initialApartment,
        location: { kind: 'home' },
        transit: { rngState: 0 },
      },
      speed: 1,
      events: initialEventsState(),
      ...S15_FIELDS,
    })
  })

  it.each([
    ['negative cash', { cash: -1, stats: { energy: 1, hunger: 1, mood: 1 } }],
    ['a missing stats object', { cash: 1 }],
  ])('v2 -> v3 with %s starts fresh', (_label, player) => {
    const v2 = { clock: { minute: 10, remainderMs: 0 }, player, speed: 1 }
    expect(migrateSave(v2, 2, config)).toEqual({ save: base, outcome: 'fresh' })
  })
})

describe('event state in the save (v5)', () => {
  const base = initialSave(config)
  const eventId = config.events.catalog[0]?.id ?? 'missing'
  const source = { type: 'event', eventId, choiceId: 'a' } as const
  // A v4 save has neither event state nor club nights (v6), and clout is a number (v7).
  const v4Player = legacyPlayer()
  delete v4Player.clubNights
  const v4: Record<string, unknown> = { ...legacyBase(), player: v4Player }
  delete v4.events

  it('v4 -> v5 keeps the clock, player and speed, and starts event state fresh', () => {
    const progressed = {
      ...v4,
      clock: { minute: 4321, remainderMs: 12 },
      player: { ...v4Player, cash: 77, clout: 9 },
      speed: 2,
    }
    expect(migrateSave(progressed, 4, config)).toEqual({
      save: {
        ...progressed,
        player: {
          ...progressed.player,
          clout: legacyCloutState(9, 0),
          flex: initialFlexState,
          clubNights: {},
          visited: {},
          inventory: emptyInventory,
          apartment: initialApartment,
          location: { kind: 'home' },
          transit: { rngState: 0 },
        },
        events: initialEventsState(),
        ...S15_FIELDS,
      },
      outcome: 'carried',
    })
  })

  it('v4 -> v5 repairs fields as a load does, and starts an unusable v4 save fresh', () => {
    const damaged = {
      ...v4,
      clock: { minute: 60, remainderMs: -5 },
      player: { ...v4Player, stats: { energy: 400, hunger: 1, mood: 1 } },
      speed: 9,
    }
    const { save, outcome } = migrateSave(damaged, 4, config)
    expect(outcome).toBe('carried')
    expect(save).toMatchObject({ clock: { minute: 60, remainderMs: 0 }, speed: 1 })
    expect(save.player.stats.energy).toBe(100)
    expect(migrateSave({ ...damaged, admin: true }, 4, config).outcome).toBe('fresh')
    expect(migrateSave({ ...damaged, events: initialEventsState() }, 4, config).outcome).toBe(
      'fresh',
    )
    expect(migrateSave({ player: { cash: 1 } }, 4, config).outcome).toBe('fresh')
  })

  it('a save of every version so far (v1 to v10) loads, carrying its progress', () => {
    const player = v4Player
    const saves: Record<number, unknown> = {
      1: { player: { cash: 501 } },
      2: { clock: base.clock, player: { cash: 502, stats: player.stats }, speed: 1 },
      3: {
        clock: base.clock,
        player: { cash: 503, stats: player.stats, clout: 3, home: player.home, rent: player.rent },
        speed: 1,
      },
      4: { ...v4, player: { ...player, cash: 504 } },
      5: { ...legacyBase(), player: { ...player, cash: 505 } },
      6: { ...legacyBase(), player: { ...legacyPlayer(), cash: 506 } },
      7: { ...legacyBase(), player: { ...legacyV7Player(), cash: 507 } },
      // v8 (S15): no decor, apartment (S16), location or transit (S08), or action count (S18c).
      8: (() => {
        const v8: Record<string, unknown> = { ...initialSave(config) }
        delete v8.actions
        const p: Record<string, unknown> = { ...initialSave(config).player, cash: 508 }
        p.inventory = legacyInventory
        delete p.apartment
        delete p.location
        delete p.transit
        return { ...v8, player: p }
      })(),
      // v9 (S16): no location or transit (S08), or action count (S18c).
      9: (() => {
        const v9: Record<string, unknown> = { ...initialSave(config) }
        delete v9.actions
        const p: Record<string, unknown> = { ...initialSave(config).player, cash: 509 }
        delete p.location
        delete p.transit
        return { ...v9, player: p }
      })(),
      // v10 (S08): no action count (S18c).
      10: (() => {
        const v10: Record<string, unknown> = { ...initialSave(config) }
        delete v10.actions
        return { ...v10, player: { ...initialSave(config).player, cash: 510 } }
      })(),
    }
    for (const [version, persisted] of Object.entries(saves)) {
      const migrated = migrateSave(persisted, Number(version), config)
      expect(migrated.outcome, `v${version}`).toBe('carried')
      expect(migrated.save.player.cash, `v${version}`).toBe(500 + Number(version))
      expect(schema.safeParse(migrated.save).success, `v${version}`).toBe(true)
    }
    const v8 = { ...base, player: { ...base.player, cash: 508 } }
    const loaded = loadSave(JSON.parse(JSON.stringify(v8)), config)
    expect(loaded.ok && loaded.save.player.cash).toBe(508)
    expect(loaded.ok && loaded.repaired).toEqual([])
  })

  it('round-trips an open event, history, pending effects and the generator state', () => {
    const save = {
      ...base,
      events: {
        active: eventId,
        history: { [eventId]: 480 },
        pending: [
          { kind: 'item', itemId: 'tee', op: 'grant', source },
          { kind: 'item', itemId: 'cap', op: 'consume', source },
        ],
        rngState: 0xffffffff,
      },
    }
    expect(loadSave(JSON.parse(JSON.stringify(save)), config)).toEqual({
      ok: true,
      save,
      repaired: [],
    })
    expect(schema.safeParse(save).success).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['not an object', 'junk'],
    ['a fractional generator state', { ...initialEventsState(), rngState: 1.5 }],
    ['a generator state above uint32', { ...initialEventsState(), rngState: 2 ** 32 }],
    ['a negative history minute', { ...initialEventsState(), history: { [eventId]: -1 } }],
    ['an unknown pending effect', { ...initialEventsState(), pending: [{ kind: 'drink' }] }],
    [
      'more pending effects than allowed',
      {
        ...initialEventsState(),
        pending: Array.from({ length: config.events.maxPendingEffects + 1 }, () => ({
          kind: 'item',
          itemId: 'tee',
          op: 'grant',
          source,
        })),
      },
    ],
  ])('resets event state that is %s and keeps the rest', (_label, events) => {
    const result = loadSave({ ...base, player: { ...base.player, cash: 55 }, events }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.events).toEqual(initialEventsState())
    expect(result.save.player.cash).toBe(55)
    expect(result.repaired).toEqual(['events'])
  })

  it('drops prototype-named history keys from a save without polluting anything', () => {
    const history = JSON.parse(
      `{"__proto__": 5, "constructor": 3, "toString": 1, "${eventId}": 7}`,
    ) as Record<string, number>
    const result = loadSave({ ...base, events: { ...initialEventsState(), history } }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.events.history).toEqual({ [eventId]: 7 })
    expect(Object.keys(result.save.events.history)).toEqual([eventId])
    expect(Object.getPrototypeOf(result.save.events.history)).toBe(Object.prototype)
    expect(result.repaired).toEqual(['events.history'])
    expect(({} as Record<string, unknown>).constructor).toBe(Object)
  })

  it.each([
    ['an open event that is not a string', { ...initialEventsState(), active: 5 }],
    ['an extra key', { ...initialEventsState(), cheat: true }],
    [
      'a pending clout effect (since v7 event clout lands at once)',
      { ...initialEventsState(), pending: [{ kind: 'clout', amount: 1, source }] },
    ],
    [
      'a pending item effect with no source',
      { ...initialEventsState(), pending: [{ kind: 'item', itemId: 'tee', op: 'grant' }] },
    ],
    ['a negative generator state', { ...initialEventsState(), rngState: -1 }],
  ])('resets event state with %s, keeping clock, cash and stats', (_label, events) => {
    const progress = {
      ...base,
      clock: { minute: 9999, remainderMs: 0 },
      player: { ...base.player, cash: 42 },
    }
    const result = loadSave({ ...progress, events }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save).toEqual({ ...progress, events: initialEventsState() })
    expect(result.repaired).toEqual(['events'])
  })

  it('drops an open event and history for events no longer in the catalog', () => {
    const events = {
      ...initialEventsState(),
      active: 'retired-event',
      history: { 'retired-event': 10, [eventId]: 20 },
    }
    const result = loadSave({ ...base, events }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.events).toEqual({ ...events, active: null, history: { [eventId]: 20 } })
    expect(result.repaired).toEqual(['events.active', 'events.history'])
  })
})

describe('club nights in the save (v6)', () => {
  const base = initialSave(config)
  const clubId = Object.keys(config.place.clubs)[0] ?? 'missing'
  const v5Player = legacyPlayer()
  delete v5Player.clubNights
  const v5 = { ...legacyBase(), player: v5Player }

  it('a fresh save has no club nights', () => {
    expect(base.player.clubNights).toEqual({})
  })

  it('v5 -> v6 keeps everything and starts with no club nights', () => {
    const progressed = {
      ...v5,
      clock: { minute: 9000, remainderMs: 0 },
      player: { ...v5Player, cash: 88, clout: 120 },
    }
    expect(migrateSave(progressed, 5, config)).toEqual({
      save: {
        ...progressed,
        player: {
          ...progressed.player,
          clout: legacyCloutState(120, 1),
          flex: initialFlexState,
          clubNights: {},
          visited: {},
          inventory: emptyInventory,
          apartment: initialApartment,
          location: { kind: 'home' },
          transit: { rngState: 0 },
        },
        // 120 earned clout holds Local: the migration derives that goal at the save's minute.
        ...S15_FIELDS,
        goals: { ...initialGoalsState, achieved: { 'reach-local': 9000 } },
      },
      outcome: 'carried',
    })
    expect(migrateSave({ ...progressed, admin: true }, 5, config).outcome).toBe('fresh')
  })

  it('round-trips a club night', () => {
    const save = {
      ...base,
      clock: { minute: 5 * 1440, remainderMs: 0 },
      player: { ...base.player, clubNights: { [clubId]: 5 } },
    }
    const loaded = loadSave(JSON.parse(JSON.stringify(save)), config)
    expect(loaded).toEqual({ ok: true, save, repaired: [] })
    expect(schema.safeParse(save).success).toBe(true)
  })

  it.each([
    ['an unknown club', { 'no-such-club': 1 }],
    ['a future night', { [clubId]: 99 }],
    ['a negative night', { [clubId]: -1 }],
    ['a fractional night', { [clubId]: 1.5 }],
    ['a string night', { [clubId]: '1' }],
  ])('drops %s and keeps the rest of the save', (_label, clubNights) => {
    const result = loadSave({ ...base, player: { ...base.player, cash: 42, clubNights } }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.repaired).toEqual(['player.clubNights'])
    expect(result.save.player.clubNights).toEqual({})
    expect(result.save.player.cash).toBe(42)
  })

  it.each([null, [], 'x', undefined])('replaces club nights of %j with none', (clubNights) => {
    const result = loadSave({ ...base, player: { ...base.player, clubNights } }, config)
    expect(result.ok && result.save.player.clubNights).toEqual({})
    expect(result.ok && result.repaired).toEqual(['player.clubNights'])
  })

  it('a "__proto__" key from JSON is dropped without polluting anything', () => {
    const persisted = JSON.parse(
      JSON.stringify({ ...base, player: { ...base.player, clubNights: {} } }).replace(
        '"clubNights":{}',
        '"clubNights":{"__proto__":{"polluted":1}}',
      ),
    ) as unknown
    const result = loadSave(persisted, config)
    expect(result.ok && result.save.player.clubNights).toEqual({})
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('the action count (v11, S18c)', () => {
  it('a v10 save starts counting at 0', () => {
    const v10: Record<string, unknown> = { ...initialSave(config) }
    delete v10.actions
    const migrated = migrateSave(v10, 10, config)
    expect(migrated.outcome).toBe('carried')
    expect(migrated.save.actions).toBe(0)
  })

  it('a count that is not a whole number is repaired to 0', () => {
    for (const actions of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 2]) {
      const result = loadSave({ ...initialSave(config), actions }, config)
      if (!result.ok) throw new Error('not loaded')
      expect(result.save.actions, String(actions)).toBe(0)
      expect(result.repaired).toContain('actions')
    }
    const kept = loadSave({ ...initialSave(config), actions: 42 }, config)
    expect(kept.ok && kept.save.actions).toBe(42)
  })
})
