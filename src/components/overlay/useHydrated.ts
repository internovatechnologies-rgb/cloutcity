'use client'

import { useSyncExternalStore } from 'react'

const noSubscribe = () => () => {}

/**
 * False during the server render and hydration, true after. Lazy islands render only after
 * hydration: what they show depends on browser-only state (storage, the open place).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  )
}
