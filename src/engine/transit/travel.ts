/**
 * The travel action: plans the trip, rolls for a subway delay, then applies it through the
 * action system (src/engine/actions.ts), which charges the fare, fast-forwards the personal
 * clock and lands the stat effects.
 *
 * Stat effects of a trip, all at arrival and clamped by the action system:
 * - energy: `walk.energyPerKm` per km walked (walking legs of any mode);
 * - mood: `rushHour.subwayMoodDrain` for a subway trip departing in rush hour, and
 *   `delay.moodDrain` when the train is delayed.
 * Energy is not an up-front cost, so an exhausted player can always walk home.
 *
 * The delay roll uses the injected random source (src/engine/rng.ts: one draw per subway trip, a
 * second for the length when delayed), so a seed replays it. A delay emits a `transit.mta-delay`
 * event for the caller to report; this module only returns it.
 *
 * Rent that falls due while the clock fast-forwards is charged by the action system and
 * returned in `rent`, so the caller can show it (the BUG-1 pattern: an advance never drops its
 * rent events).
 */
import { applyAction, effectiveDuration, type ActionDef, type ActionError } from '../actions'
import { calendar, type Rollovers } from '../clock'
import type { EngineConfig } from '../config'
import type { GameSnapshot } from '../game'
import type { RentEvent } from '../rent'
import { rollInt, type Rng } from '../rng'
import type { LocalPoint } from '@/lib/geo/projection'
import type { TransitConfig } from './config'
import {
  planTrip,
  type PlanError,
  type PlanResult,
  type Route,
  type SubwayLeg,
  type TravelMode,
} from './plan'
import type { TransitWorld } from './world'

export const MTA_DELAY_EVENT = 'transit.mta-delay'

export type TransitEvent = {
  readonly id: typeof MTA_DELAY_EVENT
  /** The line of the delayed leg (the first train boarded). */
  readonly lineId: string
  readonly extraMin: number
}

export interface TravelRequest {
  readonly from: LocalPoint
  readonly to: LocalPoint
  readonly mode: TravelMode
}

export interface TravelDeps {
  readonly world: TransitWorld
  readonly rng: Rng
}

export type TravelError =
  | ActionError
  | PlanError
  /** The trip would take longer than any one action may (`actions.maxDurationMin`). */
  | { readonly code: 'TRIP_TOO_LONG'; readonly durationMin: number; readonly maxMin: number }

export type TravelResult =
  | {
      readonly ok: true
      readonly snapshot: GameSnapshot
      /** The trip as taken, delay included; durationMin is what the clock moved. */
      readonly route: Route
      readonly durationMin: number
      readonly rollovers: Rollovers
      /** Rent charged, missed or collected while the clock moved. */
      readonly rent: readonly RentEvent[]
      readonly events: readonly TransitEvent[]
    }
  | { readonly ok: false; readonly error: TravelError }

const M_PER_KM = 1000

/** Rolls for a delay on a subway route; returns the route with the delay added to its first train. */
export function rollSubwayDelay(
  route: Route,
  rng: Rng,
  config: TransitConfig,
): { readonly route: Route; readonly event?: TransitEvent } {
  if (route.mode !== 'subway') return { route }
  const firstTrain = route.legs.findIndex((leg) => leg.mode === 'subway')
  const leg = route.legs[firstTrain]
  if (leg === undefined || leg.mode !== 'subway') return { route }
  const chance = route.rushHour ? config.delay.rushProbability : config.delay.probability
  if (rng.next() >= chance) return { route }

  const extraMin = rollInt(rng, config.delay.minutes.min, config.delay.minutes.max)
  const delayed: SubwayLeg = {
    ...leg,
    waitMin: leg.waitMin + extraMin,
    minutes: leg.minutes + extraMin,
  }
  const legs = route.legs.map((current, index) => (index === firstTrain ? delayed : current))
  return {
    route: { ...route, legs, durationMin: route.durationMin + extraMin },
    event: { id: MTA_DELAY_EVENT, lineId: leg.lineId, extraMin },
  }
}

/** What the trip costs and changes, as an action definition. */
export function travelActionDef(
  route: Route,
  delayed: boolean,
  engine: EngineConfig,
  transit: TransitConfig,
): ActionDef {
  const max = engine.stats.max
  const energy = Math.min(max, Math.round((route.walkedM / M_PER_KM) * transit.walk.energyPerKm))
  let mood = 0
  if (route.mode === 'subway' && route.rushHour) mood += transit.rushHour.subwayMoodDrain
  if (delayed) mood += transit.delay.moodDrain
  return {
    durationMin: route.durationMin,
    cashCost: route.fare,
    energyCost: 0,
    statEffects: {
      ...(energy > 0 ? { energy: -energy } : {}),
      ...(mood > 0 ? { mood: -Math.min(max, mood) } : {}),
    },
  }
}

export function travel(
  snapshot: GameSnapshot,
  request: TravelRequest,
  deps: TravelDeps,
  engine: EngineConfig,
  transit: TransitConfig,
): TravelResult {
  const { minuteOfDay } = calendar(snapshot.clock.minute, engine)
  const planned = planTrip(request.from, request.to, request.mode, {
    config: transit,
    minuteOfDay,
    world: deps.world,
  })
  return travelPlanned(snapshot, planned, deps.rng, engine, transit)
}

/**
 * Takes a trip already planned (by `planTrip`, or `planDirect` when the transit world is not
 * available): checks the fare and the length, rolls for a delay, then applies it as an action.
 */
export function travelPlanned(
  snapshot: GameSnapshot,
  planned: PlanResult,
  rng: Rng,
  engine: EngineConfig,
  transit: TransitConfig,
): TravelResult {
  if (!planned.ok) return planned

  // Refuse before rolling, so an unaffordable attempt does not consume a random draw.
  const { cash } = snapshot.player
  if (cash < planned.route.fare) {
    return {
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: planned.route.fare, available: cash },
    }
  }

  // Checked before the delay roll too, so a refused trip draws nothing.
  const plannedTooLong = tripTooLong(
    travelActionDef(planned.route, false, engine, transit),
    snapshot,
    engine,
  )
  if (plannedTooLong !== undefined) return { ok: false, error: plannedTooLong }

  const { route, event } = rollSubwayDelay(planned.route, rng, transit)
  const def = travelActionDef(route, event !== undefined, engine, transit)
  const delayedTooLong = tripTooLong(def, snapshot, engine)
  if (delayedTooLong !== undefined) return { ok: false, error: delayedTooLong }
  const result = applyAction(snapshot, def, engine)
  if (!result.ok) return result
  return {
    ok: true,
    snapshot: result.snapshot,
    route: { ...route, durationMin: result.durationMin },
    durationMin: result.durationMin,
    rollovers: result.rollovers,
    rent: result.rent,
    events: event === undefined ? [] : [event],
  }
}

/** The TRIP_TOO_LONG error when `def` would take longer than any one action may. */
export function tripTooLong(
  def: ActionDef,
  snapshot: GameSnapshot,
  engine: EngineConfig,
): TravelError | undefined {
  const durationMin = effectiveDuration(def, snapshot, engine)
  const maxMin = engine.actions.maxDurationMin
  return durationMin > maxMin ? { code: 'TRIP_TOO_LONG', durationMin, maxMin } : undefined
}
