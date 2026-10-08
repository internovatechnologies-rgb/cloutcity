/**
 * Which home the player lives in, for the 3D map (S05): the camera starts over it and the
 * avatar stands at it. Session-only and deliberately tiny like hudPanel.ts: the HUD's live
 * island (which holds the game store) writes it, and the 3D chunk reads it without pulling the
 * store, engine and catalogs into the scene chunk. Null until the HUD has read the save; the
 * scene uses the configured start home meanwhile.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import type { HomeIdLiteral } from '@/lib/data/homes'

interface PlayerHomeState {
  readonly home: HomeIdLiteral | null
}

export const playerHomeStore = createStore<PlayerHomeState>()(() => ({ home: null }))

export function setPlayerHome(home: HomeIdLiteral): void {
  if (playerHomeStore.getState().home !== home) playerHomeStore.setState({ home })
}

const homeNow = () => playerHomeStore.getState().home
const serverHome = () => null

/** The player's home, or null before the HUD has read the save (and on the server). */
export function usePlayerHome(): HomeIdLiteral | null {
  return useSyncExternalStore(playerHomeStore.subscribe, homeNow, serverHome)
}
