import { describe, expect, it } from 'vitest'
import type { EventChoice, EventConditions, GameEvent } from '@/lib/data/schemas/content'
import { minutesPerDay } from './clock'
import { totalClout } from './clout'
import { engineConfig, type EngineConfig } from './config'
import {
  canAffordChoice,
  chooseEventOption,
  choiceCashCost,
  conditionsHold,
  eligibleEvents,
  initialEventsState,
  isOffCooldown,
  openEvent,
  pickWeighted,
  rollEvent,
  selectEvent,
  type EventContext,
  type EventsState,
} from './events'
import { initialSnapshot, type GameSnapshot } from './game'
import { createRng } from './rng'
import { withClout } from './test-support'

const choice = (id: string, effects: EventChoice['effects'] = []): EventChoice => ({
  id,
  labelKey: `events.test.${id}.label`,
  resultKey: `events.test.${id}.result`,
  effects,
})

const event = (id: string, patch: Partial<GameEvent> = {}): GameEvent => ({
  id,
  titleKey: 'events.test.title',
  bodyKey: 'events.test.body',
  tags: ['social'],
  weight: 1,
  conditions: {},
  choices: [choice('a'), choice('b')],
  ...patch,
})

/** Fixed numbers and a fixture catalog, so these tests do not move with data tuning. */
function configWith(
  catalog: readonly GameEvent[],
  tuning: Partial<Omit<EngineConfig['events'], 'catalog'>> = {},
): EngineConfig {
  return {
    ...engineConfig,
    // Pinned (S03 values) so balance tuning (S12 changed hunger decay) cannot move the decay
    // these tests count.
    stats: {
      max: 100,
      start: { energy: 100, hunger: 80, mood: 70 },
      decayPerGameHour: { energy: 3, hunger: 5, mood: 2 },
      atZero: {
        energy: { extraDecayPerGameHour: { mood: 3 }, durationMultiplier: 1.5 },
        hunger: { extraDecayPerGameHour: { energy: 3, mood: 4 }, durationMultiplier: 1 },
        mood: { extraDecayPerGameHour: {}, durationMultiplier: 1.25 },
      },
    },
    events: { rollChance: 1, defaultCooldownMin: 1440, maxPendingEffects: 3, ...tuning, catalog },
  }
}

const street: EventContext = {
  borough: 'queens',
  locationId: null,
  locationCategory: null,
  itemIds: [],
}

const config = configWith([])
const DAY = minutesPerDay(config)

/** A snapshot at `day` (1-based) and `hour`, with optional cash and stats. */
function at(
  day: number,
  hour: number,
  player: { cash?: number; stats?: Partial<GameSnapshot['player']['stats']> } = {},
): GameSnapshot {
  const fresh = initialSnapshot(config)
  return {
    clock: { minute: (day - 1) * DAY + hour * 60, remainderMs: 0 },
    player: {
      ...fresh.player,
      cash: player.cash ?? fresh.player.cash,
      stats: { ...fresh.player.stats, ...player.stats },
    },
  }
}

const holds = (conditions: EventConditions, snapshot = at(1, 12), context = street) =>
  conditionsHold(conditions, snapshot, context, config)

