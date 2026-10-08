import { WEBGL_LAUNCH_ARGS } from '../../playwright.config'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import {
  completePlaceSelection,
  expectFallbackAndPanel,
  NO_WEBGL_WARNING,
} from './helpers/fallback'

// S04c: a real WebGL-disabled browser (Chromium's --disable-3d-apis), not a stubbed getContext
// (places-fallback.spec.ts): the game stays playable through the Places panel. Its own file
// because launch options force a new worker, which Playwright allows only at the top level.

test.use({
  launchOptions: { args: [...WEBGL_LAUNCH_ARGS, '--disable-3d-apis'] },
  expectedConsole: [NO_WEBGL_WARNING],
})

test('with 3D APIs disabled, a place selection completes through the Places panel', async ({
  page,
}) => {
  await page.goto('/')
  await waitForWelcomeGate(page)
  await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'error')
  await expect(page.locator('canvas')).toHaveCount(0)
  await expectFallbackAndPanel(page, 'map.error.device')
  await completePlaceSelection(page, 'late-lantern-deli')
})
