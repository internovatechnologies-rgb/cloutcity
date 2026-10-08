/**
 * S10a store-level probes: repeated taps on Buy / Sell / Use leave consistent state, the shop
 * re-checks its rules on every buy (a crafted buy at a locked or closed shop changes nothing),
 * rent notices from every path (advance, shift) reach `lastRentEvent`, and `advanceMinutes`
 * refuses bad input without touching state. Numbers come from data/config, never literals.
 */
import { describe, expect, it } from 'vitest'
import { minutesPerDay } from '@/engine/clock'
import { engineConfig } from '@/engine/config'
import { isGift, isWearable, shopItems } from '@/engine/items'
import { placeActions } from '@/engine/placeActions'
import { minuteOf } from '@/engine/places'
import { nextRentDueDay, rentFor } from '@/engine/rent'
import { createLogger } from '@/lib/log'
import { findPlace, venues } from '@/lib/world/places'
import { createSafeJsonStorage } from './storage'
import { createGameStore, type PersistedState } from './store'
import { playerWithClout } from '@/engine/test-support'
import type { Place } from '@/engine/places'
import type { GameStore } from './store'

/** The store's state after the player walks into `place` (DEC-22: its actions need them there). */
function standingAt(game: GameStore, place: Place) {
  const { player } = game.getState()
  const { location } = player
  if (location.kind !== 'place' || location.placeId !== place.id) {
    game.setState({ player: { ...player, location: { kind: 'place', placeId: place.id } } })
  }
  return game.getState()
}

const DAY = minutesPerDay(engineConfig)
const logger = createLogger({ level: 'error', sink: () => undefined })
const MAX_STACK = engineConfig.items.maxGiftStack

function place(id: string) {
  const found = findPlace(id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}

const thrift = place('rerun-racks')
const boutique = place('sidecut-studio')
const hoursOf = (id: string) => {
  const found = place(id)
  if (!('hours' in found) || found.hours === '24h') throw new Error(`${id} has no fixed hours`)
  return { open: minuteOf(found.hours.open), close: minuteOf(found.hours.close) }
}

const wearable = shopItems(engineConfig).find(isWearable)
const gift = [...shopItems(engineConfig)].filter(isGift).sort((a, b) => a.price - b.price)[0]
if (wearable === undefined || gift === undefined) throw new Error('shop needs a wearable and gift')

/** A fresh store on day 2 at `minuteOfDay` with `cash` (and optional clout). */
function storeAt(minuteOfDay: number, cash: number, clout = 0) {
  const game = createGameStore(
    createSafeJsonStorage<PersistedState>(() => undefined, logger),
    logger,
  )
  const { clock, player } = game.getState()
  game.setState({
    clock: { ...clock, minute: DAY + minuteOfDay },
    // S13: clout is a ledger now; build one holding `clout` in total.
    player: playerWithClout({ ...player, cash }, clout, engineConfig),
  })
  return game
}

const NOON = 12 * 60

describe('repeated taps through the store', () => {
  it('a wearable is bought once however many times Buy lands', () => {
    const game = storeAt(NOON, wearable.price * 5)
    const results = [1, 2, 3].map(() => standingAt(game, thrift).buyAtShop(thrift, wearable.id))
    expect(results.map((result) => result.ok)).toEqual([true, false, false])
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'ALREADY_OWNED' } })
    const { player } = game.getState()
    expect(player.cash).toBe(wearable.price * 4)
    expect(player.inventory.wearables.filter((owned) => owned.itemId === wearable.id)).toHaveLength(
      1,
    )
  })

  it('a gift stacks up to the cap, then refuses with STACK_FULL and charges nothing more', () => {
    const game = storeAt(NOON, gift.price * (MAX_STACK + 3))
    for (let i = 0; i < MAX_STACK; i += 1) {
      expect(standingAt(game, thrift).buyAtShop(thrift, gift.id).ok, `buy ${i + 1}`).toBe(true)
    }
    standingAt(game, thrift)
    const before = game.getState().player
    expect(standingAt(game, thrift).buyAtShop(thrift, gift.id)).toEqual({
      ok: false,
      error: { code: 'STACK_FULL', itemId: gift.id, max: MAX_STACK },
    })
    expect(game.getState().player).toBe(before)
    expect(before.cash).toBe(gift.price * 3)
    expect(before.inventory.gifts.find((stack) => stack.itemId === gift.id)?.count).toBe(MAX_STACK)
  })

  it('selling the last copy twice pays once; the second sell is NOT_OWNED', () => {
    const game = storeAt(NOON, wearable.price)
    expect(standingAt(game, thrift).buyAtShop(thrift, wearable.id).ok).toBe(true)
    const first = game.getState().sellItem(wearable.id)
    if (!first.ok) throw new Error(`refused: ${first.error.code}`)
    const afterFirst = game.getState().player
    expect(afterFirst.cash).toBe(first.amount)
    expect(game.getState().sellItem(wearable.id)).toMatchObject({
      ok: false,
      error: { code: 'NOT_OWNED' },
    })
    expect(game.getState().player).toBe(afterFirst)
  })

  it('selling a worn wearable takes it off the outfit', () => {
    const game = storeAt(NOON, wearable.price)
    standingAt(game, thrift).buyAtShop(thrift, wearable.id)
    expect(game.getState().equipItem(wearable.id, wearable.slot).ok).toBe(true)
    expect(game.getState().player.inventory.outfit[wearable.slot]).toBe(wearable.id)
    expect(game.getState().sellItem(wearable.id).ok).toBe(true)
    expect(game.getState().player.inventory.outfit[wearable.slot]).toBeUndefined()
  })

  it('using the last gift twice uses it once; the second use is NOT_OWNED', () => {
    const game = storeAt(NOON, gift.price)
    standingAt(game, thrift).buyAtShop(thrift, gift.id)
    expect(game.getState().consumeGift(gift.id, 'yourself').ok).toBe(true)
    const after = game.getState().player
    expect(after.inventory.gifts.some((stack) => stack.itemId === gift.id)).toBe(false)
    expect(game.getState().consumeGift(gift.id, 'yourself')).toMatchObject({
      ok: false,
      error: { code: 'NOT_OWNED' },
    })
    expect(game.getState().player).toBe(after)
  })
})

