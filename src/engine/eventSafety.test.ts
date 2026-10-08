/**
 * The event safety rules hold in the engine for any data, not only the shipped catalog
 * (CLAUDE.md "Map and landmarks"): nothing can fire at a memorial, and no crime event can fire
 * at a government building. Random condition sets come from the seeded generator, so every
 * run checks the same cases. Content (copy) scans live in src/lib/data/events.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  BOROUGHS,
  EVENT_TAGS,
  LANDMARK_CATEGORIES,
  VENUE_TYPES,
  type EventConditions,
  type GameEvent,
  type LocationCategory,
} from '@/lib/data/schemas/content'
import { engineConfig, placeCategories, type EngineConfig } from './config'
import {
  eligibleEvents,
  initialEventsState,
  isEventEligible,
  isForbiddenAt,
  openEvent,
  rollEvent,
  type EventContext,
} from './events'
import { initialSnapshot, type GameSnapshot } from './game'
import { createRng, type Rng } from './rng'
import { withClout } from './test-support'

const CATEGORIES: readonly LocationCategory[] = [...LANDMARK_CATEGORIES, ...VENUE_TYPES]

function pick<T>(list: readonly T[], rng: Rng): T {
  const value = list[Math.floor(rng.next() * list.length)]
  if (value === undefined) throw new Error('empty list')
  return value
}

const maybe = <T>(rng: Rng, make: () => T): T | undefined => (rng.next() < 0.5 ? make() : undefined)

/**
 * Any condition set, including ones the schema would reject (a memorial or government
 * category), to show the engine guard does not depend on the schema.
 */
function randomConditions(rng: Rng): EventConditions {
  const range = (max: number) => {
    const a = Math.floor(rng.next() * max)
    const b = Math.floor(rng.next() * max)
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }
  return {
    hours: maybe(rng, () => {
      const from = Math.floor(rng.next() * 24)
      return { from, to: (from + 1 + Math.floor(rng.next() * 22)) % 24 }
    }),
    boroughs: maybe(rng, () => [pick(BOROUGHS, rng)]),
    locationIds: maybe(rng, () =>
      ['memorial-site', 'city-hall', 'some-venue'].slice(0, 1 + Math.floor(rng.next() * 3)),
    ),
    locationCategories: maybe(
      rng,
      () => [pick(CATEGORIES, rng), pick(CATEGORIES, rng)] as EventConditions['locationCategories'],
    ),
    stats: maybe(rng, () => ({ mood: range(101) })),
    cash: maybe(rng, () => range(1000)),
  }
}

function randomEvent(id: string, rng: Rng): GameEvent {
  return {
    id,
    titleKey: 'events.test.title',
    bodyKey: 'events.test.body',
    tags: [pick(EVENT_TAGS, rng), ...(rng.next() < 0.5 ? (['crime'] as const) : [])],
    weight: 1 + Math.floor(rng.next() * 10),
    conditions: randomConditions(rng),
    choices: [
      { id: 'a', labelKey: 'events.test.a', resultKey: 'events.test.a', effects: [] },
      { id: 'b', labelKey: 'events.test.b', resultKey: 'events.test.b', effects: [] },
    ],
  }
}

/** A player and moment from the same seeded source. */
function randomSnapshot(rng: Rng): GameSnapshot {
  const fresh = initialSnapshot(engineConfig)
  const snapshot = {
    clock: { minute: Math.floor(rng.next() * 30 * 24 * 60), remainderMs: 0 },
    player: {
      ...fresh.player,
      cash: Math.floor(rng.next() * 1000),
      stats: { ...fresh.player.stats, mood: Math.floor(rng.next() * 101) },
    },
  }
  return withClout(snapshot, Math.floor(rng.next() * 1000), engineConfig)
}

function contextAt(category: LocationCategory, rng: Rng): EventContext {
  return {
    borough: pick(BOROUGHS, rng),
    // Category only: place ids are resolved from data, covered in 'places are judged by data'.
    locationId: null,
    locationCategory: category,
    itemIds: [],
  }
}

const CASES = 3000

