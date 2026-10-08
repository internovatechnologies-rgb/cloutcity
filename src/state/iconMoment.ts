/**
 * Whether the Icon moment (S15) is waiting to be shown, or the prestige confirm was asked for
 * from the Goals panel. Session-only UI state, never persisted, and deliberately tiny like
 * hudPanel.ts: the shell's modal mount reads it, so the victory screen with the store, engine and
 * goals copy loads only when the moment comes (DEC-11).
 *
 * The HUD's live island (which already holds the game store) sets `pending` from the save: true
 * while `goals.icon` has been reached and not acknowledged. Closing the screen or prestiging
 * clears it through the store, and the island follows. `confirm` is the Goals panel's Prestige
 * entry: after "Keep playing" the moment is gone for the run, but an Icon player can still open
 * its prestige confirm from Goals.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'

interface IconMomentState {
  readonly pending: boolean
  /** The Goals panel asked for the prestige confirm. */
  readonly confirm: boolean
}

export const iconMomentStore = createStore<IconMomentState>()(() => ({
  pending: false,
  confirm: false,
}))

export function setIconMomentPending(pending: boolean): void {
  if (iconMomentStore.getState().pending !== pending) iconMomentStore.setState({ pending })
}

/** Opens the prestige confirm on its own (the Goals panel's Prestige entry). */
export function openPrestigeConfirm(): void {
  if (!iconMomentStore.getState().confirm) iconMomentStore.setState({ confirm: true })
}

/** Closes the prestige confirm opened from Goals. */
export function closePrestigeConfirm(): void {
  if (iconMomentStore.getState().confirm) iconMomentStore.setState({ confirm: false })
}

const isPending = () => iconMomentStore.getState().pending
const isConfirm = () => iconMomentStore.getState().confirm
const serverFalse = () => false

/** True while the Icon moment should show; false during the server render and hydration. */
export function useIconMomentPending(): boolean {
  return useSyncExternalStore(iconMomentStore.subscribe, isPending, serverFalse)
}

/** True while the prestige confirm opened from Goals should show. */
export function usePrestigeConfirmRequested(): boolean {
  return useSyncExternalStore(iconMomentStore.subscribe, isConfirm, serverFalse)
}
