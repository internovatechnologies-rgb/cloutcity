/**
 * S13 flexing: where it is allowed, how often, the seeded viral roll weighted by style and the
 * place multiplier, and that memorials refuse it every way.
 */
import { describe, expect, it } from 'vitest'
import { landmarks, venues } from '@/lib/data/content'
import { totalClout } from './clout'
import { engineConfig as config } from './config'
import { flexMultiplier, flexPlaceMultiplier, performFlex, viralChance } from './flex'
import { initialSnapshot, type GameSnapshot } from './game'
import { buyItem, equipItem, isWearable, shopItems } from './items'
import type { PlaceAction } from './placeActions'
import type { Place } from './places'
import { createRng, mixSeed } from './rng'
import {
  performPlaceActionHere as performPlaceAction,
  placeActionsHere as placeActions,
  withClout,
} from './test-support'

const DAY = 24 * 60
const { flex } = config.clout

function place(id: string): Place {
  const found = [...landmarks, ...venues].find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}

/** Day `day` (1-based) at `hour`, high clout so every borough is open, plenty of cash. */
function snapshotAt(day = 1, hour = 12, clout = 5000): GameSnapshot {
  const fresh = initialSnapshot(config)
  const snapshot = {
    clock: { minute: (day - 1) * DAY + hour * 60, remainderMs: 0 },
    player: { ...fresh.player, cash: 10_000 },
  }
  return withClout(snapshot, clout, config)
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`)
  return result as Extract<T, { ok: true }>
}

function flexAction(view: ReturnType<typeof placeActions>): Extract<PlaceAction, { kind: 'flex' }> {
  if (view.kind !== 'actions') throw new Error('look-only')
  const found = view.actions.find((action) => action.kind === 'flex')
  if (found === undefined || found.kind !== 'flex') throw new Error('no flex')
  return found
}

const bridge = place('brooklyn-bridge')
const ballpark = place('queens-ballpark')
const memorial = place('september-11-memorial')

describe('where a flex is allowed', () => {
  it('landmarks use their configured multiplier, others the default', () => {
    expect(flexPlaceMultiplier(bridge, config)).toBe(2)
    expect(flexPlaceMultiplier(place('central-park'), config)).toBe(1.5)
    expect(flexPlaceMultiplier(ballpark, config)).toBe(1.25)
    const unlisted = landmarks.find(
      (entry) =>
        entry.category !== 'memorial' &&
        entry.interactions.includes('flex') &&
        !Object.hasOwn(config.place.flexMultiplier.byLandmark, entry.id),
    )
    expect(unlisted).toBeDefined()
    if (unlisted !== undefined) {
      expect(flexPlaceMultiplier(unlisted, config)).toBe(config.place.flexMultiplier.default)
    }
  })

  it('boutiques flex at the default multiplier; other venues not at all', () => {
    for (const venue of venues) {
      const expected = flex.venueTypes.includes(venue.type)
        ? config.place.flexMultiplier.default
        : null
      expect(flexPlaceMultiplier(venue, config), venue.id).toBe(expected)
    }
    expect(venues.some((venue) => venue.type === 'boutique')).toBe(true)
  })

  it('never at a club (nightlife is flavour only): no Flex action, performFlex refused', () => {
    expect(flex.venueTypes).not.toContain('club')
    const clubs = venues.filter((venue) => venue.type === 'club')
    expect(clubs.length).toBeGreaterThan(0)
    for (const club of clubs) {
      expect(flexPlaceMultiplier(club, config), club.id).toBeNull()
      for (const hour of [12, 23]) {
        const view = placeActions(club, snapshotAt(1, hour), config)
        expect(view.kind === 'actions' && view.actions.map((a) => a.id), club.id).not.toContain(
          'flex',
        )
      }
      expect(performFlex(snapshotAt(1, 23), club, config)).toEqual({
        ok: false,
        error: { code: 'FLEX_NOT_ALLOWED', placeId: club.id },
      })
      expect(performPlaceAction(snapshotAt(1, 23), club, 'flex', config)).toEqual({
        ok: false,
        error: { code: 'UNKNOWN_PLACE_ACTION', actionId: 'flex' },
      })
    }
  })

  it('memorials never: no multiplier, no Flex action, refused every way, no ledger entry', () => {
    expect(memorial).toMatchObject({ category: 'memorial' })
    expect(flexMultiplier(memorial, config)).toBeNull()
    expect(flexPlaceMultiplier(memorial, config)).toBeNull()
    const snapshot = snapshotAt()
    expect(placeActions(memorial, snapshot, config)).toEqual({ kind: 'look-only' })
    expect(performPlaceAction(snapshot, memorial, 'flex', config)).toEqual({
      ok: false,
      error: { code: 'LOOK_ONLY' },
    })
    expect(performFlex(snapshot, memorial, config)).toEqual({
      ok: false,
      error: { code: 'FLEX_NOT_ALLOWED', placeId: memorial.id },
    })
    for (const entry of landmarks.filter((l) => l.category === 'memorial')) {
      expect(performFlex(snapshot, entry, config).ok, entry.id).toBe(false)
    }
  })
})

describe('viral chance', () => {
  it('rises with style, scales with the place and is capped', () => {
    const { baseChance, perStylePoint, maxChance } = flex.viral
    expect(viralChance(0, 1, config)).toBeCloseTo(baseChance)
    expect(viralChance(10, 1, config)).toBeCloseTo(baseChance + 10 * perStylePoint)
    expect(viralChance(10, 2, config)).toBeCloseTo(2 * (baseChance + 10 * perStylePoint))
    expect(viralChance(10_000, 2, config)).toBe(maxChance)
    let last = -1
    for (let score = 0; score <= 200; score++) {
      const chance = viralChance(score, 1.5, config)
      expect(chance).toBeGreaterThanOrEqual(last)
      expect(chance).toBeLessThanOrEqual(maxChance)
      last = chance
    }
  })

  it('20,000 seeded rolls land within 1.5 points of the chance, twice as often at a 2.0 landmark', () => {
    const rate = (multiplier: number) => {
      const chance = viralChance(0, multiplier, config)
      const rng = createRng(77)
      let hits = 0
      for (let i = 0; i < 20_000; i++) {
        if (createRng(mixSeed(rng.next() * 0xffffffff, i)).next() < chance) hits++
      }
      return { chance, observed: hits / 20_000 }
    }
    const one = rate(1)
    const two = rate(2)
    expect(Math.abs(one.observed - one.chance)).toBeLessThan(0.015)
    expect(Math.abs(two.observed - two.chance)).toBeLessThan(0.015)
    expect(two.chance).toBeCloseTo(2 * one.chance)
  })

  it('2,000 flexes through performFlex go viral at the chance (the end-to-end path)', () => {
    let snapshot = snapshotAt()
    const chance = viralChance(0, 1.25, config)
    let viral = 0
    for (let i = 0; i < 2_000; i++) {
      // A fresh day each time so the once-per-place rule never blocks, rngState carried over.
      const at = { ...snapshot, clock: { minute: i * DAY + 12 * 60, remainderMs: 0 } }
      const rested = { ...at, player: { ...at.player, stats: { ...at.player.stats, energy: 100 } } }
      const result = ok(performFlex(rested, ballpark, config))
      if (result.viral) viral++
      snapshot = result.snapshot
    }
    expect(Math.abs(viral / 2_000 - chance)).toBeLessThan(0.03)
  })
})

describe('a flex', () => {
  it('costs its time and energy, draws once, saves the generator and records the clout', () => {
    const before = snapshotAt(1, 12, 0)
    const result = ok(performFlex(before, ballpark, config))
    expect(result.durationMin).toBe(flex.durationMin)
    expect(result.snapshot.player.stats.energy).toBeLessThan(before.player.stats.energy)
    const expectedRng = createRng(mixSeed(before.player.flex.rngState, before.clock.minute))
    const roll = expectedRng.next()
    expect(result.viral).toBe(roll < result.chance)
    expect(result.snapshot.player.flex.rngState).toBe(expectedRng.state)
    expect(result.snapshot.player.flex.byPlace).toEqual({ [ballpark.id]: 1 })
    const base = result.viral ? flex.baseClout * flex.viral.cloutMultiplier : flex.baseClout
    expect(result.cloutGained).toBe(Math.floor(base * 1.25))
    expect(totalClout(result.snapshot.player, config)).toBe(result.cloutGained)
    expect(result.snapshot.player.clout.ledger.at(-1)).toMatchObject({
      source: 'flex',
      currency: 'cash',
      ref: {
        placeId: ballpark.id,
        viral: result.viral,
        placeMultiplier: 1.25,
        styleScore: 0,
        base,
      },
    })
  })

  it('the same state gives the same outcome; the saved state moves on (no reroll on reload)', () => {
    const before = snapshotAt()
    const a = ok(performFlex(before, ballpark, config))
    const b = ok(performFlex(structuredClone(before), ballpark, config))
    expect(a.viral).toBe(b.viral)
    expect(a.snapshot).toEqual(b.snapshot)
    expect(a.snapshot.player.flex.rngState).not.toBe(before.player.flex.rngState)
  })

  it('the outfit style raises both the chance and the gain', () => {
    const wearables = shopItems(config).filter(isWearable)
    let dressed = snapshotAt()
    for (const item of wearables.filter((entry) => entry.rarity === 'rare')) {
      dressed = ok(buyItem(dressed, item.id, config)).snapshot
      dressed = ok(equipItem(dressed, item.id, item.slot, config)).snapshot
    }
    const plain = flexAction(placeActions(bridge, snapshotAt(), config))
    const styled = flexAction(placeActions(bridge, dressed, config))
    expect(styled.viralChance).toBeGreaterThan(plain.viralChance)
    expect(styled.cloutGain).toBeGreaterThan(plain.cloutGain)
    expect(plain.cloutGain).toBe(flex.baseClout * 2)
    const result = ok(performPlaceAction(dressed, bridge, 'flex', config))
    expect(result.cloutGained).toBe(
      result.flex?.viral === true ? styled.viralCloutGain : styled.cloutGain,
    )
  })

  it('once per place per day, at most maxPerGameDay a day, fresh the next day', () => {
    let snapshot = snapshotAt(3, 9)
    const spots = ['brooklyn-bridge', 'central-park', 'dumbo', 'high-line'].map(place)
    snapshot = ok(performPlaceAction(snapshot, spots[0] as Place, 'flex', config)).snapshot
    expect(flexAction(placeActions(spots[0] as Place, snapshot, config)).block).toEqual({
      code: 'flexed-here-today',
    })
    expect(performFlex(snapshot, spots[0] as Place, config)).toMatchObject({
      ok: false,
      error: { code: 'FLEX_LIMIT', limit: { code: 'flexed-here-today' } },
    })
    for (const spot of spots.slice(1, flex.maxPerGameDay)) {
      snapshot = ok(performPlaceAction(snapshot, spot, 'flex', config)).snapshot
    }
    const last = spots[flex.maxPerGameDay] as Place
    expect(flexAction(placeActions(last, snapshot, config)).block).toEqual({
      code: 'flex-daily-limit',
      max: flex.maxPerGameDay,
    })
    expect(performPlaceAction(snapshot, last, 'flex', config)).toMatchObject({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'flex-daily-limit' } },
    })
    const tomorrow = { ...snapshot, clock: { minute: 3 * DAY + 9 * 60, remainderMs: 0 } }
    expect(flexAction(placeActions(spots[0] as Place, tomorrow, config)).block).toBeNull()
    const next = ok(performPlaceAction(tomorrow, spots[0] as Place, 'flex', config))
    expect(next.snapshot.player.flex.byPlace).toEqual({ [spots[0]?.id ?? '']: 4 })
  })

  it('needs the energy, and a locked borough blocks it first', () => {
    const tired = snapshotAt()
    const drained = {
      ...tired,
      player: { ...tired.player, stats: { ...tired.player.stats, energy: flex.energyCost - 1 } },
    }
    expect(flexAction(placeActions(ballpark, drained, config)).block).toEqual({
      code: 'energy',
      required: flex.energyCost,
      available: flex.energyCost - 1,
    })
    const nobody = snapshotAt(1, 12, 0)
    expect(bridge).toMatchObject({ borough: expect.any(String) })
    const locked = flexAction(placeActions(place('dumbo'), nobody, config))
    expect(locked.block).toMatchObject({ code: 'borough-locked' })
  })
})
