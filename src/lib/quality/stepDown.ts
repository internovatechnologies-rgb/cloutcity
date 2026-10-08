/**
 * Runtime FPS step-down rules (S04b, CLAUDE.md: one tier down when average FPS stays below the
 * floor for `sustainMs`, with hysteresis). The scene's TierMonitor feeds drei
 * PerformanceMonitor's incline/decline events through {@link stepDecision}; the store applies the
 * result. Pure: time and state are passed in.
 *
 * The scene renders on demand (`frameloop="demand"`), so frames arrive only while something
 * moves. PerformanceMonitor measures FPS as frames over wall time, so a sample spanning an idle
 * gap reads as a very low FPS. A decline therefore counts only when the scene has rendered
 * continuously for the whole measurement window.
 */
import type { FpsStepDown, QualityTier } from '@/lib/data/schemas/config'
import { TIER_ORDER } from './tier'

/** The tier one below `tier`; low stays low. */
export function lower(tier: QualityTier): QualityTier {
  return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(tier) - 1)] ?? 'low'
}

export interface StepInput {
  /** The PerformanceMonitor event. */
  readonly event: 'decline' | 'incline'
  readonly nowMs: number
  /**
   * When the current unbroken stretch of continuous rendering began, or null when the scene is
   * not rendering continuously now.
   */
  readonly continuousSinceMs: number | null
  /** When the last step-down this session happened, or null. */
  readonly lastStepAtMs: number | null
  /** Step-downs so far this session. */
  readonly steps: number
  /** The tier in use now. */
  readonly active: QualityTier
  /** The player chose a tier in settings: automatic changes stop. */
  readonly overrideActive: boolean
  /** A data-saver request already forces low. */
  readonly dataSaver: boolean
}

export type StepIgnoreReason =
  'incline' | 'override' | 'data-saver' | 'gap' | 'cooldown' | 'max-steps' | 'at-low'

export type StepDecision =
  | { readonly action: 'step-down'; readonly to: QualityTier }
  | { readonly action: 'ignore'; readonly reason: StepIgnoreReason }

/** Whether a PerformanceMonitor event steps the tier down. Never steps up (no auto-upgrade). */
export function stepDecision(input: StepInput, cfg: FpsStepDown): StepDecision {
  const ignore = (reason: StepIgnoreReason): StepDecision => ({ action: 'ignore', reason })
  if (input.event === 'incline') return ignore('incline')
  if (input.overrideActive) return ignore('override')
  if (input.dataSaver) return ignore('data-saver')
  if (input.continuousSinceMs === null || input.nowMs - input.continuousSinceMs < cfg.sustainMs) {
    return ignore('gap')
  }
  if (input.lastStepAtMs !== null && input.nowMs - input.lastStepAtMs < cfg.cooldownMs) {
    return ignore('cooldown')
  }
  if (input.steps >= cfg.maxSteps) return ignore('max-steps')
  if (input.active === 'low') return ignore('at-low')
  return { action: 'step-down', to: lower(input.active) }
}

export interface ActiveTierInput {
  /** The picker's tier for this device. */
  readonly auto: QualityTier
  /** Step-downs this session. */
  readonly steps: number
  /** The tier chosen in settings, or null for automatic. */
  readonly override: QualityTier | null
  readonly dataSaver: boolean
}

/**
 * The tier in use: a data-saver request forces low, even over a settings choice; then the
 * settings choice; else the picked tier lowered once per step-down.
 */
export function resolveActive(input: ActiveTierInput): QualityTier {
  if (input.dataSaver) return 'low'
  if (input.override !== null) return input.override
  let tier = input.auto
  for (let step = 0; step < input.steps; step += 1) tier = lower(tier)
  return tier
}
