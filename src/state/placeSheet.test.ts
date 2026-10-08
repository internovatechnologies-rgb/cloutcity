import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { totalClout } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import { playerWithClout } from '@/engine/test-support'
import { findPlace } from '@/lib/world/places'
import { createLogger } from '@/lib/log'
import {
  announcePlace,
  closePlace,
  currentPlaceId,
  onOpenPlaceChange,
  onPlacePicked,
  openPlace,
  placeSheetStore,
} from './placeSheet'
import { createSafeJsonStorage } from './storage'
import { createGameStore, type PersistedState } from './store'
import type { Place } from '@/engine/places'
import type { GameStore } from './store'

/** The store's state after the player walks into `place` (DEC-22: its actions need them there). */
function standingAt(game: GameStore, place: Place) {
  const { player } = game.getState()
  const { location } = player
  if (location.kind !== 'place' || location.placeId !== place.id) {
    game.setState({ player: { ...player, location: { kind: 'place', placeId: place.id } } })
  }
  return game.getState()
}

afterEach(() => closePlace())

describe('place sheet store', () => {
  it('starts closed, opens one place at a time and closes', () => {
    expect(placeSheetStore.getState().placeId).toBeNull()
    openPlace('glowmatic', { origin: 'panel' })
    expect(placeSheetStore.getState().placeId).toBe('glowmatic')
    openPlace('steam-vent-coffee', { origin: 'panel' })
    expect(placeSheetStore.getState().placeId).toBe('steam-vent-coffee')
    closePlace()
    expect(placeSheetStore.getState().placeId).toBeNull()
  })
})

describe('place sheet origin and announcement (S04c)', () => {
  it('records where each pick came from and counts every pick, repeats included', () => {
    const before = placeSheetStore.getState().openCount
    openPlace('glowmatic', { origin: 'map' })
    expect(placeSheetStore.getState()).toMatchObject({ placeId: 'glowmatic', origin: 'map' })
    openPlace('glowmatic', { origin: 'panel' })
    expect(placeSheetStore.getState()).toMatchObject({ placeId: 'glowmatic', origin: 'panel' })
    expect(placeSheetStore.getState().openCount).toBe(before + 2)
    closePlace()
    expect(placeSheetStore.getState()).toMatchObject({ placeId: null, origin: null })
  })

  it('tells the 3D map about every pick and every change of the open place', () => {
    const picks: string[] = []
    const changes: (string | null)[] = []
    const offPicked = onPlacePicked((id, origin) => picks.push(`${id}:${origin}`))
    const offChange = onOpenPlaceChange((id) => changes.push(id))
    openPlace('glowmatic', { origin: 'map' })
    openPlace('glowmatic', { origin: 'panel' })
    announcePlace('Glowmatic selected')
    openPlace('brickwave', { origin: 'hook' })
    expect(currentPlaceId()).toBe('brickwave')
    closePlace()
    offPicked()
    offChange()
    openPlace('glowmatic', { origin: 'panel' })
    expect(picks).toEqual(['glowmatic:map', 'glowmatic:panel', 'brickwave:hook'])
    expect(changes).toEqual(['glowmatic', 'brickwave', null])
  })

  it('clears the announcement on every pick and on close, so a repeat is announced again', () => {
    openPlace('glowmatic', { origin: 'panel' })
    announcePlace('Glowmatic selected')
    expect(placeSheetStore.getState().announcement).toBe('Glowmatic selected')
    openPlace('glowmatic', { origin: 'panel' })
    expect(placeSheetStore.getState().announcement).toBe('')
    announcePlace('Glowmatic selected')
    closePlace()
    expect(placeSheetStore.getState().announcement).toBe('')
  })
})

