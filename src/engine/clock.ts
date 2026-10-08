/**
 * The personal game clock: a whole number of game minutes since the start of game day 1
 * (minute 0 is day 1, 00:00). Passive time advances it only while the tab is visible; actions
 * fast-forward it by their duration (src/engine/game.ts).
 *
 * The engine never reads the real clock. The caller measures real elapsed time and passes it in.
 * Real time that has not yet added up to a whole game minute is carried in `remainderMs`, so
 * many short ticks advance the clock exactly as far as one long one. The carry is done in
 * whole microseconds (each tick's elapsed time is rounded to the nearest microsecond), so
 * repeated fractional ticks never drift below a minute boundary through float error.
 */
import type { EngineConfig } from './config'

export interface ClockState {
  /** Whole game minutes since day 1, 00:00. */
  readonly minute: number
  /** Speed-scaled real milliseconds not yet worth a whole game minute (0 <= x < one minute). */
  readonly remainderMs: number
}

export interface TickOptions {
  /** False while the tab is hidden: the clock pauses. */
  readonly visible: boolean
  /** Passive speed multiplier; must be one of `time.speeds` (1x/2x). */
  readonly speed: number
}

/** Calendar view of a personal clock minute. Days and weeks are 1-based for display. */
export interface GameCalendar {
  readonly day: number
  readonly week: number
  /** 1..rentPeriodGameDays: the day within the current rent week. */
  readonly dayOfWeek: number
  readonly hour: number
  readonly minuteOfHour: number
  readonly minuteOfDay: number
}

export interface Rollovers {
  /** Game day boundaries (midnights) crossed. */
  readonly days: number
  /** Rent week boundaries crossed (every `rentPeriodGameDays` days). */
  readonly weeks: number
}

const MINUTES_PER_HOUR = 60
const REAL_MS_PER_MINUTE = 60_000
const US_PER_MS = 1000

export function minutesPerDay(config: EngineConfig): number {
  return config.time.gameDayHours * MINUTES_PER_HOUR
}

/** Real milliseconds of visible play, at 1x, per game minute (6000 ms at 10 game min / real min). */
export function realMsPerGameMinute(config: EngineConfig): number {
  return REAL_MS_PER_MINUTE / config.time.gameMinutesPerRealMinute
}

export function initialClock(config: EngineConfig): ClockState {
  return { minute: config.time.startMinuteOfDay, remainderMs: 0 }
}

export function isSpeed(speed: number, config: EngineConfig): boolean {
  return config.time.speeds.includes(speed)
}

/**
 * Passive time. Returns the advanced clock and how many whole game minutes passed.
 * Hidden tabs do not advance (and keep their remainder). A gap longer than `maxTickRealMs`
 * counts as `maxTickRealMs`, so a frozen or sleeping tab cannot skip hours on wake.
 */
export function tickClock(
  clock: ClockState,
  realElapsedMs: number,
  options: TickOptions,
  config: EngineConfig,
): { clock: ClockState; minutes: number } {
  if (!Number.isFinite(realElapsedMs) || realElapsedMs < 0) {
    throw new RangeError(`realElapsedMs must be a finite, non-negative number: ${realElapsedMs}`)
  }
  if (!isSpeed(options.speed, config)) {
    throw new RangeError(`Unsupported clock speed: ${options.speed}`)
  }
  if (!options.visible || realElapsedMs === 0) return { clock, minutes: 0 }

  const perMinuteUs = Math.round(realMsPerGameMinute(config) * US_PER_MS)
  const elapsedUs = Math.round(Math.min(realElapsedMs, config.time.maxTickRealMs) * US_PER_MS)
  const scaledUs = Math.round(clock.remainderMs * US_PER_MS) + elapsedUs * options.speed
  const minutes = Math.floor(scaledUs / perMinuteUs)
  return {
    clock: {
      minute: clock.minute + minutes,
      remainderMs: (scaledUs - minutes * perMinuteUs) / US_PER_MS,
    },
    minutes,
  }
}

/** Moves the clock forward by whole game minutes (an action's duration). */
export function fastForward(clock: ClockState, minutes: number): ClockState {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`minutes must be a non-negative integer: ${minutes}`)
  }
  return { minute: clock.minute + minutes, remainderMs: clock.remainderMs }
}

export function calendar(minute: number, config: EngineConfig): GameCalendar {
  const perDay = minutesPerDay(config)
  const dayIndex = Math.floor(minute / perDay)
  const minuteOfDay = minute - dayIndex * perDay
  const period = config.time.rentPeriodGameDays
  return {
    day: dayIndex + 1,
    week: Math.floor(dayIndex / period) + 1,
    dayOfWeek: (dayIndex % period) + 1,
    hour: Math.floor(minuteOfDay / MINUTES_PER_HOUR),
    minuteOfHour: minuteOfDay % MINUTES_PER_HOUR,
    minuteOfDay,
  }
}

/** Day and week boundaries crossed moving from `fromMinute` to `toMinute` (to >= from). */
export function rollovers(fromMinute: number, toMinute: number, config: EngineConfig): Rollovers {
  const from = calendar(fromMinute, config)
  const to = calendar(toMinute, config)
  return { days: to.day - from.day, weeks: to.week - from.week }
}
