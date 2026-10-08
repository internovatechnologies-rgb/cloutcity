'use client'

/**
 * Whether the sound settings sheet is open, shared by the HUD's More panel, which opens it, and
 * the sheet zone that draws it.
 */
import { createStore } from 'zustand/vanilla'
import { HUD_MORE_SELECTOR, focusFirstVisible } from '@/components/overlay/focusVisible'

export const SOUND_SETTINGS_SHEET_ID = 'sound-settings'

export const soundSheetStore = createStore<{ readonly open: boolean }>()(() => ({ open: false }))

export function setSoundSheetOpen(open: boolean): void {
  soundSheetStore.setState({ open })
}

/** Closes the sheet and puts focus back on what opened it: the HUD's More button (S05, S06). */
export function closeSoundSheet(): void {
  setSoundSheetOpen(false)
  focusFirstVisible([HUD_MORE_SELECTOR, 'main'])
}
