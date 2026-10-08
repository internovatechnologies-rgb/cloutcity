/**
 * DEC-46: memorials are never locked behind clout or presented as rewards. For every
 * memorial-category place, at Nobody (zero clout): its access is open, its accessible name is
 * its plain name with no lock or level copy in any pack, its sheet is the look-only info card,
 * it can be travelled to, the Places panel lists it apart from a locked borough's lock line, and
 * none of the copy it shows uses a lock, level or joke key.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { initialSnapshot } from '@/engine/game'
import { placeActions } from '@/engine/placeActions'
import { transitConfig } from '@/engine/transit/config'
import { takeTrip } from '@/engine/transit/trip'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import { cloutLevelName } from '@/lib/economyCopy'
import { tripEnd } from './tripEnds'
import {
  boroughAccessFor,
  boroughClosedReason,
  boroughs,
  findPlace,
  isMemorial,
  mapPlaces,
  placeAccess,
  placeAccessibleName,
  placeName,
} from './places'

const packs = {
  plain: createCopy(baseCopy, { id: 'none', strings: {} }),
  ...Object.fromEntries(
    Object.entries(slangPacks).map(([id, pack]) => [id, createCopy(baseCopy, pack)]),
  ),
}

const memorials = mapPlaces().filter((place) => place.category === 'memorial')

/** Every lock, level-gate or teaser string in every pack: none may reach a memorial. */
function lockTexts(copy: (typeof packs)['plain']): string[] {
  const texts: string[] = []
  for (const borough of boroughs) {
    for (const level of engineConfig.clout.levels) {
      const reason = boroughClosedReason(borough.id, boroughAccessFor(borough.id, level.minClout), {
        copy,
      })
      if (reason !== null) texts.push(reason)
    }
  }
  return texts
}

const LOCK_OR_JOKE_KEYS = /\.(locked|teaser|refused|refusedVip)$|^voice\.|^club\.door|^home\.lock/

describe('memorials (DEC-46)', () => {
  it('there is at least one memorial, and isMemorial agrees with the data', () => {
    expect(memorials.length).toBeGreaterThan(0)
    for (const place of mapPlaces()) {
      expect(isMemorial(place.id), place.id).toBe(place.category === 'memorial')
    }
  })

  it.each(memorials.map((place) => [place.id, place] as const))(
    '%s is open at Nobody, in every pack, with no lock or level copy',
    (_id, memorial) => {
      expect(placeAccess(memorial, 0).status).toBe('open')
      for (const copy of Object.values(packs)) {
        const name = placeAccessibleName(memorial, placeAccess(memorial, 0), { copy })
        expect(name).toBe(placeName(memorial, { copy }))
        // Even handed a locked access (a stale caller), no lock copy attaches.
        const forced = placeAccessibleName(
          memorial,
          { status: 'locked', required: 'scene-regular', current: 'nobody' },
          { copy },
        )
        expect(forced).toBe(placeName(memorial, { copy }))
        for (const text of lockTexts(copy)) expect(name).not.toContain(text)
        for (const level of engineConfig.clout.levels) {
          expect(name).not.toContain(cloutLevelName(level.id, { copy }))
        }
      }
    },
  )

  it.each(memorials.map((place) => [place.id] as const))(
    '%s opens as the look-only info card at Nobody, with plain base-only info copy',
    (id) => {
      const place = findPlace(id)
      if (place === undefined || !('category' in place)) throw new Error(`no landmark ${id}`)
      expect(placeActions(place, initialSnapshot(engineConfig), engineConfig)).toEqual({
        kind: 'look-only',
      })
      for (const key of [
        place.infoKey,
        place.nameKey,
        'place.memorial.label',
        'place.memorial.note',
      ]) {
        expect(key).not.toMatch(LOCK_OR_JOKE_KEYS)
        for (const pack of Object.values(slangPacks)) {
          expect(Object.hasOwn(pack.strings, key), `${pack.id} overrides ${key}`).toBe(false)
        }
      }
    },
  )

  it.each(memorials.map((place) => [place.id] as const))(
    '%s can be travelled to at Nobody (its borough lock does not apply)',
    (id) => {
      const start = initialSnapshot(engineConfig)
      const snapshot = { ...start, player: { ...start.player, cash: 1000 } }
      const from = tripEnd(snapshot.player.location, snapshot.player.home)
      const to = tripEnd({ kind: 'place', placeId: id }, snapshot.player.home)
      if (from === undefined || to === undefined) throw new Error('no trip ends')
      const trip = takeTrip(
        snapshot,
        { from: from.stop.point, to: to.stop, mode: 'taxi' },
        { world: null },
        engineConfig,
        transitConfig,
      )
      expect(trip.ok ? null : trip.error.code).toBeNull()
      // A locked-borough neighbour is still refused: the exemption is for memorials only.
      const neighbour = mapPlaces().find(
        (place) => place.borough === to.stop.borough && !isMemorial(place.id),
      )
      if (neighbour !== undefined && placeAccess(neighbour, 0).status !== 'open') {
        const end = tripEnd({ kind: 'place', placeId: neighbour.id }, snapshot.player.home)
        if (end === undefined) throw new Error('no trip end')
        const refused = takeTrip(
          snapshot,
          { from: from.stop.point, to: end.stop, mode: 'taxi' },
          { world: null },
          engineConfig,
          transitConfig,
        )
        expect(refused.ok ? null : refused.error.code).toBe('BOROUGH_LOCKED')
      }
    },
  )

  it('the Places panel at Nobody lists memorials apart from the lock line, named plainly', async () => {
    const { PlacesPanel } = await import('@/components/places/PlacesPanel')
    const markup = renderToStaticMarkup(createElement(PlacesPanel))
    for (const memorial of memorials) {
      const button = new RegExp(`<button[^>]*data-place-button="${memorial.id}"[^>]*>`).exec(markup)
      expect(button, memorial.id).not.toBeNull()
      const label = /aria-label="([^"]*)"/.exec(button?.[0] ?? '')?.[1] ?? ''
      expect(label.replace(/&#x27;/g, "'")).toBe(placeName(memorial))
    }
    expect(markup).toContain('data-memorials-open')
  })
})
