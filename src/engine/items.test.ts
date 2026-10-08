import { describe, expect, it } from 'vitest'
import { cloutSums, totalClout } from './clout'
import { engineConfig as config } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import {
  ITEM_SLOTS,
  buyItem,
  consumeGift,
  daysOwned,
  emptyInventory,
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
} from './items'

const DAY = config.time.gameDayHours * 60
const start = initialSnapshot(config)

function withCash(cash: number, snapshot: GameSnapshot = start): GameSnapshot {
  return { ...snapshot, player: { ...snapshot.player, cash } }
}

function at(minute: number, snapshot: GameSnapshot): GameSnapshot {
  return { ...snapshot, clock: { ...snapshot.clock, minute } }
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

const tee = item('bodega-graphic-tee')
const puffer = item('designer-puffer')
const flowers = item('bodega-flowers')
const npc = toNpcId('npc-bodega-cat')
if (npc === null) throw new Error('npc id')

describe('buying', () => {
  it('buys with exactly enough cash, leaving $0', () => {
    const result = ok(buyItem(withCash(tee.price), tee.id, config))
    expect(result.price).toBe(tee.price)
    expect(result.snapshot.player.cash).toBe(0)
    expect(result.snapshot.player.inventory.wearables).toEqual([
      { itemId: tee.id, acquiredMinute: start.clock.minute, worn: false },
    ])
  })

  it('refuses a buy $1 short with INSUFFICIENT_FUNDS and changes nothing', () => {
    const before = withCash(tee.price - 1)
    expect(buyItem(before, tee.id, config)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: tee.price, available: tee.price - 1 },
    })
    expect(before.player.inventory).toBe(emptyInventory)
  })

  it('refuses a second copy of a wearable', () => {
    const owned = ok(buyItem(withCash(1000), tee.id, config)).snapshot
    expect(buyItem(owned, tee.id, config)).toEqual({
      ok: false,
      error: { code: 'ALREADY_OWNED', itemId: tee.id },
    })
  })

  it('stacks gifts up to maxGiftStack, then STACK_FULL', () => {
    let snapshot = withCash(100_000)
    for (let i = 0; i < config.items.maxGiftStack; i++) {
      snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    }
    expect(giftCount(snapshot.player.inventory, flowers.id)).toBe(config.items.maxGiftStack)
    expect(buyItem(snapshot, flowers.id, config)).toEqual({
      ok: false,
      error: { code: 'STACK_FULL', itemId: flowers.id, max: config.items.maxGiftStack },
    })
  })

  it.each(['nope', '__proto__', 'constructor', ''])('refuses unknown item %j', (id) => {
    expect(buyItem(withCash(1000), id, config)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_ITEM', itemId: id },
    })
  })

  it('refuses a catalog item the shop does not sell (apartment upgrades)', () => {
    const upgrade: ItemDef = { ...tee, id: 'skylight', category: 'upgrade' } as ItemDef
    const withUpgrade = { ...config, items: { ...config.items, catalog: [upgrade] } }
    expect(buyItem(withCash(1000), 'skylight', withUpgrade)).toEqual({
      ok: false,
      error: { code: 'NOT_FOR_SALE', itemId: 'skylight' },
    })
    expect(shopItems(withUpgrade)).toEqual([])
  })

  it('never touches the clock or stats; clout counts the owned item, audited in the ledger', () => {
    const { snapshot } = ok(buyItem(withCash(1000), puffer.id, config))
    expect(snapshot.clock).toBe(start.clock)
    expect(snapshot.player.stats).toEqual(start.player.stats)
    expect(totalClout(snapshot.player, config)).toBe(puffer.cloutValue)
    expect(cloutSums(snapshot.player.clout).earned).toBe(0)
    expect(snapshot.player.clout.ledger).toEqual([
      {
        seq: 1,
        at: start.clock.minute,
        amount: puffer.cloutValue,
        currency: 'cash',
        source: 'item',
        ref: { itemId: puffer.id, op: 'buy' },
      },
    ])
  })
})

