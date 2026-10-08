/**
 * The store's passive-clock throttle (S05): the clock driver ticks every second, but the state
 * changes (and the HUD re-renders) only when a whole game minute passes. The sub-minute carry
 * lives in the store, survives the store's own actions, and is never lost or double-counted.
 */
import { describe, expect, it } from 'vitest'
import { realMsPerGameMinute } from '@/engine/clock'
import { engineConfig } from '@/engine/config'
import { createLogger } from '@/lib/log'
import { createSafeJsonStorage } from './storage'
import { createGameStore, type PersistedState } from './store'

const TICK_MS = engineConfig.time.tickIntervalMs
const PER_MINUTE_MS = realMsPerGameMinute(engineConfig)
const START = engineConfig.time.startMinuteOfDay

function newStore() {
  const logger = createLogger({ level: 'error', sink: () => {} })
  const store = createGameStore(
    createSafeJsonStorage<PersistedState>(() => undefined, logger),
    logger,
  )
  let notifications = 0
  store.subscribe(() => {
    notifications += 1
  })
  return {
    store,
    notifications: () => notifications,
    tick: (times: number, ms = TICK_MS, visible = true) => {
      for (let i = 0; i < times; i++) store.getState().tick(ms, visible)
    },
  }
}

describe('passive clock throttle (S05)', () => {
  it('the config ticks six times per game minute at 1x (self-check)', () => {
    expect(PER_MINUTE_MS / TICK_MS).toBe(6)
  })

  it('five ticks notify nobody; the sixth notifies once with the next minute', () => {
    const game = newStore()
    game.tick(5)
    expect(game.notifications()).toBe(0)
    expect(game.store.getState().clock.minute).toBe(START)
    game.tick(1)
    expect(game.notifications()).toBe(1)
    expect(game.store.getState().clock).toEqual({ minute: START + 1, remainderMs: 0 })
  })

  it('600 one-second ticks are exactly 100 game minutes, with one notification each', () => {
    const game = newStore()
    game.tick(600)
    expect(game.store.getState().clock).toEqual({ minute: START + 100, remainderMs: 0 })
    expect(game.notifications()).toBe(100)
  })

  it('at 2x a game minute passes every three ticks', () => {
    const game = newStore()
    game.store.getState().setSpeed(2)
    const afterSpeed = game.notifications()
    game.tick(2)
    expect(game.notifications()).toBe(afterSpeed)
    game.tick(1)
    expect(game.store.getState().clock.minute).toBe(START + 1)
    game.tick(597)
    expect(game.store.getState().clock.minute).toBe(START + 200)
    expect(game.notifications() - afterSpeed).toBe(200)
  })

  it('hidden ticks notify nobody and add nothing to the carry', () => {
    const game = newStore()
    game.tick(3)
    game.tick(600, TICK_MS, false)
    expect(game.notifications()).toBe(0)
    game.tick(2)
    expect(game.notifications()).toBe(0)
    game.tick(1)
    expect(game.store.getState().clock.minute).toBe(START + 1)
  })

  it('the carry survives an action that fast-forwards the clock', () => {
    const game = newStore()
    game.tick(5)
    const result = game.store.getState().performAction('bodega-breakfast')
    expect(result.ok).toBe(true)
    const afterAction = game.store.getState().clock.minute
    expect(afterAction).toBeGreaterThan(START)
    game.tick(1)
    expect(game.store.getState().clock.minute).toBe(afterAction + 1)
  })

  it('the carry survives advanceMinutes and a speed change', () => {
    const game = newStore()
    game.tick(4)
    game.store.getState().advanceMinutes(30)
    game.store.getState().setSpeed(1)
    game.tick(1)
    expect(game.store.getState().clock.minute).toBe(START + 30)
    game.tick(1)
    expect(game.store.getState().clock.minute).toBe(START + 31)
  })

  it('a clock written from outside the store drops the carry for its own remainder', () => {
    const game = newStore()
    game.tick(5)
    game.store.setState({ clock: { minute: 900, remainderMs: 0 } })
    game.tick(5)
    expect(game.store.getState().clock.minute).toBe(900)
    game.tick(1)
    expect(game.store.getState().clock.minute).toBe(901)
  })

  it('starting fresh after a newer save drops the carry', () => {
    const game = newStore()
    game.tick(5)
    game.store.getState().discardNewerSaveAndStartFresh()
    game.tick(5)
    expect(game.store.getState().clock.minute).toBe(START)
  })

  it('a minute that passes keeps the leftover in the state remainder', () => {
    const game = newStore()
    game.store.getState().tick(4500, true)
    game.store.getState().tick(PER_MINUTE_MS - 4500 + 1500, true)
    expect(game.store.getState().clock).toEqual({ minute: START + 1, remainderMs: 1500 })
  })
})
