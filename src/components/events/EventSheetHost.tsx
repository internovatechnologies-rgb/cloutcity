'use client'

import { useEffect } from 'react'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import { gameStore, useGameStore } from '@/state/store'

// The dialog and the events copy load on first use, with a loading state in the sheet zone.
const EventSheet = lazyIsland(() => import('./EventSheet').then((module) => module.EventSheet), {
  zone: 'sheet',
  labelKey: 'loading.event',
})

/**
 * Watches the game store for an open event (or an outcome still showing) and renders the event
 * sheet while there is one. Loaded at boot by EventSheetMount. In builds with test hooks it also
 * installs the e2e hook (src/components/events/eventTestHook.ts) from its own chunk.
 */
export function EventSheetHost() {
  const open = useGameStore((state) => state.eventOutcome !== null || state.events.active !== null)

  useEffect(() => {
    // Inlined at build time (next.config.ts): production builds drop the hook entirely.
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    void import('./eventTestHook').then((module) => module.installEventTestHook(gameStore))
  }, [])

  return open ? <EventSheet /> : null
}
