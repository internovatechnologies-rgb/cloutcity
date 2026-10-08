/**
 * S16 decor through the shop, farming probes and prestige: decor is owned once and depreciates,
 * selling placed decor unplaces it first, kept decor is a look only, and no place/remove or
 * buy/place/claim/sell loop pays more than once.
 */
import { describe, expect, it } from 'vitest'
import { cloutSums, goalClout, totalClout } from './clout'
import { engineConfig as config } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import { syncGoals } from './goals'
import { grant } from './grants'
import { homeClout, homeScore, moveHome, placeDecor, removeDecor } from './home'
import {
  buyItem,
  findItem,
  isDecor,
  resaleValue,
  sellItem,
  shopItems,
  type DecorDef,
} from './items'
import { prestige } from './prestige'
import { createSaveSchema, initialSave, loadSave, type SaveState } from './save'
import { withClout } from './test-support'

const schema = createSaveSchema(config)
const start = initialSnapshot(config)
const DAY = config.time.gameDayHours * 60
const MS = 1_760_000_000_000

const decorItems = config.items.catalog.filter(isDecor)

function decor(id: string): DecorDef {
  const item = findItem(id, config)
  if (item === undefined || !isDecor(item)) throw new Error(`no decor ${id}`)
  return item
}
const neon = decor('custom-neon-sign')
const lights = decor('fairy-string-lights')

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

const withCash = (cash: number, snapshot: GameSnapshot = start): GameSnapshot => ({
  ...snapshot,
  player: { ...snapshot.player, cash },
})

/** The first slot of the start home that `item` fits. */
function slotFor(item: DecorDef, home = config.startHome): string {
  const slot = config.home.slots[home].find((entry) => entry.kind === item.decor.fits)
  if (slot === undefined) throw new Error(`no ${item.decor.fits} slot in ${home}`)
  return slot.id
}

describe('decor in the shop', () => {
  it('the shop sells every decor item', () => {
    const ids = new Set(shopItems(config).map((item) => item.id))
    for (const item of decorItems) expect(ids.has(item.id), item.id).toBe(true)
  })

  it('is owned once: a second purchase is refused without charging', () => {
    const bought = ok(buyItem(withCash(1000), neon.id, config))
    expect(bought.price).toBe(neon.price)
    expect(bought.levelUp).toBeNull()
    expect(bought.snapshot.player.inventory.decor).toEqual([
      { itemId: neon.id, acquiredMinute: start.clock.minute, variant: neon.decor.variants[0]?.id },
    ])
    expect(bought.snapshot.player.clout).toBe(start.player.clout)
    expect(buyItem(bought.snapshot, neon.id, config)).toEqual({
      ok: false,
      error: { code: 'ALREADY_OWNED', itemId: neon.id },
    })
    expect(buyItem(withCash(neon.price - 1), neon.id, config)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: neon.price, available: neon.price - 1 },
    })
  })

  it('resale depreciates per whole game day like a wearable, floored at minResalePct', () => {
    const { depreciationPctPerGameDay, minResalePct } = config.items
    const at = start.clock.minute
    expect(resaleValue(neon, at, at, config)).toBe(neon.sellValue)
    expect(resaleValue(neon, at, at + DAY, config)).toBe(
      Math.floor((neon.sellValue * (100 - depreciationPctPerGameDay)) / 100),
    )
    expect(resaleValue(neon, at, at + 365 * DAY, config)).toBe(
      Math.floor((neon.sellValue * minResalePct) / 100),
    )
    for (const item of decorItems) expect(item.sellValue, item.id).toBeLessThan(item.price)
  })

  it('selling placed decor takes it out of its slot first, and its home clout with it', () => {
    const owned = ok(buyItem(withCash(1000), neon.id, config)).snapshot
    const placed = ok(placeDecor(owned, neon.id, 'wall-1', config)).snapshot
    expect(homeClout(placed.player, config)).toBe(neon.decor.homeScore)
    const sold = ok(sellItem(placed, neon.id, config))
    expect(sold.amount).toBe(neon.sellValue)
    expect(sold.levelUp).toBeNull()
    expect(sold.snapshot.player.cash).toBe(1000 - neon.price + neon.sellValue)
    expect(sold.snapshot.player.inventory.decor).toEqual([])
    expect(sold.snapshot.player.apartment.placed).toEqual({})
    expect(homeClout(sold.snapshot.player, config)).toBe(0)
    expect(schema.safeParse({ ...initialSave(config), ...sold.snapshot }).success).toBe(true)
  })

  it('selling decor not owned is refused', () => {
    expect(sellItem(start, neon.id, config)).toEqual({
      ok: false,
      error: { code: 'NOT_OWNED', itemId: neon.id },
    })
  })
})

