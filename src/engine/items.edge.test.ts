/**
 * Edge cases for S10 items: money boundaries, depreciation at each day boundary, stat effects
 * once per owned copy, gift stacks and gift targets that must never name a player.
 */
import { describe, expect, it } from 'vitest'
import { engineConfig as config } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import {
  buyItem,
  consumeGift,
  equipItem,
  findItem,
  giftCount,
  isGift,
  isWearable,
  parseGiftTarget,
  resaleValue,
  sellItem,
  shopItems,
  toNpcId,
  unequipSlot,
  type GiftTarget,
  type ItemDef,
  type WearableDef,
} from './items'

const DAY = config.time.gameDayHours * 60
const start = initialSnapshot(config)

function withCash(cash: number, snapshot: GameSnapshot = start): GameSnapshot {
  return { ...snapshot, player: { ...snapshot.player, cash } }
}

function at(minute: number, snapshot: GameSnapshot): GameSnapshot {
  return { ...snapshot, clock: { ...snapshot.clock, minute } }
}

function withMood(mood: number, snapshot: GameSnapshot): GameSnapshot {
  return {
    ...snapshot,
    player: { ...snapshot.player, stats: { ...snapshot.player.stats, mood } },
  }
}

function item(id: string): ItemDef {
  const found = findItem(id, config)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

const wearables = shopItems(config).filter(isWearable)
const gifts = shopItems(config).filter(isGift)
const tee = item('bodega-graphic-tee') as WearableDef
const flowers = item('bodega-flowers')
const cheesecake = item('cheesecake-box')

describe('money boundaries for every shop item', () => {
  it.each(shopItems(config).map((entry) => [entry.id, entry] as const))(
    '%s: exact cash buys to $0; $1 short is refused and nothing changes',
    (_id, entry) => {
      const bought = ok(buyItem(withCash(entry.price), entry.id, config))
      expect(bought.snapshot.player.cash).toBe(0)
      expect(bought.price).toBe(entry.price)

      const short = withCash(entry.price - 1)
      const refused = buyItem(short, entry.id, config)
      expect(refused).toEqual({
        ok: false,
        error: { code: 'INSUFFICIENT_FUNDS', required: entry.price, available: entry.price - 1 },
      })
      expect(short.player.inventory).toEqual(start.player.inventory)
    },
  )

  it('a full gift stack is refused without charging', () => {
    let snapshot = withCash(flowers.price * (config.items.maxGiftStack + 1))
    for (let i = 0; i < config.items.maxGiftStack; i += 1) {
      snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    }
    const cash = snapshot.player.cash
    const refused = buyItem(snapshot, flowers.id, config)
    expect(refused).toEqual({
      ok: false,
      error: { code: 'STACK_FULL', itemId: flowers.id, max: config.items.maxGiftStack },
    })
    expect(snapshot.player.cash).toBe(cash)
    expect(cash).toBe(flowers.price)
  })
})

describe('depreciation at whole-day boundaries', () => {
  const bought = ok(buyItem(at(1000, withCash(10_000)), tee.id, config)).snapshot
  const sellAt = (minute: number) => ok(sellItem(at(minute, bought), tee.id, config)).amount

  it('a wearable steps down exactly at each whole day owned, then floors at minResalePct', () => {
    const { depreciationPctPerGameDay: step, minResalePct } = config.items
    for (let day = 1; day <= 30; day += 1) {
      const before = Math.floor(
        (tee.sellValue * Math.max(minResalePct, 100 - step * (day - 1))) / 100,
      )
      const after = Math.floor((tee.sellValue * Math.max(minResalePct, 100 - step * day)) / 100)
      expect(sellAt(1000 + day * DAY - 1)).toBe(before)
      expect(sellAt(1000 + day * DAY)).toBe(after)
    }
    const floor = Math.floor((tee.sellValue * minResalePct) / 100)
    expect(sellAt(1000 + 10_000 * DAY)).toBe(floor)
  })

  it.each(wearables.map((entry) => [entry.id, entry] as const))(
    '%s never resells for less than minResalePct of sellValue or more than sellValue',
    (_id, entry) => {
      const floor = Math.floor((entry.sellValue * config.items.minResalePct) / 100)
      for (const days of [0, 1, 5, 9, 10, 11, 365]) {
        const value = resaleValue(entry, 0, days * DAY, config)
        expect(value).toBeGreaterThanOrEqual(floor)
        expect(value).toBeLessThanOrEqual(entry.sellValue)
      }
    },
  )

  it('a purchase minute after now (clock rolled back) sells for the day-0 value, not more', () => {
    expect(resaleValue(tee, 5000, 1000, config)).toBe(tee.sellValue)
  })

  it('gifts do not depreciate', () => {
    let snapshot = ok(buyItem(withCash(1000), flowers.id, config)).snapshot
    snapshot = at(start.clock.minute + 400 * DAY, snapshot)
    expect(ok(sellItem(snapshot, flowers.id, config)).amount).toBe(flowers.sellValue)
  })
})

describe('stat effects: once per owned copy', () => {
  it('equip, unequip, equip again gives nothing extra', () => {
    let snapshot = withMood(10, ok(buyItem(withCash(1000), tee.id, config)).snapshot)
    snapshot = ok(equipItem(snapshot, tee.id, tee.slot, config)).snapshot
    const mood = snapshot.player.stats.mood
    expect(mood).toBe(10 + (tee.statEffects.mood ?? 0))
    for (let i = 0; i < 3; i += 1) {
      snapshot = ok(unequipSlot(snapshot, tee.slot)).snapshot
      expect(snapshot.player.inventory.outfit[tee.slot]).toBeUndefined()
      snapshot = ok(equipItem(snapshot, tee.id, tee.slot, config)).snapshot
    }
    expect(snapshot.player.stats.mood).toBe(mood)
  })

  it('re-equipping the item already worn gives nothing extra', () => {
    let snapshot = withMood(10, ok(buyItem(withCash(1000), tee.id, config)).snapshot)
    snapshot = ok(equipItem(snapshot, tee.id, tee.slot, config)).snapshot
    const again = ok(equipItem(snapshot, tee.id, tee.slot, config)).snapshot
    expect(again.player.stats).toEqual(snapshot.player.stats)
  })

  it('swapping between two owned items in a slot grants each effect only once', () => {
    const jacket = item('thrifted-denim-jacket') as WearableDef
    let snapshot = withMood(0, withCash(1000))
    snapshot = ok(buyItem(snapshot, tee.id, config)).snapshot
    snapshot = ok(buyItem(snapshot, jacket.id, config)).snapshot
    for (let i = 0; i < 3; i += 1) {
      snapshot = ok(equipItem(snapshot, tee.id, 'top', config)).snapshot
      snapshot = ok(equipItem(snapshot, jacket.id, 'top', config)).snapshot
    }
    expect(snapshot.player.stats.mood).toBe(
      (tee.statEffects.mood ?? 0) + (jacket.statEffects.mood ?? 0),
    )
    expect(snapshot.player.inventory.outfit).toEqual({ top: jacket.id })
  })

  it('mood already at max is clamped, and the effect is still spent', () => {
    let snapshot = withMood(config.stats.max, ok(buyItem(withCash(1000), tee.id, config)).snapshot)
    snapshot = ok(equipItem(snapshot, tee.id, tee.slot, config)).snapshot
    expect(snapshot.player.stats.mood).toBe(config.stats.max)
    snapshot = ok(unequipSlot(withMood(0, snapshot), tee.slot)).snapshot
    snapshot = ok(equipItem(snapshot, tee.id, tee.slot, config)).snapshot
    expect(snapshot.player.stats.mood).toBe(0)
  })

  it.each(wearables.map((entry) => [entry.id, entry] as const))(
    '%s: sell and re-buy grants the effect again, only at a net cash loss',
    (_id, entry) => {
      let snapshot = withMood(0, withCash(10_000))
      snapshot = ok(buyItem(snapshot, entry.id, config)).snapshot
      snapshot = ok(equipItem(snapshot, entry.id, entry.slot, config)).snapshot
      snapshot = ok(sellItem(snapshot, entry.id, config)).snapshot
      expect(snapshot.player.inventory.outfit[entry.slot]).toBeUndefined()
      snapshot = ok(buyItem(snapshot, entry.id, config)).snapshot
      snapshot = ok(equipItem(snapshot, entry.id, entry.slot, config)).snapshot
      expect(snapshot.player.stats.mood).toBe(2 * (entry.statEffects.mood ?? 0))
      expect(snapshot.player.cash).toBe(10_000 - 2 * entry.price + entry.sellValue)
      expect(snapshot.player.cash).toBeLessThan(10_000 - entry.price)
    },
  )

  it('equip in a wrong or junk slot is refused and changes nothing', () => {
    const snapshot = ok(buyItem(withCash(1000), tee.id, config)).snapshot
    for (const slot of ['bottom', 'face', '__proto__', 'constructor', '', 'TOP']) {
      const result = equipItem(snapshot, tee.id, slot, config)
      expect(result).toEqual({
        ok: false,
        error: { code: 'WRONG_SLOT', itemId: tee.id, slot, itemSlot: 'top' },
      })
    }
    for (const slot of ['__proto__', 'constructor', 'hat']) {
      expect(unequipSlot(snapshot, slot)).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_SLOT', slot },
      })
    }
  })
})

