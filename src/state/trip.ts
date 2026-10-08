/**
 * The trip on screen (S08 part 2): session-only and deliberately tiny like placeSheet.ts, so the
 * shell, the HUD, the place sheet and the 3D chunk can all read it without loading the store,
 * the engine or the transit data. The travel chunk (src/state/tripDriver.ts) writes it.
 *
 * A trip is committed to the save the moment it starts (DEC-22); what lives here is only its
 * presentation: the route the avatar animates along, how far the animation has got (the HUD
 * clock counts up through the trip with it), and what the arrival says once it lands.
 *
 * It also mirrors where the player stands (`spot`, written by the HUD's live island from the
 * save), so the 3D map can stand the avatar there after a reload.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import type { PlayerLocation } from '@/engine/game'
import type { RentEvent } from '@/engine/rent'
import type { Route, TravelMode } from '@/engine/transit/plan'

/** Where the player stands: home, or a place by id (src/engine/game.ts `PlayerLocation`). */
export type PlayerSpot = PlayerLocation

/** The reserved id of the home card and the Places panel's Home row. */
export const HOME_SPOT_ID = 'home'

export interface ActiveTrip {
  /** Counts trips this session, so an arrival is matched to its own trip. */
  readonly id: number
  readonly destination: PlayerSpot
  readonly mode: TravelMode
  /** The route as animated: its first and last legs reach the avatar's resting points. */
  readonly route: Route
  /** The personal clock at departure and at arrival (whole game minutes). */
  readonly departMinute: number
  readonly arriveMinute: number
  /** Real milliseconds the animation lasts; 0 cuts straight to the arrival. */
  readonly durationMs: number
  /** `performance.now()` when the animation started (moved back by a seek). */
  readonly startedAtMs: number
}

/** What a finished trip did, shown in the destination's sheet until dismissed. */
export interface TripArrival {
  readonly id: number
  readonly destination: PlayerSpot
  readonly mode: TravelMode
  /** Game minutes the clock moved, any delay included. */
  readonly durationMin: number
  readonly fare: number
  /** Minutes the train was delayed, or 0. */
  readonly delayMin: number
  /** Rent charged, missed or collected on the way. */
  readonly rent: readonly RentEvent[]
  /** True when the route was a straight estimate (the transit data could not load). */
  readonly direct: boolean
}

interface TripState {
  readonly spot: PlayerSpot | null
  readonly active: ActiveTrip | null
  /** 0..1 through the active trip's animation. */
  readonly progress: number
  /** True while the 3D map can animate a trip (the scene is drawn and has the screen). */
  readonly animator: boolean
  readonly arrival: TripArrival | null
  /** True while arrivals roll no random event (the first-run tour, S06). */
  readonly arrivalEventsSuppressed: boolean
}

export const tripStore = createStore<TripState>()(() => ({
  spot: null,
  active: null,
  progress: 0,
  animator: false,
  arrival: null,
  arrivalEventsSuppressed: false,
}))

const sameSpot = (a: PlayerSpot | null, b: PlayerSpot) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind === 'home' || (b.kind === 'place' && a.placeId === b.placeId))

/** The HUD mirrors the save's location here. */
export function setPlayerSpot(spot: PlayerSpot): void {
  if (!sameSpot(tripStore.getState().spot, spot)) tripStore.setState({ spot })
}

/** The 3D map says whether it can animate a trip now. */
export function setTravelAnimator(ready: boolean): void {
  if (tripStore.getState().animator !== ready) tripStore.setState({ animator: ready })
}

/** Who keeps arrivals free of random events: the first-run tour (S06), or an e2e test hook. */
export type ArrivalEventsSuppressor = 'tour' | 'test'

const suppressors = new Set<ArrivalEventsSuppressor>()

/**
 * Turns `source`'s suppression of arrival events on or off; arrivals roll no event while any
 * source has it on, so the tour ending never re-enables events a test turned off.
 */
export function setArrivalEventsSuppressed(
  suppressed: boolean,
  source: ArrivalEventsSuppressor = 'tour',
): void {
  if (suppressed) suppressors.add(source)
  else suppressors.delete(source)
  const next = suppressors.size > 0
  if (tripStore.getState().arrivalEventsSuppressed !== next) {
    tripStore.setState({ arrivalEventsSuppressed: next })
  }
}

/** The destination's sheet has shown the arrival and the player dismissed it. */
export function dismissArrival(id: number): void {
  if (tripStore.getState().arrival?.id === id) tripStore.setState({ arrival: null })
}

/** The personal-clock minute to show while a trip animates, or null with no trip. */
export function tripClockMinute(state: Pick<TripState, 'active' | 'progress'>): number | null {
  const { active, progress } = state
  if (active === null) return null
  const span = active.arriveMinute - active.departMinute
  return active.departMinute + Math.floor(Math.min(1, Math.max(0, progress)) * span)
}

/** The spot as a card id: `home`, or the place id. */
export function spotId(spot: PlayerSpot): string {
  return spot.kind === 'home' ? HOME_SPOT_ID : spot.placeId
}

const activeNow = () => tripStore.getState().active
const progressNow = () => tripStore.getState().progress
const spotNow = () => tripStore.getState().spot
const arrivalNow = () => tripStore.getState().arrival
const clockNow = () => tripClockMinute(tripStore.getState())
const none = () => null
const zero = () => 0

/** The trip animating now; null with none, on the server and during hydration. */
export function useActiveTrip(): ActiveTrip | null {
  return useSyncExternalStore(tripStore.subscribe, activeNow, none)
}

export function useTripProgress(): number {
  return useSyncExternalStore(tripStore.subscribe, progressNow, zero)
}

/** Where the player stands, or null before the HUD has read the save. */
export function usePlayerSpot(): PlayerSpot | null {
  return useSyncExternalStore(tripStore.subscribe, spotNow, none)
}

export function useTripArrival(): TripArrival | null {
  return useSyncExternalStore(tripStore.subscribe, arrivalNow, none)
}

/** The HUD clock's override while a trip animates, or null. */
export function useTripClockMinute(): number | null {
  return useSyncExternalStore(tripStore.subscribe, clockNow, none)
}
