import { afterEach, describe, expect, it } from 'vitest'
import { minutesPerDay } from '@/engine/clock'
import { engineConfig } from '@/engine/config'
import { isWearable, shopItems } from '@/engine/items'
import { nextRentDueDay, rentFor } from '@/engine/rent'
import { createLogger } from '@/lib/log'
import { findPlace } from '@/lib/world/places'
import { closeHudPanel, hudPanelStore, openHudPanel } from './hudPanel'
import { closePlace, onPlaceOpened, openPlace, placeSheetStore } from './placeSheet'
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

afterEach(() => {
  closeHudPanel()
  closePlace()
})

describe('HUD panel store', () => {
  it('starts closed and opens one panel at a time', () => {
    expect(hudPanelStore.getState().panel).toBeNull()
    openHudPanel('inventory')
    expect(hudPanelStore.getState().panel).toBe('inventory')
    openHudPanel('rent')
    expect(hudPanelStore.getState().panel).toBe('rent')
    closeHudPanel()
    expect(hudPanelStore.getState().panel).toBeNull()
  })

  it('opening a panel closes the place sheet', () => {
    openPlace('rerun-racks', { origin: 'panel' })
    openHudPanel('inventory')
    expect(placeSheetStore.getState().placeId).toBeNull()
  })

  it('onPlaceOpened fires when a place opens or changes, not on close', () => {
    let calls = 0
    const stop = onPlaceOpened(() => (calls += 1))
    openPlace('rerun-racks', { origin: 'panel' })
    openPlace('rerun-racks', { origin: 'panel' })
    openPlace('glowmatic', { origin: 'panel' })
    closePlace()
    stop()
    openPlace('rerun-racks', { origin: 'panel' })
    expect(calls).toBe(2)
  })
})

describe('game store S10a actions', () => {
  const logger = createLogger({ level: 'error', sink: () => undefined })
  const store = () =>
    createGameStore(
      createSafeJsonStorage<PersistedState>(() => undefined, logger),
      logger,
    )
  const thrift = findPlace('rerun-racks')
  if (thrift === undefined) throw new Error('no rerun-racks')
  const wearable = shopItems(engineConfig).find(isWearable)
  if (wearable === undefined) throw new Error('no wearable')

  it('buyAtShop buys at an open shop and leaves state alone when refused', () => {
    const game = store()
    const { clock, player } = game.getState()
    const day = minutesPerDay(engineConfig)
    const noon = Math.floor(clock.minute / day) * day + day + 12 * 60
    game.setState({ clock: { ...clock, minute: noon }, player: { ...player, cash: 10_000 } })
    const ok = standingAt(game, thrift).buyAtShop(thrift, wearable.id)
    expect(ok.ok).toBe(true)
    expect(game.getState().player.cash).toBe(10_000 - wearable.price)
    standingAt(game, thrift)
    const before = game.getState().player
    const again = standingAt(game, thrift).buyAtShop(thrift, wearable.id)
    expect(again).toMatchObject({ ok: false, error: { code: 'ALREADY_OWNED' } })
    expect(game.getState().player).toBe(before)
  })

  it('advanceMinutes past a rent day charges rent and records the last notice', () => {
    const game = store()
    expect(game.getState().lastRentEvent).toBeNull()
    const { clock, player } = game.getState()
    const rent = rentFor(player.home, engineConfig)
    game.setState({ player: { ...player, cash: rent } })
    const due = nextRentDueDay(clock.minute, engineConfig)
    game.getState().advanceMinutes((due - 1) * minutesPerDay(engineConfig) - clock.minute)
    expect(game.getState().lastRentEvent).toMatchObject({ kind: 'paid', day: due, rent })
    expect(game.getState().player.cash).toBe(0)
  })

  it('an advance with no rent keeps the previous notice', () => {
    const game = store()
    const { clock } = game.getState()
    const due = nextRentDueDay(clock.minute, engineConfig)
    game.getState().advanceMinutes((due - 1) * minutesPerDay(engineConfig) - clock.minute)
    const notice = game.getState().lastRentEvent
    expect(notice).not.toBeNull()
    game.getState().advanceMinutes(60)
    expect(game.getState().lastRentEvent).toBe(notice)
  })

  it('the last rent notice is session-only, never persisted', () => {
    const saved: string[] = []
    const game = createGameStore(
      {
        getItem: () => null,
        setItem: (_name, value) => void saved.push(JSON.stringify(value)),
        removeItem: () => undefined,
      },
      logger,
    )
    const { clock } = game.getState()
    const due = nextRentDueDay(clock.minute, engineConfig)
    game.getState().advanceMinutes((due - 1) * minutesPerDay(engineConfig) - clock.minute)
    expect(game.getState().lastRentEvent).not.toBeNull()
    expect(saved.at(-1)).toBeDefined()
    expect(saved.at(-1)).not.toContain('lastRentEvent')
  })
})
