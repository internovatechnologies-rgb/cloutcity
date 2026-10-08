import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { moreButton, morePanel, openFromHud } from './helpers/hud'
import { waitForMapSettled } from './helpers/scene'
import {
  buyThroughPlaces,
  expectStep,
  money,
  storedTour,
  tourCard,
  tourDone,
  tourNext,
  tourSkip,
} from './helpers/tour'

// S06: the tour is skippable on every step and resumable from Help in the More panel, which
// shows at every width. A skip sticks across reloads; Help picks up where the player stopped,
// and replays the whole tour once it is done.

test.use({ tour: 'fresh' })

async function boot(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await waitForMapSettled(page)
  await expectStep(page, 'hud')
}

test('skip, then resume from Help where it stopped and finish the purchase', async ({ page }) => {
  await boot(page)
  await tourNext(page).click()
  await expectStep(page, 'find')

  await tourSkip(page).click()
  await expect(tourCard(page)).toHaveCount(0)
  // Focus goes to More, the way back in, instead of dropping to the page.
  await expect(moreButton(page)).toBeFocused()
  expect(await storedTour(page)).toEqual({
    state: { record: { status: 'skipped', step: 'find' } },
    version: 1,
  })

  // A skip sticks: the tour does not come back by itself.
  await page.reload()
  await waitForMapSettled(page)
  await expect(page.locator('[data-tour-step]')).toHaveCount(0)

  await openFromHud(page, 'Help: take the tour')
  await expect(morePanel(page)).toHaveCount(0)
  await expectStep(page, 'find')
  await buyThroughPlaces(page)
  await expect(money(page)).toHaveText('$140')
  await tourNext(page).click()
  await expectStep(page, 'done')
  await tourDone(page).click()
  await expect(tourCard(page)).toHaveCount(0)
})

test('skip on the first step, and Help replays a finished tour from the start', async ({
  page,
}) => {
  await boot(page)
  await tourSkip(page).click()
  await expect(tourCard(page)).toHaveCount(0)

  await openFromHud(page, 'Help: take the tour')
  await expectStep(page, 'hud')
  await tourNext(page).click()
  await buyThroughPlaces(page)
  await tourNext(page).click()
  await tourDone(page).click()
  await expect(tourCard(page)).toHaveCount(0)

  await openFromHud(page, 'Help: take the tour')
  await expectStep(page, 'hud')
})

test('Skip is keyboard reachable and named on every step it shows', async ({ page }) => {
  await boot(page)
  for (const step of ['hud', 'find'] as const) {
    await expectStep(page, step)
    await expect(tourSkip(page)).toBeVisible()
    if (step === 'hud') await tourNext(page).click()
  }
  await tourSkip(page).focus()
  await page.keyboard.press('Enter')
  await expect(tourCard(page)).toHaveCount(0)
  await expect(moreButton(page)).toBeFocused()
})
