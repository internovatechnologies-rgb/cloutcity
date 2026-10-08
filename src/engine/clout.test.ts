/**
 * S13 clout: the derived total, the typed ledger, item clout that cannot be farmed, style, the
 * premium cap, levels and level-ups. Numbers come from the shipped config (read, not written
 * as literals) unless a test pins its own.
 */
import { describe, expect, it } from 'vitest'
import { CLOUT_SOURCES } from '@/lib/data/cloutSources'
import { baseCopy } from '@/lib/copy/all'
import {
  appendClout,
  cloutBreakdown,
  cloutCeilings,
  cloutLevel,
  cloutProgress,
  cloutSums,
  initialCloutState,
  itemClout,
  recordClout,
  scaledGain,
  styleMultiplierPct,
  styleScore,
  totalClout,
  type CloutChange,
  type CloutState,
} from './clout'
import { engineConfig as config } from './config'
import { initialSnapshot, type GameSnapshot } from './game'
import { buyItem, equipItem, isWearable, sellItem, shopItems, unequipSlot } from './items'
import { workShift } from './jobs'
import { createRng } from './rng'
import {
  performPlaceActionHere as performPlaceAction,
  placeActionsHere as placeActions,
  withClout,
} from './test-support'
import { venues } from '@/lib/data/content'
import type { Venue } from '@/lib/data/schemas/content'

const levels = config.clout.levels
const minOf = (id: string) => {
  const level = levels.find((entry) => entry.id === id)
  if (level === undefined) throw new Error(`no level ${id}`)
  return level.minClout
}

