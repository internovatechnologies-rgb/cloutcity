'use client'

import { useEffect, useState } from 'react'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import { whenMapPlayable } from '@/state/mapPlayable'

// DEC-11: the shell carries only this mount. The tour, with its store, the game store and its
// copy, loads once the map is playable, so it never competes with the map for bandwidth and
// never points at controls that are not there yet. Nothing shows while it loads.
const TourHost = lazyIsland(() => import('./TourHost').then((module) => module.TourHost), {
  zone: 'banner',
  labelKey: 'loading.tour',
  quiet: true,
})

/** The banner zone's tour slot (S06): nothing until the map is playable, then the tour host. */
export function TourMount() {
  const [playable, setPlayable] = useState(false)

  useEffect(() => {
    let mounted = true
    void whenMapPlayable().then(() => {
      if (mounted) setPlayable(true)
    })
    return () => {
      mounted = false
    }
  }, [])

  return playable ? <TourHost /> : null
}
