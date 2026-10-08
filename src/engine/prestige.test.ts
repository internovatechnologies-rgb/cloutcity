/** Prestige (S15): the badge through the grant function, then a new run, atomically. */
import { describe, expect, it } from 'vitest'
import {
  appendClout,
  cloutSums,
  goalClout,
  itemClout,
  playerLevel,
  styleScore,
  totalClout,
} from './clout'
import { engineConfig as config, type EngineConfig } from './config'
import { initialGoalsState, syncGoals } from './goals'
import { grant } from './grants'
import { buyItem, equipItem, isWearable, sellItem, shopItems, unequipSlot } from './items'
import { canPrestige, prestige } from './prestige'
import { createSaveSchema, initialSave, type SaveState } from './save'
import { playerWithClout } from './test-support'

const NOW = 50_000
const MS = 1_760_000_000_000
const schema = createSaveSchema(config)
const wearable = (() => {
  const found = shopItems(config).find(isWearable)
  if (found === undefined) throw new Error('no wearable')
  return found
})()

/** A run at Icon: earned clout, a premium entry, an item, visits, an event history, cash. */
function iconSave(cfg: EngineConfig = config): SaveState {
  const base = initialSave(cfg)
  let player = playerWithClout({ ...base.player, cash: 9000 }, 5000, cfg)
  const bought = buyItem({ ...base, player }, wearable.id, cfg)
  if (!bought.ok) throw new Error(bought.error.code)
  player = bought.snapshot.player
  const premium = appendClout(
    player.clout,
    { source: 'premium', amount: 120, ref: { itemId: 'premium-probe', op: 'grant' } },
    NOW,
    cfg,
  ).state
  player = {
    ...player,
    clout: { ...premium, firstPaycheckPaid: true },
    home: 'brooklyn-1br',
    rent: { owed: 30, missed: 1 },
    stats: { energy: 12, hunger: 34, mood: 56 },
    flex: { rngState: 777, byPlace: { 'brooklyn-bridge': 34 } },
    clubNights: { 'probe-club': 30 },
    visited: { 'brooklyn-bridge': 100 },
  }
  const save: SaveState = {
    ...base,
    clock: { minute: NOW, remainderMs: 123 },
    speed: 2,
    player,
    events: { active: null, history: { 'probe-event': 40 }, pending: [], rngState: 4242 },
  }
  return syncGoals(save, cfg).save
}

describe('canPrestige', () => {
  it('needs the victory goal reached this run, and no open event', () => {
    expect(canPrestige(initialSave(config), config)).toEqual({ code: 'NOT_YET' })
    const icon = iconSave()
    expect(canPrestige(icon, config)).toBeNull()
    const busy = { ...icon, events: { ...icon.events, active: 'probe-event' } }
    expect(canPrestige(busy, config)).toEqual({ code: 'EVENT_OPEN' })
    expect(prestige(busy, MS, config)).toEqual({ ok: false, error: { code: 'EVENT_OPEN' } })
    expect(prestige(initialSave(config), MS, config)).toEqual({
      ok: false,
      error: { code: 'NOT_YET' },
    })
  })
})