describe('the shop re-checks its rules on every buy', () => {
  const { open, close } = hoursOf('rerun-racks')

  it.each([
    ['one minute before opening', open - 1, false],
    ['the opening minute', open, true],
    ['the last open minute', close - 1, true],
    ['the closing minute', close, false],
  ])('at %s the buy is %s', (_label, minuteOfDay, allowed) => {
    const game = storeAt(minuteOfDay, wearable.price)
    standingAt(game, thrift)
    const before = game.getState().player
    const result = standingAt(game, thrift).buyAtShop(thrift, wearable.id)
    expect(result.ok).toBe(allowed)
    if (!allowed) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'BLOCKED', block: { code: 'closed' } },
      })
      expect(game.getState().player).toBe(before)
    }
  })

  it('a crafted buy at a boutique in a locked borough is refused and changes nothing', () => {
    const game = storeAt(hoursOf('sidecut-studio').open + 30, 100_000, 0)
    standingAt(game, boutique)
    const before = game.getState()
    const result = standingAt(game, boutique).buyAtShop(boutique, wearable.id)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'borough-locked' } },
    })
    expect(game.getState().player).toBe(before.player)
    expect(game.getState().clock).toBe(before.clock)
  })

  it('a place without a shop refuses even when the store would otherwise allow it', () => {
    const game = storeAt(NOON, 100_000)
    standingAt(game, place('steam-vent-coffee'))
    const before = game.getState().player
    expect(
      standingAt(game, place('steam-vent-coffee')).buyAtShop(place('steam-vent-coffee'), gift.id),
    ).toEqual({
      ok: false,
      error: { code: 'NOT_A_SHOP' },
    })
    expect(game.getState().player).toBe(before)
  })
})

describe('advanceMinutes', () => {
  it('rejects a negative advance and leaves the clock, player and notice alone', () => {
    const game = storeAt(NOON, 500)
    const before = game.getState()
    expect(() => game.getState().advanceMinutes(-1)).toThrow(RangeError)
    expect(() => game.getState().advanceMinutes(1.5)).toThrow(RangeError)
    expect(() => game.getState().advanceMinutes(Number.NaN)).toThrow(RangeError)
    expect(game.getState().clock).toBe(before.clock)
    expect(game.getState().player).toBe(before.player)
    expect(game.getState().lastRentEvent).toBeNull()
  })

  it('a zero advance moves nothing and records no rent', () => {
    const game = storeAt(NOON, 500)
    const before = game.getState()
    game.getState().advanceMinutes(0)
    expect(game.getState().clock.minute).toBe(before.clock.minute)
    expect(game.getState().player.cash).toBe(before.player.cash)
    expect(game.getState().player.stats).toEqual(before.player.stats)
    expect(game.getState().lastRentEvent).toBeNull()
  })
})

