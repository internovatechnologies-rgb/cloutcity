/**
 * The personal game clock's minute of day, for the day/night cycle (S04f). Session-only and
 * deliberately tiny like playerHome.ts: the HUD's live island (which holds the game store)
 * writes it, and the 3D chunk and the theme read it without pulling the store, engine and
 * catalogs along. Null until the HUD has read the save (and on the server); readers show day
 * meanwhile.
 */
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'

interface DayClockState {
  readonly minuteOfDay: number | null
}

export const dayClockStore = createStore<DayClockState>()(() => ({ minuteOfDay: null }))

/** Records the minute of day (0–1439); a write of the same minute notifies no one. */
export function setMinuteOfDay(minuteOfDay: number): void {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 1440) {
    throw new Error(`dayClock: minute of day must be an integer in [0, 1440), got ${minuteOfDay}`)
  }
  if (dayClockStore.getState().minuteOfDay !== minuteOfDay) dayClockStore.setState({ minuteOfDay })
}

const minuteNow = () => dayClockStore.getState().minuteOfDay
const serverMinute = () => null

/** The game clock's minute of day, or null before the HUD has read the save (and on the server). */
export function useMinuteOfDay(): number | null {
  return useSyncExternalStore(dayClockStore.subscribe, minuteNow, serverMinute)
}
