import type { PlayerLocation } from '@/engine/game'
import type { TravelMode } from '@/engine/transit/plan'
import { tripEnd } from '@/lib/world/tripEnds'
import { gameStore } from './store'
import { HOME_SPOT_ID, setArrivalEventsSuppressed, tripStore } from './trip'
import { seekTrip, skipTrip, tripOptionsFor } from './tripDriver'
import { transitWorldStore, type TransitWorldStatus } from './transitWorld'

/**
 * Test-only hook for travel (tests/e2e/travel.spec.ts) on `window.__cloutcityTest.travel`.
 * Installed by the travel chunk only in builds with NEXT_PUBLIC_TEST_HOOKS=1 and only when the
 * page sets `window.__CLOUTCITY_E2E__ = true`; it reads state and moves the animation, and every
 * trip still goes through the engine.
 */
export interface TravelTestHook {
  state(): {
    readonly location: PlayerLocation
    readonly world: TransitWorldStatus
    readonly active: {
      readonly destination: PlayerLocation
      readonly mode: TravelMode
      readonly durationMs: number
      readonly progress: number
      readonly departMinute: number
      readonly arriveMinute: number
    } | null
    readonly arrival: {
      readonly destination: PlayerLocation
      readonly durationMin: number
      readonly fare: number
      readonly delayMin: number
    } | null
  }
  /** Moves the animation to `fraction` (0..1) of the way. */
  seek(fraction: number): void
  /** Lands the trip now (the Skip button's path). */
  skip(): void
  /**
   * Keeps arrivals free of random events (TRV-4): a spec about travel must not meet a modal
   * event it did not ask for. Specs about events leave it off.
   */
  suppressArrivalEvents(suppressed: boolean): void
  /** The "Get there" rows' data from where the player stands to `destinationId` (`home` too). */
  options(destinationId: string): readonly {
    readonly mode: TravelMode
    readonly durationMin: number
    readonly fare: number | null
    readonly blocked: string | null
  }[]
}

declare global {
  interface CloutcityTestHooks {
    travel?: TravelTestHook
  }
  interface Window {
    __CLOUTCITY_E2E__?: boolean
    __cloutcityTest?: CloutcityTestHooks
  }
}

const locationOf = (id: string): PlayerLocation =>
  id === HOME_SPOT_ID ? { kind: 'home' } : { kind: 'place', placeId: id }

export function installTravelTestHook(): void {
  if (window.__CLOUTCITY_E2E__ !== true) return
  const hook: TravelTestHook = {
    state: () => {
      const { active, progress, arrival } = tripStore.getState()
      return {
        location: gameStore.getState().player.location,
        world: transitWorldStore.getState().status,
        active:
          active === null
            ? null
            : {
                destination: active.destination,
                mode: active.mode,
                durationMs: active.durationMs,
                progress,
                departMinute: active.departMinute,
                arriveMinute: active.arriveMinute,
              },
        arrival:
          arrival === null
            ? null
            : {
                destination: arrival.destination,
                durationMin: arrival.durationMin,
                fare: arrival.fare,
                delayMin: arrival.delayMin,
              },
      }
    },
    seek: seekTrip,
    skip: skipTrip,
    suppressArrivalEvents: (suppressed) => setArrivalEventsSuppressed(suppressed, 'test'),
    options: (destinationId) => {
      const { player } = gameStore.getState()
      const from = tripEnd(player.location, player.home)
      const to = tripEnd(locationOf(destinationId), player.home)
      if (from === undefined || to === undefined) throw new Error(`No spot "${destinationId}"`)
      return tripOptionsFor({ from, to }).options.map((option) => ({
        mode: option.mode,
        durationMin: option.durationMin,
        fare: option.route?.fare ?? null,
        blocked: option.block?.code ?? null,
      }))
    },
  }
  window.__cloutcityTest = { ...window.__cloutcityTest, travel: hook }
}
