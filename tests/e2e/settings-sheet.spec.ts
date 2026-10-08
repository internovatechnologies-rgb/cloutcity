import type { Page } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { openFromHud } from './helpers/hud'
import { copyText } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'

// DEC-21: the Settings sheet shares the sheet zone one sheet at a time, like the HUD panels,
// the Places panel and the place sheet: whichever opens last is the one shown, with focus.

const settings = (page: Page) => page.getByRole('region', { name: 'Settings' })
const settingsTitle = (page: Page) => settings(page).getByRole('heading', { name: 'Settings' })
const placesPanel = (page: Page) =>
  page.getByRole('dialog', { name: copyText('places.panel.title'), exact: true })
const inventory = (page: Page) => page.getByRole('dialog', { name: 'Inventory' })

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await waitForWelcomeGate(page)
  await waitForMapSettled(page)
}

async function openSettings(page: Page): Promise<void> {
  await openFromHud(page, 'Settings')
  await expect(settingsTitle(page)).toBeFocused()
}

test.beforeEach(async ({ page }) => {
  await boot(page)
})

test('the Places panel, a place sheet or a HUD panel opening closes Settings', async ({ page }) => {
  await openSettings(page)
  await page.locator('[data-places-button]').click()
  await expect(settings(page)).toHaveCount(0)
  await expect(placesPanel(page).getByRole('heading', { level: 2 })).toBeFocused()

  // A place picked from the panel replaces it; Settings opening then closes the place sheet...
  const firstPlace = placesPanel(page).locator('[data-place-button]').first()
  await firstPlace.click()
  const placeSheet = page.locator('[data-cc-feature="cc-feature:place-sheet"]')
  await expect(placeSheet).toBeVisible()
  await openSettings(page)
  await expect(placeSheet).toHaveCount(0)

  // ...and a HUD panel opening closes Settings.
  await openFromHud(page, 'Inventory')
  await expect(settings(page)).toHaveCount(0)
  await expect(inventory(page)).toBeVisible()
})

test('Settings opening closes the Places panel and a HUD panel', async ({ page }) => {
  await page.locator('[data-places-button]').click()
  await expect(placesPanel(page)).toBeVisible()
  await openSettings(page)
  await expect(placesPanel(page)).toHaveCount(0)
  await expect(page.locator('[data-places-button]')).toHaveAttribute('aria-expanded', 'false')

  await openFromHud(page, 'Inventory')
  await expect(inventory(page)).toBeVisible()
  await openSettings(page)
  await expect(inventory(page)).toHaveCount(0)
  await expect(settings(page)).toBeVisible()
})