describe('no event can fire at a memorial', () => {
  it('no randomly generated event is ever eligible there, whatever its conditions', () => {
    const rng = createRng(911)
    let eligibleElsewhere = 0
    for (let i = 0; i < CASES; i++) {
      const event = randomEvent(`random-${i}`, rng)
      const snapshot = randomSnapshot(rng)
      const memorial = contextAt('memorial', rng)
      expect(isEventEligible(event, snapshot, initialEventsState(), memorial, engineConfig)).toBe(
        false,
      )
      // The same case at a non-memorial place is sometimes eligible: the test is not vacuous.
      const elsewhere = { ...memorial, locationCategory: 'park' as const }
      if (isEventEligible(event, snapshot, initialEventsState(), elsewhere, engineConfig)) {
        eligibleElsewhere++
      }
    }
    expect(eligibleElsewhere).toBeGreaterThan(0)
  })

  it('an event with no conditions at all is still not eligible there', () => {
    const anywhere = {
      ...randomEvent('anywhere', createRng(1)),
      conditions: {},
      tags: ['social' as const],
    }
    const memorial = contextAt('memorial', createRng(2))
    expect(
      isEventEligible(
        anywhere,
        initialSnapshot(engineConfig),
        initialEventsState(),
        memorial,
        engineConfig,
      ),
    ).toBe(false)
  })

  it('no shipped event is eligible there at any hour, in any borough, for any player', () => {
    const rng = createRng(4)
    for (let i = 0; i < CASES; i++) {
      const memorial = contextAt('memorial', rng)
      expect(
        eligibleEvents(randomSnapshot(rng), initialEventsState(), memorial, engineConfig),
      ).toEqual([])
    }
  })

  it('rolls there never fire, even with a certain roll chance, and no event can be opened', () => {
    const certain: EngineConfig = {
      ...engineConfig,
      events: { ...engineConfig.events, rollChance: 1 },
    }
    const rng = createRng(17)
    for (let seed = 0; seed < 500; seed++) {
      const events = { ...initialEventsState(), rngState: seed }
      const memorial = contextAt('memorial', rng)
      expect(rollEvent(randomSnapshot(rng), events, memorial, certain).event).toBeNull()
    }
    const memorial = contextAt('memorial', rng)
    for (const event of engineConfig.events.catalog) {
      expect(
        openEvent(
          initialSnapshot(engineConfig),
          initialEventsState(),
          event.id,
          memorial,
          engineConfig,
        ),
      ).toEqual({
        ok: false,
        error: { code: 'EVENT_NOT_ELIGIBLE', eventId: event.id },
      })
    }
  })
})

describe('no crime event can fire at a government building', () => {
  it('no randomly generated crime event is ever eligible there', () => {
    const rng = createRng(1600)
    let nonCrimeEligible = 0
    for (let i = 0; i < CASES; i++) {
      const event = randomEvent(`random-${i}`, rng)
      const snapshot = randomSnapshot(rng)
      const cityHall = contextAt('government', rng)
      const eligible = isEventEligible(
        event,
        snapshot,
        initialEventsState(),
        cityHall,
        engineConfig,
      )
      if (event.tags.includes('crime')) expect(eligible).toBe(false)
      else if (eligible) nonCrimeEligible++
    }
    // Other events may still happen there (a tourist photo at City Hall is fine).
    expect(nonCrimeEligible).toBeGreaterThan(0)
  })

  it('no shipped crime event is eligible there at any hour, in any borough, for any player', () => {
    const rng = createRng(5)
    for (let i = 0; i < CASES; i++) {
      const cityHall = contextAt('government', rng)
      const eligible = eligibleEvents(
        randomSnapshot(rng),
        initialEventsState(),
        cityHall,
        engineConfig,
      )
      expect(eligible.filter((event) => event.tags.includes('crime'))).toEqual([])
    }
  })
})

describe('the safety guard itself', () => {
  const tagged = (tags: GameEvent['tags']): GameEvent => ({
    ...randomEvent('guarded', createRng(3)),
    tags,
    conditions: {},
  })
  const at = (locationCategory: LocationCategory | null): EventContext => ({
    borough: null,
    locationId: null,
    locationCategory,
    itemIds: [],
  })

  it.each(EVENT_TAGS.map((tag) => [tag]))('a %s event is forbidden at a memorial', (tag) => {
    expect(isForbiddenAt(tagged([tag]), at('memorial'))).toBe(true)
  })

  it('only crime events are forbidden at a government building, whatever else they carry', () => {
    for (const tag of EVENT_TAGS) {
      expect(isForbiddenAt(tagged([tag]), at('government')), tag).toBe(tag === 'crime')
      expect(isForbiddenAt(tagged([tag, 'crime']), at('government')), `${tag}+crime`).toBe(true)
    }
  })

  it('crime events are allowed at every other kind of place, and on the street', () => {
    const crime = tagged(['crime'])
    for (const category of CATEGORIES.filter((c) => c !== 'memorial' && c !== 'government')) {
      expect(isForbiddenAt(crime, at(category)), category).toBe(false)
    }
    expect(isForbiddenAt(crime, at(null))).toBe(false)
  })

  it('a memorial blocks even an event listing that exact place id, with a certain roll', () => {
    const named = { ...tagged(['landmark']), conditions: { locationIds: ['a-memorial'] } }
    const certain: EngineConfig = {
      ...engineConfig,
      events: { ...engineConfig.events, rollChance: 1, catalog: [named] },
    }
    const memorial = { ...at('memorial'), locationId: 'a-memorial' }
    for (let seed = 0; seed < 200; seed++) {
      const events = { ...initialEventsState(), rngState: seed }
      expect(rollEvent(initialSnapshot(engineConfig), events, memorial, certain).event).toBeNull()
    }
  })
})

