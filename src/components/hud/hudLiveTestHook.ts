import { engineConfig } from '@/engine/config'
import { isGameClockRunning } from '@/state/gameClock'
import { guestSessionStore, type GuestSessionState } from '@/state/guestSession'
import { hudView, type HudView } from '@/state/hudView'
import { gameStore } from '@/state/store'

/**
 * Test-only hooks for S05 (tests/e2e/guest-start.spec.ts, hud-live.spec.ts), on
 * `window.__cloutcityTest.clock` and `.session`. Only builds with NEXT_PUBLIC_TEST_HOOKS=1 load
 * this module (from its own chunk, see HudLive), and it installs only when the page also sets
 * `window.__CLOUTCITY_E2E__ = true` before the app loads. Read-only: nothing here changes play.
 */
export interface ClockTestHook {
  /** True while the passive clock driver runs (after the welcome card). */
  running(): boolean
  minute(): number
  speed(): number
  /** What the HUD shows, from the same view model. */
  view(): HudView
}

export interface SessionTestHook {
  /** Status and reason only: the hook never exposes the user id or a token. */
  state(): GuestSessionState
}

declare global {
  interface CloutcityTestHooks {
    clock?: ClockTestHook
    session?: SessionTestHook
  }
}

export function installHudLiveTestHook(): void {
  if (window.__CLOUTCITY_E2E__ !== true) return
  const clock: ClockTestHook = {
    running: () => isGameClockRunning(gameStore),
    minute: () => gameStore.getState().clock.minute,
    speed: () => gameStore.getState().speed,
    view: () => {
      const { player, clock: state, speed } = gameStore.getState()
      return hudView(
        { cash: player.cash, minute: state.minute, speed, stats: player.stats },
        engineConfig,
      )
    },
  }
  const session: SessionTestHook = { state: () => ({ ...guestSessionStore.getState() }) }
  window.__cloutcityTest = { ...window.__cloutcityTest, clock, session }
}