describe('event conditions', () => {
  it('no conditions always hold', () => {
    expect(holds({})).toBe(true)
  })

  it('hour windows include from, exclude to, and wrap past midnight', () => {
    const evening = { hours: { from: 20, to: 3 } }
    expect(holds(evening, at(1, 20))).toBe(true)
    expect(holds(evening, at(1, 23))).toBe(true)
    expect(holds(evening, at(2, 0))).toBe(true)
    expect(holds(evening, at(2, 2))).toBe(true)
    expect(holds(evening, at(2, 3))).toBe(false)
    expect(holds(evening, at(1, 12))).toBe(false)
    const lunch = { hours: { from: 11, to: 14 } }
    expect(holds(lunch, at(1, 11))).toBe(true)
    expect(holds(lunch, at(1, 13))).toBe(true)
    expect(holds(lunch, at(1, 14))).toBe(false)
    expect(holds(lunch, at(1, 10))).toBe(false)
  })

  it('minDay holds from that game day on', () => {
    expect(holds({ minDay: 3 }, at(2, 23))).toBe(false)
    expect(holds({ minDay: 3 }, at(3, 0))).toBe(true)
  })

  it('boroughs need a known, listed borough', () => {
    expect(holds({ boroughs: ['queens', 'bronx'] })).toBe(true)
    expect(holds({ boroughs: ['manhattan'] })).toBe(false)
    expect(holds({ boroughs: ['queens'] }, at(1, 12), { ...street, borough: null })).toBe(false)
  })

  it('a place matches by id or by category', () => {
    const where = { locationIds: ['brooklyn-bridge'], locationCategories: ['club' as const] }
    const bridge = { ...street, locationId: 'brooklyn-bridge', locationCategory: 'bridge' as const }
    const club = { ...street, locationId: 'some-club', locationCategory: 'club' as const }
    const park = { ...street, locationId: 'a-park', locationCategory: 'park' as const }
    expect(holds(where, at(1, 12), bridge)).toBe(true)
    expect(holds(where, at(1, 12), club)).toBe(true)
    expect(holds(where, at(1, 12), park)).toBe(false)
    expect(holds(where, at(1, 12), street)).toBe(false)
  })

  it('stat, cash and clout ranges are inclusive', () => {
    const snapshot = at(1, 12, { cash: 20, stats: { mood: 60, hunger: 70 } })
    expect(holds({ stats: { mood: { min: 60 } } }, snapshot)).toBe(true)
    expect(holds({ stats: { mood: { min: 61 } } }, snapshot)).toBe(false)
    expect(holds({ stats: { hunger: { max: 70 }, mood: { max: 59 } } }, snapshot)).toBe(false)
    expect(holds({ cash: { min: 20, max: 20 } }, snapshot)).toBe(true)
    expect(holds({ cash: { min: 21 } }, snapshot)).toBe(false)
    const known = withClout(snapshot, 10, config)
    expect(holds({ clout: { min: 10 } }, known)).toBe(true)
    expect(holds({ clout: { max: 9 } }, known)).toBe(false)
  })

  it('items: owns one of anyOf and none of noneOf', () => {
    const owner = { ...street, itemIds: ['tee', 'cap'] }
    expect(holds({ items: { anyOf: ['cap', 'boots'] } }, at(1, 12), owner)).toBe(true)
    expect(holds({ items: { anyOf: ['boots'] } }, at(1, 12), owner)).toBe(false)
    expect(holds({ items: { noneOf: ['tee'] } }, at(1, 12), owner)).toBe(false)
    expect(holds({ items: { noneOf: ['boots'] } }, at(1, 12), owner)).toBe(true)
  })

  it('every listed condition must hold', () => {
    const conditions = { hours: { from: 9, to: 17 }, boroughs: ['queens' as const], minDay: 2 }
    expect(holds(conditions, at(2, 10))).toBe(true)
    expect(holds(conditions, at(1, 10))).toBe(false)
    expect(holds(conditions, at(2, 18))).toBe(false)
  })
})

describe('cooldowns', () => {
  const fired = (id: string, minute: number): EventsState => ({
    ...initialEventsState(),
    history: { [id]: minute },
  })

  it('uses the default cooldown, or the event own', () => {
    const plain = event('plain')
    expect(isOffCooldown(plain, initialEventsState(), 0, config)).toBe(true)
    expect(isOffCooldown(plain, fired('plain', 100), 100 + 1439, config)).toBe(false)
    expect(isOffCooldown(plain, fired('plain', 100), 100 + 1440, config)).toBe(true)
    const quick = event('quick', { cooldownMin: 10 })
    expect(isOffCooldown(quick, fired('quick', 100), 110, config)).toBe(true)
  })

  it('a once event never fires again', () => {
    const once = event('once', { once: true })
    expect(isOffCooldown(once, fired('once', 0), 10 * DAY, config)).toBe(false)
  })

  it('an id that is also an Object.prototype key is not treated as fired', () => {
    const tricky = event('constructor')
    expect(isOffCooldown(tricky, initialEventsState(), 0, config)).toBe(true)
  })
})

