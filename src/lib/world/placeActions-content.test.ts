/**
 * Content checks for S09 place actions: balance.json `place` agrees with data/venues,
 * data/landmarks and the copy files (BalanceConfigSchema cannot import the content schemas),
 * every real place yields a sheet without throwing, clubs open at night only, and memorial
 * copy stays plain (base only, never overridden by a slang pack).
 */
import { describe, expect, it } from 'vitest'
import { balance } from '@/lib/data/config'
import { landmarks, venues } from '@/lib/data/content'
import { BalanceConfigSchema, type BalanceConfig } from '@/lib/data/schemas/config'
import { VENUE_TYPES } from '@/lib/data/schemas/content'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { engineConfig } from '@/engine/config'
import { initialSnapshot, type GameSnapshot } from '@/engine/game'
import { withClout } from '@/engine/test-support'
import { flexMultiplier, placeActions, placeHoursNow } from '@/engine/placeActions'
import { placeAllows } from '@/engine/places'

const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase())

function snapshotAt(clock: string, clout = 0): GameSnapshot {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  const base = initialSnapshot(engineConfig)
  return withClout({ ...base, clock: { minute: h * 60 + m, remainderMs: 0 } }, clout, engineConfig)
}

describe('balance.json place config against content', () => {
  it('flexes only at real venue types (clout.flex.venueTypes)', () => {
    const known: readonly string[] = VENUE_TYPES
    expect(balance.clout.flex.venueTypes.length).toBeGreaterThan(0)
    for (const type of balance.clout.flex.venueTypes) expect(known, type).toContain(type)
  })

  it('names an action set for every venue type, and no others', () => {
    expect(Object.keys(balance.place.venueActions).sort()).toEqual([...VENUE_TYPES].sort())
  })

  it('has a club rule for every club venue, and only for club venues', () => {
    const clubs = venues.filter((venue) => venue.type === 'club').map((venue) => venue.id)
    expect(clubs.length).toBeGreaterThan(0)
    expect(Object.keys(balance.place.clubs).sort()).toEqual(clubs.sort())
  })

  it('every club refusal key is a base copy string with the level placeholders', () => {
    for (const rule of Object.values(balance.place.clubs)) {
      const template = baseCopy.strings[rule.refusalKey]
      expect(template, rule.refusalKey).toBeDefined()
      expect(template).toContain('{level}')
      expect(template).toContain('{current}')
    }
  })

  it('flex multipliers name only landmarks that allow flex (never a memorial)', () => {
    for (const id of Object.keys(balance.place.flexMultiplier.byLandmark)) {
      const landmark = landmarks.find((entry) => entry.id === id)
      expect(landmark, id).toBeDefined()
      if (landmark === undefined) continue
      expect(landmark.category).not.toBe('memorial')
      expect(placeAllows(landmark, 'flex'), id).toBe(true)
    }
  })

  it('every offered action has a copy name and gives the player something', () => {
    const offered = new Set(Object.values(balance.place.venueActions).flat())
    for (const id of offered) {
      expect(baseCopy.strings[`place.actions.${camel(id)}.name`], id).toBeDefined()
      const def = balance.actions.catalog[id] ?? balance.place.actions[id]
      const gains = Object.values(def?.statEffects ?? {}).filter((value) => value > 0)
      expect(gains.length, id).toBeGreaterThan(0)
    }
  })
})

describe('BalanceConfigSchema place rules', () => {
  const valid = balance
  const withPlace = (place: Partial<BalanceConfig['place']>) => ({
    ...valid,
    place: { ...valid.place, ...place },
  })

  it('accepts the shipped config', () => {
    expect(BalanceConfigSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a venue action that names no action', () => {
    const venueActions = { ...valid.place.venueActions, gym: ['nope'] }
    expect(BalanceConfigSchema.safeParse(withPlace({ venueActions })).success).toBe(false)
  })

  it('rejects a place action that reuses a catalog id', () => {
    const actions = {
      ...valid.place.actions,
      sleep: { durationMin: 1, cashCost: 0, energyCost: 0, statEffects: {} },
    }
    expect(BalanceConfigSchema.safeParse(withPlace({ actions })).success).toBe(false)
  })

  it('rejects a club door at an unknown clout level', () => {
    const [id, rule] = Object.entries(valid.place.clubs)[0] ?? []
    if (id === undefined || rule === undefined) throw new Error('no club rule')
    const clubs = { ...valid.place.clubs, [id]: { ...rule, minCloutLevel: 'royalty' } }
    expect(BalanceConfigSchema.safeParse(withPlace({ clubs })).success).toBe(false)
  })

  it('rejects a visit longer than maxDurationMin', () => {
    const visit = { ...valid.place.visit, durationMin: valid.actions.maxDurationMin + 1 }
    expect(BalanceConfigSchema.safeParse(withPlace({ visit })).success).toBe(false)
  })
})

describe('every real place', () => {
  const places = [...venues, ...landmarks]

  it.each(['03:00', '08:00', '12:00', '23:00'])('yields a sheet at %s', (clock) => {
    for (const clout of [0, 100, 300, 800, 5000]) {
      for (const place of places) {
        expect(() => placeActions(place, snapshotAt(clock, clout), engineConfig)).not.toThrow()
      }
    }
  })

  it('memorials are look-only with no flex multiplier', () => {
    const memorials = landmarks.filter((entry) => entry.category === 'memorial')
    expect(memorials.length).toBeGreaterThan(0)
    for (const memorial of memorials) {
      expect(placeActions(memorial, snapshotAt('12:00', 5000), engineConfig)).toEqual({
        kind: 'look-only',
      })
      expect(flexMultiplier(memorial, engineConfig)).toBeNull()
    }
  })

  it('every other landmark offers a Visit, and a Flex where it allows one', () => {
    for (const landmark of landmarks.filter((entry) => entry.category !== 'memorial')) {
      const view = placeActions(landmark, snapshotAt('12:00', 5000), engineConfig)
      const expected = placeAllows(landmark, 'flex') ? ['visit', 'flex'] : ['visit']
      expect(view.kind === 'actions' && view.actions.map((action) => action.id)).toEqual(expected)
    }
  })

  it('clubs are closed by day and open at night', () => {
    for (const club of venues.filter((venue) => venue.type === 'club')) {
      expect(placeHoursNow(club, snapshotAt('12:00'), engineConfig).status, club.id).toBe('closed')
      expect(placeHoursNow(club, snapshotAt('23:00'), engineConfig).status, club.id).toBe('open')
    }
  })
})

describe('memorial copy is plain', () => {
  const memorialKeys = [
    ...landmarks
      .filter((entry) => entry.category === 'memorial')
      .flatMap((entry) => [entry.nameKey, entry.infoKey]),
    ...Object.keys(baseCopy.strings).filter((key) => key.startsWith('place.memorial.')),
  ]

  it('no slang pack overrides a memorial string', () => {
    expect(memorialKeys.length).toBeGreaterThan(2)
    for (const [packId, pack] of Object.entries(slangPacks)) {
      for (const key of memorialKeys) {
        expect(Object.hasOwn(pack.strings, key), `${packId}: ${key}`).toBe(false)
      }
    }
  })
})
