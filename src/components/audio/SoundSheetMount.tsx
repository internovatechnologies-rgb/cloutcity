'use client'

/**
 * The sheet zone's Settings slot: nothing until Settings is tapped in the HUD's More panel, then
 * the settings sheet. The sheet, with the stores and copy it needs, is a feature island: it
 * loads in its own chunk on the first open, with a loading state in the sheet zone (DEC-11).
 *
 * One sheet at a time (DEC-21), like the HUD and Places panels: a HUD panel, the Places panel or
 * a place sheet opening closes Settings, and Settings opening closes them. The sheet that opens
 * takes focus. A Places panel the app opened by itself (the 3D map is down) waits behind
 * Settings instead, as it does behind a HUD panel. An event sheet is left alone.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import { closeHudPanel, hudPanelStore } from '@/state/hudPanel'
import { closePlace, onPlaceOpened } from '@/state/placeSheet'
import { closePlacesPanel, placesPanelStore } from '@/state/placesPanel'
import { setSoundSheetOpen, soundSheetStore } from './soundSheet'

const SoundSettingsSheet = lazyIsland(
  () => import('./SoundSettingsSheet').then((module) => module.SoundSettingsSheet),
  { zone: 'sheet', labelKey: 'loading.soundSettings' },
)

const openNow = () => soundSheetStore.getState().open
const closed = () => false

/** Wires the one-sheet rule between Settings and the other sheets; returns unsubscribe. */
export function linkSettingsSheet(): () => void {
  const close = () => {
    if (soundSheetStore.getState().open) setSoundSheetOpen(false)
  }
  const offHud = hudPanelStore.subscribe((state, previous) => {
    if (state.panel !== null && state.panel !== previous.panel) close()
  })
  const offPlaces = placesPanelStore.subscribe((state, previous) => {
    const playerOpened = state.open && !state.auto
    if (playerOpened && !(previous.open && !previous.auto)) close()
  })
  const offPlace = onPlaceOpened(close)
  const offSettings = soundSheetStore.subscribe((state, previous) => {
    if (!state.open || previous.open) return
    closeHudPanel()
    closePlace()
    if (!placesPanelStore.getState().auto) closePlacesPanel()
  })
  return () => {
    offHud()
    offPlaces()
    offPlace()
    offSettings()
  }
}

export function SoundSheetMount() {
  const open = useSyncExternalStore(soundSheetStore.subscribe, openNow, closed)
  useEffect(linkSettingsSheet, [])
  return open ? <SoundSettingsSheet /> : null
}
