/**
 * Starts the personal game clock (S05, Q12): passive time runs only once this device has a
 * passing 18+ attestation (the welcome card is complete), so a player still on the card, or
 * locked out, never loses game time behind it.
 *
 * The HUD's live island calls it from an effect. One clock driver runs per game store however
 * many callers there are (React StrictMode mounts effects twice in development): the driver
 * starts with the first caller that has an attestation and stops when the last one disposes.
 * Ticks raise no events (Q9): the store only changes when a game minute passes.
 */
import { browserClockEnv, startClockDriver, type ClockDriverEnv } from './clockDriver'
import type { OnboardingStore } from './onboarding'
import type { GameStore } from './store'

export interface GameClockOptions {
  readonly game: GameStore
  readonly onboarding: OnboardingStore
  /** Browser timing and visibility; injectable for tests. */
  readonly env?: ClockDriverEnv
}

interface RunningDriver {
  users: number
  readonly stop: () => void
}

const drivers = new WeakMap<GameStore, RunningDriver>()

/** True while a clock driver runs for `game` (the e2e clock hook reads it). */
export function isGameClockRunning(game: GameStore): boolean {
  return drivers.has(game)
}

function acquire(game: GameStore, env: ClockDriverEnv | undefined): () => void {
  let running = drivers.get(game)
  if (running === undefined) {
    running = { users: 0, stop: startClockDriver(game, env ?? browserClockEnv()) }
    drivers.set(game, running)
  }
  running.users += 1
  const owned = running
  let released = false
  return () => {
    if (released) return
    released = true
    owned.users -= 1
    if (owned.users === 0) {
      owned.stop()
      drivers.delete(game)
    }
  }
}

/**
 * Starts the clock now, or as soon as the welcome card is completed. Returns a function that
 * stops waiting or releases the clock; calling it twice is harmless.
 */
export function startGameClock({ game, onboarding, env }: GameClockOptions): () => void {
  let release: (() => void) | null = null
  let disposed = false
  const attested = () => onboarding.getState().record?.status === 'complete'

  const begin = () => {
    if (disposed || release !== null || !attested()) return
    release = acquire(game, env)
  }

  const unsubscribe = onboarding.subscribe(begin)
  begin()

  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    release?.()
    release = null
  }
}