describe('places are judged by data, not by the caller', () => {
  // A fixture place map, so these tests hold whatever data/landmarks and data/venues contain.
  const places = placeCategories(
    [
      { id: 'fixture-memorial', category: 'memorial' },
      { id: 'fixture-city-hall', category: 'government' },
      { id: 'fixture-bridge', category: 'bridge' },
    ],
    [{ id: 'fixture-club', type: 'club' }],
  )
  const anywhere: GameEvent = {
    ...randomEvent('anywhere', createRng(8)),
    tags: ['social'],
    conditions: {},
  }
  const crime: GameEvent = { ...anywhere, id: 'crime', tags: ['crime'] }
  const clubOnly: GameEvent = {
    ...anywhere,
    id: 'club-only',
    conditions: { locationCategories: ['club'] },
  }
  const config: EngineConfig = {
    ...engineConfig,
    places,
    events: { ...engineConfig.events, rollChance: 1, catalog: [anywhere, crime, clubOnly] },
  }
  const at = (
    locationId: string | null,
    locationCategory: LocationCategory | null = null,
  ): EventContext => ({
    borough: 'manhattan',
    locationId,
    locationCategory,
    itemIds: [],
  })
  const night = { ...initialSnapshot(engineConfig), clock: { minute: 22 * 60, remainderMs: 0 } }
  const ids = (context: EventContext) =>
    eligibleEvents(night, initialEventsState(), context, config).map((event) => event.id)

  it('builds the map from landmark categories and venue types', () => {
    expect(places.get('fixture-memorial')).toBe('memorial')
    expect(places.get('fixture-club')).toBe('club')
    expect(places.get('constructor')).toBeUndefined()
  })

  it('a memorial id with no category from the caller still blocks everything (the repro)', () => {
    expect(ids(at('fixture-memorial'))).toEqual([])
    expect(isForbiddenAt(anywhere, at('fixture-memorial'), config)).toBe(true)
  })

  it('a government id with no category still blocks crime, and only crime', () => {
    expect(ids(at('fixture-city-hall'))).toEqual(['anywhere'])
  })

  it('an id without a category resolves to its data category for conditions too', () => {
    expect(ids(at('fixture-club'))).toEqual(['anywhere', 'crime', 'club-only'])
  })

  it('an id the data does not know is refused for every event, never treated as the street', () => {
    expect(ids(at('no-such-place'))).toEqual([])
    expect(ids(at('no-such-place', 'club'))).toEqual([])
    expect(isForbiddenAt(anywhere, at('no-such-place'), config)).toBe(true)
    expect(ids(at(null))).toEqual(['anywhere', 'crime'])
  })

  it('when the caller and the data disagree, the data wins', () => {
    expect(ids(at('fixture-memorial', 'park'))).toEqual([])
    expect(ids(at('fixture-city-hall', 'club'))).toEqual(['anywhere'])
    expect(ids(at('fixture-bridge', 'club'))).toEqual(['anywhere', 'crime'])
    const opened = openEvent(
      night,
      initialEventsState(),
      'anywhere',
      at('fixture-memorial', 'bridge'),
      config,
    )
    expect(opened.ok).toBe(false)
    for (let seed = 0; seed < 200; seed++) {
      const events = { ...initialEventsState(), rngState: seed }
      expect(rollEvent(night, events, at('fixture-memorial', 'park'), config).event).toBeNull()
    }
  })

  it('the shipped place data is wired in, and an unknown id there is refused', () => {
    expect(engineConfig.places.size).toBeGreaterThan(0)
    expect(
      eligibleEvents(
        initialSnapshot(engineConfig),
        initialEventsState(),
        at('unknown-id'),
        engineConfig,
      ),
    ).toEqual([])
  })
})

describe('the shipped landmarks are guarded by id alone', () => {
  const by = (locationId: string): EventContext => ({
    borough: 'manhattan',
    locationId,
    locationCategory: null,
    itemIds: [],
  })

  it('city-hall is a government building and september-11-memorial a memorial', () => {
    expect(engineConfig.places.get('city-hall')).toBe('government')
    expect(engineConfig.places.get('september-11-memorial')).toBe('memorial')
  })

  it('at every hour, nothing is eligible at the memorial and no crime at City Hall', () => {
    for (let hour = 0; hour < 24; hour++) {
      const snapshot = {
        ...initialSnapshot(engineConfig),
        clock: { minute: hour * 60, remainderMs: 0 },
      }
      expect(
        eligibleEvents(snapshot, initialEventsState(), by('september-11-memorial'), engineConfig),
      ).toEqual([])
      const atCityHall = eligibleEvents(
        snapshot,
        initialEventsState(),
        by('city-hall'),
        engineConfig,
      )
      expect(atCityHall.filter((event) => event.tags.includes('crime'))).toEqual([])
    }
  })
})