describe('selling and depreciation', () => {
  it('sells a wearable on the day it was bought for its sellValue', () => {
    const owned = ok(buyItem(withCash(puffer.price), puffer.id, config)).snapshot
    const sold = ok(sellItem(owned, puffer.id, config))
    expect(sold.amount).toBe(puffer.sellValue)
    expect(sold.snapshot.player.cash).toBe(puffer.sellValue)
    expect(sold.snapshot.player.inventory.wearables).toEqual([])
  })

  it('loses depreciationPctPerGameDay of sellValue per whole game day, down to minResalePct', () => {
    const { depreciationPctPerGameDay: perDay, minResalePct } = config.items
    const bought = start.clock.minute
    for (const days of [0, 1, 2, 5, 9, 10, 11, 30, 365]) {
      const pct = Math.max(minResalePct, 100 - perDay * days)
      expect(resaleValue(puffer, bought, bought + days * DAY, config), `day ${days}`).toBe(
        Math.floor((puffer.sellValue * pct) / 100),
      )
    }
    // Concretely, with the shipped config (5 %/day, floor 50 %): $192 → $182 → $96.
    expect(resaleValue(puffer, bought, bought + DAY, config)).toBe(182)
    expect(resaleValue(puffer, bought, bought + 100 * DAY, config)).toBe(96)
  })

  it('counts only whole game days owned', () => {
    expect(daysOwned(100, 100 + DAY - 1, config)).toBe(0)
    expect(daysOwned(100, 100 + DAY, config)).toBe(1)
    expect(daysOwned(500, 100, config)).toBe(0)
  })

  it('a gift sells for its flat sellValue, one at a time', () => {
    let snapshot = withCash(flowers.price * 2)
    snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    const sold = ok(sellItem(at(snapshot.clock.minute + 50 * DAY, snapshot), flowers.id, config))
    expect(sold.amount).toBe(flowers.sellValue)
    expect(giftCount(sold.snapshot.player.inventory, flowers.id)).toBe(1)
  })

  it('refuses to sell what is not owned', () => {
    expect(sellItem(start, tee.id, config)).toEqual({
      ok: false,
      error: { code: 'NOT_OWNED', itemId: tee.id },
    })
    expect(sellItem(start, flowers.id, config)).toEqual({
      ok: false,
      error: { code: 'NOT_OWNED', itemId: flowers.id },
    })
    expect(sellItem(start, 'nope', config).ok).toBe(false)
  })

  it('selling a worn item takes it off', () => {
    let snapshot = ok(buyItem(withCash(tee.price), tee.id, config)).snapshot
    snapshot = ok(equipItem(snapshot, tee.id, 'top', config)).snapshot
    const { snapshot: sold } = ok(sellItem(snapshot, tee.id, config))
    expect(sold.player.inventory.outfit).toEqual({})
  })

  it('no buy/sell loop on any shop item, at any age, gains cash or clout', () => {
    for (const shopItem of shopItems(config)) {
      for (const days of [0, 1, 7, 100]) {
        let snapshot = withCash(shopItem.price)
        snapshot = ok(buyItem(snapshot, shopItem.id, config)).snapshot
        snapshot = at(snapshot.clock.minute + days * DAY, snapshot)
        snapshot = ok(sellItem(snapshot, shopItem.id, config)).snapshot
        expect(snapshot.player.cash, `${shopItem.id} day ${days}`).toBeLessThan(shopItem.price)
        expect(totalClout(snapshot.player, config)).toBe(0)
      }
    }
  })
})

describe('outfit', () => {
  const owning = (...ids: string[]) =>
    ids.reduce((snapshot, id) => ok(buyItem(snapshot, id, config)).snapshot, withCash(10_000))

  it('wears an owned item in its slot and applies its stat effects once per copy', () => {
    const snapshot = owning(tee.id)
    const first = ok(equipItem(snapshot, tee.id, 'top', config)).snapshot
    expect(first.player.inventory.outfit).toEqual({ top: tee.id })
    expect(first.player.stats.mood).toBe(start.player.stats.mood + (tee.statEffects.mood ?? 0))
    const off = ok(unequipSlot(first, 'top')).snapshot
    expect(off.player.inventory.outfit).toEqual({})
    const again = ok(equipItem(off, tee.id, 'top', config)).snapshot
    expect(again.player.stats).toEqual(first.player.stats)
  })

  it('replaces what is in the slot', () => {
    const snapshot = owning(tee.id, puffer.id)
    const teeOn = ok(equipItem(snapshot, tee.id, 'top', config)).snapshot
    const pufferOn = ok(equipItem(teeOn, puffer.id, 'top', config)).snapshot
    expect(pufferOn.player.inventory.outfit).toEqual({ top: puffer.id })
  })

  it('fills all five slots at once', () => {
    const picks = ITEM_SLOTS.map((slot) => {
      const pick = shopItems(config).find((entry) => isWearable(entry) && entry.slot === slot)
      if (pick === undefined) throw new Error(`no item for ${slot}`)
      return pick
    })
    let snapshot = owning(...picks.map((pick) => pick.id))
    for (const [index, slot] of ITEM_SLOTS.entries()) {
      snapshot = ok(equipItem(snapshot, picks[index]?.id ?? '', slot, config)).snapshot
    }
    expect(Object.keys(snapshot.player.inventory.outfit).sort()).toEqual([...ITEM_SLOTS].sort())
  })

  it('refuses the wrong slot, a gift, an unknown item and an item not owned', () => {
    const snapshot = owning(tee.id, flowers.id)
    expect(equipItem(snapshot, tee.id, 'shoes', config)).toEqual({
      ok: false,
      error: { code: 'WRONG_SLOT', itemId: tee.id, slot: 'shoes', itemSlot: 'top' },
    })
    expect(equipItem(snapshot, tee.id, 'hat', config).ok).toBe(false)
    expect(equipItem(snapshot, flowers.id, 'top', config)).toEqual({
      ok: false,
      error: { code: 'NOT_WEARABLE', itemId: flowers.id },
    })
    expect(equipItem(snapshot, 'nope', 'top', config)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_ITEM', itemId: 'nope' },
    })
    expect(equipItem(snapshot, puffer.id, 'top', config)).toEqual({
      ok: false,
      error: { code: 'NOT_OWNED', itemId: puffer.id },
    })
  })

  it('unequipping an empty slot is a no-op; an unknown slot is refused', () => {
    expect(ok(unequipSlot(start, 'face')).snapshot).toBe(start)
    expect(unequipSlot(start, '__proto__')).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_SLOT', slot: '__proto__' },
    })
  })
})

