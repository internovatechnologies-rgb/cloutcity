/**
 * Player needs: energy, hunger and mood, whole points in 0..stats.max. Hunger is fullness
 * (high is fed, 0 is starving), so all three bars mean "higher is better" and all three decay.
 *
 * Decay is charged once per game hour boundary the personal clock crosses (each :00), so the
 * result depends only on the start and end minute, never on how the time was split into ticks
 * or actions.
 *
 * Penalties at zero (data/config/balance.json `stats.atZero`), checked at each hour boundary:
 * - a stat at 0 drains the others by `extraDecayPerGameHour` on top of normal decay
 *   (starving drains energy and mood; exhausted drains mood);
 * - a stat at 0 multiplies action durations by `durationMultiplier` (exhausted and miserable
 *   players are slower). Multipliers of several zero stats stack.
 */
import type { EngineConfig } from './config'

export const STAT_KEYS = ['energy', 'hunger', 'mood'] as const
export type StatKey = (typeof STAT_KEYS)[number]

export type Stats = Readonly<Record<StatKey, number>>
export type StatChanges = Readonly<Partial<Record<StatKey, number>>>

const MINUTES_PER_HOUR = 60

export function initialStats(config: EngineConfig): Stats {
  return { ...config.stats.start }
}

function clamp(value: number, config: EngineConfig): number {
  return Math.min(config.stats.max, Math.max(0, value))
}

/** Adds each change (negative to drain) and clamps to 0..stats.max. */
export function applyStatChanges(stats: Stats, changes: StatChanges, config: EngineConfig): Stats {
  return {
    energy: clamp(stats.energy + (changes.energy ?? 0), config),
    hunger: clamp(stats.hunger + (changes.hunger ?? 0), config),
    mood: clamp(stats.mood + (changes.mood ?? 0), config),
  }
}

/** One game hour of decay, including the penalties of any stat already at zero. */
export function decayOneHour(stats: Stats, config: EngineConfig): Stats {
  const drain: Record<StatKey, number> = { ...config.stats.decayPerGameHour }
  for (const zero of STAT_KEYS) {
    if (stats[zero] > 0) continue
    const extra = config.stats.atZero[zero].extraDecayPerGameHour
    for (const key of STAT_KEYS) drain[key] += extra[key] ?? 0
  }
  return applyStatChanges(
    stats,
    { energy: -drain.energy, hunger: -drain.hunger, mood: -drain.mood },
    config,
  )
}

/** Game hour boundaries (:00) strictly after `fromMinute`, up to and including `toMinute`. */
export function hoursCrossed(fromMinute: number, toMinute: number): number {
  return Math.floor(toMinute / MINUTES_PER_HOUR) - Math.floor(fromMinute / MINUTES_PER_HOUR)
}

/** Passive decay for the clock moving from `fromMinute` to `toMinute`. */
export function decayStats(
  stats: Stats,
  fromMinute: number,
  toMinute: number,
  config: EngineConfig,
): Stats {
  let next = stats
  const hours = hoursCrossed(fromMinute, toMinute)
  for (let hour = 0; hour < hours; hour++) {
    // Every stat at zero is a fixed point: further hours change nothing.
    if (STAT_KEYS.every((key) => next[key] === 0)) break
    next = decayOneHour(next, config)
  }
  return next
}

/** How much longer actions take given which stats are at zero (1 when none are). */
export function durationMultiplier(stats: Stats, config: EngineConfig): number {
  let multiplier = 1
  for (const key of STAT_KEYS) {
    if (stats[key] === 0) multiplier *= config.stats.atZero[key].durationMultiplier
  }
  return multiplier
}
