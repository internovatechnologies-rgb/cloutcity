import type { Locator, Page } from '@playwright/test'
import { expect } from '../fixtures/test'
import { copyText, placeName, readJson } from './places'

// S06: the first-run tour's coach marks in the banner zone. Specs that see it run with
// `test.use({ tour: 'fresh' })`.

export const tourConfig = readJson<{
  placeId: string
  actionId: string
  maxSteps: number
  newPlayerNoticeMax: number
  meaningfulNotices: string[]
}>('data/config/tour.json')

export const TOUR_KEY = 'cloutcity:tour'

export const tourCard = (page: Page): Locator =>
  page.locator('[data-overlay-zone="banner"]').getByRole('region', { name: copyText('tour.label') })

export async function expectStep(page: Page, step: string): Promise<void> {
  await expect(tourCard(page)).toHaveAttribute('data-tour-step', step)
}

/** The step's Next (or Done) button. */
export const tourNext = (page: Page): Locator =>
  tourCard(page).getByRole('button', { name: copyText('tour.next'), exact: true })
export const tourDone = (page: Page): Locator =>
  tourCard(page).getByRole('button', { name: copyText('tour.done'), exact: true })
export const tourSkip = (page: Page): Locator =>
  tourCard(page).getByRole('button', { name: copyText('tour.skipLabel'), exact: true })

/** The pink inset ring the step draws on its control (static under reduced motion). */
export async function expectRinged(locator: Locator): Promise<void> {
  await expect(locator).toHaveCSS('box-shadow', /inset/)
}

export async function expectNotRinged(locator: Locator): Promise<void> {
  await expect(locator).not.toHaveCSS('box-shadow', /inset/)
}

export const placesButton = (page: Page): Locator =>
  page.locator('[data-overlay-zone="hud"]').getByRole('button', { name: copyText('nav.places') })

export const targetRow = (page: Page): Locator =>
  page.locator(`[data-place-button="${tourConfig.placeId}"]`)

export const targetSheet = (page: Page): Locator =>
  page.getByRole('dialog', { name: placeName(tourConfig.placeId) })

export const targetAction = (page: Page): Locator =>
  targetSheet(page).locator(`[data-place-action="${tourConfig.actionId}"]`)

/** The target sheet's "Walk there" row (S08: a new player starts at home). */
export const targetWalk = (page: Page): Locator =>
  targetSheet(page).locator('[data-trip-mode="walk"]')

/**
 * The purchase step's first half (S08): walk to the place from its sheet and land there. The
 * trip is in the save as soon as it starts; the hook lands its animation at once.
 */
export async function walkToTarget(page: Page): Promise<void> {
  await expectStep(page, 'buy')
  await expect(targetWalk(page)).toBeEnabled()
  await targetWalk(page).click()
  await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
  await expect(
    page.locator(`[data-place-sheet="${tourConfig.placeId}"][data-player-here]`),
  ).toBeVisible()
  // Still the same step: the purchase is the way on.
  await expectStep(page, 'buy')
}

export const money = (page: Page): Locator =>
  page.locator('[data-overlay-zone="hud"] [data-hud-value="money"]')

/** The stored tour envelope, or null. */
export async function storedTour(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  }, TOUR_KEY)
}

/** Walks from the find step to the purchase through the Places panel, the DOM path (A11Y-3). */
export async function buyThroughPlaces(page: Page): Promise<void> {
  await expectStep(page, 'find')
  await placesButton(page).click()
  await expectStep(page, 'pick')
  await targetRow(page).click()
  await walkToTarget(page)
  await targetAction(page).click()
  await expectStep(page, 'cash')
}
