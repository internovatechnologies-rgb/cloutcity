import type { Page } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { boroughs, copyText, placeName, places, readJson } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'
import { openFromHud } from './helpers/hud'

// S04c: the Places panel, the DOM and keyboard path to every place on the map (A11Y-3). Names
// and lock reasons come from the copy files, so the spec follows copy and data changes.

const balance = readJson<{
  clout: { levels: { id: string }[] }
  boroughs: { brooklyn: { level: string }; manhattan: { level: string } }
}>('data/config/balance.json')

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
}

const placesButton = (page: Page) => page.locator('[data-places-button]')
const panel = (page: Page) =>
  page.getByRole('dialog', { name: copyText('places.panel.title'), exact: true })

test.describe('Places panel', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('lists every place by borough in data order, with lock reasons in their names', async ({
    page,
    checkA11y,
  }) => {
    const button = placesButton(page)
    await expect(button).toHaveAccessibleName(copyText('nav.places'))
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    const dialog = panel(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused()

    // Borough groups (h3) in boroughs.json order.
    const groupNames = boroughs.map((b) => copyText(b.nameKey))
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(groupNames)

    // Home first (S08: the way back from anywhere, and a new player is there), then every place,
    // each a native, enabled button, in data order within its borough.
    const buttons = dialog.locator('[data-place-button]')
    await expect(buttons).toHaveCount(places.length + 1)
    const expectedOrder = [
      'home',
      ...boroughs.flatMap((b) =>
        places.filter((place) => place.borough === b.id).map((place) => place.id),
      ),
    ]
    expect(
      await buttons.evaluateAll((els) => els.map((el) => el.getAttribute('data-place-button'))),
    ).toEqual(expectedOrder)
    expect(
      await buttons.evaluateAll((els) => els.filter((el) => (el as HTMLButtonElement).disabled)),
    ).toHaveLength(0)

    // A new player (Nobody): Queens is open, Brooklyn and Manhattan are locked, the Bronx and
    // Staten Island are expanding soon. Each name says why.
    const levelName = (id: string) =>
      copyText(`clout.levels.${id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}.name`)
    const current = levelName(balance.clout.levels[0]?.id ?? 'nobody')
    await expect(dialog.locator('[data-place-button="glowmatic"]')).toHaveAccessibleName(
      placeName('glowmatic'),
    )
    const home = copyText('travel.panel.home', { home: copyText('housing.queensRoom.name') })
    await expect(dialog.locator('[data-place-button="home"]')).toHaveAccessibleName(
      copyText('travel.panel.hereLabel', { name: home }),
    )
    await expect(dialog.locator('[data-place-button="home"]')).toHaveAttribute(
      'data-player-here',
      '',
    )
    for (const [id, borough, key] of [
      ['brooklyn-bridge', 'brooklyn', 'boroughs.brooklyn.locked'],
      ['times-square', 'manhattan', 'boroughs.manhattan.locked'],
    ] as const) {
      await expect(dialog.locator(`[data-place-button="${id}"]`)).toHaveAccessibleName(
        copyText('places.locked.label', {
          place: placeName(id),
          reason: copyText(key, { level: levelName(balance.boroughs[borough].level), current }),
        }),
      )
    }
    await expect(dialog.locator('[data-place-button="bronx-ballpark"]')).toHaveAccessibleName(
      copyText('places.locked.label', {
        place: placeName('bronx-ballpark'),
        reason: copyText('boroughs.bronx.teaser'),
      }),
    )
    await expect(dialog.locator('[data-place-button="staten-island-ferry"]')).toHaveAccessibleName(
      copyText('places.locked.label', {
        place: placeName('staten-island-ferry'),
        reason: copyText('boroughs.statenIsland.teaser'),
      }),
    )
    // Every target is a full-size tap target.
    const heights = await buttons.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    )
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44)
    await checkA11y()

    // The Places button toggles the panel closed.
    await button.click()
    await expect(dialog).toHaveCount(0)
  })

  test('is fully keyboard driven: open, pick, come back, close', async ({ page }) => {
    await placesButton(page).focus()
    await page.keyboard.press('Enter')
    const dialog = panel(page)
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused()

    // Tab through: the Close button, Home (S08), then the first borough's first place.
    await page.keyboard.press('Tab')
    await expect(
      dialog.getByRole('button', { name: copyText('places.panel.closeLabel') }),
    ).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.locator('[data-place-button="home"]')).toBeFocused()
    await page.keyboard.press('Tab')
    const first = places.find((place) => place.borough === boroughs[0]?.id)
    if (first === undefined) throw new Error('no place in the first borough')
    const firstButton = dialog.locator(`[data-place-button="${first.id}"]`)
    await expect(firstButton).toBeFocused()

    // Enter opens the same sheet a pin tap does; the panel steps aside and the pick is announced.
    await page.keyboard.press('Enter')
    const sheet = page.locator(`[data-place-sheet="${first.id}"]`)
    await expect(sheet).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-place-announcer]')).toHaveText(
      copyText('places.announce.opened', { place: placeName(first.id) }),
    )

    // Escape closes the sheet; the panel is back with focus on that place.
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(firstButton).toBeFocused()

    // Escape closes the panel and gives focus back to the Places button.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(placesButton(page)).toBeFocused()
  })

  test('a locked place stays enabled and its sheet explains the lock', async ({ page }) => {
    await placesButton(page).click()
    await panel(page).locator('[data-place-button="brickwave"]').click()
    const sheet = page.locator('[data-place-sheet="brickwave"]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(placeName('brickwave'))
  })

  test('shares the sheet zone with the HUD panels, one at a time', async ({ page }) => {
    await placesButton(page).click()
    await expect(panel(page)).toBeVisible()
    // On phones Rent is in the HUD's More panel (S05).
    await openFromHud(page, 'Rent')
    await expect(page.getByRole('dialog', { name: 'Rent' })).toBeVisible()
    await expect(panel(page)).toHaveCount(0)
    await placesButton(page).click()
    await expect(panel(page)).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Rent' })).toHaveCount(0)
  })

  test('the Places button brings the list back over a sheet opened from it', async ({ page }) => {
    const button = placesButton(page)
    await button.click()
    await panel(page).locator('[data-place-button="glowmatic"]').click()
    await expect(page.locator('[data-place-sheet="glowmatic"]')).toBeVisible()
    // The panel is hidden behind the sheet: the button says so, and a press shows the list.
    await expect(panel(page)).toBeHidden()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await button.click()
    await expect(page.locator('[data-place-sheet]')).toHaveCount(0)
    await expect(panel(page)).toBeVisible()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(panel(page).getByRole('heading', { level: 2 })).toBeFocused()
  })

  test('the Places button replaces an open place sheet with the list', async ({ page }) => {
    await page.evaluate(() => window.__cloutcityPlaces?.open('glowmatic'))
    await expect(page.locator('[data-place-sheet="glowmatic"]')).toBeVisible()
    await placesButton(page).click()
    await expect(page.locator('[data-place-sheet]')).toHaveCount(0)
    await expect(panel(page)).toBeVisible()
  })
})
