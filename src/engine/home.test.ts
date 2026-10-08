/** S16 apartment engine: home score and clout, placing decor, colour variants and moving home. */
import { describe, expect, it } from 'vitest'
import { HOME_IDS } from '@/lib/data/homes'
import { cloutBreakdown, goalClout, levelClout, playerLevel, totalClout } from './clout'
import { engineConfig as config, type HomeId } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import {
  homeClout,
  homeLock,
  homeScore,
  initialApartment,
  moveHome,
  placeDecor,
  placementsAfterMove,
  removeDecor,
  setDecorVariant,
  slotsFor,
  type HomeResult,
} from './home'
import { canAffordMove, moveInCost, rentReserve } from './housing'
import { buyItem, findItem, isDecor, type DecorDef } from './items'
import { settleRent } from './rent'
import { withClout } from './test-support'

const start = initialSnapshot(config)
const DAY = config.time.gameDayHours * 60

function decor(id: string): DecorDef {
  const item = findItem(id, config)
  if (item === undefined || !isDecor(item)) throw new Error(`no decor ${id}`)
  return item
}
const lights = decor('fairy-string-lights') // wall
const rug = decor('thrift-flatweave-rug') // floor
const monstera = decor('windowsill-monstera') // surface
const neon = decor('custom-neon-sign') // wall
const chair = decor('cloud-lounge-chair') // floor
const player = decor('crate-record-player') // surface
const ALL = [lights, rug, monstera, neon, chair, player]

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

/** `snapshot` owning each of `ids` (bought with cash to spare, then cash set to `cash`). */
function owning(snapshot: GameSnapshot, ids: readonly string[], cash = snapshot.player.cash) {
  let out: GameSnapshot = { ...snapshot, player: { ...snapshot.player, cash: 100_000 } }
  for (const id of ids) out = ok(buyItem(out, id, config)).snapshot
  return { ...out, player: { ...out.player, cash } }
}

function inHome(snapshot: GameSnapshot, home: HomeId): GameSnapshot {
  return { ...snapshot, player: { ...snapshot.player, home } }
}

function place(snapshot: GameSnapshot, itemId: string, slotId: string): GameSnapshot {
  return ok(placeDecor(snapshot, itemId, slotId, config)).snapshot
}

function errorOf(result: HomeResult<object>) {
  if (result.ok) throw new Error('expected a refusal')
  return result.error
}

describe('home score and home clout', () => {
  it('a home with nothing placed scores its base score; the start home is 0', () => {
    for (const home of HOME_IDS) {
      const snapshot = inHome(start, home)
      expect(homeScore(snapshot.player, config)).toBe(config.home.baseScore[home])
    }
    expect(homeClout(start.player, config)).toBe(0)
    expect(totalClout(start.player, config)).toBe(0)
  })

  it('placed decor adds its homeScore; owned decor in storage adds nothing', () => {
    const owned = owning(start, [lights.id, rug.id])
    expect(homeScore(owned.player, config)).toBe(0)
    const placed = place(owned, lights.id, 'wall-1')
    expect(homeScore(placed.player, config)).toBe(lights.decor.homeScore)
    const both = place(placed, rug.id, 'floor-1')
    expect(homeScore(both.player, config)).toBe(lights.decor.homeScore + rug.decor.homeScore)
  })

  it('home clout is the score capped at home.maxClout', () => {
    let loft = inHome(
      owning(
        start,
        ALL.map((item) => item.id),
      ),
      'manhattan-loft',
    )
    for (const [itemId, slotId] of [
      [lights.id, 'wall-1'],
      [neon.id, 'wall-2'],
      [rug.id, 'floor-1'],
      [chair.id, 'floor-2'],
      [monstera.id, 'surface-1'],
      [player.id, 'surface-2'],
    ] as const) {
      loft = place(loft, itemId, slotId)
    }
    const score =
      config.home.baseScore['manhattan-loft'] +
      ALL.reduce((sum, item) => sum + item.decor.homeScore, 0)
    expect(homeScore(loft.player, config)).toBe(score)
    expect(score).toBeGreaterThan(config.home.maxClout)
    expect(homeClout(loft.player, config)).toBe(config.home.maxClout)
  })

  it('kept decor (prestige) counts 0 even when placed', () => {
    const owned = place(owning(start, [neon.id]), neon.id, 'wall-1')
    const kept = {
      ...owned.player,
      inventory: {
        ...owned.player.inventory,
        decor: owned.player.inventory.decor.map((entry) => ({
          ...entry,
          prestigeKept: true as const,
        })),
      },
    }
    expect(homeScore(kept, config)).toBe(0)
  })

  it('home clout is part of the breakdown, the total, goal clout and level clout', () => {
    const placed = place(owning(start, [neon.id]), neon.id, 'wall-1')
    const homeCl = neon.decor.homeScore
    const withEarned = withClout(placed, 90 + homeCl, config)
    const breakdown = cloutBreakdown(withEarned.player, config)
    expect(breakdown).toMatchObject({ earned: 90, items: 0, home: homeCl, premium: 0 })
    expect(breakdown.total).toBe(90 + homeCl)
    expect(totalClout(withEarned.player, config)).toBe(90 + homeCl)
    expect(goalClout(withEarned.player, config)).toBe(90 + homeCl)
    expect(levelClout(withEarned.player, config)).toBe(90 + homeCl)
    expect(playerLevel(withEarned.player, config).id).toBe('local')
  })
})

