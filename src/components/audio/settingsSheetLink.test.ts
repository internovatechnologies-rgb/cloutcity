import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hudPanelStore, openHudPanel } from '@/state/hudPanel'
import { openPlace, placeSheetStore } from '@/state/placeSheet'
import {
  autoOpenPlacesPanel,
  openPlacesPanel,
  placesPanelShown,
  placesPanelStore,
} from '@/state/placesPanel'
import { linkSettingsSheet } from './SoundSheetMount'
import { setSoundSheetOpen, soundSheetStore } from './soundSheet'

// DEC-21: the Settings sheet shares the sheet zone one sheet at a time.

let unlink: () => void = () => undefined
const settingsOpen = () => soundSheetStore.getState().open

beforeEach(() => {
  soundSheetStore.setState({ open: false })
  hudPanelStore.setState({ panel: null })
  placesPanelStore.setState({ open: false, mode: 'list', chooserIds: [], auto: false })
  placeSheetStore.setState({ placeId: null, origin: null })
  unlink = linkSettingsSheet()
})

afterEach(() => unlink())

describe('Settings and the other sheets, one at a time', () => {
  it('another sheet opening closes Settings', () => {
    for (const open of [
      () => openHudPanel('inventory'),
      () => openPlacesPanel(),
      () => openPlace('late-lantern-deli', { origin: 'panel' }),
    ]) {
      setSoundSheetOpen(true)
      open()
      expect(settingsOpen()).toBe(false)
    }
  })

  it('Settings opening closes a HUD panel, the Places panel and a place sheet', () => {
    openHudPanel('rent')
    setSoundSheetOpen(true)
    expect(hudPanelStore.getState().panel).toBeNull()

    setSoundSheetOpen(false)
    openPlacesPanel()
    setSoundSheetOpen(true)
    expect(placesPanelStore.getState().open).toBe(false)

    setSoundSheetOpen(false)
    openPlace('late-lantern-deli', { origin: 'map' })
    setSoundSheetOpen(true)
    expect(placeSheetStore.getState().placeId).toBeNull()
  })

  it('an automatically opened Places panel waits behind Settings and shows again after', () => {
    autoOpenPlacesPanel()
    setSoundSheetOpen(true)
    const panel = placesPanelStore.getState()
    expect(panel.open).toBe(true)
    expect(placesPanelShown(panel, null, null, true)).toBe(false)
    expect(placesPanelShown(panel, null, null, false)).toBe(true)
    expect(settingsOpen()).toBe(true)
  })
})
