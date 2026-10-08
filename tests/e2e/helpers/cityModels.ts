import type { Page } from '@playwright/test'
import type { QualityTier } from '@/lib/data/schemas/config'
import { QUALITY_KEY, QUALITY_VERSION } from '@/state/quality'
import { SCENE_READY_TIMEOUT_MS } from './scene'

/** Chooses a graphics tier before the page loads (headless Chromium is detected as low). */
export async function seedTier(page: Page, tier: QualityTier): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    QUALITY_KEY,
    JSON.stringify({ state: { override: tier }, version: QUALITY_VERSION }),
  ] as const)
}

export const buildingsState = (page: Page) =>
  page.evaluate(() => window.__cloutcityTest?.scene?.buildings() ?? null)

export const landmarksState = (page: Page) =>
  page.evaluate(() => window.__cloutcityTest?.scene?.landmarks() ?? null)

/**
 * Waits until the district buildings and landmark models that load after the map's first frame
 * (S04d, S07a) have finished, and on-demand rendering is idle again.
 */
export async function waitForCityModels(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const scene = window.__cloutcityTest?.scene
      const buildings = scene?.buildings()
      const landmarks = scene?.landmarks()
      return (
        buildings?.started === true &&
        !buildings.busy &&
        buildings.blocks.status !== 'loading' &&
        landmarks?.done === true &&
        scene?.pendingFrames() === 0
      )
    },
    null,
    { polling: 'raf', timeout: SCENE_READY_TIMEOUT_MS },
  )
}