describe('farming probes', () => {
  it('a place/remove loop writes nothing to the ledger and reports one level-up at most', () => {
    const owned = withClout(ok(buyItem(withCash(1000), neon.id, config)).snapshot, 90, config)
    let snapshot = owned
    const levelUps: string[] = []
    for (let i = 0; i < 200; i += 1) {
      const placed = ok(placeDecor(snapshot, neon.id, 'wall-1', config))
      if (placed.levelUp !== null) levelUps.push(placed.levelUp.to)
      const removed = ok(removeDecor(placed.snapshot, 'wall-1', config))
      if (removed.levelUp !== null) levelUps.push(removed.levelUp.to)
      snapshot = removed.snapshot
    }
    expect(levelUps).toEqual(['local'])
    expect(snapshot.player.clout.ledger).toEqual(owned.player.clout.ledger)
    expect(snapshot.player.clout.compacted).toEqual(owned.player.clout.compacted)
    expect(snapshot.player.cash).toBe(owned.player.cash)
    expect(totalClout(snapshot.player, config)).toBe(90)
  })

  it.each(decorItems.map((item) => [item.id, item] as const))(
    'buy, place, claim, sell (%s): the goal pays once; every loop loses cash; five loops lose overall',
    (_id, item) => {
      // Earned clout just short of Local, so placing this item reaches the reach-local goal.
      const local = config.clout.levels[1]?.minClout ?? 0
      let save: SaveState = {
        ...initialSave(config),
        clock: { minute: 10_000, remainderMs: 0 },
      }
      // Just enough cash for five loops, so the grant's cash cap (a share of what the next home
      // still needs) stays open.
      const cash = item.price + 5 * (item.price - item.sellValue) + 50
      save = withCash(cash, withClout(save, local - item.decor.homeScore, config)) as SaveState
      const startCash = save.player.cash
      const earnedBefore = cloutSums(save.player.clout).earned
      const deltas: number[] = []
      let grantsPaid = 0
      for (let loop = 0; loop < 5; loop += 1) {
        const before = save.player.cash
        save = { ...save, player: ok(buyItem(save, item.id, config)).snapshot.player }
        save = {
          ...save,
          player: ok(placeDecor(save, item.id, slotFor(item), config)).snapshot.player,
        }
        save = syncGoals(save, config).save
        expect(save.goals.achieved['reach-local']).toBeDefined()
        let grantCash = 0
        for (const goal of config.goals) {
          const result = grant(
            save,
            { kind: 'goal_reward', goalId: goal.id, reward: goal.reward },
            MS,
            config,
          )
          if (!result.ok || result.replayed) continue
          grantsPaid += 1
          grantCash += result.record.applied.cash
          save = result.save
        }
        save = { ...save, player: ok(sellItem(save, item.id, config)).snapshot.player }
        const delta = save.player.cash - before
        // Without the one-time goal reward, every loop is a loss (resale is below the price).
        expect(delta - grantCash, `loop ${loop}`).toBe(item.sellValue - item.price)
        deltas.push(delta)
      }
      expect(grantsPaid).toBe(1)
      for (const delta of deltas.slice(1)) expect(delta).toBeLessThan(0)
      expect(save.player.cash - startCash).toBeLessThan(0)
      // Only the one grant added earned clout; the decor's own clout left with it.
      expect(cloutSums(save.player.clout).earned - earnedBefore).toBe(
        cloutSums(save.player.clout).bySource.grant ?? 0,
      )
      expect(homeScore(save.player, config)).toBe(0)
    },
  )

  it('moving back and forth costs the move-in cost each time and adds no clout of its own', () => {
    let snapshot = withCash(10_000, withClout(start, 100, config))
    const earned = cloutSums(snapshot.player.clout).earned
    for (let i = 0; i < 6; i += 1) {
      const to = snapshot.player.home === 'queens-room' ? 'brooklyn-1br' : 'queens-room'
      snapshot = { ...snapshot, clock: { ...snapshot.clock, minute: snapshot.clock.minute + 1 } }
      snapshot = ok(moveHome(snapshot, to, config)).snapshot
    }
    expect(snapshot.player.home).toBe('queens-room')
    expect(snapshot.player.cash).toBe(10_000 - 3 * (config.housing.moveInCost['brooklyn-1br'] ?? 0))
    expect(cloutSums(snapshot.player.clout).earned).toBe(earned)
    expect(snapshot.player.clout.ledger).toEqual([])
  })
})

