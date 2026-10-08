import type { UiTheme } from './types'

/** A keyframe's start and the interface theme from it on (scene.json `dayNight`, S04g). */
export interface UiScheduleEntry {
  readonly atMinute: number
  readonly ui: UiTheme
}

/** What the HUD island needs to switch the interface with the game clock. */
export interface UiThemeClock {
  /** In clock order (scene.json keyframe order). */
  readonly schedule: readonly UiScheduleEntry[]
  readonly crossFadeMs: number
  /** `<meta name="theme-color">` per theme. */
  readonly themeColor: Readonly<Record<UiTheme, string>>
}

/**
 * The interface theme at a minute of day: the last keyframe reached, wrapping past midnight.
 * Equals `uiThemeAt` (the scene's own keyframe lookup) without the keyframe model, so the HUD
 * island carries a few numbers instead of the day/night module and its colours.
 */
export function uiThemeFor(minuteOfDay: number, schedule: readonly UiScheduleEntry[]): UiTheme {
  const last = schedule[schedule.length - 1]
  if (last === undefined) return 'day'
  let current = last
  for (const entry of schedule) {
    if (entry.atMinute <= minuteOfDay) current = entry
  }
  return current.ui
}
