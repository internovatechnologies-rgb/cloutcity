/**
 * Whether the Places panel (S04c, A11Y-3) is open in the sheet zone, and how. Session-only UI
 * state, never persisted, and tiny like placeSheet.ts: the shell imports it for the HUD's Places
 * button and the 3D map's fallback, and the panel itself loads only on first use (DEC-11).
 *
 * - `list`: every place, grouped by borough.
 * - `chooser`: a tap on the 3D map landed on several pins at once; the panel lists just those.
 *
 * `auto` marks a panel the app opened by itself because the 3D map is unavailable (no WebGL, a
 * failed load, a lost context): it must not take focus from what the player is doing nor close
 * a HUD panel they have open (it waits behind it), and it closes again when the map comes back,
 * unless the player has used it since.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import { soundSheetStore } from '@/components/audio/soundSheet'
import { useHudPanel, type HudPanel } from './hudPanel'
import { closePlace, useOpenPlaceId } from './placeSheet'

export type PlacesPanelMode = 'list' | 'chooser'

export interface PlacesPanelState {
  readonly open: boolean
  readonly mode: PlacesPanelMode
  /** The places a chooser offers, nearest first; empty in list mode. */
  readonly chooserIds: readonly string[]
  readonly auto: boolean
}

const CLOSED: PlacesPanelState = { open: false, mode: 'list', chooserIds: [], auto: false }

export const placesPanelStore = createStore<PlacesPanelState>()(() => CLOSED)

/** Opens the full list (the HUD button), replacing any open place sheet so the list shows. */
export function openPlacesPanel(): void {
  closePlace()
  placesPanelStore.setState({ open: true, mode: 'list', chooserIds: [], auto: false })
}

/**
 * Opens a chooser between places that sit too close on screen to tell apart by a tap. Like a
 * tap on a single pin, it replaces any open place sheet.
 */
export function openPlacesChooser(ids: readonly string[]): void {
  closePlace()
  placesPanelStore.setState({ open: true, mode: 'chooser', chooserIds: [...ids], auto: false })
}

/** Opens the full list without taking focus, because the 3D map is unavailable. */
export function autoOpenPlacesPanel(): void {
  if (placesPanelStore.getState().open) return
  placesPanelStore.setState({ open: true, mode: 'list', chooserIds: [], auto: true })
}

/** Closes an automatically opened panel the player has not taken over (the map is back). */
export function closeAutoPlacesPanel(): void {
  if (placesPanelStore.getState().auto) placesPanelStore.setState(CLOSED)
}

/** The player has used the auto-opened panel: it stays until they close it. */
export function keepPlacesPanel(): void {
  if (placesPanelStore.getState().auto) placesPanelStore.setState({ auto: false })
}

export function closePlacesPanel(): void {
  placesPanelStore.setState(CLOSED)
}

const current = () => placesPanelStore.getState()
const server = () => CLOSED

/** The panel state; closed during the server render and hydration. */
export function usePlacesPanel(): PlacesPanelState {
  return useSyncExternalStore(placesPanelStore.subscribe, current, server)
}

/**
 * Whether the panel is on screen, not just open: a place sheet hides it until it closes (the
 * player went into a place from it), and so does a HUD panel or the Settings sheet the player
 * has open over an automatically opened one (the app must not push the player's own panel aside).
 */
export function placesPanelShown(
  panel: PlacesPanelState,
  openPlaceId: string | null,
  hudPanel: HudPanel | null,
  settingsOpen = false,
): boolean {
  return panel.open && openPlaceId === null && !(panel.auto && (hudPanel !== null || settingsOpen))
}

const settingsOpenNow = () => soundSheetStore.getState().open
const serverSettingsOpen = () => false

/** Whether the panel is on screen (placesPanelShown) right now. */
export function usePlacesPanelShown(): boolean {
  const settingsOpen = useSyncExternalStore(
    soundSheetStore.subscribe,
    settingsOpenNow,
    serverSettingsOpen,
  )
  return placesPanelShown(usePlacesPanel(), useOpenPlaceId(), useHudPanel(), settingsOpen)
}
