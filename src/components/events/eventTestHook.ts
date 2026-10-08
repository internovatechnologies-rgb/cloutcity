import { totalClout } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import type { EventContext, OpenResult } from '@/engine/events'
import type { GameStore } from '@/state/store'

/**
 * Test-only hook so Playwright can open a specific event (tests/e2e/events.spec.ts). It is
 * installed only when the page sets `window.__CLOUTCITY_E2E__ = true` before the app loads
 * (Playwright's addInitScript). It goes through the store's `openEvent`, so the engine's
 * conditions and safety rules still apply: it cannot open anything a player could not meet.
 * Anyone with devtools could set the flag, which gives no more than editing the local save.
 */
export interface EventTestHook {
  open(eventId: string, context: EventContext): OpenResult
  state(): {
    readonly cash: number
    /** Total clout (src/engine/clout.ts `totalClout`). */
    readonly clout: number
    readonly stats: { readonly energy: number; readonly hunger: number; readonly mood: number }
    readonly minute: number
    readonly activeEvent: string | null
    readonly pendingEffects: number
  }
}

declare global {
  /** Test hooks by feature; each hook module adds its own key (interface merging). */
  interface CloutcityTestHooks {
    events?: EventTestHook
  }
  interface Window {
    __CLOUTCITY_E2E__?: boolean
    __cloutcityTest?: CloutcityTestHooks
  }
}

export function installEventTestHook(store: GameStore): void {
  if (typeof window === 'undefined' || window.__CLOUTCITY_E2E__ !== true) return
  window.__cloutcityTest = {
    ...window.__cloutcityTest,
    events: {
      open: (eventId, context) => store.getState().openEvent(eventId, context),
      state: () => {
        const { player, clock, events } = store.getState()
        return {
          cash: player.cash,
          clout: totalClout(player, engineConfig),
          stats: player.stats,
          minute: clock.minute,
          activeEvent: events.active,
          pendingEffects: events.pending.length,
        }
      },
    },
  }
}
