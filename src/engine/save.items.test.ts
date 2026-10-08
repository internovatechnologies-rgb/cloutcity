/** Save v4 (S10): `player.inventory`, its migration from v3 and its repair on load. */
import { describe, expect, it } from 'vitest'
import { legacyCloutState } from './clout'
import { engineConfig as config } from './config'
import { initialEventsState } from './events'
import { initialFlexState } from './game'
import { initialGoalsState } from './goals'
import { initialGrantsState } from './grants'
import { initialApartment } from './home'
import { emptyInventory, type Inventory } from './items'
import { initialPrestigeState } from './prestige'
import { SAVE_VERSION, createSaveSchema, initialSave, loadSave, migrateSave } from './save'

const schema = createSaveSchema(config)
const base = { ...initialSave(config), clock: { minute: 10_000, remainderMs: 0 } }
const withInventory = (inventory: unknown) => ({
  ...base,
  player: { ...base.player, inventory },
})

const valid: Inventory = {
  wearables: [
    { itemId: 'bodega-graphic-tee', acquiredMinute: 500, worn: true },
    { itemId: 'glitter-liner', acquiredMinute: 9000, worn: false },
  ],
  gifts: [{ itemId: 'bodega-flowers', count: 3 }],
  outfit: { top: 'bodega-graphic-tee' },
  decor: [],
}

describe('save v4 schema', () => {
  it('is version 11 (v4 inventory, v5 events, v6 club nights, v7 clout ledger, v8 goals, v9 apartment, v10 location, v11 actions) and a fresh save has an empty inventory', () => {
    expect(SAVE_VERSION).toBe(11)
    expect(initialSave(config).player.inventory).toEqual(emptyInventory)
    expect(schema.safeParse(initialSave(config)).success).toBe(true)
  })

  it('accepts and round-trips a valid inventory through JSON', () => {
    const save = withInventory(valid)
    const parsed = schema.safeParse(JSON.parse(JSON.stringify(save)))
    expect(parsed.success && parsed.data).toEqual(save)
    expect(loadSave(save, config)).toEqual({ ok: true, save, repaired: [] })
  })

  it.each([
    [
      'an unknown wearable',
      { ...valid, wearables: [{ itemId: 'x', acquiredMinute: 0, worn: true }] },
    ],
    [
      'a gift listed as a wearable',
      { ...valid, wearables: [{ itemId: 'bodega-flowers', acquiredMinute: 0, worn: true }] },
    ],
    ['a wearable listed as a gift', { ...valid, gifts: [{ itemId: 'cargo-pants', count: 1 }] }],
    ['a gift count of 0', { ...valid, gifts: [{ itemId: 'bodega-flowers', count: 0 }] }],
    [
      'a gift count above the stack limit',
      { ...valid, gifts: [{ itemId: 'bodega-flowers', count: config.items.maxGiftStack + 1 }] },
    ],
    ['a duplicate wearable', { ...valid, wearables: [valid.wearables[0], valid.wearables[0]] }],
    [
      'a duplicate gift stack',
      {
        ...valid,
        gifts: [
          { itemId: 'bodega-flowers', count: 1 },
          { itemId: 'bodega-flowers', count: 1 },
        ],
      },
    ],
    [
      'a wearable bought in the future',
      { ...valid, wearables: [{ itemId: 'cargo-pants', acquiredMinute: 10_001, worn: true }] },
    ],
    ['an outfit item not owned', { ...valid, outfit: { top: 'designer-puffer' } }],
    ['an outfit item in the wrong slot', { ...valid, outfit: { face: 'bodega-graphic-tee' } }],
    ['an unknown outfit slot', { ...valid, outfit: { hat: 'bodega-graphic-tee' } }],
    ['an extra inventory key', { ...valid, trades: [] }],
  ])('the schema rejects %s', (_label, inventory) => {
    expect(schema.safeParse(withInventory(inventory)).success).toBe(false)
  })
})

