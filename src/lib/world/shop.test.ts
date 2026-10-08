/**
 * S10a shop rules against the shipped venues and balance: which places run a shop, when a
 * shop can sell (borough open, open on the personal clock), and that buying at a shop applies
 * the S10 buy rules. Numbers come from data/config, never literals.
 */
import { describe, expect, it } from 'vitest'
import { minutesPerDay } from '@/engine/clock'
import { engineConfig } from '@/engine/config'
import { initialSnapshot, type GameSnapshot } from '@/engine/game'
import { isWearable, shopItems } from '@/engine/items'
import {
  buyAtShop as buyAtShopAnywhere,
  hasShop,
  SHOP_VENUE_TYPES,
  shopBlock as shopBlockAnywhere,
} from '@/engine/placeActions'
import { minuteOf } from '@/engine/places'
import { findPlace, landmarks, venues } from './places'
import {
  buyAtShopHere as buyAtShop,
  playerWithClout,
  shopBlockHere as shopBlock,
} from '@/engine/test-support'

const DAY = minutesPerDay(engineConfig)
const MAX_CLOUT = Math.max(...engineConfig.clout.levels.map((level) => level.minClout))

function place(id: string) {
  const found = findPlace(id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}

function snapshotAt(minuteOfDay: number, cash: number, clout = 0): GameSnapshot {
  const base = initialSnapshot(engineConfig)
  return {
    clock: { minute: DAY + minuteOfDay, remainderMs: 0 },
    // S13: clout is a ledger now; build one holding `clout` in total.
    player: playerWithClout({ ...base.player, cash }, clout, engineConfig),
  }
}

const shopVenues = venues.filter((venue) => hasShop(venue))
const openMinute = (id: string) => {
  const { hours } = place(id) as { hours: { open: string } | '24h' }
  return hours === '24h' ? 12 * 60 : minuteOf(hours.open) + 30
}

describe('which places run a shop', () => {
  it('every boutique and thrift venue, and nothing else', () => {
    expect(shopVenues.length).toBeGreaterThan(0)
    for (const venue of venues) {
      expect(hasShop(venue), venue.id).toBe(
        (SHOP_VENUE_TYPES as readonly string[]).includes(venue.type),
      )
    }
    for (const landmark of landmarks) expect(hasShop(landmark), landmark.id).toBe(false)
  })
})

describe('shopBlock', () => {
  it('is null at every shop while it is open and its borough is unlocked', () => {
    for (const venue of shopVenues) {
      const snapshot = snapshotAt(openMinute(venue.id), 0, MAX_CLOUT)
      expect(shopBlock(venue, snapshot, engineConfig), venue.id).toBeNull()
    }
  })

  it('says closed, with the opening time, outside hours', () => {
    const thrift = place('rerun-racks')
    if (!('type' in thrift) || thrift.hours === '24h') throw new Error('rerun-racks has hours')
    const snapshot = snapshotAt(minuteOf(thrift.hours.open) - 60, 0)
    expect(shopBlock(thrift, snapshot, engineConfig)).toEqual({
      code: 'closed',
      opensAt: thrift.hours.open,
    })
  })

  it('says the borough is locked before its clout level, even while open', () => {
    const boutique = place('sidecut-studio')
    const snapshot = snapshotAt(openMinute('sidecut-studio'), 10_000, 0)
    expect(shopBlock(boutique, snapshot, engineConfig)).toMatchObject({ code: 'borough-locked' })
  })
})

describe('buyAtShop', () => {
  const [cheapest] = [...shopItems(engineConfig)].sort((a, b) => a.price - b.price)
  if (cheapest === undefined) throw new Error('no shop items')
  const wearable = shopItems(engineConfig).find(isWearable)
  if (wearable === undefined) throw new Error('no wearable')

  it('refuses at a place without a shop', () => {
    const result = buyAtShop(
      snapshotAt(12 * 60, 10_000),
      place('steam-vent-coffee'),
      cheapest.id,
      engineConfig,
    )
    expect(result).toEqual({ ok: false, error: { code: 'NOT_A_SHOP' } })
  })

  it('refuses with the reason when the shop is closed, and changes nothing', () => {
    const snapshot = snapshotAt(minuteOf('03:00'), 10_000)
    const result = buyAtShop(snapshot, place('rerun-racks'), cheapest.id, engineConfig)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'closed' } },
    })
  })

  it('buys when open: the price leaves the cash and the item lands in the inventory', () => {
    const snapshot = snapshotAt(openMinute('rerun-racks'), wearable.price)
    const result = buyAtShop(snapshot, place('rerun-racks'), wearable.id, engineConfig)
    if (!result.ok) throw new Error(`refused: ${result.error.code}`)
    expect(result.price).toBe(wearable.price)
    expect(result.snapshot.player.cash).toBe(0)
    expect(result.snapshot.player.inventory.wearables.map((owned) => owned.itemId)).toEqual([
      wearable.id,
    ])
    expect(result.snapshot.clock).toBe(snapshot.clock)
  })

  it('passes the S10 refusals through (short of cash names the shortfall inputs)', () => {
    const snapshot = snapshotAt(openMinute('rerun-racks'), wearable.price - 1)
    expect(buyAtShop(snapshot, place('rerun-racks'), wearable.id, engineConfig)).toEqual({
      ok: false,
      error: {
        code: 'INSUFFICIENT_FUNDS',
        required: wearable.price,
        available: wearable.price - 1,
      },
    })
  })
})

describe('the shop needs the player there (DEC-22)', () => {
  const wearable = shopItems(engineConfig).find(isWearable)
  if (wearable === undefined) throw new Error('no wearable')

  it('away from an open shop, shopBlock says so and a buy is refused without changes', () => {
    const snapshot = snapshotAt(openMinute('rerun-racks'), wearable.price)
    expect(shopBlockAnywhere(place('rerun-racks'), snapshot, engineConfig)).toEqual({
      code: 'away',
    })
    expect(buyAtShopAnywhere(snapshot, place('rerun-racks'), wearable.id, engineConfig)).toEqual({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'away' } },
    })
  })

  it('a closed shop says closed before away', () => {
    const shop = place('rerun-racks') as { hours: { open: string } | '24h' }
    if (shop.hours === '24h') return
    const early = snapshotAt(minuteOf(shop.hours.open) - 1, wearable.price)
    expect(shopBlockAnywhere(place('rerun-racks'), early, engineConfig)).toMatchObject({
      code: 'closed',
    })
  })
})