describe('weighted, seeded selection', () => {
  const common = event('common', { weight: 6 })
  const uncommon = event('uncommon', { weight: 3 })
  const rare = event('rare', { weight: 1 })

  it('picks in proportion to weight over many seeded draws', () => {
    const rng = createRng(2026)
    const counts: Record<string, number> = { common: 0, uncommon: 0, rare: 0 }
    const draws = 30_000
    for (let i = 0; i < draws; i++) {
      const picked = pickWeighted([common, uncommon, rare], rng)
      if (picked !== null) counts[picked.id] = (counts[picked.id] ?? 0) + 1
    }
    expect((counts.common ?? 0) / draws).toBeCloseTo(0.6, 1)
    expect((counts.uncommon ?? 0) / draws).toBeCloseTo(0.3, 1)
    expect((counts.rare ?? 0) / draws).toBeCloseTo(0.1, 1)
  })

  it('the same seed picks the same events, run after run', () => {
    const sequence = (seed: number) => {
      const rng = createRng(seed)
      return Array.from({ length: 20 }, () => pickWeighted([common, uncommon, rare], rng)?.id)
    }
    expect(sequence(99)).toEqual(sequence(99))
    expect(sequence(99)).not.toEqual(sequence(100))
  })

  it('returns null for an empty list', () => {
    expect(pickWeighted([], createRng(1))).toBeNull()
  })

  it('rollChance gates every roll', () => {
    const catalog = [common]
    const never = configWith(catalog, { rollChance: 0 })
    const always = configWith(catalog, { rollChance: 1 })
    for (let seed = 0; seed < 200; seed++) {
      const events = { ...initialEventsState(), rngState: seed }
      expect(selectEvent(at(1, 12), events, street, never, createRng(seed))).toBeNull()
      expect(rollEvent(at(1, 12), events, street, always).event?.id).toBe('common')
    }
  })

  it('fires at about rollChance over many seeded rolls', () => {
    const tuned = configWith([common], { rollChance: 0.3 })
    let fired = 0
    for (let seed = 0; seed < 5000; seed++) {
      const events = { ...initialEventsState(), rngState: seed }
      if (rollEvent(at(1, 12), events, street, tuned).event !== null) fired++
    }
    expect(fired / 5000).toBeCloseTo(0.3, 1)
  })

  it('a roll is deterministic for the same state and moment, and differs across minutes', () => {
    const catalog = [common, uncommon, rare]
    const tuned = configWith(catalog, { rollChance: 0.5 })
    const events = { ...initialEventsState(), rngState: 12345 }
    const once = rollEvent(at(1, 12), events, street, tuned)
    expect(rollEvent(at(1, 12), events, street, tuned)).toEqual(once)
    const outcomes = new Set(
      Array.from(
        { length: 60 },
        (_, minute) =>
          rollEvent(
            { ...at(1, 12), clock: { minute: 720 + minute, remainderMs: 0 } },
            events,
            street,
            tuned,
          ).event?.id ?? 'none',
      ),
    )
    expect(outcomes.size).toBeGreaterThan(1)
  })

  it('a roll advances the saved generator, opens the event and records when it fired', () => {
    const tuned = configWith([common])
    const before = { ...initialEventsState(), rngState: 5 }
    const { events, event: fired } = rollEvent(at(2, 9), before, street, tuned)
    expect(fired?.id).toBe('common')
    expect(events.active).toBe('common')
    expect(events.history).toEqual({ common: DAY + 9 * 60 })
    expect(events.rngState).not.toBe(before.rngState)
  })

  it('nothing rolls while an event is open', () => {
    const tuned = configWith([common])
    const open = { ...initialEventsState(), active: 'common' }
    expect(rollEvent(at(1, 12), open, street, tuned)).toEqual({ events: open, event: null })
  })

  it('only eligible events are candidates', () => {
    const night = event('night', { conditions: { hours: { from: 20, to: 4 } } })
    const tuned = configWith([night, common])
    expect(eligibleEvents(at(1, 12), initialEventsState(), street, tuned).map((e) => e.id)).toEqual(
      ['common'],
    )
  })
})