describe('gift stacks', () => {
  const npc = toNpcId('npc-promoter')
  if (npc === null) throw new Error('npc id')

  it('using a gift decrements its stack and drops it at zero, leaving other stacks alone', () => {
    let snapshot = withMood(0, withCash(1000))
    snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    snapshot = ok(buyItem(snapshot, cheesecake.id, config)).snapshot
    snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    expect(snapshot.player.inventory.gifts).toEqual([
      { itemId: flowers.id, count: 2 },
      { itemId: cheesecake.id, count: 1 },
    ])
    snapshot = ok(consumeGift(snapshot, flowers.id, 'yourself', config)).snapshot
    expect(snapshot.player.inventory.gifts).toEqual([
      { itemId: flowers.id, count: 1 },
      { itemId: cheesecake.id, count: 1 },
    ])
    expect(snapshot.player.stats.mood).toBe(flowers.statEffects.mood)
    snapshot = ok(consumeGift(snapshot, flowers.id, { npcId: npc }, config)).snapshot
    expect(snapshot.player.inventory.gifts).toEqual([{ itemId: cheesecake.id, count: 1 }])
    expect(snapshot.player.stats.mood).toBe(flowers.statEffects.mood)
  })

  it('a gift used on an NPC reports the gift and target and changes no player stat or cash', () => {
    const snapshot = withMood(0, ok(buyItem(withCash(1000), cheesecake.id, config)).snapshot)
    const used = ok(consumeGift(snapshot, cheesecake.id, { npcId: npc }, config))
    expect(used.gift).toEqual({ itemId: cheesecake.id, target: { npcId: 'npc-promoter' } })
    expect(used.snapshot.player.stats).toEqual(snapshot.player.stats)
    expect(used.snapshot.player.cash).toBe(snapshot.player.cash)
    expect(used.snapshot.clock).toEqual(snapshot.clock)
  })

  it('every gift used on yourself clamps at stats.max', () => {
    for (const gift of gifts) {
      let snapshot = ok(buyItem(withCash(1000), gift.id, config)).snapshot
      snapshot = {
        ...snapshot,
        player: {
          ...snapshot.player,
          stats: { energy: config.stats.max, hunger: config.stats.max, mood: config.stats.max },
        },
      }
      const used = ok(consumeGift(snapshot, gift.id, 'yourself', config))
      expect(used.snapshot.player.stats).toEqual(snapshot.player.stats)
      expect(giftCount(used.snapshot.player.inventory, gift.id)).toBe(0)
    }
  })
})

