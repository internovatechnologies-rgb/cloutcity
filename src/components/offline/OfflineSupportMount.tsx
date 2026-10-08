'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { log } from '@/lib/log'
import { whenMapPlayable } from '@/state/mapPlayable'

/**
 * The banner zone's offline-support slot (S04e). DEC-11: the shell carries only this mount. Offline
 * support (the service worker registration and its update notice, with @serwist/window) loads in
 * its own chunk once the map is playable, so it never competes with the map for bandwidth.
 *
 * A plain `import()` rather than a lazy island: offline support is an enhancement, so a chunk that
 * does not arrive (the player is already offline) is logged at info and shows nothing, instead of
 * a retry card in the banner zone.
 */
export function OfflineSupportMount() {
  const [Loaded, setLoaded] = useState<ComponentType | null>(null)

  useEffect(() => {
    let active = true
    whenMapPlayable()
      .then(() => import('./OfflineSupport'))
      .then((module) => {
        if (active) setLoaded(() => module.OfflineSupport)
      })
      .catch((error: unknown) => {
        log.info('Offline support did not load', {
          error: error instanceof Error ? error.name : typeof error,
        })
      })
    return () => {
      active = false
    }
  }, [])

  return Loaded === null ? null : <Loaded />
}