describe('opening an event', () => {
  const tuned = configWith([event('pizza', { conditions: { hours: { from: 11, to: 23 } } })])

  it('opens an eligible event and records it', () => {
    const result = openEvent(at(1, 12), initialEventsState(), 'pizza', street, tuned)
    expect(result.ok && result.events.active).toBe('pizza')
  })

  it('refuses an unknown, ineligible or second event', () => {
    expect(openEvent(at(1, 12), initialEventsState(), 'nope', street, tuned)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_EVENT', eventId: 'nope' },
    })
    expect(openEvent(at(1, 8), initialEventsState(), 'pizza', street, tuned)).toEqual({
      ok: false,
      error: { code: 'EVENT_NOT_ELIGIBLE', eventId: 'pizza' },
    })
    const open = { ...initialEventsState(), active: 'pizza' }
    expect(openEvent(at(1, 12), open, 'pizza', street, tuned)).toEqual({
      ok: false,
      error: { code: 'EVENT_ALREADY_ACTIVE', activeId: 'pizza' },
    })
  })
})

describe('choosing an option', () => {
  const rent = event('rent', {
    choices: [
      choice('pay', [
        { kind: 'cash', amount: -25 },
        { kind: 'stat', stat: 'mood', amount: -3 },
      ]),
      choice('haggle', [
        { kind: 'time', minutes: 90 },
        { kind: 'stat', stat: 'energy', amount: -6 },
        { kind: 'cash', amount: -10 },
      ]),
      choice('flyers', [
        { kind: 'cash', amount: 30 },
        { kind: 'clout', amount: 2 },
        { kind: 'item', itemId: 'flyer-cap', op: 'grant' },
      ]),
    ],
  })
  const tuned = configWith([rent])
  const open: EventsState = { ...initialEventsState(), active: 'rent', history: { rent: 0 } }

  it('applies cash, then time with passive decay, then stat changes', () => {
    const start = at(1, 12, { cash: 50, stats: { energy: 50, hunger: 50, mood: 50 } })
    const result = chooseEventOption(start, open, 'haggle', tuned)
    if (!result.ok) throw new Error(result.error.code)
    // 90 minutes from 12:00 crosses one hour boundary: decay 3/5/2, then the -6 energy.
    expect(result.snapshot.player).toMatchObject({
      cash: 40,
      stats: { energy: 50 - 3 - 6, hunger: 50 - 5, mood: 50 - 2 },
    })
    expect(result.snapshot.clock.minute).toBe(start.clock.minute + 90)
    expect(result.outcome).toMatchObject({
      eventId: 'rent',
      choiceId: 'haggle',
      resultKey: 'events.test.haggle.result',
      durationMin: 90,
      rollovers: { days: 0, weeks: 0 },
    })
    expect(result.events.active).toBeNull()
    expect(result.events.history).toEqual(open.history)
  })

  it('applies clout at once as one event ledger entry; item effects wait with their source', () => {
    const result = chooseEventOption(at(1, 12), open, 'flyers', tuned)
    if (!result.ok) throw new Error(result.error.code)
    const source = { type: 'event', eventId: 'rent', choiceId: 'flyers' }
    expect(result.events.pending).toEqual([
      { kind: 'item', itemId: 'flyer-cap', op: 'grant', source },
    ])
    expect(result.snapshot.player.cash).toBe(at(1, 12).player.cash + 30)
    expect(totalClout(result.snapshot.player, tuned)).toBe(2)
    expect(result.snapshot.player.clout.ledger).toEqual([
      {
        seq: 1,
        at: result.snapshot.clock.minute,
        amount: 2,
        currency: 'cash',
        source: 'event',
        ref: { eventId: 'rent', choiceId: 'flyers' },
      },
    ])
    expect(result.outcome.cloutApplied).toBe(2)
    expect(result.levelUp).toBeNull()
  })

  it('keeps at most maxPendingEffects, dropping the oldest', () => {
    let events = open
    let snapshot = at(1, 12)
    for (let i = 0; i < 4; i++) {
      const result = chooseEventOption(snapshot, { ...events, active: 'rent' }, 'flyers', tuned)
      if (!result.ok) throw new Error(result.error.code)
      events = result.events
      snapshot = result.snapshot
    }
    expect(events.pending).toHaveLength(3)
    expect(events.pending.map((effect) => effect.kind)).toEqual(['item', 'item', 'item'])
    expect(totalClout(snapshot.player, tuned)).toBe(4 * 2)
  })

  it('refuses a choice the player cannot afford and changes nothing', () => {
    const broke = at(1, 12, { cash: 24 })
    expect(chooseEventOption(broke, open, 'pay', tuned)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: 25, available: 24 },
    })
    const [pay, , flyers] = rent.choices
    if (pay === undefined || flyers === undefined) throw new Error('fixture')
    expect(choiceCashCost(pay)).toBe(25)
    expect(choiceCashCost(flyers)).toBe(0)
    expect(canAffordChoice(pay, broke.player.cash)).toBe(false)
    expect(canAffordChoice(pay, 25)).toBe(true)
    const exact = chooseEventOption(at(1, 12, { cash: 25 }), open, 'pay', tuned)
    expect(exact.ok && exact.snapshot.player.cash).toBe(0)
  })

  it('refuses with no open event, an unknown choice or an open event no longer in data', () => {
    expect(chooseEventOption(at(1, 12), initialEventsState(), 'pay', tuned)).toEqual({
      ok: false,
      error: { code: 'NO_ACTIVE_EVENT' },
    })
    expect(chooseEventOption(at(1, 12), open, 'run', tuned)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_CHOICE', eventId: 'rent', choiceId: 'run' },
    })
    const gone = { ...open, active: 'removed' }
    expect(chooseEventOption(at(1, 12), gone, 'pay', tuned)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_EVENT', eventId: 'removed' },
    })
  })

  it('a choice with no effects just closes the event', () => {
    const quiet = configWith([event('quiet')])
    const result = chooseEventOption(at(1, 12), { ...open, active: 'quiet' }, 'a', quiet)
    expect(result.ok && result.snapshot).toEqual(at(1, 12))
    expect(result.ok && result.events.active).toBeNull()
  })
})

