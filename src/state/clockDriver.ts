/**
 * Drives the personal game clock from real time: the one place that reads the real clock for
 * passive time (the engine never does). It ticks the store every `time.tickIntervalMs` with
 * the real time elapsed since the last tick, and pauses while the tab is hidden: time spent
 * hidden is never counted, because the baseline is reset when the tab becomes visible again.
 *
 * Every browser dependency is injectable for tests.
 */
import { engineConfig } from '@/engine/config'
import type { GameStore } from './store'

export interface ClockDriverEnv {
  /** Monotonic milliseconds (performance.now in a browser). */
  readonly now: () => number
  readonly isVisible: () => boolean
  /** Calls `onChange` whenever visibility changes; returns an unsubscribe function. */
  readonly onVisibilityChange: (onChange: () => void) => () => void
  readonly setInterval: (callback: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

export function browserClockEnv(): ClockDriverEnv {
  return {
    now: () => performance.now(),
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (onChange) => {
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  }
}

/** Starts ticking `store`; returns a function that stops it. */
export function startClockDriver(
  store: GameStore,
  env: ClockDriverEnv = browserClockEnv(),
  intervalMs: number = engineConfig.time.tickIntervalMs,
): () => void {
  let last = env.now()

  const step = (visible: boolean) => {
    const now = env.now()
    // A non-monotonic clock must never move game time backwards (the engine rejects it).
    const elapsed = Math.max(0, now - last)
    last = now
    store.getState().tick(elapsed, visible)
  }

  const unsubscribe = env.onVisibilityChange(() => {
    if (env.isVisible()) {
      // Time spent hidden is not played time: start counting again from now.
      last = env.now()
    } else {
      // Count the visible time up to the moment the tab was hidden.
      step(true)
    }
  })
  const handle = env.setInterval(() => step(env.isVisible()), intervalMs)

  return () => {
    env.clearInterval(handle)
    unsubscribe()
  }
}