function snapshotAt(minute = 600, cash = 100_000): GameSnapshot {
  const fresh = initialSnapshot(config)
  return { clock: { minute, remainderMs: 0 }, player: { ...fresh.player, cash } }
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

const wearables = shopItems(config).filter(isWearable)
const tee = wearables.find((item) => item.id === 'bodega-graphic-tee')
const puffer = wearables.find((item) => item.id === 'designer-puffer')
if (tee === undefined || puffer === undefined) throw new Error('shop items missing')

const event = (amount: number): CloutChange => ({
  source: 'event',
  amount,
  ref: { eventId: 'probe', choiceId: 'a' },
})

describe('levels (CLAUDE.md ladder)', () => {
  it('ships exactly six levels in order, named Nobody to Icon', () => {
    expect(levels.map((level) => level.id)).toEqual([
      'nobody',
      'local',
      'scene-regular',
      'known',
      'famous',
      'icon',
    ])
    const names = ['nobody', 'local', 'sceneRegular', 'known', 'famous', 'icon'].map(
      (id) => baseCopy.strings[`clout.levels.${id}.name`],
    )
    expect(names).toEqual(['Nobody', 'Local', 'Scene Regular', 'Known', 'Famous', 'Icon'])
  })

  it('every level above the first has a level-up message', () => {
    for (const id of ['local', 'sceneRegular', 'known', 'famous', 'icon']) {
      expect(baseCopy.strings[`clout.levelUp.${id}`], id).toBeTypeOf('string')
    }
  })

  it('progress is a whole percent toward the next level, full at the top', () => {
    const local = minOf('local')
    const scene = minOf('scene-regular')
    const at = (total: number) =>
      cloutProgress(withClout(snapshotAt(), total, config).player, config)
    expect(at(local - 1)).toMatchObject({ level: { id: 'nobody' }, next: { id: 'local' }, pct: 99 })
    expect(at(local)).toMatchObject({
      level: { id: 'local' },
      next: { id: 'scene-regular' },
      intoLevel: 0,
      levelSpan: scene - local,
      pct: 0,
      atMax: false,
    })
    expect(at(local + 1).pct).toBe(Math.floor((100 * 1) / (scene - local)))
    expect(at(minOf('icon') + 7)).toMatchObject({ next: null, pct: 100, atMax: true })
  })

  it('gates read the total, item clout included', () => {
    const owner = ok(buyItem(withClout(snapshotAt(), minOf('local') - 2, config), tee.id, config))
    expect(tee.cloutValue).toBeGreaterThanOrEqual(2)
    expect(cloutLevel(totalClout(owner.snapshot.player, config), config).id).toBe('local')
    const night = { ...owner.snapshot, clock: { minute: 23 * 60, remainderMs: 0 } }
    expect(config.place.clubs.glowmatic?.minCloutLevel).toBe('local')
    expect(performPlaceAction(night, findVenue('glowmatic'), 'club-night', config).ok).toBe(true)
  })
})

describe('the ledger', () => {
  it('records each source with its currency and reference, in seq order', () => {
    let snapshot = snapshotAt()
    const changes: CloutChange[] = [
      { source: 'paycheck', amount: 3, ref: { jobId: 'barista' } },
      {
        source: 'flex',
        amount: 4,
        ref: { placeId: 'dumbo', viral: false, placeMultiplier: 1.5, styleScore: 0, base: 4 },
      },
      { source: 'club', amount: 5, ref: { venueId: 'glowmatic', night: 1 } },
      event(6),
      { source: 'grant', amount: 7, ref: { grantKey: 'probe' } },
      { source: 'legacy', amount: 8, ref: {} },
      { source: 'repair', amount: 9, ref: {} },
      { source: 'item', amount: 2, ref: { itemId: tee.id, op: 'buy' } },
      { source: 'premium', amount: 10, ref: { itemId: 'probe-premium', op: 'grant' } },
    ]
    for (const change of changes) {
      snapshot = { ...snapshot, player: recordClout(snapshot, change, config).player }
    }
    const { ledger } = snapshot.player.clout
    expect(ledger.map((entry) => entry.source)).toEqual([...CLOUT_SOURCES])
    expect(ledger.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(ledger.map((entry) => entry.currency)).toEqual([...Array<string>(8).fill('cash'), 'usd'])
    // The flex entry stores what was applied (4 x 1.5), its ref keeps the base.
    expect(ledger[1]).toMatchObject({ amount: 6, ref: { base: 4, placeMultiplier: 1.5 } })
    expect(ledger.every((entry) => entry.at === 600)).toBe(true)
    // Item entries are audit only; premium counts up to the cap.
    const sums = cloutSums(snapshot.player.clout)
    expect(sums.earned).toBe(3 + 6 + 5 + 6 + 7 + 8 + 9)
    expect(sums.premium).toBe(10)
    expect(totalClout(snapshot.player, config)).toBe(sums.earned + 10)
  })

  it('a change that applies nothing writes nothing', () => {
    const result = recordClout(snapshotAt(), event(0), config)
    expect(result.entry).toBeNull()
    expect(result.player.clout).toBe(initialCloutState)
  })

  it('a loss is clamped at 0 earned, and the entry records what was applied', () => {
    const start = withClout(snapshotAt(), 5, config)
    const result = recordClout(start, event(-20), config)
    expect(result.entry).toMatchObject({ source: 'event', amount: -5 })
    expect(totalClout(result.player, config)).toBe(0)
    const again = recordClout({ ...start, player: result.player }, event(-3), config)
    expect(again.entry).toBeNull()
    expect(cloutSums(again.player.clout).earned).toBe(0)
  })

  it('a premium revoke never takes premium clout below 0', () => {
    const revoke: CloutChange = {
      source: 'premium',
      amount: -50,
      ref: { itemId: 'x', op: 'revoke' },
    }
    expect(recordClout(snapshotAt(), revoke, config).entry).toBeNull()
  })

  it('rejects amounts that are not whole numbers', () => {
    for (const amount of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => recordClout(snapshotAt(), event(amount), config)).toThrow(RangeError)
    }
  })

  it('compaction keeps per-source sums and the total identical (1,000 entries)', () => {
    const rng = createRng(13)
    const sources = ['paycheck', 'club', 'event', 'grant', 'item'] as const
    let state: CloutState = initialCloutState
    const expected = new Map<string, number>()
    let lastSeq = 0
    for (let i = 0; i < 1000; i++) {
      const source = sources[Math.floor(rng.next() * sources.length)] ?? 'event'
      const amount = 1 + Math.floor(rng.next() * 20)
      const change = { source, amount, ref: refOf(source) } as CloutChange
      const appended = appendClout(state, change, i, config)
      state = appended.state
      expect(appended.entry?.seq).toBe(lastSeq + 1)
      lastSeq = appended.entry?.seq ?? lastSeq
      expect(state.ledger.length).toBeLessThanOrEqual(config.clout.ledger.maxEntries)
      expected.set(source, (expected.get(source) ?? 0) + amount)
    }
    expect(state.ledger).toHaveLength(config.clout.ledger.maxEntries)
    expect(state.compacted.entries).toBe(1000 - config.clout.ledger.maxEntries)
    expect(cloutSums(state).bySource).toEqual(Object.fromEntries(expected))
    const earned = [...expected].filter(([s]) => s !== 'item').reduce((a, [, v]) => a + v, 0)
    expect(cloutSums(state).earned).toBe(earned)
    expect(state.nextSeq).toBe(1001)
  })
})

function refOf(source: string) {
  switch (source) {
    case 'paycheck':
      return { jobId: 'barista' }
    case 'club':
      return { venueId: 'glowmatic', night: 1 }
    case 'grant':
      return { grantKey: 'k' }
    case 'item':
      return { itemId: 'bodega-graphic-tee', op: 'buy' }
    default:
      return { eventId: 'probe', choiceId: 'a' }
  }
}

describe('item clout cannot be farmed', () => {
  it('50 buy/sell cycles of every wearable change no total, earned clout, peak or level-up', () => {
    // Earned clout just below Local, so the first purchase of a big item legitimately crosses.
    let snapshot = withClout(snapshotAt(600, 1_000_000), minOf('local') - 1, config)
    const before = cloutBreakdown(snapshot.player, config)
    let levelUps = 0
    for (let cycle = 0; cycle < 50; cycle++) {
      for (const item of wearables) {
        const bought = ok(buyItem(snapshot, item.id, config))
        if (bought.levelUp !== null) levelUps += 1
        const sold = ok(sellItem(bought.snapshot, item.id, config))
        expect(sold.levelUp).toBeNull()
        snapshot = sold.snapshot
        expect(totalClout(snapshot.player, config)).toBe(before.total)
      }
    }
    expect(levelUps).toBe(1)
    expect(cloutSums(snapshot.player.clout).earned).toBe(before.earned)
    expect(snapshot.player.clout.peakLevel).toBe(1)
    expect(snapshot.player.cash).toBeLessThan(1_000_000)
  })

  it('a seeded random buy/sell/equip/unequip sequence keeps total = earned + owned clout', () => {
    const rng = createRng(2026)
    let snapshot = withClout(snapshotAt(600, 1_000_000), 40, config)
    for (let step = 0; step < 2000; step++) {
      const item = wearables[Math.floor(rng.next() * wearables.length)] ?? tee
      const roll = rng.next()
      const result =
        roll < 0.35
          ? buyItem(snapshot, item.id, config)
          : roll < 0.65
            ? sellItem(snapshot, item.id, config)
            : roll < 0.85
              ? equipItem(snapshot, item.id, item.slot, config)
              : unequipSlot(snapshot, item.slot)
      if (result.ok) snapshot = result.snapshot
      const owned = snapshot.player.inventory.wearables.reduce(
        (sum, entry) => sum + (wearables.find((w) => w.id === entry.itemId)?.cloutValue ?? 0),
        0,
      )
      const total = totalClout(snapshot.player, config)
      expect(total).toBe(40 + owned)
      expect(Number.isSafeInteger(total)).toBe(true)
    }
  })

  it('selling removes the clout; equipping and unequipping change none', () => {
    const owned = ok(buyItem(snapshotAt(), puffer.id, config)).snapshot
    expect(totalClout(owned.player, config)).toBe(puffer.cloutValue)
    const worn = ok(equipItem(owned, puffer.id, puffer.slot, config)).snapshot
    expect(totalClout(worn.player, config)).toBe(puffer.cloutValue)
    expect(worn.player.clout).toBe(owned.player.clout)
    const off = ok(unequipSlot(worn, puffer.slot)).snapshot
    expect(off.player.clout).toBe(owned.player.clout)
    const sold = ok(sellItem(worn, puffer.id, config)).snapshot
    expect(totalClout(sold.player, config)).toBe(0)
    expect(sold.player.clout.ledger.at(-1)).toMatchObject({
      source: 'item',
      amount: -puffer.cloutValue,
      ref: { itemId: puffer.id, op: 'sell' },
    })
  })

  it('gifts carry no clout or style', () => {
    const gifts = config.items.catalog.filter((item) => item.category === 'gift')
    expect(gifts.length).toBeGreaterThan(0)
    for (const gift of gifts) expect(gift.styleValue, gift.id).toBe(0)
    const holding = ok(buyItem(snapshotAt(), gifts[0]?.id ?? '', config)).snapshot
    expect(itemClout(holding.player, config)).toBe(0)
    expect(holding.player.clout.ledger).toEqual([])
  })
})

describe('style', () => {
  it('scores what is worn, not what is owned', () => {
    const owned = ok(buyItem(snapshotAt(), puffer.id, config)).snapshot
    expect(styleScore(owned.player, config)).toBe(0)
    const worn = ok(equipItem(owned, puffer.id, puffer.slot, config)).snapshot
    expect(styleScore(worn.player, config)).toBe(puffer.styleValue)
  })

  it('the multiplier rises per point and is capped', () => {
    const { pctPerPoint, maxBonusPct } = config.clout.style
    expect(styleMultiplierPct(0, config)).toBe(100)
    expect(styleMultiplierPct(5, config)).toBe(100 + 5 * pctPerPoint)
    expect(styleMultiplierPct(10_000, config)).toBe(100 + maxBonusPct)
    // The best outfit the shop can build reaches the cap.
    const best = new Map<string, number>()
    for (const item of wearables)
      best.set(item.slot, Math.max(best.get(item.slot) ?? 0, item.styleValue))
    const top = [...best.values()].reduce((a, b) => a + b, 0)
    expect(styleMultiplierPct(top, config)).toBe(100 + maxBonusPct)
  })

  it('scales only the configured sources, floors, and never rounds a gain to 0', () => {
    const worn = ok(
      equipItem(
        ok(buyItem(snapshotAt(), puffer.id, config)).snapshot,
        puffer.id,
        puffer.slot,
        config,
      ),
    ).snapshot
    const pct = styleMultiplierPct(puffer.styleValue, config)
    expect(config.clout.style.appliesTo).toEqual(['flex', 'event', 'paycheck'])
    for (const source of config.clout.style.appliesTo) {
      expect(scaledGain(10, source, 1, worn.player, config), source).toBe(
        Math.floor((10 * pct) / 100),
      )
    }
    for (const source of ['club', 'item', 'premium', 'grant', 'legacy', 'repair'] as const) {
      expect(scaledGain(10, source, 1, worn.player, config), source).toBe(10)
    }
    expect(scaledGain(1, 'event', 1, snapshotAt().player, config)).toBe(1)
    expect(scaledGain(1, 'flex', 1.25, snapshotAt().player, config)).toBe(1)
    expect(scaledGain(4, 'flex', 1.25, snapshotAt().player, config)).toBe(5)
    // Losses are never scaled.
    expect(scaledGain(-10, 'event', 1, worn.player, config)).toBe(-10)
  })
})

describe('premium cap', () => {
  const cap = config.clout.caps.byCurrency.usd

  it('the cap stays below the top level, so premium clout alone never reaches Icon', () => {
    expect(cap).toBeLessThan(minOf('icon'))
    const grant: CloutChange = {
      source: 'premium',
      amount: 1_000_000,
      ref: { itemId: 'whale', op: 'grant' },
    }
    const result = recordClout(snapshotAt(), grant, config)
    expect(cloutBreakdown(result.player, config)).toMatchObject({
      premium: cap,
      premiumRaw: 1_000_000,
      total: cap,
    })
    expect(cloutLevel(totalClout(result.player, config), config).id).not.toBe('icon')
  })
})

describe('first paycheck', () => {
  it('pays its clout once, on the first shift ever', () => {
    const first = ok(workShift(snapshotAt(480, 0), 'barista', config))
    expect(first.cloutGained).toBe(config.clout.sources.firstPaycheck)
    expect(first.snapshot.player.clout.firstPaycheckPaid).toBe(true)
    expect(first.snapshot.player.clout.ledger).toEqual([
      expect.objectContaining({ source: 'paycheck', ref: { jobId: 'barista' } }),
    ])
    const second = ok(workShift(first.snapshot, 'retail', config))
    expect(second.cloutGained).toBe(0)
    expect(totalClout(second.snapshot.player, config)).toBe(config.clout.sources.firstPaycheck)
  })
})

describe('level-ups', () => {
  const justBelow = (id: string) => withClout(snapshotAt(23 * 60), minOf(id) - 1, config)

  it('fire once on the first crossing, from every source', () => {
    const paycheck = ok(
      workShift(withClout(snapshotAt(480), minOf('local') - 1, config), 'barista', config),
    )
    expect(paycheck.levelUp).toMatchObject({
      fromPeak: 'nobody',
      to: 'local',
      toIndex: 1,
      source: 'paycheck',
    })

    const night = withClout(snapshotAt(23 * 60), minOf('scene-regular') - 1, config)
    const club = ok(performPlaceAction(night, findVenue('glowmatic'), 'club-night', config))
    expect(club.levelUp).toMatchObject({ to: 'scene-regular', source: 'club' })

    const item = ok(buyItem(justBelow('local'), tee.id, config))
    expect(item.levelUp).toMatchObject({ to: 'local', source: 'item' })

    const chosen = recordClout(justBelow('known'), event(1), config)
    expect(chosen.levelUp).toMatchObject({ to: 'known', source: 'event' })
    const after = recordClout({ ...justBelow('known'), player: chosen.player }, event(1), config)
    expect(after.levelUp).toBeNull()
  })

  it('a multi-level jump is one event listing every unlock on the way', () => {
    const result = recordClout(snapshotAt(), event(minOf('known')), config)
    expect(result.levelUp).toMatchObject({ fromPeak: 'nobody', to: 'known', toIndex: 3 })
    expect(result.levelUp?.unlocks).toEqual({
      boroughs: ['brooklyn', 'manhattan'],
      jobs: ['junior-dev'],
      clubs: ['glowmatic', 'brickwave', 'afterglass'],
    })
    expect(result.player.clout.peakLevel).toBe(3)
  })

  it('fromPeak is the old peak, even when the player had dropped below it', () => {
    // Reach Local through an item, sell it (back to Nobody), then earn past Scene Regular.
    const bought = ok(buyItem(justBelow('local'), tee.id, config))
    expect(bought.levelUp).toMatchObject({ fromPeak: 'nobody', to: 'local' })
    const sold = ok(sellItem(bought.snapshot, tee.id, config))
    expect(cloutLevel(totalClout(sold.snapshot.player, config), config).id).toBe('nobody')
    const climb = minOf('scene-regular') - totalClout(sold.snapshot.player, config)
    const result = recordClout(sold.snapshot, event(climb), config)
    expect(result.levelUp).toMatchObject({ fromPeak: 'local', to: 'scene-regular' })
    // Only what lies above the old peak counts as newly unlocked.
    expect(result.levelUp?.unlocks).toEqual({
      boroughs: ['manhattan'],
      jobs: [],
      clubs: ['brickwave'],
    })
  })

  it('does not replay after a drop and a climb back (sell and rebuy)', () => {
    const below = justBelow('local')
    const bought = ok(buyItem(below, tee.id, config))
    expect(bought.levelUp).not.toBeNull()
    const sold = ok(sellItem(bought.snapshot, tee.id, config))
    expect(cloutLevel(totalClout(sold.snapshot.player, config), config).id).toBe('nobody')
    const rebought = ok(buyItem(sold.snapshot, tee.id, config))
    expect(rebought.levelUp).toBeNull()
  })

  it('unlocks match the config', () => {
    const local = recordClout(justBelow('local'), event(1), config).levelUp
    expect(local?.unlocks).toEqual({
      boroughs: ['brooklyn'],
      jobs: ['junior-dev'],
      clubs: ['glowmatic'],
    })
  })
})

describe('ceilings (S18c)', () => {
  it('bound every source the bots and players can use', () => {
    const ceilings = cloutCeilings(config)
    const { flex, style } = config.clout
    const topPlace = Math.max(...Object.values(config.place.flexMultiplier.byLandmark))
    expect(ceilings.bySource.flex?.perAction).toBe(
      Math.floor(
        (flex.baseClout * flex.viral.cloutMultiplier * topPlace * (100 + style.maxBonusPct)) / 100,
      ),
    )
    expect(ceilings.bySource.flex?.perGameDay).toBe(
      (ceilings.bySource.flex?.perAction ?? 0) * flex.maxPerGameDay,
    )
    expect(ceilings.bySource.paycheck?.perAction).toBe(
      Math.floor((config.clout.sources.firstPaycheck * (100 + style.maxBonusPct)) / 100),
    )
    expect(ceilings.premiumCap).toBe(config.clout.caps.byCurrency.usd)
    expect(ceilings.itemCloutMax).toBe(wearables.reduce((sum, item) => sum + item.cloutValue, 0))
    for (const ceiling of Object.values(ceilings.bySource)) {
      expect(ceiling?.perGameDay ?? 0).toBeGreaterThanOrEqual(ceiling?.perAction ?? 0)
    }
  })
})

function findVenue(id: string): Venue {
  const venue = venues.find((entry) => entry.id === id)
  if (venue === undefined) throw new Error(`no venue ${id}`)
  return venue
}

describe('nightlife is flavour only (user rule): style never multiplies club clout', () => {
  it('a fully dressed player gets exactly the configured club clout, as the sheet promises', () => {
    let dressed = withClout(snapshotAt(23 * 60), minOf('known'), config)
    for (const item of wearables.filter((entry) => entry.rarity === 'rare')) {
      dressed = ok(buyItem(dressed, item.id, config)).snapshot
      dressed = ok(equipItem(dressed, item.id, item.slot, config)).snapshot
    }
    expect(styleMultiplierPct(styleScore(dressed.player, config), config)).toBeGreaterThan(100)
    expect(config.clout.style.appliesTo).not.toContain('club')
    for (const [clubId, rule] of Object.entries(config.place.clubs)) {
      const venue = findVenue(clubId)
      const view = placeActions(venue, dressed, config)
      const preview =
        view.kind === 'actions' ? view.actions.find((a) => a.id === 'club-night') : undefined
      expect(preview?.kind === 'club-night' && preview.cloutGain, clubId).toBe(rule.cloutGain)
      const night = ok(performPlaceAction(dressed, venue, 'club-night', config))
      expect(night.cloutGained, clubId).toBe(rule.cloutGain)
      expect(night.snapshot.player.clout.ledger.at(-1)).toMatchObject({
        source: 'club',
        amount: rule.cloutGain,
      })
    }
    expect(scaledGain(25, 'club', 1, dressed.player, config)).toBe(25)
  })
})