describe('save v3 -> v4', () => {
  const v3 = {
    clock: { minute: 9000, remainderMs: 12 },
    player: {
      cash: 420,
      stats: { energy: 50, hunger: 40, mood: 30 },
      clout: 7,
      home: 'brooklyn-1br',
      rent: { owed: 30, missed: 1 },
    },
    speed: 2,
  }

  it('keeps everything and starts with no items', () => {
    const migrated = migrateSave(v3, 3, config)
    expect(migrated).toEqual({
      outcome: 'carried',
      save: {
        ...v3,
        player: {
          ...v3.player,
          clout: legacyCloutState(7, 0),
          flex: initialFlexState,
          inventory: emptyInventory,
          clubNights: {},
          visited: {},
          apartment: initialApartment,
          location: { kind: 'home' },
          transit: { rngState: 0 },
        },
        events: initialEventsState(),
        goals: initialGoalsState,
        grants: initialGrantsState,
        prestige: initialPrestigeState,
        actions: 0,
      },
    })
    expect(schema.safeParse(migrated.save).success).toBe(true)
  })

  it('repairs out-of-range v3 fields on the way', () => {
    const damaged = { ...v3, player: { ...v3.player, home: 'penthouse' }, speed: 9 }
    const { save, outcome } = migrateSave(damaged, 3, config)
    expect(outcome).toBe('carried')
    expect(save.player.home).toBe(config.startHome)
    expect(save.speed).toBe(1)
  })

  it.each([
    ['a v3 save that already has an inventory', withInventory(emptyInventory)],
    ['negative cash', { ...v3, player: { ...v3.player, cash: -1 } }],
    ['a missing rent object', { ...v3, player: { ...v3.player, rent: undefined } }],
    ['junk', 'junk'],
  ])('starts %s fresh', (_label, persisted) => {
    expect(migrateSave(persisted, 3, config)).toEqual({
      save: initialSave(config),
      outcome: 'fresh',
    })
  })

  it('v1 and v2 saves still migrate, with an empty inventory', () => {
    const v1 = migrateSave({ player: { cash: 77 } }, 1, config)
    expect(v1.outcome).toBe('carried')
    expect(v1.save.player).toMatchObject({ cash: 77, inventory: emptyInventory })
    const v2 = migrateSave(
      { clock: v3.clock, player: { cash: 5, stats: v3.player.stats }, speed: 1 },
      2,
      config,
    )
    expect(v2.outcome).toBe('carried')
    expect(v2.save.player.inventory).toEqual(emptyInventory)
    expect(schema.safeParse(v2.save).success).toBe(true)
  })

  it('a v4 save without an inventory is structurally unusable', () => {
    // As stored: JSON drops the key entirely.
    const player: Record<string, unknown> = { ...base.player }
    delete player.inventory
    expect(loadSave(JSON.parse(JSON.stringify({ ...base, player })), config).ok).toBe(false)
  })
})

describe('loading repairs the inventory and keeps the rest', () => {
  const repair = (inventory: unknown) => {
    const result = loadSave(withInventory(inventory), config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.repaired).toEqual(['player.inventory'])
    expect(result.save.player.cash).toBe(base.player.cash)
    expect(schema.safeParse(result.save).success).toBe(true)
    return result.save.player.inventory
  }

  it.each([null, 'junk', 42, [], { wearables: 'x', gifts: 7, outfit: [] }])(
    'an inventory of %j becomes empty',
    (inventory) => {
      expect(repair(inventory)).toEqual(emptyInventory)
    },
  )

  it('drops unknown, misfiled and duplicate items', () => {
    const inventory = repair({
      wearables: [
        { itemId: 'cargo-pants', acquiredMinute: 1, worn: false },
        { itemId: 'cargo-pants', acquiredMinute: 2, worn: true },
        { itemId: '__proto__', acquiredMinute: 1, worn: true },
        { itemId: 'bodega-flowers', acquiredMinute: 1, worn: true },
        'junk',
      ],
      gifts: [
        { itemId: 'bodega-flowers', count: 2 },
        { itemId: 'bodega-flowers', count: 5 },
        { itemId: 'cargo-pants', count: 1 },
        { itemId: 'constructor', count: 1 },
      ],
      outfit: {},
    })
    expect(inventory).toEqual({
      wearables: [{ itemId: 'cargo-pants', acquiredMinute: 1, worn: false }],
      gifts: [{ itemId: 'bodega-flowers', count: 2 }],
      outfit: {},
      decor: [],
    })
  })

  it('clamps purchase minutes and gift counts, and treats an unknown worn flag as worn', () => {
    const inventory = repair({
      wearables: [
        { itemId: 'cargo-pants', acquiredMinute: 99_999, worn: 'yes' },
        { itemId: 'gold-hoops', acquiredMinute: -5, worn: false },
        { itemId: 'glitter-liner', acquiredMinute: 'soon', worn: true },
        { itemId: 'subway-tote', acquiredMinute: 12.6, worn: true },
      ],
      gifts: [
        { itemId: 'bodega-flowers', count: 999 },
        { itemId: 'cheesecake-box', count: 1.6 },
        { itemId: 'courtside-tickets', count: 0.2 },
      ],
      outfit: {},
    })
    expect(inventory.wearables).toEqual([
      { itemId: 'cargo-pants', acquiredMinute: 10_000, worn: true },
      { itemId: 'gold-hoops', acquiredMinute: 0, worn: false },
      { itemId: 'glitter-liner', acquiredMinute: 10_000, worn: true },
      { itemId: 'subway-tote', acquiredMinute: 13, worn: true },
    ])
    expect(inventory.gifts).toEqual([
      { itemId: 'bodega-flowers', count: config.items.maxGiftStack },
      { itemId: 'cheesecake-box', count: 2 },
    ])
  })

  it('empties outfit slots that hold an item not owned or for another slot', () => {
    const inventory = repair({
      ...valid,
      outfit: {
        top: 'bodega-graphic-tee',
        face: 'bodega-graphic-tee',
        shoes: 'limited-drop-sneakers',
        bottom: 42,
        hat: 'glitter-liner',
      },
    })
    expect(inventory.outfit).toEqual({ top: 'bodega-graphic-tee' })
  })

  it('a tampered __proto__ outfit key does not pollute the result', () => {
    const persisted = JSON.parse(
      JSON.stringify(withInventory(valid)).replace(
        '"outfit":{"top":"bodega-graphic-tee"}',
        '"outfit":{"__proto__":{"top":"designer-puffer"}}',
      ),
    ) as unknown
    const result = loadSave(persisted, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.player.inventory.outfit).toEqual({})
    expect(Object.getPrototypeOf(result.save.player.inventory.outfit)).toBe(Object.prototype)
  })
})

