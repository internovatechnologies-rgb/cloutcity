import type { Page } from '@playwright/test'

/**
 * The lazy 3D map (S04a) draws behind every overlay and is still loading or already drawn
 * depending on timing, so overlay screenshots hide its canvas and loading status: those
 * baselines cover the overlay layout (static background and map attribution included), not the
 * map, which city-scene.spec.ts covers through its test hook. The apartment's canvas (S16) is
 * hidden the same way; home-apartment.spec.ts covers it through its own hook.
 */
export async function hideSceneForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '[data-scene-root] canvas, [data-scene-root] [role="status"], [data-scene-slot] canvas { visibility: hidden !important; }',
  })
}

/** How long the 3D map may take to start in headless Chromium (city-scene.spec.ts). */
export const SCENE_READY_TIMEOUT_MS = 30_000

/**
 * Waits until the 3D map has finished starting (drawn, or failed) and on-demand rendering is
 * idle. In headless Chromium WebGL runs on the CPU (SwiftShader), so starting the map keeps the
 * main thread busy for seconds; a spec that times another feature's UI calls this first, so it
 * measures that feature rather than the map's start-up. The map still starts in every spec.
 */
export async function waitForMapSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = document.querySelector('[data-scene-root]')?.getAttribute('data-scene-status')
      if (status === 'error') return true
      return status === 'ready' && window.__cloutcityTest?.scene?.pendingFrames() === 0
    },
    null,
    { polling: 'raf', timeout: SCENE_READY_TIMEOUT_MS },
  )
}
