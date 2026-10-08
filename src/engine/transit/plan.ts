/**
 * Trip planning: walk, subway and taxi between two points in local metres, with time and cost
 * from config. Distances are straight lines times a per-mode detour factor (streets are not
 * straight lines); the subway rides along its real line paths. Rush hour is judged by the
 * personal clock at departure.
 *
 * Nobody walks or drives across open water (src/engine/transit/land.ts): a walk that would is
 * refused, subway entry, exit and transfer walks that would are not used, and a taxi goes via
 * the configured bridges and tunnels (src/engine/transit/taxi.ts).
 *
 * A route is an ordered list of legs, each with a polyline in local metres: straight for walking
 * and taxi legs, the line's own path between the two stations for subway legs. The 3D layer
 * animates the avatar along those polylines (src/engine/transit/timeline.ts).
 *
 * Station ids appear in legs for the scene and tests only. Never render GTFS station names
 * (STN-1: generic display labels come through copy later).
 */
import { distanceM, type LocalPoint } from '@/lib/geo/projection'
import type { TransitConfig } from './config'
import { joinRidePolylines, searchSubway, type SubwayStep } from './network'
import { snapToLand } from './land'
import { taxiPath } from './taxi'
import type { TransitWorld } from './world'

export const TRAVEL_MODES = ['walk', 'subway', 'taxi'] as const
export type TravelMode = (typeof TRAVEL_MODES)[number]

export interface WalkLeg {
  readonly mode: 'walk'
  readonly from: LocalPoint
  readonly to: LocalPoint
  /** Straight-line metres (the polyline's length). */
  readonly distanceM: number
  /** Game minutes, fractional; street detour included. */
  readonly minutes: number
  readonly polyline: readonly LocalPoint[]
}

export interface TaxiLeg {
  readonly mode: 'taxi'
  readonly from: LocalPoint
  readonly to: LocalPoint
  /** Polyline metres: straight, or via the crossings' ends. */
  readonly distanceM: number
  /** Pickup wait plus driving. */
  readonly minutes: number
  /** from, then each crossing's two ends in order, then to. */
  readonly polyline: readonly LocalPoint[]
  /** Ids of the bridges and tunnels used, in order (data only, never rendered by S08). */
  readonly crossingIds: readonly string[]
}

export interface SubwayLeg {
  readonly mode: 'subway'
  readonly lineId: string
  readonly fromStationId: string
  readonly toStationId: string
  /** Stops the train makes, the alighting stop included. */
  readonly stops: number
  /** Platform wait before boarding (first board, transfer, or any delay). */
  readonly waitMin: number
  readonly rideMin: number
  /** waitMin + rideMin. */
  readonly minutes: number
  /** Metres along the line path (the drawn polyline's length). */
  readonly distanceM: number
  readonly from: LocalPoint
  readonly to: LocalPoint
  /** The line path between the two stations. */
  readonly polyline: readonly LocalPoint[]
}

export type Leg = WalkLeg | TaxiLeg | SubwayLeg

export interface Route {
  readonly mode: TravelMode
  readonly from: LocalPoint
  readonly to: LocalPoint
  readonly legs: readonly Leg[]
  /** Whole game minutes the trip fast-forwards the personal clock (sum of legs, rounded up). */
  readonly durationMin: number
  /** Whole dollars. */
  readonly fare: number
  /** Changes of line on a subway trip. */
  readonly transfers: number
  /** Metres walked (street distance), across every walking leg. */
  readonly walkedM: number
  /** True when a subway or taxi trip departs in a rush-hour window (walking is unaffected). */
  readonly rushHour: boolean
}

export type PlanError =
  | { readonly code: 'INVALID_POINT' }
  /** That end is off land and further than `snapToLandM` from the shore. */
  | { readonly code: 'POINT_NOT_REACHABLE'; readonly end: 'from' | 'to' }
  | { readonly code: 'ALREADY_THERE'; readonly distanceM: number }
  /** No subway trip makes sense: the ends share a nearest station, or no line links them. */
  | { readonly code: 'NO_SUBWAY_ROUTE' }
  /** The straight walk leaves land for more than `walk.maxWaterM`. */
  | { readonly code: 'WALK_CROSSES_WATER' }
  /** No chain of configured crossings links the two ends by road. */
  | { readonly code: 'TAXI_NO_CROSSING' }

