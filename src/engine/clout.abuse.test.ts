/**
 * S13 adversarial probes: ways a player (or a tampered save) might farm clout, replay a
 * level-up or re-roll a flex, across the item, flex, event, ledger and save paths together.
 * Numbers come from the shipped config unless a test pins its own.
 */
import { describe, expect, it } from 'vitest'
import { landmarks, venues } from '@/lib/data/content'
import {
  cloutBreakdown,
  cloutSums,
  legacyCloutState,
  playerLevel,
  recordClout,
  styleScore,
  totalClout,
  type CloutChange,
} from './clout'
import { engineConfig as config } from './config'
import { performFlex } from './flex'
import { initialSnapshot, type GameSnapshot } from './game'
import { buyItem, equipItem, isWearable, sellItem, shopItems, unequipSlot } from './items'
import { workShift } from './jobs'
import type { Place } from './places'
import { createSaveSchema, initialSave, loadSave, migrateSave, type SaveState } from './save'
import {
  performPlaceActionHere as performPlaceAction,
  placeActionsHere as placeActions,
  withClout,
} from './test-support'

const DAY = 24 * 60
const schema = createSaveSchema(config)
const levels = config.clout.levels
const minOf = (id: string) => {
  const level = levels.find((entry) => entry.id === id)
  if (level === undefined) throw new Error(`no level ${id}`)
  return level.minClout
}

