/**
 * A fake browser for the clock driver's tests (src/state/clockDriver.ts): a manual monotonic
 * clock, a visibility flag and one interval, all driven by the test.
 */
import type { ClockDriverEnv } from '@/state/clockDriver'

/** A fake browser: a manual clock, visibility flag and interval. */
export function fakeClockEnv() {
  let now = 0
  let visible = true
  let onTick: (() => void) | undefined
  let onVisibility: (() => void) | undefined
  const env: ClockDriverEnv = {
    now: () => now,
    isVisible: () => visible,
    onVisibilityChange: (callback) => {
      onVisibility = callback
      return () => (onVisibility = undefined)
    },
    setInterval: (callback) => {
      onTick = callback
      return 1
    },
    clearInterval: () => (onTick = undefined),
  }
  return {
    env,
    /** Advances real time in interval steps, firing the interval each step. */
    run(ms: number, step = 1000) {
      for (let left = ms; left > 0; left -= step) {
        now += Math.min(step, left)
        onTick?.()
      }
    },
    setVisible(next: boolean) {
      visible = next
      onVisibility?.()
    },
    jump(ms: number) {
      now += ms
    },
    get running() {
      return onTick !== undefined && onVisibility !== undefined
    },
  }
}