export type PlanResult =
  { readonly ok: true; readonly route: Route } | { readonly ok: false; readonly error: PlanError }

export interface PlanContext {
  readonly config: TransitConfig
  /** Personal clock minute of the day at departure (0..1439). */
  readonly minuteOfDay: number
  readonly world: TransitWorld
}

const M_PER_KM = 1000
const MIN_PER_HOUR = 60

function minutesAt(metres: number, speedKmh: number): number {
  return (metres / M_PER_KM / speedKmh) * MIN_PER_HOUR
}

export function walkMinutes(straightM: number, config: TransitConfig): number {
  return minutesAt(straightM * config.walk.detourFactor, config.walk.speedKmh)
}

/** Fare for a drive whose path (straight or via crossings) is `pathM` long. */
export function taxiFare(pathM: number, config: TransitConfig): number {
  const km = (pathM * config.taxi.detourFactor) / M_PER_KM
  return Math.ceil(config.taxi.baseFare + config.taxi.perKm * km)
}

export function isRushHour(minuteOfDay: number, config: TransitConfig): boolean {
  return config.rushHour.windows.some(
    (window) => minuteOfDay >= window.startMin && minuteOfDay < window.endMin,
  )
}

function isPoint(point: LocalPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function walkLeg(from: LocalPoint, to: LocalPoint, config: TransitConfig): WalkLeg {
  const d = distanceM(from, to)
  return {
    mode: 'walk',
    from,
    to,
    distanceM: d,
    minutes: walkMinutes(d, config),
    polyline: [from, to],
  }
}

function finish(
  mode: TravelMode,
  from: LocalPoint,
  to: LocalPoint,
  legs: readonly Leg[],
  fields: Pick<Route, 'fare' | 'transfers' | 'rushHour'>,
  config: TransitConfig,
): Route {
  const minutes = legs.reduce((sum, leg) => sum + leg.minutes, 0)
  const walkedM = legs.reduce(
    (sum, leg) => sum + (leg.mode === 'walk' ? leg.distanceM * config.walk.detourFactor : 0),
    0,
  )
  // Guard float noise (e.g. 12.000000001) before rounding up to whole minutes.
  const durationMin = Math.ceil(Math.round(minutes * 1e6) / 1e6)
  return { mode, from, to, legs, durationMin, walkedM, ...fields }
}

function planSubway(from: LocalPoint, to: LocalPoint, context: PlanContext): PlanResult {
  const { config, world } = context
  const { network } = world
  const rushHour = isRushHour(context.minuteOfDay, config)
  const rushFactor = rushHour ? config.rushHour.subwayDurationMultiplier : 1
  const found = searchSubway(from, to, network, config.subway, {
    walkMin: (metres) => walkMinutes(metres, config),
    rideMin: (metres) =>
      (minutesAt(metres, config.subway.speedKmh) + config.subway.dwellMinPerStop) * rushFactor,
    boardWaitMin: config.subway.boardWaitMin,
    transferPenaltyMin: config.subway.transferPenaltyMin,
    walkable: world.walkable,
  })
  if (found === undefined || found.entry.station === found.exit.station) {
    return { ok: false, error: { code: 'NO_SUBWAY_ROUTE' } }
  }

  const station = (index: number) => {
    const s = network.stations[index]
    if (s === undefined) throw new RangeError(`unknown station index ${index}`)
    return s
  }
  const point = (index: number): LocalPoint => {
    const s = station(index)
    return { x: s.x, y: s.y }
  }

  const legs: Leg[] = [walkLeg(from, point(found.entry.station), config)]
  let waitMin = config.subway.boardWaitMin
  let transfers = 0
  let run: Extract<SubwayStep, { kind: 'ride' }>[] = []

  const flush = () => {
    const first = run[0]
    const last = run[run.length - 1]
    if (first === undefined || last === undefined) return
    const drawn = joinRidePolylines(run, network, config.subway.pathJoinM)
    const rideMin = run.reduce((sum, ride) => sum + ride.minutes, 0)
    legs.push({
      mode: 'subway',
      lineId: first.lineId,
      fromStationId: station(first.from).id,
      toStationId: station(last.to).id,
      stops: run.length,
      waitMin,
      rideMin,
      minutes: waitMin + rideMin,
      distanceM: run.reduce((sum, ride) => sum + ride.lengthM, 0) + drawn.joinM,
      from: point(first.from),
      to: point(last.to),
      polyline: drawn.points,
    })
    run = []
  }

  for (const step of found.steps) {
    if (step.kind === 'ride') {
      const current = run[0]
      if (current !== undefined && current.lineId !== step.lineId) flush()
      run.push(step)
      continue
    }
    flush()
    transfers++
    waitMin = config.subway.transferPenaltyMin
    if (step.walkM > 0) legs.push(walkLeg(point(step.from), point(step.to), config))
  }
  flush()
  legs.push(walkLeg(point(found.exit.station), to, config))

  return {
    ok: true,
    route: finish(
      'subway',
      from,
      to,
      legs,
      { fare: config.subwayFare, transfers, rushHour },
      config,
    ),
  }
}

/**
 * Plans one trip by the given mode. A trip end off land (a bridge's midspan, a pier) is first
 * moved to the nearest land within `snapToLandM`; the route's `from` and `to` are the points
 * actually used.
 */
export function planTrip(
  requestedFrom: LocalPoint,
  requestedTo: LocalPoint,
  mode: TravelMode,
  context: PlanContext,
): PlanResult {
  const { config, world } = context
  if (!isPoint(requestedFrom) || !isPoint(requestedTo)) {
    return { ok: false, error: { code: 'INVALID_POINT' } }
  }
  const from = snapToLand(requestedFrom, world.land, config.snapToLandM)
  if (from === undefined) return { ok: false, error: { code: 'POINT_NOT_REACHABLE', end: 'from' } }
  const to = snapToLand(requestedTo, world.land, config.snapToLandM)
  if (to === undefined) return { ok: false, error: { code: 'POINT_NOT_REACHABLE', end: 'to' } }
  const straight = distanceM(from, to)
  if (straight < config.minTripM) {
    return { ok: false, error: { code: 'ALREADY_THERE', distanceM: straight } }
  }
  const none = { fare: 0, transfers: 0, rushHour: false }

  switch (mode) {
    case 'walk':
      if (!world.walkable(from, to)) return { ok: false, error: { code: 'WALK_CROSSES_WATER' } }
      return {
        ok: true,
        route: finish('walk', from, to, [walkLeg(from, to, config)], none, config),
      }
    case 'taxi': {
      const path = taxiPath(from, to, world.crossings)
      if (path === undefined) return { ok: false, error: { code: 'TAXI_NO_CROSSING' } }
      const rushHour = isRushHour(context.minuteOfDay, config)
      const rushFactor = rushHour ? config.rushHour.taxiDurationMultiplier : 1
      const driveMin =
        minutesAt(path.lengthM * config.taxi.detourFactor, config.taxi.speedKmh) * rushFactor
      const leg: TaxiLeg = {
        mode: 'taxi',
        from,
        to,
        distanceM: path.lengthM,
        minutes: config.taxi.pickupMin + driveMin,
        polyline: path.points,
        crossingIds: path.crossingIds,
      }
      const fields = { ...none, fare: taxiFare(path.lengthM, config), rushHour }
      return { ok: true, route: finish('taxi', from, to, [leg], fields, config) }
    }
    case 'subway':
      return planSubway(from, to, context)
  }
}

export interface TripOptions {
  readonly walk: PlanResult
  readonly subway: PlanResult
  readonly taxi: PlanResult
  /** The mode with the shortest duration; ties go walk, then subway, then taxi (cheapest first). */
  readonly fastest: TravelMode | undefined
}

/** Every mode for one trip, so the player can compare time and cost. */
export function planAllModes(from: LocalPoint, to: LocalPoint, context: PlanContext): TripOptions {
  const results = {
    walk: planTrip(from, to, 'walk', context),
    subway: planTrip(from, to, 'subway', context),
    taxi: planTrip(from, to, 'taxi', context),
  }
  let fastest: TravelMode | undefined
  let bestMin = Infinity
  for (const mode of TRAVEL_MODES) {
    const result = results[mode]
    if (result.ok && result.route.durationMin < bestMin) {
      bestMin = result.route.durationMin
      fastest = mode
    }
  }
  return { ...results, fastest }
}
