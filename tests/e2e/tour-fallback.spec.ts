import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { NO_WEBGL_WARNING, placesPanel } from './helpers/fallback'
import {
  expectRinged,
  expectStep,
  money,
  targetAction,
  walkToTarget,
  targetRow,
  tourCard,
  tourNext,
} from './helpers/tour'

// S06, A11Y-3: without WebGL the game is played through the Places panel, and so is the tour.
// The panel the app opened by itself already shows the place, so the tour goes from the HUD
// straight to picking it, and the guided purchase works with no 3D map at all.

test.use({ tour: 'fresh', expectedConsole: [NO_WEBGL_WARNING] })

test('without WebGL the tour leads through the auto-opened Places panel', async ({
  page,
  checkA11y,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (/webgl/i.test(type)) return null
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest)
    } as typeof HTMLCanvasElement.prototype.getContext
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'error')
  await expect(placesPanel(page)).toBeVisible()

  // A failed map is still a playable one: the tour starts.
  await expectStep(page, 'hud')
  await expect(tourCard(page)).toBeVisible()
  await checkA11y()
  await tourNext(page).click()
  await expectStep(page, 'pick')
  await expectRinged(targetRow(page))
  await targetRow(page).click()
  // Without WebGL the trip lands at once (no animation to watch).
  await walkToTarget(page)
  await targetAction(page).click()
  await expectStep(page, 'cash')
  await expect(money(page)).toHaveText('$140')
})
