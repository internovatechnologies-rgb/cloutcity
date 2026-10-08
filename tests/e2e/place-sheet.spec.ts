import type { Locator, Page } from '@playwright/test'
import type { PlaceTestHook } from '@/components/places/placeTestHook'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

// S09: the location action sheet. Places are opened through the test-only hook
// (src/components/places/placeTestHook.ts), which calls the same `openPlace` the 3D pins and
// Places panel use. Opening hours follow the personal game clock, which the hook sets; city
// time (page.clock) does not affect them. Numbers come from the engine through the hook, so
// the spec does not move when balance.json is tuned.

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
}

const HOUR = 60
const at = (hour: number) => hour * HOUR

const sheet = (page: Page, name: string | RegExp): Locator => page.getByRole('dialog', { name })

async function openPlace(page: Page, id: string, timeOfDay: number, clout = 0) {
  await page.evaluate(
    ([placeId, minute, points]) => {
      const places = window.__cloutcityPlaces
      if (places === undefined) throw new Error('place test hook is not installed')
      places.setTimeOfDay(minute)
      places.setClout(points)
      if (!places.open(placeId)) throw new Error(`no place ${placeId}`)
    },
    [id, timeOfDay, clout] as const,
  )
}

const state = (page: Page) =>
  page.evaluate((): ReturnType<PlaceTestHook['state']> => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    return places.state()
  })
const actions = (page: Page, id: string) =>
  page.evaluate((placeId) => window.__cloutcityPlaces?.actions(placeId) ?? [], id)

