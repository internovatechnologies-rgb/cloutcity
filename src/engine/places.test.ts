import { describe, expect, it } from 'vitest'
import type { Landmark, Venue } from '@/lib/data/schemas/content'
import { isOpenAt, placeAllows, type PlaceHook } from './places'

const at = (clock: string) => {
  const [h = 0, m = 0] = clock.split(':').map(Number)
  return h * 60 + m
}

describe('isOpenAt', () => {
  it.each([
    ['00:00', true],
    ['12:00', true],
    ['23:59', true],
  ])('24h is open at %s', (clock, open) => {
    expect(isOpenAt('24h', at(clock))).toBe(open)
  })

  const day = { open: '07:00', close: '23:00' }
  it.each([
    ['06:59', false],
    ['07:00', true],
    ['15:30', true],
    ['22:59', true],
    ['23:00', false],
    ['00:00', false],
  ])('07:00-23:00 at %s is %s', (clock, open) => {
    expect(isOpenAt(day, at(clock))).toBe(open)
  })

  const club = { open: '22:00', close: '04:00' }
  it.each([
    ['21:59', false],
    ['22:00', true],
    ['23:59', true],
    ['00:00', true],
    ['03:59', true],
    ['04:00', false],
    ['12:00', false],
  ])('a club open 22:00-04:00 (past midnight) at %s is %s', (clock, open) => {
    expect(isOpenAt(club, at(clock))).toBe(open)
  })

  it('wraps minutes outside one day onto the clock', () => {
    expect(isOpenAt(club, at('23:00') + 1440)).toBe(true)
    expect(isOpenAt(club, -60)).toBe(true)
    expect(isOpenAt(day, at('12:00') + 2 * 1440)).toBe(true)
  })
})

const base = {
  nameKey: 'landmarks.probe.name',
  infoKey: 'landmarks.probe.info',
  nameMode: 'real',
  legalReviewed: false,
  borough: 'manhattan',
  zoneId: 'mn01',
  location: { lat: 40.71, lng: -74.01 },
} as const

const memorial: Landmark = { ...base, id: 'memorial', category: 'memorial', lookOnly: true }
const cityHall: Landmark = {
  ...base,
  id: 'hall',
  category: 'government',
  interactions: ['visit'],
}
const park: Landmark = {
  ...base,
  id: 'park',
  category: 'park',
  interactions: ['visit', 'flex'],
}
const bodega: Venue = {
  id: 'bodega',
  nameKey: 'venues.probe.name',
  blurbKey: 'venues.probe.blurb',
  type: 'bodega',
  borough: 'queens',
  zoneId: 'qn01',
  location: { lat: 40.76, lng: -73.92 },
  hours: '24h',
}

const HOOKS: readonly PlaceHook[] = ['visit', 'flex', 'emote', 'events', 'crime']

describe('placeAllows', () => {
  it.each(HOOKS)('a memorial allows no %s', (hook) => {
    expect(placeAllows(memorial, hook)).toBe(false)
  })

  it('a government building never hosts crime', () => {
    expect(placeAllows(cityHall, 'crime')).toBe(false)
    expect(placeAllows(cityHall, 'visit')).toBe(true)
  })

  it('a landmark allows only the interactions it lists, plus crime', () => {
    expect(HOOKS.filter((hook) => placeAllows(park, hook))).toEqual(['visit', 'flex', 'crime'])
  })

  it('a venue allows every hook', () => {
    expect(HOOKS.every((hook) => placeAllows(bodega, hook))).toBe(true)
  })
})

describe('isOpenAt edge minutes', () => {
  const day = { open: '07:00', close: '23:00' }
  const club = { open: '22:00', close: '04:00' }
  const midnightOpen = { open: '00:00', close: '06:00' }
  const midnightClose = { open: '18:00', close: '00:00' }

  it('floors fractional minutes onto the clock', () => {
    expect(isOpenAt(day, at('07:00') - 0.5)).toBe(false)
    expect(isOpenAt(day, at('07:00') + 0.5)).toBe(true)
    expect(isOpenAt(day, at('23:00') - 0.01)).toBe(true)
    expect(isOpenAt(club, at('04:00') - 0.01)).toBe(true)
  })

  it('treats 1440 as midnight and negative minutes as the previous day', () => {
    expect(isOpenAt(club, 1440)).toBe(true)
    expect(isOpenAt(day, 1440)).toBe(false)
    expect(isOpenAt(day, -1)).toBe(false)
    expect(isOpenAt(club, -1)).toBe(true)
    expect(isOpenAt(day, at('07:00') - 1440)).toBe(true)
  })

  it('handles hours that open or close exactly at midnight', () => {
    expect(isOpenAt(midnightOpen, 0)).toBe(true)
    expect(isOpenAt(midnightOpen, at('05:59'))).toBe(true)
    expect(isOpenAt(midnightOpen, at('06:00'))).toBe(false)
    expect(isOpenAt(midnightOpen, at('23:59'))).toBe(false)
    expect(isOpenAt(midnightClose, at('18:00'))).toBe(true)
    expect(isOpenAt(midnightClose, at('23:59'))).toBe(true)
    expect(isOpenAt(midnightClose, 0)).toBe(false)
    expect(isOpenAt(midnightClose, at('17:59'))).toBe(false)
  })

  it('a one-minute window is open for exactly that minute', () => {
    const minute = { open: '12:00', close: '12:01' }
    expect([at('11:59'), at('12:00'), at('12:01')].map((m) => isOpenAt(minute, m))).toEqual([
      false,
      true,
      false,
    ])
    const allButOne = { open: '12:01', close: '12:00' }
    expect([at('11:59'), at('12:00'), at('12:01')].map((m) => isOpenAt(allButOne, m))).toEqual([
      true,
      false,
      true,
    ])
  })
})

describe('placeAllows on landmark categories', () => {
  it('a government building allows only what it lists and never crime', () => {
    const hall: Landmark = { ...cityHall, interactions: ['visit', 'flex', 'emote', 'events'] }
    expect(HOOKS.filter((hook) => placeAllows(hall, hook))).toEqual([
      'visit',
      'flex',
      'emote',
      'events',
    ])
  })
})