describe('prestige', () => {
  const before = iconSave()
  const result = prestige(before, MS, config)
  if (!result.ok) throw new Error(result.error.code)
  const after = result.save
  const fresh = initialSave(config)

  it('grants the run badge through the grant function, logged under the victory key', () => {
    expect(result.badge).toBe('prestige-1')
    expect(result.grant).toMatchObject({
      key: 'goal:reach-icon:r1',
      applied: { cash: 0, clout: 0, badge: 'prestige-1' },
      issuedAtMs: MS,
    })
    expect(after.grants.log.map((record) => record.key)).toEqual(['goal:reach-icon:r1'])
  })

  it('records the finished run and keeps prestige, the clock and speed', () => {
    expect(after.prestige).toEqual({
      count: 1,
      badges: ['prestige-1'],
      history: [{ run: 1, endedAt: NOW, issuedAtMs: MS, badge: 'prestige-1' }],
    })
    expect(after.clock).toEqual(before.clock)
    expect(after.speed).toBe(2)
  })

  it('resets cash, stats, home, rent, gifts, flexes, club nights, visits, events and goals', () => {
    expect(after.player.cash).toBe(config.startCash)
    expect(after.player.stats).toEqual(fresh.player.stats)
    expect(after.player.home).toBe(config.startHome)
    expect(after.player.rent).toEqual({ owed: 0, missed: 0 })
    expect(after.player.inventory.gifts).toEqual([])
    expect(after.player.flex).toEqual({ rngState: 777, byPlace: {} })
    expect(after.player.clubNights).toEqual({})
    expect(after.player.visited).toEqual({})
    expect(after.events).toEqual({ active: null, history: {}, pending: [], rngState: 4242 })
    expect(after.goals).toEqual({ ...initialGoalsState, run: 2 })
  })

  it('starts clout at zero earned but keeps premium clout, with seq carrying on', () => {
    const sums = cloutSums(after.player.clout)
    expect(sums.earned).toBe(0)
    expect(sums.premium).toBe(120)
    expect(after.player.clout.ledger).toEqual([])
    expect(after.player.clout.nextSeq).toBe(before.player.clout.nextSeq)
    expect(after.player.clout.firstPaycheckPaid).toBe(false)
    expect(totalClout(after.player, config)).toBe(120)
    expect(playerLevel(after.player, config).id).toBe('local')
    expect(after.player.clout.peakLevel).toBe(playerLevel(after.player, config).index)
  })

  it('premium clout reaches no goal in the new run (goal clout excludes it)', () => {
    expect(syncGoals(after, config).newlyAchieved).toEqual([])
  })

  it('the result is a valid save, and the new run can earn and be rewarded again', () => {
    expect(schema.safeParse(after).success).toBe(true)
    const reached = syncGoals(
      {
        ...after,
        player: { ...after.player, clout: { ...after.player.clout, firstPaycheckPaid: true } },
      },
      config,
    ).save
    const paid = grant(
      reached,
      { kind: 'goal_reward', goalId: 'first-paycheck', reward: { cash: 25, clout: 5 } },
      MS,
      config,
    )
    if (!paid.ok) throw new Error(paid.error.code)
    expect(paid.record.key).toBe('goal:first-paycheck:r2')
  })

  it('a claimed victory reward is replayed, never a second badge', () => {
    const claimed = grant(
      before,
      { kind: 'goal_reward', goalId: 'reach-icon', reward: { badge: true } },
      MS - 5,
      config,
    )
    if (!claimed.ok) throw new Error(claimed.error.code)
    const again = prestige(claimed.save, MS, config)
    if (!again.ok) throw new Error(again.error.code)
    expect(again.grant).toEqual(claimed.record)
    expect(again.save.prestige.badges).toEqual(['prestige-1'])
    expect(again.save.grants.log).toHaveLength(1)
  })

  it('the second run earns the second badge', () => {
    const run2 = syncGoals(
      { ...after, player: playerWithClout(after.player, 5000, config) },
      config,
    ).save
    const second = prestige(run2, MS + 1, config)
    if (!second.ok) throw new Error(second.error.code)
    expect(second.badge).toBe('prestige-2')
    expect(second.save.prestige.badges).toEqual(['prestige-1', 'prestige-2'])
    expect(second.save.goals.run).toBe(3)
  })

  it('is atomic: the input save is never changed', () => {
    const copy = structuredClone(before)
    prestige(before, MS, config)
    expect(before).toEqual(copy)
  })

  it('follows the config lists: inventory starts over when resets lists it', () => {
    const resetItems: EngineConfig = {
      ...config,
      prestige: {
        ...config.prestige,
        keeps: config.prestige.keeps.filter((part) => part !== 'inventory'),
        resets: [...config.prestige.resets, 'inventory'],
      },
    }
    const reset = prestige(iconSave(resetItems), MS, resetItems)
    if (!reset.ok) throw new Error(reset.error.code)
    expect(reset.save.player.inventory).toEqual(fresh.player.inventory)
  })
})

