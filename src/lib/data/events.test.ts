/**
 * Event content (data/events) against the schema, the other data files and the safety rules in
 * CLAUDE.md. The engine-side guarantees (no event can be eligible at a memorial, whatever its
 * conditions) are proven in src/engine/eventSafety.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { balance } from './config'
import { events, items, landmarks, venues } from './content'
import {
  DRINKING_WORDS,
  DRUG_WORDS,
  GAMBLING_WORDS,
  PROFANITY_WORDS,
  SEXUAL_WORDS,
  findWords,
} from './eventSafety.fixture'
import { EventSchema, EventsFileSchema, type GameEvent } from './schemas/content'

const EFFECT_KINDS: readonly string[] = ['cash', 'stat', 'time', 'clout', 'item']

const REQUIRED_EVENTS = ['mta-delay', 'rent-hike', 'free-pizza', 'club-promoter', 'viral-moment']

const isCrime = (event: GameEvent) => event.tags.includes('crime')
const isLandmarkTied = (event: GameEvent) =>
  event.tags.includes('landmark') &&
  (event.conditions.locationIds !== undefined || event.conditions.locationCategories !== undefined)

/** Every copy key an event names, by role. */
function eventKeys(event: GameEvent) {
  return {
    flavour: [event.titleKey, event.bodyKey],
    choices: event.choices.flatMap((choice) => [choice.labelKey, choice.resultKey]),
  }
}

/** The text of a key in base copy and in every slang pack that overrides it. */
function renderings(key: string): string[] {
  const texts = [baseCopy.strings[key] ?? '']
  for (const pack of Object.values(slangPacks)) {
    const text = pack.strings[key]
    if (text !== undefined) texts.push(text)
  }
  return texts
}

function scan(keys: readonly string[], words: readonly string[]) {
  return keys.flatMap((key) =>
    renderings(key).flatMap((text) => findWords(text, words).map((word) => `${key}: ${word}`)),
  )
}

const valid: GameEvent = (() => {
  const first = events[0]
  if (first === undefined) throw new Error('data/events has no events')
  return first
})()

describe('event catalog', () => {
  it('has 15 events, including the ones the spec names', () => {
    expect(events).toHaveLength(15)
    expect(events.map((event) => event.id)).toEqual(expect.arrayContaining(REQUIRED_EVENTS))
  })

  it('has exactly two crime events, both mild (no cash loss above the food range)', () => {
    const crime = events.filter(isCrime)
    expect(crime).toHaveLength(2)
    for (const event of crime) {
      for (const choice of event.choices) {
        const loss = choice.effects
          .filter((effect) => effect.kind === 'cash')
          .reduce((sum, effect) => sum + effect.amount, 0)
        expect(-loss, `${event.id}.${choice.id}`).toBeLessThanOrEqual(balance.costs.food.max)
      }
    }
  })

  it('has at least two landmark-tied events', () => {
    expect(events.filter(isLandmarkTied).length).toBeGreaterThanOrEqual(2)
  })

  it('every copy key an event names exists in base copy', () => {
    const keys = events.flatMap((event) => Object.values(eventKeys(event)).flat())
    expect(keys.filter((key) => baseCopy.strings[key] === undefined)).toEqual([])
  })

  it('every place an event names is a known landmark or venue', () => {
    const places = new Set([...landmarks, ...venues].map((place) => place.id))
    const unknown = events.flatMap((event) =>
      (event.conditions.locationIds ?? []).filter((id) => !places.has(id)),
    )
    expect(unknown).toEqual([])
  })

  it('every item an event names exists in data/items', () => {
    const known = new Set(items.map((item) => item.id))
    const named = events.flatMap((event) => [
      ...(event.conditions.items?.anyOf ?? []),
      ...(event.conditions.items?.noneOf ?? []),
      ...event.choices.flatMap((choice) =>
        choice.effects.flatMap((effect) => (effect.kind === 'item' ? [effect.itemId] : [])),
      ),
    ])
    expect(named.filter((id) => !known.has(id))).toEqual([])
  })

  it('no choice takes longer than the longest allowed action', () => {
    const tooLong = events.flatMap((event) =>
      event.choices
        .filter(
          (choice) =>
            choice.effects.reduce(
              (sum, effect) => sum + (effect.kind === 'time' ? effect.minutes : 0),
              0,
            ) > balance.actions.maxDurationMin,
        )
        .map((choice) => `${event.id}.${choice.id}`),
    )
    expect(tooLong).toEqual([])
  })
})

