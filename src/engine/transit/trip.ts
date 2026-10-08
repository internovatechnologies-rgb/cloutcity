/**
 * Trips (S08 part 2): the player goes from where they are (home, or a place) to another spot by
 * walk, subway or taxi. A trip is committed at once, when it starts (DEC-22): the fare is paid,
 * the personal clock fast-forwards by the trip's length (rent falling due on the way included)
 * and the player's location becomes the destination. The 3D animation that follows only shows
 * what already happened, so a reload or a closed tab mid-animation loses nothing.
 *
 * The caller resolves both ends to points in local metres (src/lib/world/places.ts and the
 * homes data) and passes the destination's borough: a place in a borough the player cannot
 * enter yet cannot be travelled to. Home is always open, and so is a memorial (DEC-46).
 *
 * Without the transit world (the geo layers failed to load) only a taxi can be planned, as a
 * straight drive (`planDirect`): no water test and no crossings, so it is an estimate. The
 * delay roll draws from the player's own generator (`player.transit.rngState`, mixed with the
 * clock minute like the flex and event rolls), which the save keeps, so a reload cannot re-roll.
 */
import { effectiveDuration } from '../actions'
import { calendar } from '../clock'
import { placeBoroughAccess, type BoroughAccess } from '../boroughs'
import { levelClout } from '../clout'
import type { EngineConfig } from '../config'
import { sameLocation, type GameSnapshot, type PlayerLocation } from '../game'
import { createRng, mixSeed } from '../rng'
import type { Borough } from '@/lib/data/schemas/content'
import { distanceM, type LocalPoint } from '@/lib/geo/projection'
import type { TransitConfig } from './config'
import {
  isRushHour,
  planTrip,
  taxiFare,
  TRAVEL_MODES,
  type PlanError,
  type PlanResult,
  type Route,
  type TaxiLeg,
  type TravelMode,
} from './plan'
import {
  travelActionDef,
  travelPlanned,
  tripTooLong,
  type TransitEvent,
  type TravelError,
  type TravelResult,
} from './travel'
import type { TransitWorld } from './world'

/** One end of a trip: a spot the player can be at, where it is, and the borough that gates it. */
export interface TripStop {
  readonly location: PlayerLocation
  readonly point: LocalPoint
  readonly borough: Borough
}

export interface TripRequest {
  /** Where the player stands now (their current location's point). */
  readonly from: LocalPoint
  readonly to: TripStop
  readonly mode: TravelMode
}

export interface TripDeps {
  /** The transit world, or null when the geo layers could not load (taxi estimate only). */
  readonly world: TransitWorld | null
}

export type TripError =
  | TravelError
  /** The player is already there. */
  | { readonly code: 'ALREADY_HERE' }
  /** The destination's borough is not open to the player. */
  | {
      readonly code: 'BOROUGH_LOCKED'
      readonly access: Exclude<BoroughAccess, { readonly status: 'open' }>
    }
  /** Walk and subway need the transit world, which is not available. */
  | { readonly code: 'NO_ROUTE_DATA' }

export type TripResult =
  | (Extract<TravelResult, { readonly ok: true }> & {
      /** Where the trip started and ended. */
      readonly from: PlayerLocation
      readonly to: PlayerLocation
      /** The subway delay, or null. */
      readonly delay: TransitEvent | null
      /** True when the route is a straight estimate (no transit world). */
      readonly direct: boolean
    })
  | { readonly ok: false; readonly error: TripError }

const M_PER_KM = 1000
const MIN_PER_HOUR = 60

/**
 * A taxi trip as a straight drive, for when the transit world is not available: the same speed,
 * detour, pickup, rush-hour slowdown and fare as `planTrip`'s taxi, without water or crossings,
 * over the straight distance times `taxi.estimateDetourFactor` so the estimate is an upper
 * bound of the routed ride.
 */
export function planDirect(
  from: LocalPoint,
  to: LocalPoint,
  minuteOfDay: number,
  config: TransitConfig,
): PlanResult {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) {
    return { ok: false, error: { code: 'INVALID_POINT' } }
  }
  const straight = distanceM(from, to)
  if (straight < config.minTripM) {
    return { ok: false, error: { code: 'ALREADY_THERE', distanceM: straight } }
  }
  const rushHour = isRushHour(minuteOfDay, config)
  const rushFactor = rushHour ? config.rushHour.taxiDurationMultiplier : 1
  // An upper bound on the routed drive (TRV-5): blocking the geo download must never buy a
  // cheaper or quicker ride than the bridges and tunnels allow.
  const pathM = straight * config.taxi.estimateDetourFactor
  const driveMin =
    ((pathM * config.taxi.detourFactor) / M_PER_KM / config.taxi.speedKmh) *
    MIN_PER_HOUR *
    rushFactor
  const leg: TaxiLeg = {
    mode: 'taxi',
    from,
    to,
    distanceM: pathM,
    minutes: config.taxi.pickupMin + driveMin,
    polyline: [from, to],
    crossingIds: [],
  }
  const minutes = Math.ceil(Math.round(leg.minutes * 1e6) / 1e6)
  return {
    ok: true,
    route: {
      mode: 'taxi',
      from,
      to,
      legs: [leg],
      durationMin: minutes,
      fare: taxiFare(pathM, config),
      transfers: 0,
      walkedM: 0,
      rushHour,
    },
  }
}