describe('slotsFor', () => {
  it('lists each home’s slots from the interiors data', () => {
    expect(slotsFor('queens-room', config).map((slot) => slot.id)).toEqual([
      'wall-1',
      'floor-1',
      'surface-1',
    ])
    expect(slotsFor('brooklyn-1br', config)).toHaveLength(5)
    expect(slotsFor('manhattan-loft', config)).toHaveLength(7)
  })
})

describe('placeDecor', () => {
  const owned = owning(start, [lights.id, neon.id, rug.id])

  it('refuses unknown items, non-decor, decor not owned, unknown slots and the wrong kind', () => {
    expect(errorOf(placeDecor(owned, 'nope', 'wall-1', config))).toEqual({
      code: 'UNKNOWN_ITEM',
      itemId: 'nope',
    })
    expect(errorOf(placeDecor(owned, 'bodega-graphic-tee', 'wall-1', config)).code).toBe(
      'NOT_DECOR',
    )
    expect(errorOf(placeDecor(owned, chair.id, 'floor-1', config)).code).toBe('NOT_OWNED')
    for (const slotId of ['wall-2', 'surface-9', '__proto__', 'constructor', '']) {
      expect(errorOf(placeDecor(owned, lights.id, slotId, config)), slotId).toEqual({
        code: 'UNKNOWN_SLOT',
        slotId,
      })
    }
    expect(errorOf(placeDecor(owned, lights.id, 'floor-1', config))).toEqual({
      code: 'WRONG_SLOT_KIND',
      itemId: lights.id,
      slotId: 'floor-1',
      fits: 'wall',
      kind: 'floor',
    })
  })

  it('a slot from a bigger home is unknown in Queens and fine in Brooklyn', () => {
    expect(errorOf(placeDecor(owned, lights.id, 'wall-2', config)).code).toBe('UNKNOWN_SLOT')
    const brooklyn = inHome(owned, 'brooklyn-1br')
    expect(place(brooklyn, lights.id, 'wall-2').player.apartment.placed).toEqual({
      'wall-2': lights.id,
    })
  })

  it('placing where another item sits sends that one back to storage', () => {
    const first = place(owned, lights.id, 'wall-1')
    const swapped = place(first, neon.id, 'wall-1')
    expect(swapped.player.apartment.placed).toEqual({ 'wall-1': neon.id })
    expect(swapped.player.inventory.decor.map((entry) => entry.itemId)).toContain(lights.id)
  })

  it('placing an item already placed moves it (one item, one slot)', () => {
    const brooklyn = place(inHome(owned, 'brooklyn-1br'), lights.id, 'wall-1')
    const moved = place(brooklyn, lights.id, 'wall-2')
    expect(moved.player.apartment.placed).toEqual({ 'wall-2': lights.id })
  })

  it('never touches the clock, cash, stats or the clout ledger', () => {
    const placed = place(owned, lights.id, 'wall-1')
    expect(placed.clock).toBe(owned.clock)
    expect(placed.player.cash).toBe(owned.player.cash)
    expect(placed.player.stats).toBe(owned.player.stats)
    expect(placed.player.clout.ledger).toEqual(owned.player.clout.ledger)
  })

  it('reports a level-up when the home score lifts the player to a new level, once', () => {
    const near = withClout(owned, 100 - neon.decor.homeScore, config)
    const result = ok(placeDecor(near, neon.id, 'wall-1', config))
    expect(result.levelUp).toMatchObject({ fromPeak: 'nobody', to: 'local', source: 'home' })
    expect(result.levelUp?.unlocks.boroughs).toEqual(['brooklyn'])
    const removed = ok(removeDecor(result.snapshot, 'wall-1', config))
    expect(removed.levelUp).toBeNull()
    expect(playerLevel(removed.snapshot.player, config).id).toBe('nobody')
    // The peak is remembered: placing it again replays no level-up.
    expect(ok(placeDecor(removed.snapshot, neon.id, 'wall-1', config)).levelUp).toBeNull()
  })
})

