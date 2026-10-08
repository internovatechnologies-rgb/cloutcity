/**
 * Player-facing text for travel (S08 part 2), built from what the engine reports
 * (src/engine/transit/trip.ts): the "Get there" rows, why a mode cannot be taken, the trip
 * progress card and the arrival line. Rows are plain ("Take the subway: 24 min, $3"); flavour
 * stays in the delay line. No transit operator's name or branding appears anywhere, and nothing
 * claims the routes are real-time or exact (CLAUDE.md "Map and landmarks").
 */
import type { HomeId } from '@/engine/config'
import type { PlayerLocation } from '@/engine/game'
import type { RentEvent } from '@/engine/rent'
import type { TravelMode } from '@/engine/transit/plan'
import type { TripError, TripOption } from '@/engine/transit/trip'
import { copy as activeCopy, type CopyFn, type CopyKey } from '@/lib/copy'
import { homeName, rentNotice } from '@/lib/economyCopy'
import { formatCount, formatMoney } from '@/lib/format'
import { formatDuration } from './placeActionCopy'
import { boroughClosedReason, findPlace, placeName, type MapPlace } from './places'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/travel'

export interface TravelCopyOptions {
  readonly copy?: CopyFn
}

type PlaceRef = Pick<MapPlace, 'borough'>

/** A reason a row is disabled: the engine's, or another trip still animating. */
export type TripBlock = TripError | { readonly code: 'TRIP_IN_PROGRESS' }

const ACTION_KEYS: Readonly<Record<TravelMode, CopyKey>> = {
  walk: 'travel.mode.walk.action',
  subway: 'travel.mode.subway.action',
  taxi: 'travel.mode.taxi.action',
}

const PROGRESS_KEYS: Readonly<Record<TravelMode, CopyKey>> = {
  walk: 'travel.progress.walk',
  subway: 'travel.progress.subway',
  taxi: 'travel.progress.taxi',
}

const ARRIVED_KEYS: Readonly<Record<TravelMode, CopyKey>> = {
  walk: 'travel.arrived.walk',
  subway: 'travel.arrived.subway',
  taxi: 'travel.arrived.taxi',
}

/** The row's button text: "Walk there", "Take the subway", "Take a taxi". */
export function tripModeAction(mode: TravelMode, { copy = activeCopy }: TravelCopyOptions = {}) {
  return copy(ACTION_KEYS[mode])
}

/** What a mode costs: "18 min, free" or "24 min, $3, 1 change, rush hour". Empty when unplanned. */
export function tripOptionDetails(
  option: Pick<TripOption, 'route' | 'durationMin'>,
  options: TravelCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  const { route } = option
  if (route === null) return ''
  const parts = [
    formatDuration(option.durationMin, options),
    route.fare > 0 ? formatMoney(route.fare) : copy('travel.option.free'),
  ]
  if (route.transfers === 1) parts.push(copy('travel.option.transfersOne'))
  if (route.transfers > 1) {
    parts.push(copy('travel.option.transfersMany', { count: formatCount(route.transfers) }))
  }
  if (route.rushHour) parts.push(copy('travel.option.rushHour'))
  return parts.join(', ')
}

/** Why a trip cannot be taken, plainly. `place` is the destination (null for home). */
export function tripBlockReason(
  error: TripBlock,
  place: PlaceRef | null,
  options: TravelCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  switch (error.code) {
    case 'WALK_CROSSES_WATER':
      return copy('travel.blocked.walkWater')
    case 'NO_SUBWAY_ROUTE':
      return copy('travel.blocked.noSubway')
    case 'TAXI_NO_CROSSING':
      return copy('travel.blocked.taxiNoCrossing')
    case 'INVALID_POINT':
    case 'POINT_NOT_REACHABLE':
    case 'INVALID_ACTION':
    case 'UNKNOWN_ACTION':
    case 'INSUFFICIENT_ENERGY':
      return copy('travel.blocked.unreachable')
    case 'TRIP_TOO_LONG':
      return copy('travel.blocked.tooLong', {
        duration: formatDuration(error.durationMin, options),
      })
    case 'INSUFFICIENT_FUNDS':
      return copy('travel.blocked.funds', {
        required: formatMoney(error.required),
        available: formatMoney(error.available),
      })
    case 'ALREADY_HERE':
    case 'ALREADY_THERE':
      return copy('travel.blocked.alreadyHere')
    case 'NO_ROUTE_DATA':
      return copy('travel.blocked.noRouteData')
    case 'TRIP_IN_PROGRESS':
      return copy('travel.blocked.inProgress')
    case 'BOROUGH_LOCKED':
      return (
        (place === null ? null : boroughClosedReason(place.borough, error.access, options)) ??
        copy('travel.blocked.boroughLocked')
      )
  }
}

/** A row's accessible name: the action and what it costs, plus why it is blocked when it is. */
export function tripOptionAccessibleName(
  option: Omit<TripOption, 'block'> & { readonly block: TripBlock | null },
  place: PlaceRef | null,
  options: TravelCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  const name = tripModeAction(option.mode, options)
  const details = tripOptionDetails(option, options)
  const label = details === '' ? name : copy('travel.option.label', { name, details })
  return option.block === null
    ? label
    : copy('travel.option.blockedLabel', {
        action: label,
        reason: tripBlockReason(option.block, place, options),
      })
}

/** A spot's display name: the place's, or "Home". */
export function spotName(location: PlayerLocation, options: TravelCopyOptions = {}): string {
  const { copy = activeCopy } = options
  if (location.kind === 'home') return copy('travel.home.title')
  const place = findPlace(location.placeId)
  return place === undefined ? '' : placeName(place, options)
}

/** "On the way to Late Lantern Deli" and "Walking", for the progress card. */
export function tripProgressText(
  destination: PlayerLocation,
  mode: TravelMode,
  options: TravelCopyOptions = {},
): { readonly title: string; readonly mode: string } {
  const { copy = activeCopy } = options
  return {
    title: copy('travel.progress.title', { place: spotName(destination, options) }),
    mode: copy(PROGRESS_KEYS[mode]),
  }
}

/** What an arrival says: the trip, any delay, and rent charged on the way. */
export function arrivalText(
  arrival: {
    readonly destination: PlayerLocation
    readonly mode: TravelMode
    readonly durationMin: number
    readonly fare: number
    readonly delayMin: number
    readonly rent: readonly RentEvent[]
  },
  options: TravelCopyOptions = {},
): string {
  const { copy = activeCopy } = options
  const parts = [
    copy(ARRIVED_KEYS[arrival.mode], {
      place: spotName(arrival.destination, options),
      duration: formatDuration(arrival.durationMin, options),
      fare: formatMoney(arrival.fare),
    }),
  ]
  if (arrival.delayMin > 0) {
    parts.push(
      copy('travel.arrived.delay', { duration: formatDuration(arrival.delayMin, options) }),
    )
  }
  for (const event of arrival.rent) parts.push(rentNotice(event, options))
  return parts.join(' ')
}

/** The home card's line: "Queens room. Your place, your rules." */
export function homeBlurb(home: HomeId, options: TravelCopyOptions = {}): string {
  const { copy = activeCopy } = options
  return copy('travel.home.blurb', { home: homeName(home, options) })
}