/** Why the player cannot travel to `to` at all (whatever the mode), or null. */
function destinationBlock(snapshot: GameSnapshot, to: TripStop, config: EngineConfig) {
  if (sameLocation(snapshot.player.location, to.location)) {
    return { code: 'ALREADY_HERE' } as const
  }
  if (to.location.kind === 'home') return null
  const clout = levelClout(snapshot.player, config)
  const access = placeBoroughAccess(to.location.placeId, to.borough, clout, config)
  return access.status === 'open' ? null : ({ code: 'BOROUGH_LOCKED', access } as const)
}

function plan(
  snapshot: GameSnapshot,
  request: TripRequest,
  deps: TripDeps,
  engine: EngineConfig,
  transit: TransitConfig,
): PlanResult | { readonly ok: false; readonly error: { readonly code: 'NO_ROUTE_DATA' } } {
  const { minuteOfDay } = calendar(snapshot.clock.minute, engine)
  if (deps.world !== null) {
    return planTrip(request.from, request.to.point, request.mode, {
      config: transit,
      minuteOfDay,
      world: deps.world,
    })
  }
  if (request.mode !== 'taxi') return { ok: false, error: { code: 'NO_ROUTE_DATA' } }
  return planDirect(request.from, request.to.point, minuteOfDay, transit)
}

/**
 * Takes a trip: re-checks the destination (not where the player already is, its borough open),
 * plans it, pays the fare, rolls for a subway delay, fast-forwards the clock and moves the
 * player there, all at once. Nothing changes when it fails.
 */
export function takeTrip(
  snapshot: GameSnapshot,
  request: TripRequest,
  deps: TripDeps,
  engine: EngineConfig,
  transit: TransitConfig,
): TripResult {
  const block = destinationBlock(snapshot, request.to, engine)
  if (block !== null) return { ok: false, error: block }
  const planned = plan(snapshot, request, deps, engine, transit)
  if (!planned.ok) return planned
  const { player } = snapshot
  const rng = createRng(mixSeed(player.transit.rngState, snapshot.clock.minute))
  const result = travelPlanned(snapshot, planned, rng, engine, transit)
  if (!result.ok) return result
  const moved = result.snapshot.player
  return {
    ...result,
    snapshot: {
      ...result.snapshot,
      player: { ...moved, location: request.to.location, transit: { rngState: rng.state } },
    },
    from: player.location,
    to: request.to.location,
    delay: result.events[0] ?? null,
    direct: deps.world === null,
  }
}

/** One "Get there" row: a mode with what it costs now, or why it cannot be taken. */
export interface TripOption {
  readonly mode: TravelMode
  /** The planned route (before any delay), or null when the mode cannot be planned at all. */
  readonly route: Route | null
  /** Game minutes the clock would move (the at-zero slowdown applied; any delay is extra). */
  readonly durationMin: number
  /** Null when the player can take it now. */
  readonly block: TripError | null
}

/**
 * Every mode from where the player stands to `to`, for the "Get there" rows (GR-10: the rows
 * are built from this data, so their copy always matches what a trip would do). Blocks are the
 * ones `takeTrip` would return, in its order, minus the delay roll.
 */
export function tripOptions(
  snapshot: GameSnapshot,
  from: LocalPoint,
  to: TripStop,
  deps: TripDeps,
  engine: EngineConfig,
  transit: TransitConfig,
): readonly TripOption[] {
  const block = destinationBlock(snapshot, to, engine)
  return TRAVEL_MODES.map((mode): TripOption => {
    const planned = plan(snapshot, { from, to, mode }, deps, engine, transit)
    if (!planned.ok) {
      return { mode, route: null, durationMin: 0, block: block ?? (planned.error as PlanError) }
    }
    const { route } = planned
    const def = travelActionDef(route, false, engine, transit)
    const durationMin = effectiveDuration(def, snapshot, engine)
    const tooLong = tripTooLong(def, snapshot, engine)
    const cash = snapshot.player.cash
    const funds: TripError | null =
      cash < route.fare
        ? { code: 'INSUFFICIENT_FUNDS', required: route.fare, available: cash }
        : null
    return { mode, route, durationMin, block: block ?? funds ?? tooLong ?? null }
  })
}