describe('removeDecor', () => {
  const placed = place(owning(start, [lights.id]), lights.id, 'wall-1')

  it('takes the item back to storage and its score away', () => {
    const removed = ok(removeDecor(placed, 'wall-1', config))
    expect(removed.snapshot.player.apartment.placed).toEqual({})
    expect(removed.snapshot.player.inventory.decor.map((entry) => entry.itemId)).toEqual([
      lights.id,
    ])
    expect(homeScore(removed.snapshot.player, config)).toBe(0)
  })

  it('is a no-op on an empty slot and refuses a slot the home does not have', () => {
    const empty = ok(removeDecor(placed, 'floor-1', config))
    expect(empty.snapshot).toBe(placed)
    expect(empty.levelUp).toBeNull()
    expect(errorOf(removeDecor(placed, 'wall-2', config))).toEqual({
      code: 'UNKNOWN_SLOT',
      slotId: 'wall-2',
    })
  })
})

describe('setDecorVariant', () => {
  const owned = owning(start, [neon.id])

  it('a new purchase shows its first variant; choosing another changes looks only', () => {
    expect(owned.player.inventory.decor[0]?.variant).toBe(neon.decor.variants[0]?.id)
    const placed = place(owned, neon.id, 'wall-1')
    const other = neon.decor.variants[1]?.id ?? ''
    const changed = ok(setDecorVariant(placed, neon.id, other, config)).snapshot
    expect(changed.player.inventory.decor[0]?.variant).toBe(other)
    expect(changed.player.apartment).toBe(placed.player.apartment)
    expect(totalClout(changed.player, config)).toBe(totalClout(placed.player, config))
  })

  it('refuses an unknown variant, decor not owned and non-decor', () => {
    expect(errorOf(setDecorVariant(owned, neon.id, 'plaid', config))).toEqual({
      code: 'UNKNOWN_VARIANT',
      itemId: neon.id,
      variantId: 'plaid',
    })
    expect(errorOf(setDecorVariant(owned, rug.id, 'teal', config)).code).toBe('NOT_OWNED')
    expect(errorOf(setDecorVariant(owned, 'bodega-flowers', 'pink', config)).code).toBe('NOT_DECOR')
  })
})

describe('placementsAfterMove', () => {
  it('keeps what fits a slot the new home also has; the rest goes to storage', () => {
    const placed = {
      'wall-1': lights.id,
      'wall-2': neon.id,
      'floor-2': chair.id,
      'surface-1': monstera.id,
    }
    expect(placementsAfterMove(placed, 'queens-room', config)).toEqual({
      'wall-1': lights.id,
      'surface-1': monstera.id,
    })
    expect(placementsAfterMove(placed, 'manhattan-loft', config)).toEqual(placed)
  })
})

describe('homeLock: current, then borough, then funds', () => {
  it('the current home is locked as current, whatever else holds', () => {
    expect(homeLock(start.player, 'queens-room', config)).toEqual({
      code: 'CURRENT_HOME',
      home: 'queens-room',
    })
  })

  it('a home in a borough the level has not opened is borough-locked before funds are checked', () => {
    const broke = { ...start.player, cash: 0 }
    expect(homeLock(broke, 'brooklyn-1br', config)).toEqual({
      code: 'BOROUGH_LOCKED',
      home: 'brooklyn-1br',
      borough: 'brooklyn',
      access: { status: 'locked', required: 'local', current: 'nobody' },
    })
    const local = withClout({ ...start, player: broke }, 100, config).player
    expect(homeLock(local, 'manhattan-loft', config)).toMatchObject({
      code: 'BOROUGH_LOCKED',
      borough: 'manhattan',
      access: { required: 'scene-regular', current: 'local' },
    })
  })

  it('an open borough the player cannot afford is funds-short, naming the reserve plus move-in', () => {
    const local = withClout({ ...start, player: { ...start.player, cash: 50 } }, 100, config)
    const required = rentReserve(local.player, config) + moveInCost('brooklyn-1br', config)
    expect(homeLock(local.player, 'brooklyn-1br', config)).toEqual({
      code: 'FUNDS_SHORT',
      home: 'brooklyn-1br',
      required,
      available: 50,
    })
  })

  it('is open exactly when canAffordMove is, once the borough is open (canAffordMove unchanged)', () => {
    const local = withClout(start, 100, config)
    const threshold = rentReserve(local.player, config) + moveInCost('brooklyn-1br', config)
    for (const cash of [0, threshold - 1, threshold, threshold + 1, 10_000]) {
      const p = { ...local.player, cash }
      expect(homeLock(p, 'brooklyn-1br', config) === null, `cash ${cash}`).toBe(
        canAffordMove(p, 'brooklyn-1br', config),
      )
    }
  })
})

