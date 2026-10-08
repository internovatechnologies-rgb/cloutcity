/**
 * Whether the player asked for reduced motion (`prefers-reduced-motion: reduce`), live: a change
 * in the OS setting re-renders the reader. False on the server and where matchMedia is missing,
 * so the first client render matches the server one.
 */
import { useSyncExternalStore } from 'react'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

type MatchMedia = (query: string) => MediaQueryList

function browserMatchMedia(): MatchMedia | undefined {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? undefined
    : window.matchMedia.bind(window)
}

/** Current preference; false without matchMedia. */
export function readReducedMotion(
  matchMedia: MatchMedia | undefined = browserMatchMedia(),
): boolean {
  return matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false
}

/** Calls `onChange` whenever the preference changes; returns the unsubscribe. */
export function subscribeReducedMotion(
  onChange: () => void,
  matchMedia: MatchMedia | undefined = browserMatchMedia(),
): () => void {
  if (matchMedia === undefined) return () => {}
  const query = matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const subscribe = (onChange: () => void) => subscribeReducedMotion(onChange)
const snapshot = () => readReducedMotion()
const serverSnapshot = () => false

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
