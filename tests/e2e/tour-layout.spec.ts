import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { holdGameTime, waitForHudLoaded } from './helpers/hud'
import { hideSceneForScreenshot, waitForMapSettled } from './helpers/scene'
import { buyThroughPlaces, expectStep, tourCard, tourNext } from './helpers/tour'

// S06, UX-1: the tour's coach marks live in the banner zone, never over the HUD, toasts, sheets
// or tab bar, at a phone, a desktop, a short phone and a landscape phone. Every step's text fits
// without clipping, every button is a 44 px target, and nothing behind it turns inert.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 390, height: 600 },
  { width: 844, height: 390 },
] as const

test.use({ tour: 'fresh' })

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error(`${name} is not rendered`)
  return box
}

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5

/** The card sits inside the banner zone, its text is not clipped and its buttons are 44 px. */
async function expectFits(page: Page, step: string) {
  await expectStep(page, step)
  const banner = await boxOf(page.locator('[data-overlay-zone="banner"]'), 'banner zone')
  const hud = await boxOf(page.locator('[data-overlay-zone="hud"]'), 'HUD zone')
  const card = await boxOf(tourCard(page), 'tour card')
  expect(inside(card, banner), `${step}: card inside the banner zone`).toBe(true)
  expect(card.y + card.height, `${step}: card above the HUD`).toBeLessThanOrEqual(hud.y + 0.5)
  const text = tourCard(page).getByRole('status')
  const clipped = await text.evaluate((element) => element.scrollHeight > element.clientHeight + 1)
  expect(clipped, `${step}: text clipped`).toBe(false)
  for (const button of await tourCard(page).getByRole('button').all()) {
    const box = await boxOf(button, `${step} button`)
    expect(box.width, `${step}: button width`).toBeGreaterThanOrEqual(44)
    expect(box.height, `${step}: button height`).toBeGreaterThanOrEqual(44)
    expect(inside(box, banner), `${step}: button inside the banner zone`).toBe(true)
  }
}

for (const viewport of VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`

  test.describe(`tour at ${label}`, () => {
    test.use({ viewport })

    test('every step fits the banner zone and nothing behind it is inert', async ({
      page,
      checkA11y,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await holdGameTime(page)
      await page.goto('/')
      await waitForMapSettled(page)
      await waitForHudLoaded(page)

      await expectFits(page, 'hud')
      await expect(page.locator('[inert]')).toHaveCount(0)
      await checkA11y()
      await tourNext(page).click()
      await expectFits(page, 'find')
      await buyThroughPlaces(page)
      await expectFits(page, 'cash')
      await tourNext(page).click()
      await expectFits(page, 'done')
      await checkA11y()

      await hideSceneForScreenshot(page)
      await expect(page.locator('[data-overlay-zone="banner"]')).toHaveScreenshot(
        `tour-banner-${label}.png`,
      )
    })
  })
}

test.describe('tour at 568x320 (a very short phone)', () => {
  test.use({ viewport: { width: 568, height: 320 } })

  test('the banner keeps its full height, so the buttons are not clipped (UI-8)', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await holdGameTime(page)
    await page.goto('/')
    await waitForMapSettled(page)
    await waitForHudLoaded(page)
    await expectFits(page, 'hud')
    const banner = await boxOf(page.locator('[data-overlay-zone="banner"]'), 'banner zone')
    expect(banner.height).toBeGreaterThanOrEqual(48 - 0.5)
    await tourNext(page).click()
    await expectFits(page, 'find')
  })
})

test('the ring pulses only when motion is welcome', async ({ page }) => {
  await page.goto('/')
  await waitForMapSettled(page)
  await expectStep(page, 'hud')
  const hud = page.locator('[data-hud]')
  await expect(hud).toHaveCSS('animation-name', 'cc-tour-pulse')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(hud).toHaveCSS('animation-name', 'none')
  await expect(hud).toHaveCSS('box-shadow', /inset/)
})
