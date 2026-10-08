'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'

/**
 * The sheet zone's event slot (DEC-11). The shell carries none of the event code: the host
 * (with the game store, engine, save and catalogs it needs) is a boot island that starts loading
 * when the shell runs, because an event left open before a reload has to reappear. The host then
 * loads the event sheet UI and its copy only when an event is open. Nothing shows while the
 * host loads: most boots have no event open.
 */
export const EventSheetMount = lazyIsland(
  () => import('./EventSheetHost').then((module) => module.EventSheetHost),
  { zone: 'sheet', labelKey: 'loading.event', eager: true, quiet: true },
)