describe('the shipped catalog', () => {
  /** A moment, place and player that satisfy an event's conditions. */
  function satisfying(conditions: EventConditions): {
    snapshot: GameSnapshot
    context: EventContext
  } {
    const hour = conditions.hours?.from ?? 12
    const stats = Object.fromEntries(
      Object.entries(conditions.stats ?? {}).map(([key, range]) => [key, range.min ?? range.max]),
    )
    const snapshot = withClout(
      at(conditions.minDay ?? 1, hour, { cash: conditions.cash?.min ?? 500, stats }),
      conditions.clout?.min ?? 0,
      engineConfig,
    )
    const locationId = conditions.locationIds?.[0] ?? null
    const locationCategory = conditions.locationCategories?.[0] ?? null
    return {
      snapshot,
      context: {
        borough: conditions.boroughs?.[0] ?? 'queens',
        locationId,
        locationCategory,
        itemIds: conditions.items?.anyOf?.slice(0, 1) ?? [],
      },
    }
  }

  it.each(engineConfig.events.catalog.map((entry) => [entry.id, entry] as const))(
    '%s can open, and every choice resolves',
    (_id, entry) => {
      const { snapshot, context } = satisfying(entry.conditions)
      const opened = openEvent(snapshot, initialEventsState(), entry.id, context, engineConfig)
      if (!opened.ok) throw new Error(opened.error.code)
      for (const option of entry.choices) {
        const result = chooseEventOption(snapshot, opened.events, option.id, engineConfig)
        expect(result.ok, option.id).toBe(true)
      }
    },
  )
})

