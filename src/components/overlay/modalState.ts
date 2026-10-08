'use client'

/**
 * Whether a modal is open over the overlay (UX-1). A modal component declares itself with
 * `useModalPresence(open)`; the overlay background reads `useModalOpen()` to make the scene and
 * every zone inert and dimmed behind it. Generic, so later dialogs (S06, S19) reuse it.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'

interface ModalState {
  /** How many modals are open now. */
  readonly openCount: number
  /**
   * True once the modal slot's island has loaded and rendered its decision (the welcome card,
   * the lock screen, or nothing for a returning player). Until then a page with a modal slot is
   * held inert, from the first server-rendered byte on: the 18+ gate fails closed at every
   * moment, including before hydration.
   */
  readonly settled: boolean
}

export const modalStore = createStore<ModalState>()(() => ({ openCount: 0, settled: false }))

const isOpen = () => modalStore.getState().openCount > 0
const serverIsOpen = () => false
const isHeld = () => !modalStore.getState().settled
const serverIsHeld = () => true

/** True while any modal is open. False during the server render and hydration. */
export function useModalOpen(): boolean {
  return useSyncExternalStore(modalStore.subscribe, isOpen, serverIsOpen)
}

/**
 * True while a page with a modal slot is waiting for that slot's island to decide (see
 * `settled`). True during the server render and hydration, so the prerendered HTML is inert.
 */
export function useModalHold(hasModalSlot: boolean): boolean {
  const held = useSyncExternalStore(modalStore.subscribe, isHeld, serverIsHeld)
  return hasModalSlot && held
}

/** Called by the modal slot's island once it has loaded and rendered (lazyIsland). */
export function useModalSettled(): void {
  useEffect(() => {
    if (!modalStore.getState().settled) modalStore.setState({ settled: true })
  }, [])
}

/** Marks a modal as open for as long as `open` is true and the caller stays mounted. */
export function useModalPresence(open: boolean): void {
  useEffect(() => {
    if (!open) return
    modalStore.setState((state) => ({ openCount: state.openCount + 1 }))
    return () => modalStore.setState((state) => ({ openCount: state.openCount - 1 }))
  }, [open])
}