function place(id: string): Place {
  const found = [...landmarks, ...venues].find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

/** Day `day` (1-based) at minute-of-day `minuteOfDay`, `clout` total, plenty of cash. */
function at(day: number, minuteOfDay: number, clout = 5000, cash = 1_000_000): GameSnapshot {
  const fresh = initialSnapshot(config)
  const snapshot = {
    clock: { minute: (day - 1) * DAY + minuteOfDay, remainderMs: 0 },
    player: { ...fresh.player, cash },
  }
  return withClout(snapshot, clout, config)
}

/** A full save around a snapshot, through JSON as the store would persist it. */
function persisted(snapshot: GameSnapshot): unknown {
  const save: SaveState = { ...initialSave(config), ...snapshot }
  return JSON.parse(JSON.stringify(save)) as unknown
}

function reload(snapshot: GameSnapshot): SaveState {
  const result = loadSave(persisted(snapshot), config)
  if (!result.ok) throw new Error('expected the save to load')
  expect(result.repaired).toEqual([])
  return result.save
}

const event = (amount: number): CloutChange => ({
  source: 'event',
  amount,
  ref: { eventId: 'probe', choiceId: 'a' },
})

const wearables = shopItems(config).filter(isWearable)
const byClout = [...wearables].sort((a, b) => b.cloutValue - a.cloutValue)
const top = byClout[0]
if (top === undefined) throw new Error('no wearables')

describe('farming probes', () => {
  it('a level reached through item clout is not replayed when earned clout climbs back after selling', () => {
    const below = at(1, 600, minOf('local') - 1)
    const bought = ok(buyItem(below, top.id, config))
    expect(bought.levelUp).toMatchObject({ to: 'local', source: 'item' })
    const sold = ok(sellItem(bought.snapshot, top.id, config))
    expect(playerLevel(sold.snapshot.player, config).id).toBe('nobody')
    // Earn the way back with an event, then a flex: neither reports Local again.
    const back = recordClout(sold.snapshot, event(1), config)
    expect(playerLevel(back.player, config).id).toBe('local')
    expect(back.levelUp).toBeNull()
    const flexed = ok(
      performFlex({ ...sold.snapshot, player: back.player }, place('queens-ballpark'), config),
    )
    expect(flexed.levelUp).toBeNull()
  })

  it('selling a worn item takes its clout and its style, and writes one audit entry', () => {
    const owned = ok(buyItem(at(1, 600, 0), top.id, config)).snapshot
    const worn = ok(equipItem(owned, top.id, top.slot, config)).snapshot
    expect(styleScore(worn.player, config)).toBe(top.styleValue)
    const seq = worn.player.clout.nextSeq
    const sold = ok(sellItem(worn, top.id, config)).snapshot
    expect(totalClout(sold.player, config)).toBe(0)
    expect(styleScore(sold.player, config)).toBe(0)
    expect(sold.player.inventory.outfit[top.slot]).toBeUndefined()
    expect(sold.player.clout.nextSeq).toBe(seq + 1)
    expect(sold.player.cash).toBeLessThan(at(1, 600, 0).player.cash)
  })

  it('equip/unequip loops write no ledger entry and never move the total', () => {
    let snapshot = ok(buyItem(at(1, 600, 0), top.id, config)).snapshot
    const clout = snapshot.player.clout
    for (let i = 0; i < 200; i++) {
      snapshot = ok(equipItem(snapshot, top.id, top.slot, config)).snapshot
      snapshot = ok(unequipSlot(snapshot, top.slot)).snapshot
    }
    expect(snapshot.player.clout).toEqual(clout)
  })

  it('a buy/sell loop that floods the ledger past compaction keeps earned clout, peak and total', () => {
    let snapshot = at(1, 600, 0)
    // Real earned clout first, so compaction must fold it rather than lose it.
    for (const amount of [7, 11, 13]) {
      snapshot = { ...snapshot, player: recordClout(snapshot, event(amount), config).player }
    }
    const before = cloutBreakdown(snapshot.player, config)
    const peak = snapshot.player.clout.peakLevel
    for (let cycle = 0; cycle < 3 * config.clout.ledger.maxEntries; cycle++) {
      snapshot = ok(buyItem(snapshot, top.id, config)).snapshot
      snapshot = ok(sellItem(snapshot, top.id, config)).snapshot
    }
    const { clout } = snapshot.player
    expect(clout.ledger.length).toBeLessThanOrEqual(config.clout.ledger.maxEntries)
    expect(clout.compacted.entries).toBeGreaterThan(0)
    expect(cloutBreakdown(snapshot.player, config)).toEqual(before)
    expect(cloutSums(clout).bySource.event).toBe(31)
    expect(clout.peakLevel).toBe(peak)
    expect(schema.safeParse(persisted(snapshot)).success).toBe(true)
  })

  it('premium clout above the cap, then revoked, never counts past the cap or below 0', () => {
    const cap = config.clout.caps.byCurrency.usd
    const premium = (amount: number, op: 'grant' | 'revoke'): CloutChange => ({
      source: 'premium',
      amount,
      ref: { itemId: 'probe', op },
    })
    let snapshot = at(1, 600, 0)
    snapshot = {
      ...snapshot,
      player: recordClout(snapshot, premium(cap * 3, 'grant'), config).player,
    }
    expect(totalClout(snapshot.player, config)).toBe(cap)
    snapshot = {
      ...snapshot,
      player: recordClout(snapshot, premium(-cap, 'revoke'), config).player,
    }
    expect(totalClout(snapshot.player, config)).toBe(cap)
    snapshot = {
      ...snapshot,
      player: recordClout(snapshot, premium(-cap * 10, 'revoke'), config).player,
    }
    expect(cloutSums(snapshot.player.clout).premium).toBe(0)
    expect(totalClout(snapshot.player, config)).toBe(0)
  })
})

describe('reload probes', () => {
  it('a flex cannot be re-rolled by reloading the save it started from', () => {
    const start = at(2, 12 * 60)
    const ballpark = place('queens-ballpark')
    const first = ok(performFlex(start, ballpark, config))
    const again = ok(performFlex(reload(start), ballpark, config))
    expect(again.viral).toBe(first.viral)
    expect(again.cloutGained).toBe(first.cloutGained)
    expect(again.snapshot.player.flex).toEqual(first.snapshot.player.flex)
    // And the save written after the flex remembers it.
    const after = reload(first.snapshot)
    expect(performFlex(after, ballpark, config)).toMatchObject({
      ok: false,
      error: { code: 'FLEX_LIMIT' },
    })
  })

  it('the first paycheck is paid once across a save and reload', () => {
    const morning = at(1, 8 * 60, 0)
    const first = ok(workShift(morning, 'barista', config))
    expect(first.cloutGained).toBe(config.clout.sources.firstPaycheck)
    const reloaded = reload(first.snapshot)
    expect(reloaded.player.clout.firstPaycheckPaid).toBe(true)
    expect(ok(workShift(reloaded, 'barista', config)).cloutGained).toBe(0)
  })

  it('a level reached before a reload is never reported again after it', () => {
    const crossed = recordClout(at(1, 600, minOf('local') - 1), event(1), config)
    expect(crossed.levelUp).not.toBeNull()
    const reloaded = reload({ ...at(1, 600), player: crossed.player })
    expect(recordClout(reloaded, event(1), config).levelUp).toBeNull()
  })
})

describe('flex across midnight', () => {
  const bridge = place('brooklyn-bridge')
  const flexAt = (snapshot: GameSnapshot, spot: Place) =>
    ok(performPlaceAction(snapshot, spot, 'flex', config)).snapshot

  it('a flex that starts before midnight counts for the day it started, and only that day', () => {
    const late = flexAt(at(4, DAY - 10), bridge)
    // The flex ran past midnight: it is day 5 now, and day 4's flex there is used up.
    expect(Math.floor(late.clock.minute / DAY) + 1).toBe(5)
    expect(late.player.flex.byPlace).toEqual({ [bridge.id]: 4 })
    const view = placeActions(bridge, late, config)
    expect(view.kind === 'actions' && view.actions.find((a) => a.kind === 'flex')?.block).toBeNull()
    const next = flexAt(late, bridge)
    // Pruned to today's flexes only.
    expect(next.player.flex.byPlace).toEqual({ [bridge.id]: 5 })
  })

  it('the daily limit counts the flexes started today, not yesterday', () => {
    const { maxPerGameDay, durationMin } = config.clout.flex
    const spots = ['central-park', 'dumbo', 'high-line', 'times-square'].map(place)
    // Every flex starts on day 6; the last one ends on day 7.
    let snapshot = at(6, DAY - (maxPerGameDay - 1) * durationMin - 10)
    for (const spot of spots.slice(0, maxPerGameDay)) snapshot = flexAt(snapshot, spot)
    expect(Math.floor(snapshot.clock.minute / DAY) + 1).toBe(7)
    // Day 7 has no flexes yet: the limit does not carry over midnight.
    const last = spots[maxPerGameDay] as Place
    const view = placeActions(last, snapshot, config)
    expect(view.kind === 'actions' && view.actions.find((a) => a.kind === 'flex')?.block).toBeNull()
  })
})

describe('save repair probes (tampered saves never break loading or the safe-integer rule)', () => {
  const base = { ...initialSave(config), clock: { minute: 10 * DAY, remainderMs: 0 } }
  const loadWith = (clout: unknown) => {
    const result = loadSave({ ...base, player: { ...base.player, clout } }, config)
    if (!result.ok) throw new Error('expected a repaired save')
    return result
  }
  const big = Number.MAX_SAFE_INTEGER

  it('folded totals that sum past a safe integer are repaired into a valid save', () => {
    const result = loadWith({
      ...legacyCloutState(0, 0),
      compacted: { entries: 2, bySource: { legacy: big, event: big } },
    })
    expect(Number.isSafeInteger(totalClout(result.save.player, config))).toBe(true)
    expect(schema.safeParse(result.save).success).toBe(true)
  })

  it('folded losses that sum past a safe integer load instead of throwing', () => {
    expect(() =>
      loadWith({
        ...legacyCloutState(0, 0),
        compacted: { entries: 2, bySource: { legacy: -big, event: -big } },
      }),
    ).not.toThrow()
    const result = loadWith({
      ...legacyCloutState(0, 0),
      compacted: { entries: 2, bySource: { legacy: -big, event: -big } },
    })
    expect(totalClout(result.save.player, config)).toBe(0)
    expect(schema.safeParse(result.save).success).toBe(true)
  })

  it('a v6 save whose pending event clout overflows the legacy clout migrates to a valid save', () => {
    const player: Record<string, unknown> = { ...base.player, clout: big }
    delete player.flex
    const source = { type: 'event', eventId: 'e', choiceId: 'a' }
    const events = {
      ...base.events,
      pending: [{ kind: 'clout', amount: big, source }],
    }
    const migrated = migrateSave({ ...base, player, events }, 6, config)
    expect(Number.isSafeInteger(totalClout(migrated.save.player, config))).toBe(true)
    expect(schema.safeParse(migrated.save).success).toBe(true)
  })
})
