/**
 * Trips, end to end (S08 part 2), in the travel chunk: the place sheet's "Get there" rows import
 * this module on first use (and the shell's idle prefetch builds the transit world it needs).
 *
 * 1. `tripOptionsFor` lists every mode from where the player stands, from the engine's own
 *    planning (src/engine/transit/trip.ts `tripOptions`), so a row never says something a trip
 *    would not do (GR-10).
 * 2. `startTrip` commits the trip to the save at once through the store (`commitTrip`, DEC-22):
 *    fare, clock, rent and location. Only then does the presentation start.
 * 3. The presentation (src/state/trip.ts) animates for at most `transit.animation.maxMs`, the HUD
 *    clock counting up through the trip, and the 3D map moves the avatar along the route. It
 *    cuts straight to the arrival when the player prefers reduced motion, the 3D map cannot
 *    animate (no WebGL, not drawn yet, a lost context), the apartment has the screen or the tab
 *    is hidden; Skip, and the tab being hidden mid-trip, cut too.
 * 4. On arrival the destination's sheet opens again (`openPlace` origin `travel`) with what the
 *    trip did (time, fare, any delay, rent on the way), and a random event may fire there,
 *    except during the first-run tour and after a delayed train (one bad break is enough).
 */
import { engineConfig } from '@/engine/config'
import type { EventContext } from '@/engine/events'
import type { GameSnapshot } from '@/engine/game'
import { transitConfig } from '@/engine/transit/config'
import type { Route, TravelMode } from '@/engine/transit/plan'
import { createTimeline } from '@/engine/transit/timeline'
import {
  takeTrip,
  tripOptions,
  type TripError,
  type TripOption,
  type TripResult,
} from '@/engine/transit/trip'
import type { TripEnd } from '@/lib/world/tripEnds'
import { log } from '@/lib/log'
import { openPlace } from './placeSheet'
import { sceneFocusStore } from './sceneFocus'
import { gameStore } from './store'
import { spotId, tripStore, type ActiveTrip, type PlayerSpot } from './trip'
import { ensureTransitWorld, transitWorldStore, type TransitWorldStatus } from './transitWorld'

export interface TripPlan {
  readonly from: TripEnd
  readonly to: TripEnd
}

export interface TripRows {
  readonly status: TransitWorldStatus
  /** Empty while the transit world loads. With a failed world, only the taxi estimate plans. */
  readonly options: readonly TripOption[]
}

/** Why a trip did not start: the engine's reason, or another trip still animating. */
export type StartTripError = TripError | { readonly code: 'TRIP_IN_PROGRESS' }

export type StartTripResult = TripResult | { readonly ok: false; readonly error: StartTripError }

/** The world rows plan against: built, a straight estimate after a failure, or none yet. */
function routeWorld() {
  const { status, world } = transitWorldStore.getState()
  if (status === 'ready' && world !== null) return { usable: true as const, world }
  if (status === 'failed') return { usable: true as const, world: null }
  return { usable: false as const, world: null }
}

/**
 * Every mode from `plan.from` to `plan.to` for `snapshot` (the store's, unless given), or none
 * while the world loads.
 */
