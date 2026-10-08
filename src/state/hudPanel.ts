/**
 * Which HUD panel (inventory or rent, S10a; goals, S15; more, S05; home, S16; me, opened by the
 * Me tab, S18a; cloud, S18c) is open in the sheet zone. Session-only UI state, never persisted,
 * and deliberately tiny like placeSheet.ts: the shell imports it for the HUD buttons, and each
 * panel with its engine, data and copy loads only on first use (DEC-11).
 *
 * One sheet at a time: opening a panel closes any place sheet, and the panel mount closes the
 * panel when a place opens.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import { closePlace } from './placeSheet'

export const HUD_PANELS = ['inventory', 'rent', 'goals', 'more', 'home', 'me', 'cloud'] as const
export type HudPanel = (typeof HUD_PANELS)[number]

interface HudPanelState {
  readonly panel: HudPanel | null
}

export const hudPanelStore = createStore<HudPanelState>()(() => ({ panel: null }))

/** Opens a HUD panel, replacing any open panel or place sheet. */
export function openHudPanel(panel: HudPanel): void {
  closePlace()
  hudPanelStore.setState({ panel })
}

export function closeHudPanel(): void {
  hudPanelStore.setState({ panel: null })
}

const openPanel = () => hudPanelStore.getState().panel
const serverPanel = () => null

/** The open panel; null during the server render and hydration. */
export function useHudPanel(): HudPanel | null {
  return useSyncExternalStore(hudPanelStore.subscribe, openPanel, serverPanel)
}
