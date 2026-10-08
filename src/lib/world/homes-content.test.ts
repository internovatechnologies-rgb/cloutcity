/**
 * data/homes/homes.json (S05): every home has a start point on its borough's land, in the zone
 * it names, outside any park. The Queens room, where every new player starts, sits in Astoria
 * near the 24-hour Late Lantern Deli, so a first breakfast is a short walk away.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { balance } from '@/lib/data/config'
import { homes, venues } from '@/lib/data/content'
import { land, parks, zoneShapes } from '@/lib/data/geo'
import { HOME_IDS } from '@/lib/data/homes'
import { HomesFileSchema } from '@/lib/data/schemas/content'
import { areaAt, prepareAreas } from '@/lib/geo/lookup'
import { distanceM, project } from '@/lib/geo/projection'

const DATA = join(import.meta.dirname, '../../../data')
const raw = JSON.parse(readFileSync(join(DATA, 'homes/homes.json'), 'utf8')) as {
  homes: Record<string, unknown>
}

const boroughAreas = prepareAreas(land.boroughs)
const zoneAreas = prepareAreas(zoneShapes.zones)
const parkAreas = prepareAreas(parks.parks)
const zoneBorough = new Map(
  (
    JSON.parse(readFileSync(join(DATA, 'zones/zones.derived.json'), 'utf8')) as {
      zones: { id: string; borough: string }[]
    }
  ).zones.map((zone) => [zone.id, zone.borough]),
)

/** The Queens room's start point is within this walk of the Queens bodega. */
const NEAR_DELI_M = 250

describe('homes (S05)', () => {
  it('has exactly one entry per home id', () => {
    expect(Object.keys(homes).sort()).toEqual([...HOME_IDS].sort())
  })

  it('the schema rejects a missing home and an unknown one', () => {
    const missing = Object.fromEntries(
      Object.entries(raw.homes).filter(([id]) => id !== 'manhattan-loft'),
    )
    expect(HomesFileSchema.safeParse({ homes: missing }).success).toBe(false)
    expect(
      HomesFileSchema.safeParse({
        homes: { ...raw.homes, 'bronx-studio': raw.homes['queens-room'] },
      }).success,
    ).toBe(false)
  })

  it.each(HOME_IDS.map((id) => [id] as const))(
    '%s: on its borough’s land, in its zone, not in a park',
    (id) => {
      const home = homes[id]
      const point = project(home.location)
      expect(areaAt(point, boroughAreas), 'borough').toBe(home.borough)
      expect(areaAt(point, zoneAreas), 'zoneId').toBe(home.zoneId)
      expect(zoneBorough.get(home.zoneId), 'zone borough').toBe(home.borough)
      expect(areaAt(point, parkAreas), 'park').toBeUndefined()
    },
  )

  it('every new player starts in the Queens room, in zone qn01', () => {
    expect(balance.start.home).toBe('queens-room')
    expect(homes['queens-room']).toMatchObject({ borough: 'queens', zoneId: 'qn01' })
  })

  it('the Queens room is a short walk from the Queens bodega', () => {
    const deli = venues.find((venue) => venue.id === 'late-lantern-deli')
    if (deli === undefined) throw new Error('late-lantern-deli is missing')
    const gap = distanceM(project(homes['queens-room'].location), project(deli.location))
    expect(gap).toBeLessThanOrEqual(NEAR_DELI_M)
    // Not on top of it either: the avatar and the venue pin must not overlap.
    expect(gap).toBeGreaterThanOrEqual(50)
  })
})