export function tripOptionsFor(
  plan: TripPlan,
  snapshot: GameSnapshot = gameStore.getState(),
): TripRows {
  void ensureTransitWorld()
  const { status } = transitWorldStore.getState()
  const route = routeWorld()
  if (!route.usable) return { status, options: [] }
  const options = tripOptions(
    { clock: snapshot.clock, player: snapshot.player },
    plan.from.stop.point,
    plan.to.stop,
    { world: route.world },
    engineConfig,
    transitConfig,
  )
  return { status, options }
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Whether the trip should cut straight to the arrival instead of animating. */
function shouldCut(): boolean {
  return (
    prefersReducedMotion() ||
    !tripStore.getState().animator ||
    sceneFocusStore.getState().focus === 'room' ||
    document.visibilityState === 'hidden'
  )
}

/** The route as animated: from the avatar's resting point and on to the destination's. */
function animatedRoute(route: Route, plan: TripPlan): Route {
  const legs = route.legs.map((leg, index) => {
    const first = index === 0
    const last = index === route.legs.length - 1
    if (!first && !last) return leg
    const points = leg.polyline.length > 0 ? [...leg.polyline] : [leg.from, leg.to]
    if (first) points.unshift(plan.from.rest)
    if (last) points.push(plan.to.rest)
    return { ...leg, polyline: points }
  })
  // The animation ends (and a cut or Skip lands the avatar) where it rests, not on the route's
  // end point (a landmark's approach).
  return { ...route, from: plan.from.rest, to: plan.to.rest, legs }
}

let tripCount = 0
let frame: number | null = null
let pendingArrival: (() => void) | null = null

function stopLoop() {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
  document.removeEventListener('visibilitychange', onVisibility)
}

function onVisibility() {
  // A hidden tab draws nothing: the trip lands at once rather than waiting for the tab.
  if (document.visibilityState === 'hidden') skipTrip()
}

function step() {
  frame = null
  const { active } = tripStore.getState()
  if (active === null) return
  const progress =
    active.durationMs <= 0 ? 1 : (performance.now() - active.startedAtMs) / active.durationMs
  if (progress >= 1) {
    skipTrip()
    return
  }
  // About a hundred updates over the whole trip: enough for the clock and the bar.
  if (progress - tripStore.getState().progress >= 0.01) tripStore.setState({ progress })
  frame = requestAnimationFrame(step)
}

/** Ends the active trip's animation now: the arrival shows at once. No-op with no trip. */
export function skipTrip(): void {
  stopLoop()
  const arrive = pendingArrival
  pendingArrival = null
  arrive?.()
}

/** Moves the active animation to `fraction` (0..1) of the way (the e2e hook). */
export function seekTrip(fraction: number): void {
  const { active } = tripStore.getState()
  if (active === null || active.durationMs <= 0) return
  const clamped = Math.min(1, Math.max(0, fraction))
  tripStore.setState({
    active: { ...active, startedAtMs: performance.now() - clamped * active.durationMs },
    progress: clamped,
  })
}

/** The random-event context at an arrival, or null where none may roll (home). */
function arrivalContext(destination: PlayerSpot, plan: TripPlan): EventContext | null {
  if (destination.kind === 'home') return null
  const { inventory } = gameStore.getState().player
  return {
    borough: plan.to.stop.borough,
    locationId: destination.placeId,
    locationCategory: null,
    itemIds: [
      ...inventory.wearables.map((owned) => owned.itemId),
      ...inventory.gifts.map((stack) => stack.itemId),
    ],
  }
}

/**
 * Takes a trip by `mode`. The save changes at once; the result is the engine's. A refusal
 * (funds, water, a locked borough, another trip animating) changes nothing.
 */
export function startTrip(plan: TripPlan, mode: TravelMode): StartTripResult {
  if (tripStore.getState().active !== null) {
    return { ok: false, error: { code: 'TRIP_IN_PROGRESS' } }
  }
  const route = routeWorld()
  if (!route.usable) return { ok: false, error: { code: 'NO_ROUTE_DATA' } }
  const departMinute = gameStore.getState().clock.minute
  const result = gameStore
    .getState()
    .commitTrip((snapshot) =>
      takeTrip(
        snapshot,
        { from: plan.from.stop.point, to: plan.to.stop, mode },
        { world: route.world },
        engineConfig,
        transitConfig,
      ),
    )
  if (!result.ok) {
    log.info('A trip was refused', { code: result.error.code, mode })
    return result
  }

  const id = ++tripCount
  const destination = result.to
  const animated = animatedRoute(result.route, plan)
  const cut = shouldCut()
  const durationMs = cut
    ? 0
    : createTimeline(animated, { reducedMotion: false, animation: transitConfig.animation })
        .durationMs
  const active: ActiveTrip = {
    id,
    destination,
    mode,
    route: animated,
    departMinute,
    arriveMinute: result.snapshot.clock.minute,
    durationMs,
    startedAtMs: performance.now(),
  }
  const delayMin = result.delay?.extraMin ?? 0
  pendingArrival = () => {
    tripStore.setState({
      active: null,
      progress: 0,
      arrival: {
        id,
        destination,
        mode,
        durationMin: result.durationMin,
        fare: result.route.fare,
        delayMin,
        rent: result.rent,
        direct: result.direct,
      },
    })
    openPlace(spotId(destination), { origin: 'travel' })
    const context = arrivalContext(destination, plan)
    // No event during the tour (S06, GR-9), and none on top of a delayed train.
    if (context !== null && delayMin === 0 && !tripStore.getState().arrivalEventsSuppressed) {
      gameStore.getState().rollForEvent(context)
    }
  }
  tripStore.setState({ active, progress: 0, arrival: null })
  if (durationMs <= 0) {
    skipTrip()
  } else {
    document.addEventListener('visibilitychange', onVisibility)
    frame = requestAnimationFrame(step)
  }
  return result
}

// Inlined at build time (next.config.ts): production builds drop the hook entirely.
if (process.env.NEXT_PUBLIC_TEST_HOOKS === '1' && typeof window !== 'undefined') {
  // This module can load just as a spec cuts the network for scripts (audio-recovery.spec), so
  // a hook chunk that cannot arrive is noted, not left as an uncaught rejection.
  void import('./travelTestHook')
    .then((module) => module.installTravelTestHook())
    .catch((error: unknown) => {
      log.info('The travel test hook did not load', {
        error: error instanceof Error ? error.name : typeof error,
      })
    })
}

export { ensureTransitWorld, retryTransitWorld, transitWorldStore } from './transitWorld'
