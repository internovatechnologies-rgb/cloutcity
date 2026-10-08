import { describe, expect, it } from 'vitest'
import { createLogger } from '@/lib/log'
import { fakeClockEnv as fakeEnv } from '@/lib/testing/fakeClockEnv'
import { startClockDriver } from './clockDriver'
import { createSafeJsonStorage } from './storage'
import { createGameStore, type PersistedState } from './store'

function newStore() {
  const logger = createLogger({ sink: () => {} })
  return createGameStore(
    createSafeJsonStorage<PersistedState>(() => undefined, logger),
    logger,
  )
}

describe('clock driver', () => {
  it('advances 10 game minutes per real minute while visible', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    fake.run(60_000)
    expect(store.getState().clock.minute).toBe(480 + 10)
  })

  it('does not count time spent hidden, including the gap before the next tick', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    fake.run(30_000)
    fake.setVisible(false)
    expect(store.getState().clock.minute).toBe(485)
    fake.run(10 * 60_000)
    // Mobile browsers may freeze intervals entirely while hidden.
    fake.jump(60 * 60_000)
    fake.setVisible(true)
    expect(store.getState().clock.minute).toBe(485)
    fake.run(30_000)
    expect(store.getState().clock.minute).toBe(490)
  })

  it('counts visible time up to the moment the tab is hidden', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    fake.run(59_000)
    fake.jump(1000)
    fake.setVisible(false)
    expect(store.getState().clock.minute).toBe(490)
  })

  it('runs at 2x when the speed is toggled', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    store.getState().setSpeed(2)
    fake.run(60_000)
    expect(store.getState().clock.minute).toBe(480 + 20)
  })

  it('stops cleanly', () => {
    const store = newStore()
    const fake = fakeEnv()
    const stop = startClockDriver(store, fake.env, 1000)
    stop()
    expect(fake.running).toBe(false)
    fake.run(60_000)
    expect(store.getState().clock.minute).toBe(480)
  })
})

describe('clock driver edge cases', () => {
  it('a monotonic clock stepping backwards neither throws nor moves game time back', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    fake.run(30_000)
    expect(store.getState().clock.minute).toBe(485)
    fake.jump(-10_000)
    expect(() => fake.run(1000)).not.toThrow()
    expect(store.getState().clock.minute).toBe(485)
    fake.run(30_000)
    expect(store.getState().clock.minute).toBe(490)
  })

  it('hidden -> visible after a frozen timer counts none of the hidden time, even if the interval fires late', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    fake.setVisible(false)
    fake.jump(3 * 60 * 60_000)
    fake.setVisible(true)
    // The first interval after waking measures only from the visibility change.
    fake.run(6000)
    expect(store.getState().clock.minute).toBe(481)
  })

  it('a hidden interval tick does not advance and does not count toward the next visible tick', () => {
    const store = newStore()
    const fake = fakeEnv()
    startClockDriver(store, fake.env, 1000)
    fake.setVisible(false)
    fake.run(60_000)
    expect(store.getState().clock.minute).toBe(480)
  })

  it('stop() removes the visibility listener so later visibility changes do nothing', () => {
    const store = newStore()
    const fake = fakeEnv()
    const stop = startClockDriver(store, fake.env, 1000)
    fake.run(3000)
    stop()
    fake.jump(60_000)
    fake.setVisible(false)
    // A live listener would count the 60 s jump (capped at 5 s) on top of the 3 s carried, and
    // a game minute would pass.
    expect(store.getState().clock.minute).toBe(480)
  })
})
