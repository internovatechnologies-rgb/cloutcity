/**
 * The HUD's view model (S05): what the money, clock, speed and stat cells show, from the save.
 * Pure: no React, store or copy, so it is unit-tested directly and the HUD renders exactly what
 * it returns. Numbers go through the shared formatters (UX-2).
 */
import { calendar } from '@/engine/clock'
import type { EngineConfig } from '@/engine/config'
import { STAT_KEYS, type StatKey, type Stats } from '@/engine/stats'
import { formatGameTime, formatMoney } from '@/lib/format'

export interface HudStat {
  readonly id: StatKey
  /** Whole points, 0..max (stats may decay in fractions; the HUD shows whole points). */
  readonly value: number
  readonly max: number
}

export interface HudView {
  /** "$150". */
  readonly money: string
  /** 1-based game day. */
  readonly day: number
  /** "8:00 AM". */
  readonly time: string
  readonly speed: number
  /** The speed the speed button switches to next. */
  readonly nextSpeed: number
  readonly stats: readonly HudStat[]
}

export interface HudInput {
  readonly cash: number
  readonly minute: number
  readonly speed: number
  readonly stats: Stats
}

/** The speed after `speed` in `time.speeds`, wrapping round; the first one if it is unknown. */
export function nextSpeed(speed: number, speeds: readonly number[]): number {
  const index = speeds.indexOf(speed)
  const next = speeds[(index + 1) % speeds.length]
  if (next === undefined) throw new Error('time.speeds is empty')
  return next
}

/** The clock cell: the 1-based day and the time of day. */
export function clockView(minute: number, config: EngineConfig): { day: number; time: string } {
  const { day, minuteOfDay } = calendar(minute, config)
  return { day, time: formatGameTime(minuteOfDay) }
}

/** The stats cell: whole points, clamped to 0..max. */
export function statsView(stats: Stats, config: EngineConfig): readonly HudStat[] {
  const max = config.stats.max
  return STAT_KEYS.map((id) => ({
    id,
    value: Math.min(max, Math.max(0, Math.round(stats[id]))),
    max,
  }))
}

export function hudView(input: HudInput, config: EngineConfig): HudView {
  return {
    money: formatMoney(input.cash),
    ...clockView(input.minute, config),
    speed: input.speed,
    nextSpeed: nextSpeed(input.speed, config.time.speeds),
    stats: statsView(input.stats, config),
  }
}