describe('event safety rules in the data', () => {
  const memorialIds = new Set(
    landmarks.filter((place) => place.category === 'memorial').map((place) => place.id),
  )
  const governmentIds = new Set(
    landmarks.filter((place) => place.category === 'government').map((place) => place.id),
  )

  it('no event names a memorial, by category or by id', () => {
    const offenders = events.filter(
      (event) =>
        (event.conditions.locationCategories as readonly string[] | undefined)?.includes(
          'memorial',
        ) || (event.conditions.locationIds ?? []).some((id) => memorialIds.has(id)),
    )
    expect(offenders.map((event) => event.id)).toEqual([])
  })

  it('no crime event names a government building, by category or by id', () => {
    const offenders = events
      .filter(isCrime)
      .filter(
        (event) =>
          (event.conditions.locationCategories ?? []).includes('government') ||
          (event.conditions.locationIds ?? []).some((id) => governmentIds.has(id)),
      )
    expect(offenders.map((event) => event.id)).toEqual([])
  })

  it('the schema rejects a memorial location and a crime event at a government building', () => {
    const atMemorial = { ...valid, conditions: { locationCategories: ['memorial'] } }
    expect(EventSchema.safeParse(atMemorial).success).toBe(false)
    const crimeAtCityHall = {
      ...valid,
      tags: ['crime'],
      conditions: { locationCategories: ['government'] },
    }
    expect(EventSchema.safeParse(crimeAtCityHall).success).toBe(false)
    const tourAtCityHall = { ...valid, tags: ['landmark'], conditions: crimeAtCityHall.conditions }
    expect(EventSchema.safeParse(tourAtCityHall).success).toBe(true)
  })

  it('effects can only touch cash, stats, time, clout and items: nothing can reward drinking', () => {
    const kinds = new Set(
      events.flatMap((event) => event.choices.flatMap((c) => c.effects.map((e) => e.kind))),
    )
    expect([...kinds].filter((kind) => !EFFECT_KINDS.includes(kind))).toEqual([])
    const drink = { kind: 'drink', amount: 1 }
    const choice = { ...valid.choices[0], effects: [drink] }
    expect(EventSchema.safeParse({ ...valid, choices: [choice, valid.choices[1]] }).success).toBe(
      false,
    )
    const luck = { kind: 'stat', stat: 'buzz', amount: 1 }
    const buzzed = { ...valid.choices[0], effects: [luck] }
    expect(EventSchema.safeParse({ ...valid, choices: [buzzed, valid.choices[1]] }).success).toBe(
      false,
    )
  })

  it('no event condition depends on an item whose id suggests a drink', () => {
    const named = events.flatMap((event) => [
      ...(event.conditions.items?.anyOf ?? []),
      ...(event.conditions.items?.noneOf ?? []),
    ])
    expect(named.flatMap((id) => findWords(id.replace(/-/g, ' '), DRINKING_WORDS))).toEqual([])
  })

  it('no choice mentions drinking, so none can require or reward it', () => {
    expect(
      scan(
        events.flatMap((event) => eventKeys(event).choices),
        DRINKING_WORDS,
      ),
    ).toEqual([])
  })

  it('no event text mentions drinking at all (nightlife stays scenery)', () => {
    expect(
      scan(
        events.flatMap((event) => eventKeys(event).flavour),
        DRINKING_WORDS,
      ),
    ).toEqual([])
  })

  it.each([
    ['drug', DRUG_WORDS],
    ['sexual', SEXUAL_WORDS],
    ['gambling', GAMBLING_WORDS],
    ['strong profanity', PROFANITY_WORDS],
  ])('no event text has %s references', (_label, words) => {
    const keys = events.flatMap((event) => Object.values(eventKeys(event)).flat())
    expect(scan(keys, words)).toEqual([])
  })

  it.each([
    ['drinking', DRINKING_WORDS],
    ['drug', DRUG_WORDS],
    ['sexual', SEXUAL_WORDS],
    ['gambling', GAMBLING_WORDS],
    ['strong profanity', PROFANITY_WORDS],
  ])(
    'no events.* string in base copy or any pack, referenced or not, has %s words',
    (_l, words) => {
      const sources = [
        ['base', baseCopy.strings],
        ...Object.entries(slangPacks).map(([id, pack]) => [id, pack.strings]),
      ] as const
      const hits = sources.flatMap(([source, strings]) =>
        Object.entries(strings as Record<string, string>)
          .filter(([key]) => key.startsWith('events.'))
          .flatMap(([key, text]) =>
            findWords(text, words).map((word) => `${source} ${key}: ${word}`),
          ),
      )
      expect(hits).toEqual([])
    },
  )

  it('the club promoter offers nothing that rewards or requires drinking', () => {
    const promoter = events.find((event) => event.id === 'club-promoter')
    if (promoter === undefined) throw new Error('club-promoter is missing')
    expect(promoter.tags).toContain('nightlife')
    // A broke player can always walk away, and no choice needs an item.
    expect(promoter.choices.some((choice) => choice.effects.length === 0)).toBe(true)
    expect(promoter.conditions.items).toBeUndefined()
    for (const choice of promoter.choices) {
      expect(
        choice.effects.filter((effect) => effect.kind === 'item'),
        choice.id,
      ).toEqual([])
      expect(scan([choice.labelKey, choice.resultKey], DRINKING_WORDS), choice.id).toEqual([])
    }
  })

  it('the scanner finds whole words in any case and ignores words inside words', () => {
    expect(findWords('Grab a BEER and some Shots', DRINKING_WORDS)).toEqual(['beer', 'shots'])
    expect(findWords('Ginger ale at the rumba class', [...DRINKING_WORDS, 'ass'])).toEqual([])
    expect(findWords('No hook up here', SEXUAL_WORDS)).toEqual(['hook up'])
  })
})