describe('condition boundaries', () => {
  /** A snapshot at an exact minute of a day. */
  const atMinute = (day: number, hour: number, minute: number) => {
    const snapshot = at(day, hour)
    return { ...snapshot, clock: { minute: snapshot.clock.minute + minute, remainderMs: 0 } }
  }

  it('a window starting at hour 0 includes midnight and ends before `to`', () => {
    const early = { hours: { from: 0, to: 6 } }
    expect(holds(early, at(2, 0))).toBe(true)
    expect(holds(early, atMinute(2, 5, 59))).toBe(true)
    expect(holds(early, at(2, 6))).toBe(false)
    expect(holds(early, atMinute(1, 23, 59))).toBe(false)
  })

  it('a window ending at hour 0 runs to 23:59 and excludes midnight', () => {
    const late = { hours: { from: 22, to: 0 } }
    expect(holds(late, at(1, 22))).toBe(true)
    expect(holds(late, atMinute(1, 23, 59))).toBe(true)
    expect(holds(late, at(2, 0))).toBe(false)
    expect(holds(late, atMinute(1, 21, 59))).toBe(false)
  })

  it('a one-hour window that wraps (23 -> 0) and one that wraps by one hour (23 -> 1)', () => {
    expect(holds({ hours: { from: 23, to: 0 } }, atMinute(1, 23, 30))).toBe(true)
    expect(holds({ hours: { from: 23, to: 0 } }, atMinute(2, 0, 30))).toBe(false)
    expect(holds({ hours: { from: 23, to: 1 } }, atMinute(2, 0, 59))).toBe(true)
    expect(holds({ hours: { from: 23, to: 1 } }, at(2, 1))).toBe(false)
  })

  it('the to-hour is excluded at every minute of it, the from-hour included at every minute', () => {
    const lunch = { hours: { from: 11, to: 14 } }
    for (let minute = 0; minute < 60; minute++) {
      expect(holds(lunch, atMinute(1, 11, minute)), `11:${minute}`).toBe(true)
      expect(holds(lunch, atMinute(1, 14, minute)), `14:${minute}`).toBe(false)
    }
  })

  it('minDay 1 holds from the very first minute of the game', () => {
    const first = { ...at(1, 0), clock: { minute: 0, remainderMs: 0 } }
    expect(holds({ minDay: 1 }, first)).toBe(true)
    expect(holds({ minDay: 2 }, atMinute(1, 23, 59))).toBe(false)
    expect(holds({ minDay: 2 }, at(2, 0))).toBe(true)
  })

  it('stat ranges include 0 and stats.max at both ends', () => {
    const max = config.stats.max
    const empty = at(1, 12, { stats: { energy: 0, hunger: max, mood: 0 } })
    expect(holds({ stats: { energy: { max: 0 } } }, empty)).toBe(true)
    expect(holds({ stats: { energy: { min: 0, max: 0 } } }, empty)).toBe(true)
    expect(holds({ stats: { energy: { min: 1 } } }, empty)).toBe(false)
    expect(holds({ stats: { hunger: { min: max } } }, empty)).toBe(true)
    expect(holds({ stats: { hunger: { max: max - 1 } } }, empty)).toBe(false)
  })

  it('cash and clout ranges include 0', () => {
    const broke = at(1, 12, { cash: 0 })
    expect(holds({ cash: { max: 0 } }, broke)).toBe(true)
    expect(holds({ cash: { min: 0 } }, broke)).toBe(true)
    expect(holds({ cash: { min: 1 } }, broke)).toBe(false)
    expect(holds({ clout: { max: 0 } }, broke, street)).toBe(true)
    expect(holds({ clout: { min: 1 } }, broke, street)).toBe(false)
  })

  it('items: anyOf fails with no items, noneOf holds with no items, both combine', () => {
    expect(holds({ items: { anyOf: ['cap'] } })).toBe(false)
    expect(holds({ items: { noneOf: ['cap'] } })).toBe(true)
    const both = { items: { anyOf: ['cap', 'tee'], noneOf: ['boots'] } }
    expect(holds(both, at(1, 12), { ...street, itemIds: ['tee'] })).toBe(true)
    expect(holds(both, at(1, 12), { ...street, itemIds: ['tee', 'boots'] })).toBe(false)
    expect(holds(both, at(1, 12), { ...street, itemIds: ['boots'] })).toBe(false)
  })

  it('a place listed by id matches even when the caller gives no category', () => {
    const bridge = { ...street, locationId: 'brooklyn-bridge' }
    expect(holds({ locationIds: ['brooklyn-bridge'] }, at(1, 12), bridge)).toBe(true)
    expect(holds({ locationCategories: ['bridge'] }, at(1, 12), bridge)).toBe(false)
  })
})