describe('prestige keeps decor as looks only (DEC-14) and remaps the apartment', () => {
  function iconSave(): SaveState {
    let save: SaveState = { ...initialSave(config), clock: { minute: 50_000, remainderMs: 0 } }
    save = withCash(100_000, save) as SaveState
    for (const id of [neon.id, lights.id]) {
      save = { ...save, player: ok(buyItem(save, id, config)).snapshot.player }
    }
    save = withClout(save, 5000, config) as SaveState
    save = { ...save, player: ok(moveHome(save, 'brooklyn-1br', config)).snapshot.player }
    save = { ...save, player: ok(placeDecor(save, neon.id, 'wall-2', config)).snapshot.player }
    save = { ...save, player: ok(placeDecor(save, lights.id, 'wall-1', config)).snapshot.player }
    return syncGoals(save, config).save
  }

  it('marks decor kept, keeps it placed where the new home has the slot, and scores it 0', () => {
    const before = iconSave()
    expect(before.goals.achieved['reach-icon']).toBeDefined()
    const result = prestige(before, MS, config)
    if (!result.ok) throw new Error(result.error.code)
    const { player } = result.save
    expect(player.home).toBe(config.startHome)
    expect(player.inventory.decor.map((owned) => owned.itemId).sort()).toEqual(
      [lights.id, neon.id].sort(),
    )
    expect(player.inventory.decor.every((owned) => owned.prestigeKept === true)).toBe(true)
    // wall-2 is not in the Queens room, so the neon sign goes back to storage.
    expect(player.apartment.placed).toEqual({ 'wall-1': lights.id })
    expect(player.apartment.moveLog).toEqual(before.player.apartment.moveLog)
    expect(homeScore(player, config)).toBe(0)
    expect(totalClout(player, config)).toBe(0)
    expect(goalClout(player, config)).toBe(0)
    expect(schema.safeParse(result.save).success).toBe(true)
    expect(loadSave(JSON.parse(JSON.stringify(result.save)), config)).toEqual({
      ok: true,
      save: result.save,
      repaired: [],
    })
  })

  it('kept decor cannot be sold or bought again, but can still be placed and recoloured', () => {
    const result = prestige(iconSave(), MS, config)
    if (!result.ok) throw new Error(result.error.code)
    const save = result.save
    expect(sellItem(save, neon.id, config)).toEqual({
      ok: false,
      error: { code: 'PRESTIGE_KEPT', itemId: neon.id },
    })
    expect(buyItem(withCash(10_000, save), neon.id, config)).toEqual({
      ok: false,
      error: { code: 'ALREADY_OWNED', itemId: neon.id },
    })
    const placed = ok(placeDecor(save, neon.id, 'wall-1', config))
    expect(placed.levelUp).toBeNull()
    expect(homeClout(placed.snapshot.player, config)).toBe(0)
  })

  it('with the inventory reset, decor and placements start over', () => {
    const resetsInventory = {
      ...config,
      prestige: {
        ...config.prestige,
        resets: [...config.prestige.resets, 'inventory' as const],
        keeps: config.prestige.keeps.filter((part) => part !== 'inventory'),
      },
    }
    const result = prestige(iconSave(), MS, resetsInventory)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.save.player.inventory.decor).toEqual([])
    expect(result.save.player.apartment.placed).toEqual({})
  })
})