describe('rent notices reach the panel state', () => {
  /** Advances a store to the first minute of its next rent day; returns that day. */
  function toNextRentDay(game: ReturnType<typeof storeAt>) {
    const { minute } = game.getState().clock
    const due = nextRentDueDay(minute, engineConfig)
    game.getState().advanceMinutes((due - 1) * DAY - minute)
    return due
  }

  it('missed rent, then a late fee, then eviction, each become the last notice', () => {
    const game = storeAt(NOON, 0)
    const { home } = game.getState().player
    const rent = rentFor(home, engineConfig)
    const [firstFee = 0, secondFee = 0] = engineConfig.rent.lateFees
    const evictAfter = engineConfig.rent.evictAfterMissed
    expect(evictAfter).toBeGreaterThanOrEqual(3)

    const day1 = toNextRentDay(game)
    expect(game.getState().lastRentEvent).toMatchObject({
      kind: 'missed',
      day: day1,
      lateFee: firstFee,
      missed: 1,
      missesBeforeEviction: evictAfter - 1,
    })
    expect(game.getState().player.rent.owed).toBe(rent + firstFee)

    // A minute later, so the next advance crosses the following rent day.
    game.getState().advanceMinutes(1)
    toNextRentDay(game)
    expect(game.getState().lastRentEvent).toMatchObject({
      kind: 'missed',
      lateFee: secondFee,
      missed: 2,
      owed: rent + firstFee + rent + secondFee,
    })

    for (let miss = 3; miss < evictAfter; miss += 1) {
      game.getState().advanceMinutes(1)
      toNextRentDay(game)
    }
    game.getState().advanceMinutes(1)
    toNextRentDay(game)
    expect(game.getState().lastRentEvent).toMatchObject({ kind: 'evicted' })
    expect(game.getState().player.rent.owed).toBe(0)
  })

  it('back rent collected at a later midnight becomes the last notice', () => {
    const game = storeAt(NOON, 0)
    toNextRentDay(game)
    const owed = game.getState().player.rent.owed
    expect(owed).toBeGreaterThan(0)
    game.setState({ player: { ...game.getState().player, cash: owed } })
    game.getState().advanceMinutes(DAY)
    expect(game.getState().lastRentEvent).toMatchObject({ kind: 'arrears-paid', amount: owed })
    expect(game.getState().player.cash).toBe(0)
    expect(game.getState().player.rent.owed).toBe(0)
  })

  it('a shift that crosses a rent day returns the rent event and records it', () => {
    // Any venue whose shift can start late enough on the eve of a rent day to end after the
    // midnight that opens it (shifts may run past closing; only the start needs open hours).
    for (const venue of venues) {
      const game = storeAt(NOON, 0)
      const due = nextRentDueDay(game.getState().clock.minute, engineConfig)
      const atNoon = placeActions(venue, standingAt(game, venue), engineConfig)
      if (atNoon.kind !== 'actions') continue
      const offered = atNoon.actions.find((entry) => entry.kind === 'shift')
      if (offered === undefined) continue
      const start = (due - 1) * DAY - (offered.def.durationMin - 1)
      game.setState({ clock: { ...game.getState().clock, minute: start } })
      const view = placeActions(venue, standingAt(game, venue), engineConfig)
      if (view.kind !== 'actions') continue
      const shift = view.actions.find((entry) => entry.id === offered.id && entry.block === null)
      if (shift === undefined) continue
      const result = standingAt(game, venue).performPlaceAction(venue, shift.id)
      if (!result.ok) throw new Error(`refused: ${result.error.code}`)
      expect(result.rent.length).toBeGreaterThan(0)
      expect(result.rent[0]).toMatchObject({ kind: 'missed', day: due })
      expect(game.getState().lastRentEvent).toBe(result.rent.at(-1))
      return
    }
    throw new Error('no venue offers a shift that can start an hour before midnight')
  })
})