test.describe('location action sheet', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('nothing is open, and the empty sheet zone lets touches through', async ({ page }) => {
    await expect(page.locator('[data-place-sheet]')).toHaveCount(0)
    const wrapper = page.locator('[data-overlay-zone="sheet"] > div')
    await expect(wrapper).toHaveCSS('pointer-events', 'none')
  })

  test('a coffee shop by day offers its actions; at night it is closed with its opening time', async ({
    page,
  }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    const card = sheet(page, 'Steam Vent Coffee')
    await expect(card).toBeVisible()
    await expect(card.getByText('Open until 19:00')).toBeVisible()
    const coffee = card.getByRole('button', { name: /^Coffee: / })
    const shift = card.getByRole('button', { name: /^Work a Barista shift: / })
    await expect(coffee).toBeEnabled()
    await expect(shift).toBeEnabled()

    await page.evaluate(() => window.__cloutcityPlaces?.setTimeOfDay(23 * 60))
    await expect(card.getByText('Closed right now. Doors open at 06:00.').first()).toBeVisible()
    await expect(coffee).toBeDisabled()
    await expect(shift).toBeDisabled()
    await expect(coffee).toHaveAccessibleName(
      /^Coffee: .+\. Closed right now\. Doors open at 06:00\.$/,
    )
  })

  test('buying a coffee charges the price and moves the personal clock', async ({ page }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    const [coffee] = (await actions(page, 'steam-vent-coffee')).filter((a) => a.id === 'coffee')
    if (coffee === undefined) throw new Error('no coffee action')
    const before = await state(page)
    await sheet(page, 'Steam Vent Coffee')
      .getByRole('button', { name: /^Coffee: / })
      .click()
    await expect(sheet(page, 'Steam Vent Coffee').getByRole('status')).toHaveText(/^Done\./)
    const after = await state(page)
    expect(after.cash).toBe(before.cash - coffee.cashCost)
    expect(after.minute).toBe(before.minute + coffee.durationMin)
  })

  test('the club is closed by day, refuses at the door at night, then admits after clout rises', async ({
    page,
  }) => {
    await openPlace(page, 'glowmatic', at(12))
    const card = sheet(page, 'Glowmatic')
    const goIn = card.getByRole('button', { name: /^Go in: / })
    await expect(card.getByText('Closed right now. Doors open at 22:00.').first()).toBeVisible()
    await expect(goIn).toBeDisabled()

    await page.evaluate(() => window.__cloutcityPlaces?.setTimeOfDay(23 * 60))
    await expect(card.getByText('Open until 04:00')).toBeVisible()
    await expect(goIn).toBeDisabled()
    await expect(goIn).toHaveAccessibleName(/Bouncer checked the list, then checked your clout\./)
    await expect(card.getByText(/^Bouncer checked the list/)).toBeVisible()

    await page.evaluate(() => window.__cloutcityPlaces?.setClout(100))
    await expect(goIn).toBeEnabled()
    const [night] = await actions(page, 'glowmatic')
    if (night === undefined) throw new Error('no club night')
    const before = await state(page)
    await goIn.click()
    await expect(card.getByRole('status')).toHaveText(/^You're in\..*\+\d+ clout\.$/)
    const after = await state(page)
    expect(after.cash).toBe(before.cash - night.cashCost)
    expect(after.clout).toBe(before.clout + night.cloutGain)
    expect(after.minute).toBe(before.minute + night.durationMin)
  })

  test('a club the player cannot afford says so', async ({ page }) => {
    await openPlace(page, 'glowmatic', at(23), 100)
    await page.evaluate(() => window.__cloutcityPlaces?.setCash(0))
    const goIn = sheet(page, 'Glowmatic').getByRole('button', { name: /^Go in: / })
    await expect(goIn).toBeDisabled()
    await expect(goIn).toHaveAccessibleName(/That's \$\d+\. Your wallet says \$0\./)
  })

  test('a landmark visit moves the clock and lifts mood', async ({ page }) => {
    await openPlace(page, 'flushing-meadows', at(10))
    const card = sheet(page, /^Flushing Meadows/)
    await expect(card.getByText('Open 24 hours')).toBeVisible()
    const [visit] = await actions(page, 'flushing-meadows')
    if (visit === undefined) throw new Error('no visit')
    const before = await state(page)
    await card.getByRole('button', { name: /^Visit: / }).click()
    await expect(card.getByRole('status')).toHaveText(/checked\..*\+\d+ mood\.$/)
    const after = await state(page)
    expect(after.minute).toBe(before.minute + visit.durationMin)
    expect(after.stats.mood).toBeGreaterThan(before.stats.mood)
  })

  test('a place in a locked borough explains the lock on every action', async ({ page }) => {
    await openPlace(page, 'brickwave', at(23))
    const goIn = sheet(page, 'Brickwave').getByRole('button', { name: /^Go in: / })
    await expect(goIn).toBeDisabled()
    await expect(goIn).toHaveAccessibleName(/Brooklyn's not checking for you yet\./)
  })

  test('the memorial shows a respectful info card only', async ({ page }) => {
    await openPlace(page, 'september-11-memorial', at(12), 300)
    const card = sheet(page, '9/11 Memorial')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-look-only', '')
    await expect(
      card.getByText(/Two reflecting pools mark where the Twin Towers stood/),
    ).toBeVisible()
    await expect(card.getByText(/A place of remembrance/)).toBeVisible()
    // Close is the only control: no visit, flex, emote or any other action.
    await expect(card.getByRole('button')).toHaveCount(1)
    await expect(card.getByRole('button')).toHaveAccessibleName('Close 9/11 Memorial')
    expect(await actions(page, 'september-11-memorial')).toEqual([])
  })

  test('Escape and Close both close the sheet; focus moves into it on open', async ({ page }) => {
    await openPlace(page, 'late-lantern-deli', at(8))
    const card = sheet(page, 'Late Lantern Deli')
    await expect(card.getByRole('heading', { name: 'Late Lantern Deli' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    await page.evaluate(() => window.__cloutcityPlaces?.open('late-lantern-deli'))
    await card.getByRole('button', { name: 'Close Late Lantern Deli' }).click()
    await expect(card).toHaveCount(0)
  })

  test('an unknown place id opens nothing', async ({ page }) => {
    expect(await page.evaluate(() => window.__cloutcityPlaces?.open('nowhere'))).toBe(false)
    await expect(page.locator('[data-place-sheet]')).toHaveCount(0)
  })

  test('the open sheet stays inside the sheet zone, has 44 px targets and passes axe', async ({
    page,
    checkA11y,
  }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    const card = sheet(page, 'Steam Vent Coffee')
    await expect(card).toBeVisible()

    const zone = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
    const hud = await page.locator('[data-overlay-zone="hud"]').boundingBox()
    const tabs = await page.locator('[data-overlay-zone="tabs"]').boundingBox()
    if (!zone || !hud || !tabs) throw new Error('overlay zones are not rendered')
    expect(zone.y).toBeGreaterThanOrEqual(hud.y + hud.height)
    expect(zone.y + zone.height).toBeLessThanOrEqual(tabs.y)

    for (const button of await card.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded()
      const box = await button.boundingBox()
      if (!box) throw new Error('button is not rendered')
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
      // Each control sits inside the sheet zone (it scrolls there rather than spilling out).
      expect(box.y).toBeGreaterThanOrEqual(zone.y - 0.5)
      expect(box.y + box.height).toBeLessThanOrEqual(zone.y + zone.height + 0.5)
    }
    await checkA11y()

    await openPlace(page, 'september-11-memorial', at(12), 300)
    await expect(sheet(page, '9/11 Memorial')).toBeVisible()
    await checkA11y()
  })

  test('closing gives focus back to the control that had it before the sheet opened', async ({
    page,
  }) => {
    const shop = page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Shop' })
    await shop.focus()
    await openPlace(page, 'late-lantern-deli', at(8))
    const card = sheet(page, 'Late Lantern Deli')
    await expect(card.getByRole('heading', { name: 'Late Lantern Deli' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    await expect(shop).toBeFocused()

    // The Close button path returns focus the same way.
    await shop.focus()
    await openPlace(page, 'late-lantern-deli', at(8))
    await card.getByRole('button', { name: 'Close Late Lantern Deli' }).click()
    await expect(card).toHaveCount(0)
    await expect(shop).toBeFocused()
  })

  test('Escape from a focused action button closes the sheet', async ({ page }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    const card = sheet(page, 'Steam Vent Coffee')
    await card.getByRole('button', { name: /^Coffee: / }).focus()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  test('opening another place swaps the sheet and clears the last result', async ({ page }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    const coffeeShop = sheet(page, 'Steam Vent Coffee')
    await coffeeShop.getByRole('button', { name: /^Coffee: / }).click()
    await expect(coffeeShop.getByRole('status')).toHaveText(/^Done\./)

    await page.evaluate(() => window.__cloutcityPlaces?.open('late-lantern-deli'))
    const deli = sheet(page, 'Late Lantern Deli')
    await expect(deli).toBeVisible()
    await expect(page.locator('[data-place-sheet]')).toHaveCount(1)
    await expect(deli.getByRole('status')).toHaveText('')
    await expect(deli.getByRole('heading', { name: 'Late Lantern Deli' })).toBeFocused()

    // Back to the first place: its old result is gone too.
    await page.evaluate(() => window.__cloutcityPlaces?.open('steam-vent-coffee'))
    await expect(coffeeShop.getByRole('status')).toHaveText('')
  })

  test('a double tap with cash for exactly one cover lets the player in once', async ({ page }) => {
    await openPlace(page, 'glowmatic', at(23), 100)
    const [night] = await actions(page, 'glowmatic')
    if (night === undefined) throw new Error('no club night')
    await page.evaluate((cover) => window.__cloutcityPlaces?.setCash(cover), night.cashCost)
    const card = sheet(page, 'Glowmatic')
    const goIn = card.getByRole('button', { name: /^Go in: / })
    await expect(goIn).toBeEnabled()
    const before = await state(page)
    await goIn.dblclick()
    await expect(card.getByRole('status')).toHaveText(/^You're in\./)
    const after = await state(page)
    expect(after.cash).toBe(0)
    expect(after.clout).toBe(before.clout + night.cloutGain)
    expect(after.minute).toBe(before.minute + night.durationMin)
    // With the wallet empty the button now explains why it is off.
    await expect(goIn).toBeDisabled()
    await expect(goIn).toHaveAccessibleName(/Your wallet says \$0\./)
  })
})

test.describe('location action sheet: busy state and club nights (orchestrator rulings, S09)', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('a double tap with plenty of cash runs a coffee once, and Dismiss re-enables it', async ({
    page,
  }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    await page.evaluate(() => window.__cloutcityPlaces?.setCash(1000))
    const [coffee] = (await actions(page, 'steam-vent-coffee')).filter((a) => a.id === 'coffee')
    if (coffee === undefined) throw new Error('no coffee action')
    const card = sheet(page, 'Steam Vent Coffee')
    const button = card.getByRole('button', { name: /^Coffee: / })
    const before = await state(page)
    await button.dblclick()
    await expect(card.getByRole('status')).toHaveText(/^Done\./)
    const after = await state(page)
    expect(after.cash).toBe(before.cash - coffee.cashCost)
    expect(after.minute).toBe(before.minute + coffee.durationMin)

    // While the result shows, the button is off and says why.
    await expect(button).toBeDisabled()
    await expect(button).toHaveAccessibleName(/Dismiss the result to do this again\.$/)
    const dismiss = card.getByRole('button', { name: 'Dismiss', exact: true })
    await dismiss.click()
    await expect(card.getByRole('status')).toHaveText('')
    await expect(button).toBeEnabled()

    // A single tap: focus goes to Dismiss, and back to the action once dismissed. (After a
    // double tap the second tap lands on the disabled button, which takes focus off Dismiss.)
    await button.click()
    await expect(card.getByRole('status')).toHaveText(/^Done\./)
    await expect(dismiss).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(card.getByRole('status')).toHaveText('')
    await expect(button).toBeFocused()
    expect((await state(page)).cash).toBe(before.cash - 2 * coffee.cashCost)
  })

  test('a different action replacing the result re-enables the first one', async ({ page }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    await page.evaluate(() => window.__cloutcityPlaces?.setCash(1000))
    const card = sheet(page, 'Steam Vent Coffee')
    const coffee = card.getByRole('button', { name: /^Coffee: / })
    const shift = card.getByRole('button', { name: /^Work a Barista shift: / })
    await coffee.click()
    await expect(coffee).toBeDisabled()
    // The action guard's cooldown (layout.json actionCooldownMs) ignores a click on another
    // row in the spot just tapped; a deliberate click after it acts.
    await expect(card.locator('[aria-busy="true"]')).toHaveCount(0)
    await shift.click()
    await expect(card.getByRole('status')).toHaveText(/^Shift done\./)
    await expect(coffee).toBeEnabled()
    await expect(shift).toBeDisabled()
  })

  test('the club pays out clout once a night; a second entry says so in voice', async ({
    page,
  }) => {
    await openPlace(page, 'glowmatic', at(22), 100)
    await page.evaluate(() => window.__cloutcityPlaces?.setCash(1000))
    const [night] = await actions(page, 'glowmatic')
    if (night === undefined) throw new Error('no club night')
    const card = sheet(page, 'Glowmatic')
    const goIn = card.getByRole('button', { name: /^Go in: / })
    const start = await state(page)
    await goIn.click()
    await expect(card.getByRole('status')).toHaveText(/\+\d+ clout\.$/)
    await card.getByRole('button', { name: 'Dismiss', exact: true }).click()

    // Still the same night (the club is open past midnight): no more clout.
    await expect(goIn).toHaveAccessibleName(/clout already earned here tonight/)
    const [repeat] = await actions(page, 'glowmatic')
    expect(repeat?.cloutGain).toBe(0)
    const before = await state(page)
    await goIn.click()
    await expect(card.getByRole('status')).toHaveText(
      /^Back again\? You already made your name here tonight, so no extra clout\./,
    )
    const after = await state(page)
    expect(after.clout).toBe(start.clout + night.cloutGain)
    expect(after.cash).toBe(before.cash - night.cashCost)
    expect(after.minute).toBe(before.minute + night.durationMin)
  })
})

test.describe('location action sheet, phone landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('the sheet stays between the HUD and tabs, scrolls inside its zone and passes axe', async ({
    page,
    checkA11y,
  }) => {
    await openPlace(page, 'steam-vent-coffee', at(8))
    const card = sheet(page, 'Steam Vent Coffee')
    await expect(card).toBeVisible()
    await expect(card.getByRole('heading', { name: 'Steam Vent Coffee' })).toBeFocused()

    const zone = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
    const hud = await page.locator('[data-overlay-zone="hud"]').boundingBox()
    const tabs = await page.locator('[data-overlay-zone="tabs"]').boundingBox()
    if (!zone || !hud || !tabs) throw new Error('overlay zones are not rendered')
    expect(zone.y).toBeGreaterThanOrEqual(hud.y + hud.height)
    expect(zone.y + zone.height).toBeLessThanOrEqual(tabs.y)

    // The page itself never scrolls; any overflow scrolls inside the sheet zone.
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(overflow.page).toBeLessThanOrEqual(0)
    expect(overflow.pageX).toBeLessThanOrEqual(0)

    for (const button of await card.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded()
      const box = await button.boundingBox()
      if (!box) throw new Error('button is not rendered')
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.y).toBeGreaterThanOrEqual(zone.y - 0.5)
      expect(box.y + box.height).toBeLessThanOrEqual(zone.y + zone.height + 0.5)
    }
    // The last action is reachable and usable after scrolling.
    const shift = card.getByRole('button', { name: /^Work a Barista shift: / })
    await shift.scrollIntoViewIfNeeded()
    await expect(shift).toBeInViewport()
    await checkA11y()

    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })
})