describe('prestige keeps outfits as looks only (user ruling Q-8, ECON-1)', () => {
  const gift = shopItems(config).find((item) => !isWearable(item))
  if (gift === undefined) throw new Error('no gift')
  /** Icon with the wearable equipped, a second wearable owned but never worn, and a gift. */
  function dressedIcon(): SaveState {
    const base = iconSave()
    let snapshot: SaveState = base
    const second = shopItems(config).find(
      (item) => isWearable(item) && item.id !== wearable.id && item.slot !== wearable.slot,
    )
    if (second === undefined) throw new Error('no second wearable')
    for (const id of [second.id, gift?.id ?? '']) {
      const bought = buyItem(snapshot, id, config)
      if (!bought.ok) throw new Error(bought.error.code)
      snapshot = { ...snapshot, player: bought.snapshot.player }
    }
    const worn = equipItem(snapshot, wearable.id, wearable.slot, config)
    if (!worn.ok) throw new Error(worn.error.code)
    return syncGoals({ ...snapshot, player: worn.snapshot.player }, config).save
  }

  const before = dressedIcon()
  const result = prestige(before, MS, config)
  if (!result.ok) throw new Error(result.error.code)
  const after = result.save
  const { inventory } = after.player

  it('keeps every owned wearable and the outfit, marked kept and worn; gifts start over', () => {
    expect(config.prestige.keeps).toContain('inventory')
    expect(inventory.wearables.map((owned) => owned.itemId)).toEqual(
      before.player.inventory.wearables.map((owned) => owned.itemId),
    )
    expect(inventory.wearables.every((owned) => owned.prestigeKept === true && owned.worn)).toBe(
      true,
    )
    expect(inventory.outfit).toEqual(before.player.inventory.outfit)
    expect(inventory.outfit[wearable.slot]).toBe(wearable.id)
    expect(inventory.gifts).toEqual([])
    expect(schema.safeParse(after).success).toBe(true)
  })

  it('kept looks add 0 item clout and 0 style; goal and total clout carry nothing over', () => {
    expect(itemClout(after.player, config)).toBe(0)
    expect(styleScore(after.player, config)).toBe(0)
    expect(goalClout(after.player, config)).toBe(0)
    expect(totalClout(after.player, config)).toBe(120) // premium only
    expect(syncGoals(after, config).newlyAchieved).toEqual([])
  })

  it('the shop refuses to buy a kept look back, and it cannot be bought twice', () => {
    expect(sellItem(after, wearable.id, config)).toEqual({
      ok: false,
      error: { code: 'PRESTIGE_KEPT', itemId: wearable.id },
    })
    const rich = { ...after, player: { ...after.player, cash: 10_000 } }
    expect(buyItem(rich, wearable.id, config)).toEqual({
      ok: false,
      error: { code: 'ALREADY_OWNED', itemId: wearable.id },
    })
  })

  it('stays wearable: off and on again, with no stat effects landing again', () => {
    const off = unequipSlot(after, wearable.slot)
    if (!off.ok) throw new Error(off.error.code)
    const on = equipItem(
      { ...after, player: off.snapshot.player },
      wearable.id,
      wearable.slot,
      config,
    )
    if (!on.ok) throw new Error(on.error.code)
    expect(on.snapshot.player.inventory.outfit[wearable.slot]).toBe(wearable.id)
    expect(on.snapshot.player.stats).toEqual(after.player.stats)
  })

  it('a wearable bought in the new run counts in full', () => {
    const extra = shopItems(config).find(
      (item) => isWearable(item) && !inventory.wearables.some((o) => o.itemId === item.id),
    )
    if (extra === undefined) throw new Error('no unowned wearable')
    const bought = buyItem(
      { ...after, player: { ...after.player, cash: 10_000 } },
      extra.id,
      config,
    )
    if (!bought.ok) throw new Error(bought.error.code)
    expect(itemClout(bought.snapshot.player, config)).toBe(isWearable(extra) ? extra.cloutValue : 0)
  })
})