describe('moveHome', () => {
  const ready = withClout({ ...start, player: { ...start.player, cash: 2000 } }, 100, config)

  it('refuses an unknown home, including prototype names', () => {
    for (const home of ['penthouse', '__proto__', 'constructor', '']) {
      expect(errorOf(moveHome(ready, home, config)), home).toEqual({ code: 'UNKNOWN_HOME', home })
    }
  })

  it('refuses what homeLock refuses, changing nothing', () => {
    expect(errorOf(moveHome(ready, 'queens-room', config)).code).toBe('CURRENT_HOME')
    expect(errorOf(moveHome(ready, 'manhattan-loft', config)).code).toBe('BOROUGH_LOCKED')
    const broke = { ...ready, player: { ...ready.player, cash: 10 } }
    expect(errorOf(moveHome(broke, 'brooklyn-1br', config)).code).toBe('FUNDS_SHORT')
  })

  it('is instant: pays the move-in cost, changes the home and logs the move', () => {
    const at = { ...ready, clock: { ...ready.clock, minute: 3 * DAY + 100 } }
    const result = ok(moveHome(at, 'brooklyn-1br', config))
    const cost = moveInCost('brooklyn-1br', config)
    expect(result.cost).toBe(cost)
    expect(result.snapshot.clock).toBe(at.clock)
    expect(result.snapshot.player.cash).toBe(2000 - cost)
    expect(result.snapshot.player.home).toBe('brooklyn-1br')
    expect(result.snapshot.player.rent).toBe(at.player.rent)
    expect(result.snapshot.player.apartment.moveLog).toEqual([
      { from: 'queens-room', to: 'brooklyn-1br', at: 3 * DAY + 100, cost },
    ])
    expect(homeClout(result.snapshot.player, config)).toBe(config.home.baseScore['brooklyn-1br'])
  })

  it('keeps decor in slots the new home also has; the rest goes back to storage', () => {
    const decorated = place(
      place(owning(ready, [lights.id, chair.id]), lights.id, 'wall-1'),
      chair.id,
      'floor-1',
    )
    const brooklyn = ok(moveHome(decorated, 'brooklyn-1br', config)).snapshot
    expect(brooklyn.player.apartment.placed).toEqual({ 'wall-1': lights.id, 'floor-1': chair.id })
    const moved = place(brooklyn, chair.id, 'floor-2')
    const back = ok(moveHome(moved, 'queens-room', config)).snapshot
    expect(back.player.apartment.placed).toEqual({ 'wall-1': lights.id })
    expect(back.player.inventory.decor.map((entry) => entry.itemId).sort()).toEqual(
      [chair.id, lights.id].sort(),
    )
  })

  it('keeps the newest home.moveLogMax moves', () => {
    let snapshot: GameSnapshot = { ...ready, player: { ...ready.player, cash: 1_000_000 } }
    const moves = config.home.moveLogMax + 5
    for (let i = 0; i < moves; i += 1) {
      const to = snapshot.player.home === 'queens-room' ? 'brooklyn-1br' : 'queens-room'
      snapshot = { ...snapshot, clock: { ...snapshot.clock, minute: snapshot.clock.minute + 1 } }
      snapshot = ok(moveHome(snapshot, to, config)).snapshot
    }
    const log = snapshot.player.apartment.moveLog
    expect(log).toHaveLength(config.home.moveLogMax)
    expect(log.at(-1)?.at).toBe(snapshot.clock.minute)
  })

  it('reports a level-up when the new home’s base score lifts the player (source home)', () => {
    const known = config.clout.levels.find((level) => level.id === 'known')?.minClout ?? 0
    const nearKnown = withClout(
      { ...start, player: { ...start.player, cash: 50_000 } },
      known - config.home.baseScore['manhattan-loft'],
      config,
    )
    const result = ok(moveHome(nearKnown, 'manhattan-loft', config))
    expect(result.levelUp).toMatchObject({ to: 'known', source: 'home' })
  })
})

describe('eviction and the apartment', () => {
  it('an eviction to the lowest-rent home sends decor in slots it lacks back to storage', () => {
    const owned = owning(inHome(start, 'brooklyn-1br'), [lights.id, neon.id], 0)
    const placed = place(place(owned, lights.id, 'wall-1'), neon.id, 'wall-2')
    const missed = { ...placed.player, rent: { owed: 0, missed: config.rent.evictAfterMissed - 1 } }
    const week = config.time.rentPeriodGameDays * DAY
    const settled = settleRent(missed, week - 1, week, config)
    expect(settled.events.map((event) => event.kind)).toEqual(['evicted'])
    expect(settled.player.home).toBe('queens-room')
    expect(settled.player.apartment).toEqual({
      ...initialApartment,
      placed: { 'wall-1': lights.id },
    })
  })
})