describe('game store performPlaceAction', () => {
  const logger = createLogger({ level: 'error', sink: () => undefined })
  const store = () =>
    createGameStore(
      createSafeJsonStorage<PersistedState>(() => undefined, logger),
      logger,
    )

  function place(id: string) {
    const found = findPlace(id)
    if (found === undefined) throw new Error(`no place ${id}`)
    return found
  }

  it('applies an allowed action to the clock and player', () => {
    const game = store()
    standingAt(game, place('flushing-meadows'))
    const before = game.getState()
    const result = standingAt(game, place('flushing-meadows')).performPlaceAction(
      place('flushing-meadows'),
      'visit',
    )
    expect(result.ok).toBe(true)
    expect(game.getState().clock.minute).toBeGreaterThan(before.clock.minute)
  })

  it('leaves state alone when the engine refuses (the club is closed by day)', () => {
    const game = store()
    standingAt(game, place('glowmatic'))
    const before = game.getState()
    const result = standingAt(game, place('glowmatic')).performPlaceAction(
      place('glowmatic'),
      'club-night',
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'BLOCKED' } })
    expect(game.getState().clock).toBe(before.clock)
    expect(game.getState().player).toBe(before.player)
  })
})

describe('one way into a place sheet', () => {
  // S09: the 3D pins and the Places panel (S04c) must open the sheet only through `openPlace`,
  // so every caller gets the same sheet. Guarded by source: nothing outside this module writes
  // the store, and only PlaceSheetMount renders the sheet.
  const SRC = resolve(import.meta.dirname, '..')
  const sources = readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file))
    .map((file) => ({ file: relative(SRC, file), code: readFileSync(file, 'utf8') }))

  it('only src/state/placeSheet.ts touches the sheet store', () => {
    const users = sources.filter(({ code }) => /\bplaceSheetStore\b/.test(code))
    expect(users.map(({ file }) => file)).toEqual(['state/placeSheet.ts'])
  })

  it('only PlaceSheetMount loads the sheet component', () => {
    const importers = sources.filter(({ code }) =>
      /import\(\s*['"](?:\.\/|@\/components\/places\/)PlaceSheet['"]|from\s+['"](?:\.\/|@\/components\/places\/)PlaceSheet['"]/.test(
        code,
      ),
    )
    expect(importers.map(({ file }) => file)).toEqual(['components/places/PlaceSheetMount.tsx'])
  })

  it('an unknown id still goes through the store (the sheet clears it), and reopening replaces', () => {
    openPlace('nowhere', { origin: 'panel' })
    expect(placeSheetStore.getState().placeId).toBe('nowhere')
    openPlace('september-11-memorial', { origin: 'panel' })
    expect(placeSheetStore.getState().placeId).toBe('september-11-memorial')
  })
})

describe('game store performPlaceAction: repeated activation', () => {
  const logger = createLogger({ level: 'error', sink: () => undefined })
  const glowmatic = findPlace('glowmatic')
  if (glowmatic === undefined) throw new Error('no glowmatic')

  it('a double tap with cash for one cover runs once; the second is refused by the re-check', () => {
    const game = createGameStore(
      createSafeJsonStorage<PersistedState>(() => undefined, logger),
      logger,
    )
    const rule = engineConfigClub('glowmatic')
    const { clock, player } = game.getState()
    const perDay = 24 * 60
    const night = Math.floor(clock.minute / perDay) * perDay + 23 * 60
    game.setState({
      clock: { ...clock, minute: night > clock.minute ? night : night + perDay },
      player: { ...playerWithClout(player, 100, engineConfig), cash: rule.coverCharge },
    })
    const first = standingAt(game, glowmatic).performPlaceAction(glowmatic, 'club-night')
    const afterFirst = game.getState()
    const second = standingAt(game, glowmatic).performPlaceAction(glowmatic, 'club-night')
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'BLOCKED', block: { code: 'funds' } },
    })
    expect(totalClout(game.getState().player, engineConfig)).toBe(100 + rule.cloutGain)
    expect(game.getState().player.cash).toBe(afterFirst.player.cash)
    expect(game.getState().clock).toBe(afterFirst.clock)
  })
})

function engineConfigClub(id: string) {
  const rule = engineConfig.place.clubs[id]
  if (rule === undefined) throw new Error(`no club rule ${id}`)
  return rule
}