describe('gift targets can never name a player', () => {
  const malicious = Object.create(null) as Record<string, unknown>
  malicious.npcId = 'npc-cat'
  malicious.userId = 'u-1'

  it.each([
    ['userId', { userId: 'u-1' }],
    ['playerId alongside npcId', { npcId: 'npc-cat', playerId: 'u-1' }],
    ['handle alongside npcId', { npcId: 'npc-cat', handle: 'someone' }],
    ['a null-prototype object with a userId', malicious],
    ['npcId __proto__', JSON.parse('{"npcId":"__proto__"}') as unknown],
    ['npcId npc-__proto__', { npcId: 'npc-__proto__' }],
    ['npcId constructor', { npcId: 'constructor' }],
    ['npcId with a trailing newline', { npcId: 'npc-cat\n' }],
    ['npcId with a leading space', { npcId: ' npc-cat' }],
    ['npcId a number', { npcId: 42 }],
    ['npcId nested', { npcId: { npcId: 'npc-cat' } }],
    ['the string npc-cat', 'npc-cat'],
    ['Yourself capitalised', 'Yourself'],
    ['yourself with spaces', ' yourself '],
    ['an empty object', {}],
    ['undefined', undefined],
    ['a boxed string', new String('yourself')],
  ])('%s is refused', (_label, target) => {
    expect(parseGiftTarget(target)).toBeNull()
    const snapshot = ok(buyItem(withCash(1000), flowers.id, config)).snapshot
    expect(consumeGift(snapshot, flowers.id, target as GiftTarget, config)).toEqual({
      ok: false,
      error: { code: 'INVALID_TARGET' },
    })
  })

  it('a null-prototype { npcId } with a valid id is accepted as an NPC', () => {
    const target = Object.create(null) as Record<string, unknown>
    target.npcId = 'npc-cat'
    expect(parseGiftTarget(target)).toEqual({ npcId: 'npc-cat' })
  })

  it('type level: no player-shaped target compiles', () => {
    const npc = toNpcId('npc-cat')
    if (npc === null) throw new Error('npc id')
    // @ts-expect-error userId is not a GiftTarget
    const byUser: GiftTarget = { userId: 'u-1' }
    // @ts-expect-error an npc target cannot also carry a player id
    const both: GiftTarget = { npcId: npc, playerId: 'u-1' }
    // @ts-expect-error a plain string is not an NpcId
    const plain: GiftTarget = { npcId: 'npc-cat' as string }
    const fine: GiftTarget[] = ['yourself', { npcId: npc }]
    expect([byUser, both, plain, ...fine]).toHaveLength(5)
  })
})
