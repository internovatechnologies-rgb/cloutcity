import { describe, expect, it } from 'vitest'
import { boroughAccess } from '@/engine/boroughs'
import { appendClout, levelClout, totalClout } from '@/engine/clout'
import { engineConfig, type EngineConfig } from '@/engine/config'
import { placeAllows } from '@/engine/places'
import { initialSave } from '@/engine/save'
import { playerWithClout } from '@/engine/test-support'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { cloutLevelName } from '@/lib/economyCopy'
import { project } from '@/lib/geo/projection'
import { landmarks as loadedLandmarks, venues as loadedVenues } from '@/lib/data/content'
import {
  boroughClosedReason,
  boroughRenderState,
  gateClout,
  landmarks,
  mapPlaces,
  placeAccess,
  placeAccessibleName,
  placeName,
  venues,
} from './places'

const packs = {
  plain: createCopy(baseCopy, slangPacks.plain ?? { id: 'plain', strings: {} }),
  nyc: createCopy(baseCopy, slangPacks.nyc ?? { id: 'nyc', strings: {} }),
}
const place = (id: string) => {
  const found = mapPlaces().find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no place ${id}`)
  return found
}
const minClout = (id: string) =>
  engineConfig.clout.levels.find((level) => level.id === id)?.minClout ?? Number.NaN

describe('client data matches the validated loader', () => {
  it('venues and landmarks are the parsed data files', () => {
    expect(venues).toEqual(loadedVenues)
    expect(landmarks).toEqual(loadedLandmarks)
  })
})

describe('mapPlaces', () => {
  it('lists every venue and landmark once, projected', () => {
    const places = mapPlaces()
    expect(places).toHaveLength(venues.length + landmarks.length)
    const deli = place('late-lantern-deli')
    const at = project({ lat: 40.7644, lng: -73.9235 })
    expect(deli).toMatchObject({ kind: 'venue', category: 'bodega', borough: 'queens' })
    expect([deli.x, deli.y]).toEqual([at.x, at.y])
    expect([deli.routeX, deli.routeY]).toEqual([at.x, at.y])
  })

  it('routes to the approach point when a landmark has one', () => {
    const statue = place('statue-of-liberty')
    const battery = landmarks.find((entry) => entry.id === 'statue-of-liberty')?.approach
    if (battery === undefined) throw new Error('statue has no approach')
    expect([statue.routeX, statue.routeY]).toEqual([project(battery).x, project(battery).y])
    expect([statue.x, statue.y]).not.toEqual([statue.routeX, statue.routeY])
  })
})

describe('gating places', () => {
  it('a bridge gates by its approach borough', () => {
    expect(place('brooklyn-bridge').borough).toBe('brooklyn')
    expect(placeAccess(place('brooklyn-bridge'), 0).status).toBe('locked')
    expect(placeAccess(place('brooklyn-bridge'), minClout('local')).status).toBe('open')
    expect(placeAccess(place('queensboro-bridge'), 0).status).toBe('open')
    expect(placeAccess(place('manhattan-bridge'), minClout('local')).status).toBe('locked')
  })

  it('the memorial in an unlocked Manhattan is reachable but look-only', () => {
    const memorial = landmarks.find((entry) => entry.category === 'memorial')
    if (memorial === undefined) throw new Error('no memorial')
    expect(placeAccess(memorial, minClout('scene-regular')).status).toBe('open')
    for (const hook of ['visit', 'flex', 'emote', 'events', 'crime'] as const) {
      expect(placeAllows(memorial, hook)).toBe(false)
    }
  })

  it('follows a config override', () => {
    const config: EngineConfig = {
      ...engineConfig,
      boroughs: { ...engineConfig.boroughs, brooklyn: { access: 'open' } },
    }
    expect(placeAccess(place('dumbo'), 0, config).status).toBe('open')
  })
})

describe('accessible names explain the lock', () => {
  // Memorials are never locked (DEC-46), so they are left out here; see below.
  const locked = mapPlaces().filter(
    (entry) =>
      (entry.borough === 'brooklyn' || entry.borough === 'manhattan') &&
      entry.category !== 'memorial',
  )

  it.each(Object.entries(packs))('in the %s pack, every locked place says why', (_pack, copy) => {
    for (const entry of locked) {
      const access = placeAccess(entry, 0)
      const reason = boroughClosedReason(entry.borough, access, { copy })
      expect(reason, entry.id).not.toBeNull()
      const name = placeAccessibleName(entry, access, { copy })
      expect(name).toContain(placeName(entry, { copy }))
      expect(name).toContain(reason ?? '')
      expect(name).toContain(cloutLevelName('nobody', { copy }))
    }
  })

  it('renders the why-locked copy with the level names, in voice', () => {
    const access = boroughAccess('manhattan', 0, engineConfig)
    expect(placeAccessibleName(place('times-square'), access, { copy: packs.nyc })).toBe(
      "Times Square. Manhattan? On bodega money? Hit Scene Regular first. You're Nobody right now.",
    )
    expect(
      placeAccessibleName(place('dumbo'), placeAccess(place('dumbo'), 0), { copy: packs.plain }),
    ).toBe("DUMBO. Brooklyn is locked: reach Local clout to unlock it. You're at Nobody.")
  })

  it('an open place is just its name', () => {
    const deli = place('late-lantern-deli')
    expect(placeAccessibleName(deli, placeAccess(deli, 0))).toBe(placeName(deli))
  })

  it.each(Object.entries(packs))('in the %s pack, teaser names carry the teaser', (_pack, copy) => {
    for (const id of ['bronx-ballpark', 'staten-island-ferry']) {
      const entry = place(id)
      const access = placeAccess(entry, minClout('icon'))
      expect(access.status).toBe('expanding-soon')
      const teaser = boroughClosedReason(entry.borough, access, { copy })
      expect(teaser).toMatch(/expanding soon/i)
      expect(placeAccessibleName(entry, access, { copy })).toContain(teaser ?? '')
    }
  })

  it('no place has an empty name in any pack', () => {
    for (const copy of Object.values(packs)) {
      for (const entry of mapPlaces()) {
        expect(
          placeAccessibleName(entry, placeAccess(entry, 0), { copy }).trim(),
          entry.id,
        ).not.toBe('')
      }
    }
  })
})

describe('boroughRenderState', () => {
  it('dims the expanding-soon boroughs with their teasers and draws the rest normally', () => {
    expect(boroughRenderState('bronx')).toEqual({
      state: 'dimmed',
      teaserLandmarkIds: ['bronx-ballpark'],
      teaserKey: 'boroughs.bronx.teaser',
    })
    expect(boroughRenderState('staten-island')).toEqual({
      state: 'dimmed',
      teaserLandmarkIds: ['staten-island-ferry'],
      teaserKey: 'boroughs.statenIsland.teaser',
    })
    for (const id of ['queens', 'brooklyn', 'manhattan'] as const) {
      expect(boroughRenderState(id)).toEqual({ state: 'normal', teaserLandmarkIds: [] })
    }
  })

  it('follows the config', () => {
    const config: EngineConfig = {
      ...engineConfig,
      boroughs: { ...engineConfig.boroughs, bronx: { access: 'open' } },
    }
    expect(boroughRenderState('bronx', config).state).toBe('normal')
  })
})

describe('accessible names at and around the unlock level', () => {
  const unlock = { brooklyn: 'local', manhattan: 'scene-regular' } as const

  it.each(Object.entries(packs))(
    'in the %s pack, a place is its plain name from its unlock level and explains the lock one clout below',
    (_pack, copy) => {
      for (const entry of mapPlaces()) {
        if (entry.borough !== 'brooklyn' && entry.borough !== 'manhattan') continue
        if (entry.category === 'memorial') continue
        const threshold = minClout(unlock[entry.borough])
        const plain = placeName(entry, { copy })
        const open = placeAccessibleName(entry, placeAccess(entry, threshold), { copy })
        expect(open, entry.id).toBe(plain)
        const below = placeAccessibleName(entry, placeAccess(entry, threshold - 1), { copy })
        expect(below, entry.id).not.toBe(plain)
        expect(below.startsWith(plain), entry.id).toBe(true)
      }
    },
  )

  it.each(Object.entries(packs))(
    'in the %s pack, no accessible name at any level is empty or holds a raw placeholder',
    (_pack, copy) => {
      for (const level of engineConfig.clout.levels) {
        for (const entry of mapPlaces()) {
          const name = placeAccessibleName(entry, placeAccess(entry, level.minClout), { copy })
          expect(name.trim(), `${entry.id} at ${level.id}`).not.toBe('')
          expect(name, `${entry.id} at ${level.id}`).not.toMatch(/[{}]/)
        }
      }
    },
  )
})

describe('the Places panel gates on levelClout, as the engine does (Icon boundary)', () => {
  const ICON = engineConfig.clout.levels.at(-1)?.minClout ?? Number.NaN
  // A borough opening at Icon makes the Icon rule visible: only earned clout reaches Icon.
  const config: EngineConfig = {
    ...engineConfig,
    boroughs: { ...engineConfig.boroughs, brooklyn: { access: 'clout', level: 'icon' } },
  }

  function player(earned: number, granted: number) {
    const base = initialSave(engineConfig).player
    const withEarned = playerWithClout(base, earned, engineConfig)
    if (granted === 0) return withEarned
    const { state } = appendClout(
      withEarned.clout,
      { source: 'grant', amount: granted, ref: { grantKey: 'goal:reach-famous:r1' } },
      9000,
      engineConfig,
    )
    return { ...withEarned, clout: state }
  }

  it('one clout short of Icon in earned clout, topped up by a grant, stays locked', () => {
    const p = player(ICON - 110, 110)
    expect(totalClout(p, engineConfig)).toBe(ICON)
    expect(gateClout(p, config)).toBe(levelClout(p, config))
    expect(gateClout(p, config)).toBe(ICON - 1)
    expect(placeAccess(place('dumbo'), gateClout(p, config), config).status).toBe('locked')
    // What the engine itself says about a trip there agrees.
    expect(boroughAccess('brooklyn', levelClout(p, config), config).status).toBe('locked')
    // The raw total would have opened it: the bug this guards against.
    expect(placeAccess(place('dumbo'), totalClout(p, engineConfig), config).status).toBe('open')
  })

  it('Icon reached on earned clout opens it', () => {
    const p = player(ICON, 0)
    expect(gateClout(p, config)).toBe(ICON)
    expect(placeAccess(place('dumbo'), gateClout(p, config), config).status).toBe('open')
  })

  it('below Icon, levelClout is the total (grants count toward every other level)', () => {
    const p = player(50, 60)
    expect(gateClout(p, engineConfig)).toBe(totalClout(p, engineConfig))
    expect(placeAccess(place('dumbo'), gateClout(p, engineConfig)).status).toBe('open')
  })
})