describe('gifts', () => {
  const holding = (count: number) => {
    let snapshot = withCash(flowers.price * count)
    for (let i = 0; i < count; i++) snapshot = ok(buyItem(snapshot, flowers.id, config)).snapshot
    return snapshot
  }

  it('used on yourself: consumed, and its stat effects land', () => {
    const result = ok(consumeGift(holding(2), flowers.id, 'yourself', config))
    expect(result.gift).toEqual({ itemId: flowers.id, target: 'yourself' })
    expect(giftCount(result.snapshot.player.inventory, flowers.id)).toBe(1)
    expect(result.snapshot.player.stats.mood).toBe(
      Math.min(config.stats.max, start.player.stats.mood + (flowers.statEffects.mood ?? 0)),
    )
  })

  it('used on an NPC: consumed, no stat change for the player, NPC reported back', () => {
    const before = holding(1)
    const result = ok(consumeGift(before, flowers.id, { npcId: npc }, config))
    expect(result.gift).toEqual({ itemId: flowers.id, target: { npcId: 'npc-bodega-cat' } })
    expect(result.snapshot.player.inventory.gifts).toEqual([])
    expect(result.snapshot.player.stats).toEqual(before.player.stats)
    expect(result.snapshot.player.cash).toBe(before.player.cash)
  })

  it('the last gift is gone after use: a second use is NOT_OWNED', () => {
    const used = ok(consumeGift(holding(1), flowers.id, 'yourself', config)).snapshot
    expect(consumeGift(used, flowers.id, 'yourself', config)).toEqual({
      ok: false,
      error: { code: 'NOT_OWNED', itemId: flowers.id },
    })
  })

  it('refuses a wearable or an unknown item', () => {
    const snapshot = ok(buyItem(withCash(100), tee.id, config)).snapshot
    expect(consumeGift(snapshot, tee.id, 'yourself', config)).toEqual({
      ok: false,
      error: { code: 'NOT_A_GIFT', itemId: tee.id },
    })
    expect(consumeGift(snapshot, 'nope', 'yourself', config).ok).toBe(false)
  })

  it('every gift in the data is consumable on yourself and on an NPC', () => {
    for (const gift of shopItems(config).filter(isGift)) {
      const owned = ok(buyItem(withCash(gift.price), gift.id, config)).snapshot
      expect(consumeGift(owned, gift.id, 'yourself', config).ok, gift.id).toBe(true)
      expect(consumeGift(owned, gift.id, { npcId: npc }, config).ok, gift.id).toBe(true)
    }
  })
})

describe('gifts can never target another player', () => {
  it('the target type has no player variant', () => {
    // @ts-expect-error a player id is not a GiftTarget
    const byPlayerId: GiftTarget = { playerId: 'u-1' }
    // @ts-expect-error a raw string is not an NpcId: only toNpcId makes one
    const rawNpc: GiftTarget = { npcId: 'npc-bodega-cat' }
    // @ts-expect-error a handle is not a target
    const byHandle: GiftTarget = { handle: 'someone' }
    // @ts-expect-error only 'yourself' is a string target
    const other: GiftTarget = 'friend'
    expect([byPlayerId, rawNpc, byHandle, other]).toHaveLength(4)
  })

  it.each([
    ['a player id', { playerId: '0b9f8f9e-1c55-4c8e-9a51-1f1f2a9b2c3d' }],
    ['a uuid as an npc id', { npcId: '0b9f8f9e-1c55-4c8e-9a51-1f1f2a9b2c3d' }],
    ['an unprefixed npc id', { npcId: 'bodega-cat' }],
    ['an npc and a player', { npcId: 'npc-bodega-cat', playerId: 'u-1' }],
    ['a handle', { handle: 'someone' }],
    ['a friend', 'friend'],
    ['the bare word self', 'self'],
    ['null', null],
    ['an array', ['yourself']],
    ['an npc id with uppercase', { npcId: 'npc-Bodega' }],
  ])('refuses %s at runtime and keeps the gift', (_label, target) => {
    const snapshot = ok(buyItem(withCash(flowers.price), flowers.id, config)).snapshot
    expect(parseGiftTarget(target)).toBeNull()
    const result = consumeGift(snapshot, flowers.id, target as GiftTarget, config)
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_TARGET' } })
    expect(giftCount(snapshot.player.inventory, flowers.id)).toBe(1)
  })

  it('toNpcId accepts only npc- prefixed kebab ids', () => {
    expect(toNpcId('npc-promoter')).toBe('npc-promoter')
    expect(toNpcId('npc-')).toBeNull()
    expect(toNpcId('player-1')).toBeNull()
    expect(toNpcId(42)).toBeNull()
  })
})
