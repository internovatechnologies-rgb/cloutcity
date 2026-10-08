import type { Page } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { hitsCanvas, pinConfig, scenePins, type HookPin } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'
import {
  expectRinged,
  expectStep,
  money,
  targetAction,
  walkToTarget,
  targetSheet,
  tourConfig,
  tourNext,
} from './helpers/tour'

// S06: the map is the game, so the tour accepts the map path too: a tap on the place's 3D pin,
// on any step before the purchase, jumps straight to the purchase step.

test.use({ tour: 'fresh' })

async function boot(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
}

/** The target's pin, on screen and with no other pin close enough to make the tap ambiguous. */
function isolatedTarget(pins: readonly HookPin[]): { x: number; y: number } | null {
  const target = pins.find((pin) => pin.id === tourConfig.placeId)
  if (target?.screen == null) return null
  const { x, y } = target.screen
  const clear = pins.every(
    (pin) =>
      pin.id === target.id ||
      pin.screen === null ||
      Math.hypot(pin.screen.x - x, pin.screen.y - y) >
        pinConfig.hitRadiusPx + pinConfig.ambiguityPx + 4,
  )
  return clear ? { x, y } : null
}

test('a tap on the place pin skips to the purchase step', async ({ page }, testInfo) => {
  await boot(page)
  await expectStep(page, 'hud')

  // Fly the camera to the place the way the Places panel does, then close its sheet: the tour
  // follows the screen (purchase step while the sheet is open, back to finding it after).
  await page.evaluate((id) => window.__cloutcityPlaces?.open(id), tourConfig.placeId)
  await expectStep(page, 'buy')
  await page.evaluate(() => window.__cloutcityPlaces?.close())
  await expectStep(page, 'find')
  await waitForMapSettled(page)

  const point = isolatedTarget(await scenePins(page))
  expect(point, 'the target pin is on screen and isolated after the camera flight').not.toBeNull()
  if (point === null) return
  expect(await hitsCanvas(page, point)).toBe(true)

  if (testInfo.project.use.hasTouch) await page.touchscreen.tap(point.x, point.y)
  else await page.mouse.click(point.x, point.y)

  await expectStep(page, 'buy')
  await expect(targetSheet(page)).toBeVisible()
  await walkToTarget(page)
  await expectRinged(targetAction(page))
  await targetAction(page).click()
  await expectStep(page, 'cash')
  await expect(money(page)).toHaveText('$140')
  await tourNext(page).click()
  await expectStep(page, 'done')
})