describe('cooldown edge cases', () => {
  it('a cooldown of 0 lets an event fire again the same minute', () => {
    const quick = event('quick', { cooldownMin: 0 })
    const fired = { ...initialEventsState(), history: { quick: 600 } }
    expect(isOffCooldown(quick, fired, 600, config)).toBe(true)
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'an event id "%s" is off cooldown until it fires, then on cooldown',
    (id) => {
      const tricky = event(id)
      const tuned = configWith([tricky])
      expect(isOffCooldown(tricky, initialEventsState(), 0, tuned)).toBe(true)
      const { events } = rollEvent(at(1, 12), initialEventsState(), street, tuned)
      expect(events.active).toBe(id)
      expect(Object.hasOwn(events.history, id)).toBe(true)
      expect(isOffCooldown(tricky, events, at(1, 12).clock.minute + 1, tuned)).toBe(false)
      expect(Object.getPrototypeOf(events.history)).toBe(Object.prototype)
    },
  )

  it('history parsed from JSON with a __proto__ key does not mark other events as fired', () => {
    const history = JSON.parse('{"__proto__": {"plain": 0}}') as Record<string, number>
    const plain = event('plain')
    expect(isOffCooldown(plain, { ...initialEventsState(), history }, 0, config)).toBe(true)
  })

  it('a once event stays spent after the state goes through JSON (a reload)', () => {
    const once = event('once', { once: true })
    const tuned = configWith([once])
    const { events } = rollEvent(at(1, 12), initialEventsState(), street, tuned)
    expect(events.active).toBe('once')
    const reloaded = JSON.parse(JSON.stringify({ ...events, active: null })) as EventsState
    for (let day = 2; day < 60; day += 7) {
      expect(rollEvent(at(day, 12), reloaded, street, tuned).event).toBeNull()
    }
  })
})

describe('seeded rolls over many saves', () => {
  const heavy = event('heavy', { weight: 7 })
  const medium = event('medium', { weight: 2 })
  const light = event('light', { weight: 1 })
  const tuned = configWith([heavy, medium, light])

  it('across many saved generator states at one moment, picks match the weights', () => {
    const counts: Record<string, number> = {}
    const saves = 20_000
    for (let seed = 0; seed < saves; seed++) {
      const fired = rollEvent(at(1, 12), { ...initialEventsState(), rngState: seed }, street, tuned)
      const id = fired.event?.id ?? 'none'
      counts[id] = (counts[id] ?? 0) + 1
    }
    expect(counts.none).toBeUndefined()
    // 20k draws: 3 sigma on p = 0.1 is about 0.0064; 0.015 leaves room without being loose.
    expect(Math.abs((counts.heavy ?? 0) / saves - 0.7)).toBeLessThan(0.015)
    expect(Math.abs((counts.medium ?? 0) / saves - 0.2)).toBeLessThan(0.015)
    expect(Math.abs((counts.light ?? 0) / saves - 0.1)).toBeLessThan(0.015)
  })

  it('one save rolling over and over (state carried forward) also matches the weights', () => {
    const counts: Record<string, number> = {}
    let events = initialEventsState()
    const rolls = 20_000
    for (let roll = 0; roll < rolls; roll++) {
      // Same moment every time, cooldowns cleared: only the carried generator state moves.
      const next = rollEvent(at(1, 12), { ...events, history: {} }, street, tuned)
      const id = next.event?.id ?? 'none'
      counts[id] = (counts[id] ?? 0) + 1
      events = { ...next.events, active: null }
    }
    expect(Math.abs((counts.heavy ?? 0) / rolls - 0.7)).toBeLessThan(0.015)
    expect(Math.abs((counts.light ?? 0) / rolls - 0.1)).toBeLessThan(0.015)
  })

  it('a roll that fires nothing still advances the saved generator', () => {
    const nothing = configWith([event('night', { conditions: { hours: { from: 20, to: 4 } } })])
    const before = { ...initialEventsState(), rngState: 77 }
    const result = rollEvent(at(1, 12), before, street, nothing)
    expect(result.event).toBeNull()
    expect(result.events.active).toBeNull()
    expect(result.events.rngState).not.toBe(77)
    expect(result.events.history).toEqual({})
  })

  it('the same save at the same minute rolls the same event, even after JSON (a reload)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const events = { ...initialEventsState(), rngState: seed * 7919 }
      const first = rollEvent(at(3, 21), events, street, tuned)
      const reloaded = JSON.parse(JSON.stringify(events)) as EventsState
      expect(rollEvent(at(3, 21), reloaded, street, tuned)).toEqual(first)
    }
  })
})

