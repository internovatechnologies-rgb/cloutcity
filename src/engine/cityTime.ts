/**
 * City time: the real New York wall clock, shared by every player (presence, live events,
 * chat reset, heartbeats). It is separate from each player's personal game clock and never
 * derived from it. The caller passes the current instant in; the engine never reads the clock.
 */
import { wallClockParts } from '@/lib/format'

export const CITY_TIME_ZONE = 'America/New_York'

export interface CityTime {
  readonly year: number
  /** 1-12 */
  readonly month: number
  readonly day: number
  /** 0-23 */
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number
  /** Minutes ahead of UTC: -300 in EST, -240 in EDT. */
  readonly utcOffsetMinutes: number
  /** New York calendar date `YYYY-MM-DD`, e.g. the key for a midnight reset. */
  readonly dateKey: string
}

const pad = (value: number, width: number) => String(value).padStart(width, '0')

export function cityTime(epochMs: number): CityTime {
  const wall = wallClockParts(epochMs, CITY_TIME_ZONE)
  return { ...wall, dateKey: `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}` }
}
