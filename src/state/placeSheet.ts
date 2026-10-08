/**
 * Which place's action sheet is open (S09). Session-only UI state, never persisted: a reload
 * starts with no sheet open.
 *
 * Every way into a place goes through `openPlace` (the 3D pins, the Places panel, the e2e hook),
 * so they all open the same sheet; `origin` says which one, so the 3D map can bring a place
 * picked outside the map into view (S04c). The store also carries the selection announcement
 * the persistent status in PlaceSheetMount reads out (A11Y-3). It is deliberately tiny and holds
 * no game data: the shell imports it to know when to load the sheet, and the sheet with its
 * engine and data loads only on first use (DEC-11).
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'

/**
 * Where a place was picked: a tap on its 3D pin, the Places panel, a test hook, or the end of a
 * trip there (S08: the sheet opens again on arrival, announcing it).
 */
export type PlaceOrigin = 'map' | 'panel' | 'hook' | 'travel'

interface PlaceSheetState {
  /** The place whose sheet is open, or null. An unknown id renders nothing and is cleared. */
  readonly placeId: string | null
  readonly origin: PlaceOrigin | null
  /** Counts every openPlace call, so picking the open place again is still a new pick. */
  readonly openCount: number
  /** What the selection status announces ("Glowmatic selected"); empty when nothing is new. */
  readonly announcement: string
}

export const placeSheetStore = createStore<PlaceSheetState>()(() => ({
  placeId: null,
  origin: null,
  openCount: 0,
  announcement: '',
}))

export interface OpenPlaceOptions {
  readonly origin: PlaceOrigin
}

/** Opens the action sheet for a venue or landmark (replacing any open one). */
export function openPlace(placeId: string, { origin }: OpenPlaceOptions): void {
  placeSheetStore.setState((state) => ({
    placeId,
    origin,
    openCount: state.openCount + 1,
    // Cleared until the sheet has the place's name, so the same text announced twice in a row
    // still changes the live region.
    announcement: '',
  }))
}

/** Closes the action sheet. */
export function closePlace(): void {
  placeSheetStore.setState({ placeId: null, origin: null, announcement: '' })
}

/** Sets the selection announcement (the place sheet calls this with the place's name). */
export function announcePlace(text: string): void {
  placeSheetStore.setState({ announcement: text })
}

const openPlaceId = () => placeSheetStore.getState().placeId
const serverPlaceId = () => null

/** The open place id; null during the server render and hydration. */
export function useOpenPlaceId(): string | null {
  return useSyncExternalStore(placeSheetStore.subscribe, openPlaceId, serverPlaceId)
}

const openCountNow = () => placeSheetStore.getState().openCount
const serverOpenCount = () => 0

/** Changes on every openPlace call, including a repeat pick of the open place. */
export function usePlaceOpenCount(): number {
  return useSyncExternalStore(placeSheetStore.subscribe, openCountNow, serverOpenCount)
}

const originNow = () => placeSheetStore.getState().origin
const serverOrigin = () => null

/** How the open place was picked; null with none, on the server and during hydration. */
export function usePlaceOrigin(): PlaceOrigin | null {
  return useSyncExternalStore(placeSheetStore.subscribe, originNow, serverOrigin)
}

const announcementNow = () => placeSheetStore.getState().announcement
const serverAnnouncement = () => ''

/** The current selection announcement; empty during the server render and hydration. */
export function usePlaceAnnouncement(): string {
  return useSyncExternalStore(placeSheetStore.subscribe, announcementNow, serverAnnouncement)
}

/** The open place id right now (outside React: the 3D map's selection ring). */
export function currentPlaceId(): string | null {
  return placeSheetStore.getState().placeId
}

/**
 * Calls `listener` on every openPlace call, with the place and where it was picked, repeat picks
 * of the open place included (S04c: the 3D map flies to places picked elsewhere). Returns
 * unsubscribe.
 */
export function onPlacePicked(
  listener: (placeId: string, origin: PlaceOrigin) => void,
): () => void {
  return placeSheetStore.subscribe((state, previous) => {
    if (state.openCount === previous.openCount) return
    if (state.placeId !== null && state.origin !== null) listener(state.placeId, state.origin)
  })
}

/** Calls `listener` whenever the open place changes, with the new id or null. Returns unsubscribe. */
export function onOpenPlaceChange(listener: (placeId: string | null) => void): () => void {
  return placeSheetStore.subscribe((state, previous) => {
    if (state.placeId !== previous.placeId) listener(state.placeId)
  })
}

/** Calls `listener` each time a place opens (S10a: the HUD panels make way). Returns unsubscribe. */
export function onPlaceOpened(listener: () => void): () => void {
  return placeSheetStore.subscribe((state, previous) => {
    if (state.placeId !== null && state.placeId !== previous.placeId) listener()
  })
}

/** A place action that ran (S06): where, which action, and the player's cash around it. */
export interface PlaceActionDone {
  readonly placeId: string
  readonly actionId: string
  readonly cashBefore: number
  readonly cashAfter: number
}

const actionDoneListeners = new Set<(done: PlaceActionDone) => void>()

/**
 * Calls `listener` each time a place sheet action succeeds (S06: the tour waits for the first
 * purchase). Returns unsubscribe.
 */
export function onPlaceActionDone(listener: (done: PlaceActionDone) => void): () => void {
  actionDoneListeners.add(listener)
  return () => {
    actionDoneListeners.delete(listener)
  }
}

/** The place sheet reports each action that succeeded. */
export function reportPlaceActionDone(done: PlaceActionDone): void {
  for (const listener of [...actionDoneListeners]) listener(done)
}
