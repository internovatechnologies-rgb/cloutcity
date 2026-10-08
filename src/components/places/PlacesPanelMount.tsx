'use client'

import { useEffect } from 'react'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import { closeHudPanel, hudPanelStore } from '@/state/hudPanel'
import { closePlacesPanel, placesPanelStore, usePlacesPanel } from '@/state/placesPanel'

// DEC-11: the shell carries only this mount. The panel, with the place data, the game store (for
// the lock reasons) and the copy it needs, loads in its own chunk the first time it opens.
const PlacesPanel = lazyIsland(() => import('./PlacesPanel').then((module) => module.PlacesPanel), {
  zone: 'sheet',
  labelKey: 'loading.places',
})

/**
 * The sheet zone's Places-panel slot (S04c): nothing until the HUD's Places button, a tap on
 * overlapping pins or an unavailable 3D map opens it. It shares the zone with the HUD panels
 * (S10a), one at a time: opening either closes the other, except that a panel the app opened by
 * itself waits behind a HUD panel instead. A place sheet opened from it hides it until the sheet
 * closes (PlacesPanel).
 */
export function PlacesPanelMount() {
  const panel = usePlacesPanel()

  useEffect(() => {
    // A panel the app opened by itself (the 3D map is down) stays open behind a HUD panel and
    // shows again when it closes; it never closes the player's HUD panel either.
    const offHud = hudPanelStore.subscribe((state, previous) => {
      if (state.panel === null || state.panel === previous.panel) return
      if (!placesPanelStore.getState().auto) closePlacesPanel()
    })
    const offPlaces = placesPanelStore.subscribe((state, previous) => {
      const playerOpened = state.open && !state.auto
      const wasPlayerOpened = previous.open && !previous.auto
      if (playerOpened && !wasPlayerOpened) closeHudPanel()
    })
    return () => {
      offHud()
      offPlaces()
    }
  }, [])

  return panel.open ? <PlacesPanel /> : null
}
