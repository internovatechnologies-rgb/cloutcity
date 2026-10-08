/**
 * Shared steps of the `npm run e2e:perf` specs (S04b): the perf config, a returning player's
 * storage (welcome card passed, a chosen quality tier), reading the app's User Timing marks
 * (src/lib/perfMarks.ts), medians, and the run report (test-results/perf/report.json).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { PerfConfigSchema, type QualityTier } from '@/lib/data/schemas/config'
import { PLAYABLE_MARK, SCENE_MARKS, SHELL_INTERACTIVE_MARK } from '@/lib/perfMarks'
import { QUALITY_KEY, QUALITY_VERSION } from '@/state/quality'
import { ONBOARDING_KEY, completedOnboardingSeed } from '../e2e/fixtures/onboarding-seed'

const ROOT = join(import.meta.dirname, '../..')

export const perf = PerfConfigSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'data/config/perf.json'), 'utf8')),
)
// PerfConfigSchema checks that perfRun.profile names a throttle profile.
export const profile = perf.throttleProfiles[perf.perfRun.profile as 'cc-mid-4g']

export const REPORT_PATH = join(ROOT, 'test-results/perf/report.json')

/**
 * Seeds a returning player before the page loads: the welcome card passed, and the graphics
 * setting `tier` (headless Chromium renders on SwiftShader, which the picker always puts on
 * the low tier, so every other tier is measured through the settings override).
 */
export async function seedPlayer(page: Page, tier: QualityTier): Promise<void> {
  await page.addInitScript(
    (entries) => {
      for (const [key, value] of entries) localStorage.setItem(key, value)
    },
    [
      [ONBOARDING_KEY, JSON.stringify(completedOnboardingSeed())],
      [QUALITY_KEY, JSON.stringify({ state: { override: tier }, version: QUALITY_VERSION })],
    ] as const,
  )
}

/** One page load's marks, in milliseconds since navigation start. */
export interface LoadTimings {
  readonly shellInteractiveMs: number
  readonly playableMs: number
  /** The 3D start-up steps (PERF-4) that were reached. */
  readonly scene: Readonly<Record<string, number>>
}

/** Waits for `cc:playable` (no timeout of its own: the test's timeout bounds it). */
export async function waitForPlayable(page: Page): Promise<LoadTimings> {
  await page.waitForFunction(
    (name) => performance.getEntriesByName(name, 'mark').length > 0,
    PLAYABLE_MARK,
    { polling: 100, timeout: 0 },
  )
  const marks = await page.evaluate(
    (names) =>
      Object.fromEntries(
        names.flatMap((name) => {
          const entry = performance.getEntriesByName(name, 'mark')[0]
          return entry === undefined ? [] : [[name, Math.round(entry.startTime)]]
        }),
      ),
    [SHELL_INTERACTIVE_MARK, PLAYABLE_MARK, ...SCENE_MARKS],
  )
  const shellInteractiveMs = marks[SHELL_INTERACTIVE_MARK]
  const playableMs = marks[PLAYABLE_MARK]
  if (shellInteractiveMs === undefined || playableMs === undefined) {
    throw new Error(`missing load marks: ${JSON.stringify(marks)}`)
  }
  const scene: Record<string, number> = {}
  for (const name of SCENE_MARKS) {
    const value = marks[name]
    if (value !== undefined) scene[name] = value
  }
  return { shellInteractiveMs, playableMs, scene }
}

/** The median of an odd-length list (perfRun.coldRuns is odd). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('no values')
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/** The per-step median of several loads' scene marks. */
export function medianMarks(runs: readonly LoadTimings[]): Record<string, number> {
  return Object.fromEntries(
    SCENE_MARKS.flatMap((name) => {
      const values = runs.flatMap((run) => {
        const value = run.scene[name]
        return value === undefined ? [] : [value]
      })
      return values.length === runs.length ? [[name, median(values)]] : []
    }),
  )
}

/** Merges one spec's section into the report (the specs run one at a time, in one worker). */
export function writeReport(section: string, data: unknown): void {
  let report: Record<string, unknown> = {}
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    report = {}
  }
  report[section] = { ...(data as object), measuredAt: new Date().toISOString() }
  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
}
