/**
 * The safety toast (S18b): what a block, mute or report just did, with an Undo while it can still
 * be undone. Session-only UI state, never persisted, and deliberately tiny like hudPanel.ts: the
 * shell's toast mount reads it, so the toast with its copy loads only when there is one
 * (DEC-11). The text arrives already rendered, so this module needs no copy.
 *
 * One toast at a time: a new one replaces the last (its Undo is gone with it, as the server's
 * undo window would close soon anyway).
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'

export interface SafetyToastUndo {
  /** The Undo button's accessible name. */
  readonly label: string
  /** Undo is offered until this time (epoch ms), then the button goes away. */
  readonly untilMs: number
  readonly run: () => void
}

export interface SafetyToast {
  readonly id: number
  readonly text: string
  readonly undo: SafetyToastUndo | null
}

interface SafetyToastState {
  readonly toast: SafetyToast | null
}

export const safetyToastStore = createStore<SafetyToastState>()(() => ({ toast: null }))

let nextId = 1

/** Shows a toast in place of any other; returns its id. */
export function showSafetyToast(text: string, undo: SafetyToastUndo | null = null): number {
  const id = nextId++
  safetyToastStore.setState({ toast: { id, text, undo } })
  return id
}

/** Closes the toast with `id`, if it is still the one showing. */
export function dismissSafetyToast(id: number): void {
  if (safetyToastStore.getState().toast?.id === id) safetyToastStore.setState({ toast: null })
}

const current = () => safetyToastStore.getState().toast
const serverToast = () => null

/** The toast showing now; null during the server render and hydration. */
export function useSafetyToast(): SafetyToast | null {
  return useSyncExternalStore(safetyToastStore.subscribe, current, serverToast)
}