describe('tampered v4 inventories', () => {
  const load = (inventory: unknown, minute = base.clock.minute) => {
    const result = loadSave(
      { ...withInventory(inventory), clock: { minute, remainderMs: 0 } },
      config,
    )
    if (!result.ok) throw new Error('expected a repaired save')
    expect(schema.safeParse(result.save).success).toBe(true)
    return result
  }

  it('an outfit slot naming a gift or an unowned wearable is emptied', () => {
    const { save, repaired } = load({
      ...valid,
      outfit: { top: 'bodega-flowers', face: 'editorial-glam-kit', bottom: 'cheesecake-box' },
    })
    expect(repaired).toEqual(['player.inventory'])
    expect(save.player.inventory.outfit).toEqual({})
    expect(save.player.inventory.wearables).toEqual(valid.wearables)
  })

  it('constructor and toString outfit keys are dropped without touching the prototype', () => {
    const persisted = JSON.parse(
      JSON.stringify(withInventory(valid)).replace(
        '"outfit":{"top":"bodega-graphic-tee"}',
        '"outfit":{"top":"bodega-graphic-tee","constructor":"designer-puffer","toString":"x"}',
      ),
    ) as unknown
    const result = loadSave(persisted, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.player.inventory.outfit).toEqual({ top: 'bodega-graphic-tee' })
    expect(Object.keys(result.save.player.inventory.outfit)).toEqual(['top'])
  })

  it('__proto__ and constructor item ids from JSON are dropped', () => {
    const persisted = JSON.parse(
      JSON.stringify(
        withInventory({
          wearables: [{ itemId: 'constructor', acquiredMinute: 1, worn: true }],
          gifts: [
            { itemId: '__proto__', count: 1 },
            { itemId: 'hasOwnProperty', count: 1 },
          ],
          outfit: {},
        }),
      ),
    ) as unknown
    const result = loadSave(persisted, config)
    if (!result.ok) throw new Error('expected a repaired save')
    expect(result.save.player.inventory).toEqual(emptyInventory)
  })

  it('non-finite and huge minutes and counts are repaired, never kept', () => {
    const { save } = load({
      wearables: [
        { itemId: 'cargo-pants', acquiredMinute: Number.NaN, worn: true },
        { itemId: 'gold-hoops', acquiredMinute: Number.POSITIVE_INFINITY, worn: true },
        { itemId: 'glitter-liner', acquiredMinute: 1e308, worn: true },
        { itemId: 'subway-tote', acquiredMinute: Number.NEGATIVE_INFINITY, worn: true },
      ],
      gifts: [
        { itemId: 'bodega-flowers', count: Number.NaN },
        { itemId: 'cheesecake-box', count: 1e308 },
        { itemId: 'courtside-tickets', count: Number.POSITIVE_INFINITY },
      ],
      outfit: {},
    })
    const now = base.clock.minute
    expect(save.player.inventory.wearables.map((owned) => owned.acquiredMinute)).toEqual([
      now,
      now,
      now,
      now,
    ])
    expect(save.player.inventory.gifts).toEqual([
      { itemId: 'cheesecake-box', count: config.items.maxGiftStack },
    ])
  })

  it('a clock rolled back below a purchase clamps the purchase to now', () => {
    const { save } = load(valid, 600)
    expect(save.player.inventory.wearables).toEqual([
      { itemId: 'bodega-graphic-tee', acquiredMinute: 500, worn: true },
      { itemId: 'glitter-liner', acquiredMinute: 600, worn: false },
    ])
    expect(save.player.inventory.outfit).toEqual(valid.outfit)
  })

  it('negative and fractional gift counts below one drop the stack', () => {
    const { save } = load({
      ...valid,
      gifts: [
        { itemId: 'bodega-flowers', count: -3 },
        { itemId: 'cheesecake-box', count: 0 },
        { itemId: 'courtside-tickets', count: 0.49 },
      ],
    })
    expect(save.player.inventory.gifts).toEqual([])
  })

  it('a save from a newer build throws and is never migrated', () => {
    expect(() => migrateSave(withInventory(valid), SAVE_VERSION + 1, config)).toThrow(/newer/)
  })
})
