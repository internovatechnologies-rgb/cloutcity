/**
 * The automatic quality tier (S04b, CLAUDE.md "Quality tiers"): low, mid or high from the device
 * signals the shell probes (src/lib/quality/probe.ts), with every threshold in
 * data/config/perf.json `tierPicker`. Pure: the signals and the config are passed in.
 *
 * A signal the browser does not expose is unknown (`null`) and neutral: it never makes a device
 * low and is skipped by the high checks. The renderer is the exception for high, since it is the
 * only signal that names the GPU: high needs a known renderer that matches a high pattern.
 */
import type { QualityTier, TierPicker } from '@/lib/data/schemas/config'

/** The tiers from lowest to highest (the order of perf.json's per-tier objects). */
export const TIER_ORDER = ['low', 'mid', 'high'] as const satisfies readonly QualityTier[]

export interface TierSignals {
  /** Whether a WebGL2 context could be created. */
  readonly webgl2: boolean
  /** The WebGL renderer string (unmasked where the browser masks it), or null when unknown. */
  readonly renderer: string | null
  /** `MAX_TEXTURE_SIZE` of the WebGL2 context. */
  readonly maxTextureSize: number | null
  /** `navigator.deviceMemory` in GB. */
  readonly deviceMemoryGb: number | null
  /** `navigator.hardwareConcurrency`. */
  readonly cores: number | null
  /** `navigator.connection.saveData` (the Save-Data request). */
  readonly saveData: boolean | null
  /** `(prefers-reduced-data: reduce)`. */
  readonly prefersReducedData: boolean | null
}

/** Why the picker chose its tier, in the order the checks ran. */
export type TierReason =
  | 'no-webgl2'
  | 'data-saver'
  | 'low-renderer'
  | 'low-max-texture-size'
  | 'low-device-memory'
  | 'low-cores'
  | 'high-capable'
  | 'default'

export interface TierPick {
  readonly tier: QualityTier
  readonly reasons: readonly TierReason[]
}

type NumericSignal = keyof TierPicker['lowBelow']

const LOW_SIGNALS: readonly (readonly [NumericSignal, TierReason])[] = [
  ['maxTextureSize', 'low-max-texture-size'],
  ['deviceMemoryGb', 'low-device-memory'],
  ['cores', 'low-cores'],
]

function matchesAny(renderer: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(renderer))
}

/** True when a Save-Data or prefers-reduced-data request is present (CLAUDE.md: forces low). */
export function dataSaverRequested(signals: Pick<TierSignals, 'saveData' | 'prefersReducedData'>) {
  return signals.saveData === true || signals.prefersReducedData === true
}

/**
 * Picks the tier. Checks run in order: no WebGL2, data saver, a low renderer, then any known
 * numeric signal below its low threshold (all of them are reported); then high when the renderer
 * matches a high pattern and every known numeric signal reaches its high threshold; else mid.
 */
export function pickTier(signals: TierSignals, cfg: TierPicker): TierPick {
  if (!signals.webgl2) return { tier: 'low', reasons: ['no-webgl2'] }
  if (dataSaverRequested(signals)) return { tier: 'low', reasons: ['data-saver'] }
  if (signals.renderer !== null && matchesAny(signals.renderer, cfg.lowRendererPatterns)) {
    return { tier: 'low', reasons: ['low-renderer'] }
  }

  const low = LOW_SIGNALS.filter(([signal]) => {
    const value = signals[signal]
    return value !== null && value < cfg.lowBelow[signal]
  }).map(([, reason]) => reason)
  if (low.length > 0) return { tier: 'low', reasons: low }

  const highRenderer =
    signals.renderer !== null && matchesAny(signals.renderer, cfg.highRendererPatterns)
  const highSignals = LOW_SIGNALS.every(([signal]) => {
    const value = signals[signal]
    return value === null || value >= cfg.highAtLeast[signal]
  })
  if (highRenderer && highSignals) return { tier: 'high', reasons: ['high-capable'] }
  return { tier: 'mid', reasons: ['default'] }
}
