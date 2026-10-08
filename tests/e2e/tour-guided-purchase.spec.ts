import { expect, test } from './fixtures/test'
import { passWelcomeCard, welcomeDialog } from './fixtures/welcome'
import { placesPanel } from './helpers/fallback'
import { moreButton } from './helpers/hud'
import { copyText, placeName } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'
import {
  expectNotRinged,
  expectRinged,
  expectStep,
  money,
  placesButton,
  storedTour,
  targetAction,
  targetWalk,
  walkToTarget,
  targetRow,
  targetSheet,
  tourCard,
  tourConfig,
  tourDone,
  tourNext,
  tourSkip,
} from './helpers/tour'

// S06: a brand-new player passes the welcome card and the tour walks them over the live map to
// a first bodega purchase near their Queens start: coach marks only (no tutorial screens), at
// most six steps, no further gate or age check, and every step moves on what the player does.

test.use({ onboarding: 'fresh', tour: 'fresh' })

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('a new player is led from the welcome card to a first purchase', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/')
  // The tour waits behind the welcome card.
  await expect(welcomeDialog(page)).toBeVisible()
  await expect(tourCard(page)).toHaveCount(0)
  await passWelcomeCard(page)
  await waitForMapSettled(page)

  // From here on, no other gate, age check or modal ever shows.
  const modals = page.locator('[aria-modal="true"]')

  // 1. The HUD: a coach mark, not a screen. The map and HUD stay usable; nothing is inert.
  await expectStep(page, 'hud')
  await expect(tourCard(page)).toContainText('1/6')
  await expect(tourCard(page).getByRole('status')).toHaveText(copyText('tour.step.hud'))
  await expectRinged(page.locator('[data-hud]'))
  await expect(page.locator('[inert]')).toHaveCount(0)
  await expect(modals).toHaveCount(0)
  await expect(tourSkip(page)).toBeVisible()
  await checkA11y()
  await tourNext(page).click()

  // 2. Find: the Places button is ringed; the step has no Next, opening Places moves it on.
  await expectStep(page, 'find')
  await expect(tourNext(page)).toHaveCount(0)
  await expectRinged(placesButton(page))
  await expectNotRinged(page.locator('[data-hud]'))
  await placesButton(page).click()

  // 3. Pick: the place is ringed in the Places panel.
  await expectStep(page, 'pick')
  await expect(tourCard(page).getByRole('status')).toHaveText(
    copyText('tour.step.pick', { place: placeName(tourConfig.placeId) }),
  )
  await expectRinged(targetRow(page))
  await targetRow(page).click()

  // 4. Buy: away from the place (S08) the step rings "Walk there" first, with the copy built
  // from that button's own label; on arrival, in the same step, the action is ringed.
  await expectStep(page, 'buy')
  await expect(targetSheet(page)).toBeVisible()
  await expectRinged(targetWalk(page))
  await expect(tourCard(page).getByRole('status')).toHaveText(
    copyText('tour.step.buyAway', {
      walk: copyText('travel.mode.walk.action'),
      action: copyText('place.actions.bodegaBreakfast.name'),
    }),
  )
  await checkA11y()
  await walkToTarget(page)
  await expectRinged(targetAction(page))
  // Once here the sheet shows "You're here" instead of the travel rows, so no ring is left behind.
  await expect(targetWalk(page)).toHaveCount(0)
  // Walking is free, and no random event greets an arrival during the tour.
  await expect(money(page)).toHaveText('$150')
  await expect(page.locator('[data-cc-feature="cc-feature:event-sheet"]')).toHaveCount(0)
  await targetAction(page).click()

  // 5. Cash: what the purchase did, with the shared money formatter, and the cash ringed.
  await expectStep(page, 'cash')
  await expect(money(page)).toHaveText('$140')
  await expect(tourCard(page).getByRole('status')).toHaveText(
    copyText('tour.step.cash', { before: '$150', after: '$140' }),
  )
  await expectRinged(page.locator('[data-hud-cell="money"]'))
  await tourNext(page).click()

  // 6. Done: where the tour lives now (More, Help).
  await expectStep(page, 'done')
  await expect(tourCard(page)).toContainText(`${tourConfig.maxSteps}/${tourConfig.maxSteps}`)
  await expectRinged(moreButton(page))
  await tourDone(page).click()
  // About 20 seconds for a player: src/lib/tourCopy.test.ts holds the reading-time model.

  await expect(tourCard(page)).toHaveCount(0)
  await expect(moreButton(page)).toBeFocused()
  await expectNotRinged(moreButton(page))
  await expect(modals).toHaveCount(0)
  await expect(welcomeDialog(page)).toHaveCount(0)
  expect(await storedTour(page)).toEqual({ state: { record: { status: 'done' } }, version: 1 })

  // A reload neither shows the welcome card nor the tour again.
  await page.reload()
  await waitForMapSettled(page)
  await expect(welcomeDialog(page)).toHaveCount(0)
  await expect(page.locator('[data-tour-step]')).toHaveCount(0)
  await expect(money(page)).toHaveText('$140')
})

test('a reload mid-tour picks up on the step that fits the screen', async ({ page }) => {
  await page.goto('/')
  await passWelcomeCard(page)
  await waitForMapSettled(page)
  await tourNext(page).click()
  await placesButton(page).click()
  await expectStep(page, 'pick')

  await page.reload()
  await waitForMapSettled(page)
  // The Places panel does not survive a reload, so the tour is back on finding it.
  await expectStep(page, 'find')
  await expect(placesPanel(page)).toHaveCount(0)
})