describe('event schema', () => {
  it('accepts the shipped file', () => {
    expect(EventsFileSchema.safeParse({ events }).success).toBe(true)
  })

  it('needs a choice that costs nothing, so a broke player is never stuck', () => {
    const cost = (id: string) => ({
      ...valid.choices[0],
      id,
      effects: [{ kind: 'cash', amount: -5 }],
    })
    expect(EventSchema.safeParse({ ...valid, choices: [cost('a'), cost('b')] }).success).toBe(false)
  })

  it('rejects an empty hour window, an inverted range, a zero amount and one choice', () => {
    const withConditions = (conditions: unknown) => ({ ...valid, conditions })
    expect(EventSchema.safeParse(withConditions({ hours: { from: 5, to: 5 } })).success).toBe(false)
    expect(EventSchema.safeParse(withConditions({ cash: { min: 9, max: 1 } })).success).toBe(false)
    expect(EventSchema.safeParse(withConditions({ stats: { mood: {} } })).success).toBe(false)
    const zero = { ...valid.choices[0], effects: [{ kind: 'clout', amount: 0 }] }
    expect(EventSchema.safeParse({ ...valid, choices: [zero, valid.choices[1]] }).success).toBe(
      false,
    )
    expect(EventSchema.safeParse({ ...valid, choices: [valid.choices[0]] }).success).toBe(false)
  })

  it('rejects duplicate choice ids', () => {
    const first = valid.choices[0]
    expect(EventSchema.safeParse({ ...valid, choices: [first, first] }).success).toBe(false)
  })
})
