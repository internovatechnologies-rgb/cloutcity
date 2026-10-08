/**
 * What the 3D apartment should show (S16), handed from the Home panel to the room's mount.
 * Session-only and deliberately tiny like sceneFocus.ts: the mount sits in the shell (the room's
 * `next/dynamic` import must be reachable from the page for the build to list its chunk), so it
 * reads this instead of the game store, and the Home panel's chunk, which holds the store, writes
 * it. Taps on the room travel back the same way.
 *
 * Null while the Home panel is closed: the room mounts only while there is a view to show.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import type { ApartmentView, SlotTap } from '@/scene/apartment/types'

interface ApartmentViewState {
  readonly view: ApartmentView | null
}

export const apartmentViewStore = createStore<ApartmentViewState>()(() => ({ view: null }))

/** Shows `view` in the room, or closes the room with null. */
export function setApartmentView(view: ApartmentView | null): void {
  apartmentViewStore.setState({ view })
}

const viewNow = () => apartmentViewStore.getState().view
const serverView = () => null

/** The room's view; null on the server, during hydration and while the Home panel is closed. */
export function useApartmentView(): ApartmentView | null {
  return useSyncExternalStore(apartmentViewStore.subscribe, viewNow, serverView)
}

const tapListeners = new Set<(tap: SlotTap) => void>()

/** Reports a tap on the room to the Home panel. */
export function tapApartmentSlot(tap: SlotTap): void {
  for (const listener of tapListeners) listener(tap)
}

/** Listens for taps on the room; returns the function that stops listening. */
export function onApartmentSlotTap(listener: (tap: SlotTap) => void): () => void {
  tapListeners.add(listener)
  return () => {
    tapListeners.delete(listener)
  }
}
