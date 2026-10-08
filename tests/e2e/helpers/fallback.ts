import type { Page } from '@playwright/test'
import { expect, type ExpectedConsoleMessage } from '../fixtures/test'
import { copyText, placeName } from './places'

// S04c: shared steps of the no-WebGL and lost-context specs.

/** The one warning a device without WebGL logs (src/scene/SceneErrorBoundary.tsx). */
export const NO_WEBGL_WARNING: ExpectedConsoleMessage = {
  type: 'warning',
  text: /^\{"level":"warn","msg":"3D scene failed to start; showing the static map background","time":"[^"]+","correlationId":"[^"]+","context":\{"reason":"no-webgl"\}\}$/,
  count: 1,
}

export const placesPanel = (page: Page) =>
  page.getByRole('dialog', { name: copyText('places.panel.title'), exact: true })

export async function expectFallbackAndPanel(page: Page, statusKey: string): Promise<void> {
  await expect(page.getByRole('img', { name: copyText('map.fallback') })).toBeVisible()
  await expect(page.locator('[data-scene-fallback]')).toHaveCSS(
    'background-image',
    /\/geo\/fallback\?v=[0-9a-f]{12}/,
  )
  await expect(page.getByRole('status').filter({ hasText: copyText(statusKey) })).toBeVisible()
  const dialog = placesPanel(page)
  await expect(dialog).toBeVisible()
  // Opened by the app, not the player: focus stays where it was.
  expect(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    'the auto-opened panel must not take focus',
  ).toBe(false)
}

/** Picks a place from the panel and checks the sheet and the announcement. */
export async function completePlaceSelection(page: Page, id: string): Promise<void> {
  await placesPanel(page).locator(`[data-place-button="${id}"]`).click()
  const sheet = page.locator(`[data-place-sheet="${id}"]`)
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('heading', { name: placeName(id) })).toBeVisible()
  await expect(page.locator('[data-place-announcer]')).toHaveText(
    copyText('places.announce.opened', { place: placeName(id) }),
  )
  // An action runs: the place is playable without the 3D map.
  const action = sheet.locator('button[data-place-action]:enabled').first()
  if ((await action.count()) > 0) await action.click()
  await sheet
    .getByRole('button', { name: copyText('place.sheet.closeLabel', { place: placeName(id) }) })
    .click()
  await expect(sheet).toHaveCount(0)
  // Back to the panel, with focus on the place picked.
  await expect(placesPanel(page).locator(`[data-place-button="${id}"]`)).toBeFocused()
}