describe('choice edge cases', () => {
  const mixed = event('mixed', {
    choices: [
      choice('net', [
        { kind: 'cash', amount: 30 },
        { kind: 'cash', amount: -40 },
      ]),
      choice('late', [
        { kind: 'time', minutes: 120 },
        { kind: 'stat', stat: 'energy', amount: -6 },
      ]),
      choice('tick', [{ kind: 'time', minutes: 1 }]),
    ],
  })
  const tuned = configWith([mixed], { maxPendingEffects: 100 })
  const open: EventsState = { ...initialEventsState(), active: 'mixed', history: { mixed: 0 } }

  it('several cash effects are charged as their net, and exact cash on hand is enough', () => {
    const [net] = mixed.choices
    if (net === undefined) throw new Error('fixture')
    expect(choiceCashCost(net)).toBe(10)
    const exact = chooseEventOption(at(1, 12, { cash: 10 }), open, 'net', tuned)
    expect(exact.ok && exact.snapshot.player.cash).toBe(0)
    expect(chooseEventOption(at(1, 12, { cash: 9 }), open, 'net', tuned)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: 10, available: 9 },
    })
  })

  it('a refused choice leaves the event open and the input state untouched', () => {
    const frozen = structuredClone(open)
    const result = chooseEventOption(at(1, 12, { cash: 0 }), open, 'net', tuned)
    expect(result.ok).toBe(false)
    expect(open).toEqual(frozen)
  })

  it('a time effect that crosses midnight reports the day rollover and charges decay', () => {
    const start = at(1, 23, { stats: { energy: 50, hunger: 50, mood: 50 } })
    const result = chooseEventOption(start, open, 'late', tuned)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.outcome.rollovers).toEqual({ days: 1, weeks: 0 })
    expect(result.outcome.durationMin).toBe(120)
    // 23:00 -> 01:00 crosses two hour boundaries: energy decay 3 x 2, then the -6.
    expect(result.snapshot.player.stats.energy).toBe(50 - 6 - 6)
  })

  it('a time effect that crosses the rent week boundary reports one week rollover', () => {
    const lastDay = config.time.rentPeriodGameDays
    const result = chooseEventOption(at(lastDay, 23), open, 'late', tuned)
    expect(result.ok && result.outcome.rollovers).toEqual({ days: 1, weeks: 1 })
  })

  it('decay lands only when a game-hour boundary is crossed', () => {
    const fresh = at(1, 12, { stats: { energy: 50, hunger: 50, mood: 50 } })
    const before = { ...fresh, clock: { minute: fresh.clock.minute + 58, remainderMs: 0 } }
    const noBoundary = chooseEventOption(before, open, 'tick', tuned)
    expect(noBoundary.ok && noBoundary.snapshot.player.stats).toEqual(fresh.player.stats)
    const edge = { ...fresh, clock: { minute: fresh.clock.minute + 59, remainderMs: 0 } }
    const crossed = chooseEventOption(edge, open, 'tick', tuned)
    expect(crossed.ok && crossed.snapshot.player.stats).toEqual({
      energy: 47,
      hunger: 45,
      mood: 48,
    })
  })

  it('a stat change after decay clamps at 0', () => {
    const tired = at(1, 23, { stats: { energy: 5 } })
    const result = chooseEventOption(tired, open, 'late', tuned)
    expect(result.ok && result.snapshot.player.stats.energy).toBe(0)
  })

  it('at the shipped cap of 100 pending effects, the oldest drop first', () => {
    const cap = engineConfig.events.maxPendingEffects
    expect(cap).toBe(100)
    const promo = event('promo', {
      choices: [
        choice('take', [
          { kind: 'item', itemId: 'promo-a', op: 'grant' },
          { kind: 'item', itemId: 'promo-b', op: 'grant' },
        ]),
        choice('skip'),
      ],
    })
    const capped = configWith([promo], { maxPendingEffects: cap })
    const source = { type: 'event', eventId: 'old', choiceId: 'x' } as const
    const pending = Array.from({ length: cap - 1 }, (_, i) => ({
      kind: 'item' as const,
      itemId: `old-${100 + i}`,
      op: 'grant' as const,
      source,
    }))
    const full: EventsState = { ...initialEventsState(), active: 'promo', pending }
    const result = chooseEventOption(at(1, 12), full, 'take', capped)
    if (!result.ok) throw new Error(result.error.code)
    expect(result.events.pending).toHaveLength(cap)
    // 99 + 2 = 101: the oldest (old-100) is the one dropped.
    expect(result.events.pending[0]).toMatchObject({ itemId: 'old-101' })
    expect(result.events.pending.at(-1)).toMatchObject({
      itemId: 'promo-b',
      source: { eventId: 'promo' },
    })
  })
})
