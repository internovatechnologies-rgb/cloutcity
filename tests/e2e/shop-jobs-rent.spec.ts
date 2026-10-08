import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import type { HudTestHook } from '@/components/hud/hudTestHook'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'
import { hudIsWide, hudOpener, openFromHud } from './helpers/hud'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

// S10a: the shop in a thrift store's place sheet, the inventory and rent panels from the HUD,
// and a shift with its lock and energy states. Places open through the S09 test hook (the same
// `openPlace` the map uses); the HUD hook advances the personal clock through the store. Prices,
// wages and durations come from the engine through the hooks, never literals.

const THRIFT = 'rerun-racks'
const NOON = 12 * 60

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(
    () => window.__cloutcityPlaces !== undefined && window.__cloutcityTest?.hud !== undefined,
  )
  await waitForMapSettled(page)
}

const hudState = (page: Page) =>
  page.evaluate((): ReturnType<HudTestHook['state']> => {
    const hook = window.__cloutcityTest?.hud
    if (hook === undefined) throw new Error('hud test hook is not installed')
    return hook.state()
  })

async function openThrift(page: Page, cash: number) {
  await page.evaluate(
    ([id, minute, money]) => {
      const hook = window.__cloutcityPlaces
      if (hook === undefined) throw new Error('place test hook is not installed')
      hook.setTimeOfDay(minute)
      hook.setCash(money)
      if (!hook.open(id)) throw new Error(`no place ${id}`)
    },
    [THRIFT, NOON, cash] as const,
  )
}

const sheet = (page: Page): Locator => page.locator(`[data-place-sheet="${THRIFT}"]`)
const shopRow = (page: Page, itemId: string) => sheet(page).locator(`[data-shop-item="${itemId}"]`)

async function cheapestWearable(page: Page) {
  const items = await page.evaluate(() => window.__cloutcityTest?.hud?.shop() ?? [])
  // Wearables only: gifts stack and decor (S16) goes in the Home panel, not the outfit.
  const [item] = items
    .filter((entry) => !entry.gift && !entry.decor)
    .sort((a, b) => a.price - b.price)
  if (item === undefined) throw new Error('no wearable for sale')
  const dearest = [...items].sort((a, b) => b.price - a.price)[0]
  if (dearest === undefined) throw new Error('no items for sale')
  return { item, dearest }
}

test.describe('shop, inventory, jobs and rent', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('buy, wear, sell, work a shift and pay rent', async ({ page, checkA11y }) => {
    const { item } = await cheapestWearable(page)
    await openThrift(page, 1000)
    const card = page.getByRole('dialog', { name: 'Rerun Racks' })
    await expect(card).toBeVisible()
    await expect(sheet(page).locator('[data-shop-item]')).toHaveCount(
      await page.evaluate(() => window.__cloutcityTest?.hud?.shop().length ?? 0),
    )
    await checkA11y()

    // Buy: the price leaves the cash; the button turns off and says the item is owned.
    const buy = shopRow(page, item.id).getByRole('button', { name: /^Buy / })
    await expect(buy).toBeEnabled()
    const before = await hudState(page)
    await buy.click()
    await expect(sheet(page).locator('[data-shop-status]')).not.toHaveText('')
    const bought = await hudState(page)
    expect(bought.cash).toBe(before.cash - item.price)
    expect(bought.owned).toContain(item.id)
    await expect(buy).toBeDisabled()
    await expect(buy).toHaveAccessibleName(/^Buy .+\. .+/)

    // Work a shift: cash and the personal clock move by what the engine says.
    const shift = await page.evaluate(
      (id) => window.__cloutcityPlaces?.actions(id).find((a) => a.id.startsWith('shift-')),
      THRIFT,
    )
    if (shift === undefined) throw new Error('the thrift store lists no shift')
    const work = card.getByRole('button', { name: /^Work a .+ shift: / })
    await work.click()
    await expect(card.getByRole('status')).not.toHaveText('')
    const worked = await hudState(page)
    expect(worked.cash).toBeGreaterThan(bought.cash)
    expect(worked.minute).toBe(bought.minute + shift.durationMin)

    // Inventory from the HUD: the place sheet makes way for the panel.
    await openFromHud(page, 'Inventory')
    const inventory = page.getByRole('dialog', { name: 'Inventory' })
    await expect(inventory).toBeVisible()
    await expect(card).toHaveCount(0)
    await checkA11y()
    const row = inventory.locator(`[data-inventory-item="${item.id}"]`)
    await row.getByRole('button', { name: /^Wear / }).click()
    await expect(inventory.getByRole('status')).not.toHaveText('')
    expect(Object.values((await hudState(page)).outfit)).toContain(item.id)
    await expect(row.getByRole('button', { name: /^Take off / })).toBeVisible()

    // Sell at the shown resale value.
    const sell = row.getByRole('button', { name: /^Sell .+ for / })
    const cashBeforeSale = (await hudState(page)).cash
    await expect(row.getByText(/^Sells for /)).toBeVisible()
    await sell.click()
    await expect(row).toHaveCount(0)
    const sold = await hudState(page)
    expect(sold.owned).not.toContain(item.id)
    expect(sold.cash).toBeGreaterThan(cashBeforeSale)
    expect(sold.cash - cashBeforeSale).toBeLessThan(item.price)
    await expect(inventory.getByRole('status')).not.toHaveText('')

    // Rent: nothing has come due yet; advancing past a rent day pays it and shows the notice.
    await openFromHud(page, 'Rent')
    const rent = page.getByRole('dialog', { name: 'Rent' })
    await expect(rent).toBeVisible()
    await expect(rent.locator('[data-rent-next-due]')).toHaveText(/ day \d+\.$/)
    const notice = rent.locator('[data-rent-notice]')
    await expect(notice).toHaveText('No rent has come due this session.')
    const due = await page.evaluate(
      () => window.__cloutcityTest?.hud?.advancePastNextRentDay() ?? 0,
    )
    expect(due).toBeGreaterThan(1)
    await expect(notice).toContainText(/paid/i)
    const after = await hudState(page)
    expect(after.lastRentEvent).toBe('paid')
    await checkA11y()

    // Escape closes the panel and focus goes back to the HUD button.
    await rent.getByRole('heading', { name: 'Rent', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(rent).toHaveCount(0)
    await expect(hudOpener(page, 'Rent')).toBeFocused()
  })

  test('a buy the player cannot afford, and a tired player, say why in the accessible name', async ({
    page,
  }) => {
    const { dearest } = await cheapestWearable(page)
    await openThrift(page, 0)
    const buy = shopRow(page, dearest.id).getByRole('button', { name: /^Buy / })
    await expect(buy).toBeDisabled()
    // The shortfall is the whole price at $0 (wording varies by slang pack).
    await expect(buy).toHaveAccessibleName(/\d+ more/)

    await page.evaluate(() => window.__cloutcityTest?.hud?.setEnergy(0))
    const work = page
      .getByRole('dialog', { name: 'Rerun Racks' })
      .getByRole('button', { name: /^Work a .+ shift: / })
    await expect(work).toBeDisabled()
    await expect(work).toHaveAccessibleName(/energy/)
  })

  test('the shop refuses while the store is closed', async ({ page }) => {
    const { item } = await cheapestWearable(page)
    await openThrift(page, 1000)
    await page.evaluate(() => window.__cloutcityPlaces?.setTimeOfDay(3 * 60))
    const buy = shopRow(page, item.id).getByRole('button', { name: /^Buy / })
    await expect(buy).toBeDisabled()
    await expect(buy).toHaveAccessibleName(/Opens at|Doors open at/)
  })

  test('HUD buttons are 44 px targets and toggle their panel', async ({ page, checkA11y }) => {
    // Wide screens show Inventory and Rent; phones show More, which holds them (S05).
    const toggles = hudIsWide(page)
      ? (['Inventory', 'Rent'] as const).map((name) => ({ name, dialog: name }))
      : [{ name: 'More', dialog: 'More' }]
    for (const { name, dialog } of toggles) {
      const button = page
        .locator('[data-overlay-zone="hud"]')
        .getByRole('button', { name, exact: true })
      const box = await button.boundingBox()
      if (box === null) throw new Error(`${name} is not rendered`)
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
      await button.click()
      await expect(page.getByRole('dialog', { name: dialog })).toBeVisible()
      await expect(button).toHaveAttribute('aria-expanded', 'true')
      await button.click()
      await expect(page.getByRole('dialog', { name: dialog })).toHaveCount(0)
    }
    await openFromHud(page, 'Inventory')
    await expect(page.getByText(/^Nothing here yet\./)).toBeVisible()
    await checkA11y()
  })
})

// ---------------------------------------------------------------------------------------------
// S10a probes: double taps, focus, shop rules, phone layouts, rent notices.
// Balance numbers the hooks do not expose are read from data/config, never written as literals.

const balance = JSON.parse(
  readFileSync(new URL('../../data/config/balance.json', import.meta.url), 'utf8'),
) as {
  readonly items: { readonly maxGiftStack: number }
  readonly time: { readonly rentPeriodGameDays: number; readonly gameDayHours: number }
}
const MAX_GIFT_STACK = balance.items.maxGiftStack

const venueData = JSON.parse(
  readFileSync(new URL('../../data/venues/venues.json', import.meta.url), 'utf8'),
) as { readonly venues: readonly { readonly id: string; readonly hours: unknown }[] }
const toMinute = (time: string) => {
  const [hour = '', minute = ''] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}
function venueHours(id: string) {
  const hours = venueData.venues.find((venue) => venue.id === id)?.hours
  if (typeof hours !== 'object' || hours === null) throw new Error(`${id} has no fixed hours`)
  const { open, close } = hours as { open: string; close: string }
  return { open: toMinute(open), close: toMinute(close) }
}
const RENT_PERIOD = balance.time.rentPeriodGameDays
const DAY = balance.time.gameDayHours * 60

const inventoryDialog = (page: Page) => page.getByRole('dialog', { name: 'Inventory' })
/** What has focus, as `TAG:text` (short), so a focus failure names where focus went. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement
    if (active === null) return 'none'
    return `${active.tagName}:${(active.textContent ?? '').trim().slice(0, 20)}`
  })

async function shopList(page: Page) {
  const items = await page.evaluate(() => window.__cloutcityTest?.hud?.shop() ?? [])
  const byPrice = [...items].sort((a, b) => a.price - b.price)
  const wearables = byPrice.filter((item) => !item.gift && !item.decor)
  const gifts = byPrice.filter((item) => item.gift)
  if (wearables.length < 2 || gifts.length < 2)
    throw new Error('shop needs 2 wearables and 2 gifts')
  return { items, wearables, gifts }
}

/** Buys `ids` one tap at a time through the thrift store's shop, then closes the sheet. */
async function buyThrough(page: Page, ids: readonly string[], cash: number) {
  await openThrift(page, cash)
  for (const id of ids) {
    const buy = shopRow(page, id).getByRole('button', { name: /^Buy / })
    const before = await hudState(page)
    await buy.click()
    await expect.poll(async () => (await hudState(page)).cash).toBeLessThan(before.cash)
  }
}

async function openInventory(page: Page) {
  await openFromHud(page, 'Inventory')
  const panel = inventoryDialog(page)
  await expect(panel).toBeVisible()
  return panel
}

test.describe('shop and inventory: double taps and focus', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('a double tap on Buy buys a wearable once', async ({ page }) => {
    const { wearables } = await shopList(page)
    const [item] = wearables
    if (item === undefined) throw new Error('no wearable')
    await openThrift(page, 1000)
    const buy = shopRow(page, item.id).getByRole('button', { name: /^Buy / })
    const before = await hudState(page)
    await buy.dblclick()
    await expect(buy).toBeDisabled()
    const after = await hudState(page)
    expect(after.owned.filter((id) => id === item.id)).toHaveLength(1)
    expect(after.cash).toBe(before.cash - item.price)
  })

  test('a single tap that buys a wearable moves focus to the shop heading', async ({ page }) => {
    const { wearables } = await shopList(page)
    const [item] = wearables
    if (item === undefined) throw new Error('no wearable')
    await openThrift(page, 1000)
    const buy = shopRow(page, item.id).getByRole('button', { name: /^Buy / })
    await buy.click()
    await expect(buy).toBeDisabled()
    await expect.poll(() => focused(page)).toBe('H3:Shop')
  })

  test('gift Buy taps stack up to the cap, then the button says the hands are full', async ({
    page,
  }) => {
    const { gifts } = await shopList(page)
    const [gift] = gifts
    if (gift === undefined) throw new Error('no gift')
    const start = gift.price * (MAX_GIFT_STACK + 2)
    await openThrift(page, start)
    const buy = shopRow(page, gift.id).getByRole('button', { name: /^Buy / })
    // Double taps while two more fit (each tap buys one), then single taps up to the cap; the
    // last tap disables the button, so focus must move to the shop heading.
    for (let i = 0; i + 2 < MAX_GIFT_STACK; i += 2) await buy.dblclick()
    while (((await hudState(page)).gifts[gift.id] ?? 0) < MAX_GIFT_STACK) await buy.click()
    await expect(buy).toBeDisabled()
    const after = await hudState(page)
    expect(after.gifts[gift.id]).toBe(MAX_GIFT_STACK)
    expect(after.cash).toBe(start - MAX_GIFT_STACK * gift.price)
    await expect(buy).toHaveAccessibleName(new RegExp(`${MAX_GIFT_STACK}`))
    await expect.poll(() => focused(page)).toBe('H3:Shop')
  })

  test('a double tap on Wear leaves the item worn', async ({ page }) => {
    const { wearables } = await shopList(page)
    const [item] = wearables
    if (item === undefined) throw new Error('no wearable')
    await buyThrough(page, [item.id], 1000)
    const panel = await openInventory(page)
    const row = panel.locator(`[data-inventory-item="${item.id}"]`)
    await row.getByRole('button', { name: /^Wear / }).dblclick()
    await expect(panel.getByRole('status')).not.toHaveText('')
    expect(Object.values((await hudState(page)).outfit)).toContain(item.id)
    await expect(row.getByRole('button', { name: /^Take off / })).toBeVisible()
  })

  test('a double tap on Sell sells only the tapped item', async ({ page }) => {
    const { wearables } = await shopList(page)
    const [first, second] = wearables
    if (first === undefined || second === undefined) throw new Error('need two wearables')
    await buyThrough(page, [first.id, second.id], 1000)
    const panel = await openInventory(page)
    const row = panel.locator(`[data-inventory-item="${first.id}"]`)
    await row.getByRole('button', { name: /^Sell / }).dblclick()
    await expect(row).toHaveCount(0)
    const after = await hudState(page)
    expect(after.owned).not.toContain(first.id)
    expect(after.owned).toContain(second.id)
  })

  test('a double tap on Use for the last gift uses only that gift', async ({ page }) => {
    const { gifts } = await shopList(page)
    const [first, second] = gifts
    if (first === undefined || second === undefined) throw new Error('need two gifts')
    await buyThrough(page, [first.id, second.id], 1000)
    const panel = await openInventory(page)
    const row = panel.locator(`[data-inventory-item="${first.id}"]`)
    await row.getByRole('button', { name: /^Use / }).dblclick()
    await expect(row).toHaveCount(0)
    const after = await hudState(page)
    expect(after.gifts[first.id]).toBeUndefined()
    expect(after.gifts[second.id]).toBe(1)
  })

  test('selling the last copy and using the last gift move focus to the panel heading', async ({
    page,
  }) => {
    const { wearables, gifts } = await shopList(page)
    const [item] = wearables
    const [gift] = gifts
    if (item === undefined || gift === undefined) throw new Error('no items')
    await buyThrough(page, [item.id, gift.id], 1000)
    const panel = await openInventory(page)
    const heading = panel.getByRole('heading', { name: 'Inventory', exact: true })

    await panel
      .locator(`[data-inventory-item="${item.id}"]`)
      .getByRole('button', { name: /^Sell / })
      .click()
    await expect(panel.locator(`[data-inventory-item="${item.id}"]`)).toHaveCount(0)
    await expect(heading).toBeFocused()

    await panel
      .locator(`[data-inventory-item="${gift.id}"]`)
      .getByRole('button', { name: /^Use / })
      .click()
    await expect(panel.locator(`[data-inventory-item="${gift.id}"]`)).toHaveCount(0)
    await expect(heading).toBeFocused()
    await expect(panel.getByText(/^Nothing here yet\./)).toBeVisible()
  })

  test('switching between a place and a panel keeps one sheet open and focus inside it', async ({
    page,
  }) => {
    const dialogs = page.locator('[data-overlay-zone="sheet"] [role="dialog"]')

    await openThrift(page, 100)
    const card = page.getByRole('dialog', { name: 'Rerun Racks' })
    await expect(card.getByRole('heading', { name: 'Rerun Racks' })).toBeFocused()

    const panel = await openInventory(page)
    await expect(card).toHaveCount(0)
    await expect(dialogs).toHaveCount(1)
    await expect(panel.getByRole('heading', { name: 'Inventory', exact: true })).toBeFocused()

    // A place opening (map pin or Places panel) closes the panel and takes focus.
    await page.evaluate((id) => window.__cloutcityPlaces?.open(id), THRIFT)
    await expect(card).toBeVisible()
    await expect(panel).toHaveCount(0)
    await expect(dialogs).toHaveCount(1)
    await expect(card.getByRole('heading', { name: 'Rerun Racks' })).toBeFocused()

    // Panel to panel: Rent replaces Inventory, and closing Rent returns to the Rent button.
    await openInventory(page)
    await openFromHud(page, 'Rent')
    const rent = page.getByRole('dialog', { name: 'Rent' })
    await expect(rent.getByRole('heading', { name: 'Rent', exact: true })).toBeFocused()
    await expect(dialogs).toHaveCount(1)
    await rent.getByRole('button', { name: /^Close / }).click()
    await expect(dialogs).toHaveCount(0)
    await expect(hudOpener(page, 'Rent')).toBeFocused()
  })
})

test.describe('shop rules in the sheet', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('a boutique in a locked borough shows every Buy disabled with the lock reason', async ({
    page,
    checkA11y,
  }) => {
    await page.evaluate(() => {
      const hook = window.__cloutcityPlaces
      if (hook === undefined) throw new Error('place test hook is not installed')
      hook.setTimeOfDay(12 * 60)
      hook.setClout(0)
      hook.setCash(100_000)
      hook.open('sidecut-studio')
    })
    const card = page.locator('[data-place-sheet="sidecut-studio"]')
    await expect(card).toBeVisible()
    const buttons = card.locator('[data-shop-item]').getByRole('button')
    const count = await buttons.count()
    expect(count).toBe((await shopList(page)).items.length)
    for (const button of await buttons.all()) {
      await expect(button).toBeDisabled()
      await expect(button).toHaveAccessibleName(/^Buy .+\. \S.+/)
    }
    const before = await hudState(page)
    // A forced click on a disabled control does nothing.
    await buttons.first().click({ force: true })
    expect((await hudState(page)).cash).toBe(before.cash)
    await checkA11y()
  })

  test('the shop opens at the opening minute and closes at the closing minute', async ({
    page,
  }) => {
    const { wearables } = await shopList(page)
    const [item] = wearables
    if (item === undefined) throw new Error('no wearable')
    const hours = venueHours(THRIFT)
    await openThrift(page, 1000)
    const buy = shopRow(page, item.id).getByRole('button', { name: /^Buy / })
    const at = (minute: number) =>
      page.evaluate((m) => window.__cloutcityPlaces?.setTimeOfDay(m), minute)

    await at(hours.open - 1)
    await expect(buy).toBeDisabled()
    await at(hours.open)
    await expect(buy).toBeEnabled()
    await at(hours.close - 1)
    await expect(buy).toBeEnabled()
    await at(hours.close)
    await expect(buy).toBeDisabled()
  })
})

test.describe('rent notices', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('missed rent, a late fee and an eviction each show in the rent panel', async ({
    page,
    checkA11y,
  }) => {
    await page.evaluate(() => window.__cloutcityPlaces?.setCash(0))
    await openFromHud(page, 'Rent')
    const rent = page.getByRole('dialog', { name: 'Rent' })
    const notice = rent.locator('[data-rent-notice]')
    const owed = rent.locator('[data-rent-owed]')
    const advance = () =>
      page.evaluate(() => window.__cloutcityTest?.hud?.advancePastNextRentDay() ?? 0)

    await advance()
    expect((await hudState(page)).lastRentEvent).toBe('missed')
    await expect(notice).toContainText(/\$\d/)
    await expect(owed).toContainText(/\$\d/)
    const firstNotice = await notice.textContent()
    await checkA11y()

    await advance()
    expect((await hudState(page)).lastRentEvent).toBe('missed')
    await expect(notice).not.toHaveText(firstNotice ?? '')
    await expect(notice).toContainText(/fee/i)

    // Keep missing until the engine evicts.
    for (let i = 0; i < 10 && (await hudState(page)).lastRentEvent !== 'evicted'; i += 1) {
      await advance()
    }
    expect((await hudState(page)).lastRentEvent).toBe('evicted')
    await expect(notice).not.toHaveText(/^No rent/)
    await expect(owed).not.toContainText(/\$\d/)
    await checkA11y()
  })

  test('a shift that runs past the midnight rent comes due adds the rent notice', async ({
    page,
  }) => {
    // The eve of the first rent day, late enough that a shift ends after midnight. The place
    // hook sets the clock directly, so no rent settles on the way there.
    const site = 'northside-dispatch'
    const [shift] = (
      await page.evaluate((id) => window.__cloutcityPlaces?.actions(id) ?? [], site)
    ).filter((action) => action.id.startsWith('shift-'))
    if (shift === undefined) throw new Error(`${site} lists no shift`)
    await page.evaluate(
      ([period, perDay, duration]) => {
        const hook = window.__cloutcityPlaces
        if (hook === undefined) throw new Error('place test hook is not installed')
        const eve = period - 1
        // Half a day at a time (the hook never skips days, and settles no rent) to the eve.
        while (Math.floor(hook.state().minute / perDay) < eve) {
          hook.setTimeOfDay((hook.state().minuteOfDay + perDay / 2) % perDay)
        }
        hook.setTimeOfDay(perDay - (duration - 1))
        if (Math.floor(hook.state().minute / perDay) !== eve) throw new Error('missed the eve')
        hook.setCash(0)
        hook.open('northside-dispatch')
      },
      [RENT_PERIOD, DAY, shift.durationMin] as const,
    )
    const card = page.locator(`[data-place-sheet="${site}"]`)
    const work = card.getByRole('button', { name: /^Work a .+ shift: / })
    await expect(work).toBeEnabled()
    await work.click()
    await expect(card.getByRole('status')).toContainText(/owe \$\d/)
    expect((await hudState(page)).lastRentEvent).toBe('missed')
  })
})

test.describe('shop on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`at ${viewport.width}x${viewport.height} every shop row scrolls inside the sheet zone with 44 px targets`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize(viewport)
      // Cash for some items, not others, so enabled and disabled-with-reason rows both show.
      await openThrift(page, 40)
      const zone = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
      const hud = await page.locator('[data-overlay-zone="hud"]').boundingBox()
      const tabs = await page.locator('[data-overlay-zone="tabs"]').boundingBox()
      if (!zone || !hud || !tabs) throw new Error('overlay zones are not rendered')
      expect(zone.y).toBeGreaterThanOrEqual(hud.y + hud.height)
      expect(zone.y + zone.height).toBeLessThanOrEqual(tabs.y)

      const rows = sheet(page).locator('[data-shop-item]')
      await expect(rows).toHaveCount((await shopList(page)).items.length)
      for (const button of await sheet(page).getByRole('button').all()) {
        await button.scrollIntoViewIfNeeded()
        const box = await button.boundingBox()
        if (!box) throw new Error('button is not rendered')
        expect(box.height).toBeGreaterThanOrEqual(44)
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.y).toBeGreaterThanOrEqual(zone.y - 0.5)
        expect(box.y + box.height).toBeLessThanOrEqual(zone.y + zone.height + 0.5)
      }
      // The page never scrolls; the overflow lives inside the sheet zone.
      const overflow = await page.evaluate(() => ({
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }))
      expect(overflow.y).toBeLessThanOrEqual(0)
      expect(overflow.x).toBeLessThanOrEqual(0)
      await expect(sheet(page).locator('[data-shop-item] button:disabled').first()).toBeAttached()
      await expect(sheet(page).locator('[data-shop-item] button:enabled').first()).toBeAttached()
      await checkA11y()

      // The HUD's actions stay 44 px targets (on phones Inventory and Rent are behind More).
      const actions = await page.locator('[data-hud-cell="actions"] button:visible').all()
      expect(actions.length).toBeGreaterThan(0)
      for (const action of actions) {
        const box = await action.boundingBox()
        if (!box) throw new Error('a HUD action is not rendered')
        expect(box.height).toBeGreaterThanOrEqual(44)
        expect(box.width).toBeGreaterThanOrEqual(44)
      }
    })
  }
})

test.describe('HUD row', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  // S05 replaced the one-row HUD with a grid: two rows (one on a landscape phone). The title is a
  // screen-reader heading now (UX-8), so the visible parts checked here are the live cells, the
  // Goals button with the clout meter inside it, the Places button (S04c, visible at every width,
  // A11Y-3) and every visible action. The intent is unchanged: nothing overlaps, everything fits
  // the HUD zone, and every control is a 44 px target.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
    { width: 390, height: 600 },
    { width: 844, height: 390 },
  ]) {
    test(`at ${viewport.width}x${viewport.height} nothing in the HUD overlaps and every control fits it`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize(viewport)
      const zone = page.locator('[data-overlay-zone="hud"]')
      const places = zone.locator('[data-places-button]')
      await expect(places).toBeVisible()
      await expect(zone.locator('[data-clout-meter]')).toBeVisible()
      await expect(zone.locator('[data-cc-feature="cc-feature:sound-control"]')).toBeVisible()
      await expect(zone.getByRole('heading', { level: 1, name: 'Clout City: NYC' })).toBeAttached()

      const parts = [
        ...['money', 'clock', 'stats'].map((cell) => ({
          name: cell,
          locator: zone.locator(`[data-hud-cell="${cell}"]`),
        })),
        ...(await zone.getByRole('button').filter({ visible: true }).all()).map(
          (locator, index) => ({ name: `button ${index}`, locator }),
        ),
      ]
      const row = await zone.boundingBox()
      if (row === null) throw new Error('the HUD zone is not rendered')
      const boxes = []
      for (const part of parts) {
        const box = await part.locator.boundingBox()
        if (box === null) throw new Error(`${part.name} is not rendered`)
        const name = (await part.locator.getAttribute('aria-label')) ?? part.name
        expect(box.width, `${name} width`).toBeGreaterThan(0)
        expect(box.x, `${name} left`).toBeGreaterThanOrEqual(row.x - 0.5)
        expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(row.x + row.width + 0.5)
        expect(box.y, `${name} top`).toBeGreaterThanOrEqual(row.y - 0.5)
        expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(row.y + row.height + 0.5)
        if (part.name.startsWith('button')) {
          expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44)
          expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44)
        }
        boxes.push({ name, box })
      }
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          const apart =
            a.box.x + a.box.width <= b.box.x + 0.5 ||
            b.box.x + b.box.width <= a.box.x + 0.5 ||
            a.box.y + a.box.height <= b.box.y + 0.5 ||
            b.box.y + b.box.height <= a.box.y + 0.5
          expect(apart, `${a.name} overlaps ${b.name}`).toBe(true)
        }
      }
      // Wide screens show the Places label; phones and landscape phones an icon (its label stays
      // the accessible name).
      await expect(places).toHaveAccessibleName('Places')
      const label = await places.getByText('Places', { exact: true }).boundingBox()
      expect((label?.width ?? 0) > 1, 'Places label shown').toBe(hudIsWide(page))
      await checkA11y()
    })
  }
})

test.describe('lazy loading (DEC-11)', () => {
  test('the HUD panels load only when opened, never with the shell', async ({ page }) => {
    const scripts: string[] = []
    page.on('response', async (response) => {
      if (!response.url().includes('/_next/static/chunks/') || !response.url().endsWith('.js')) {
        return
      }
      scripts.push(await response.text().catch(() => ''))
    })
    const loaded = (marker: string) => scripts.some((body) => body.includes(marker))

    // No e2e flag: the page boots as a player's would.
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(loaded('data-hud-panel-dialog'), 'panel frame at boot').toBe(false)
    expect(loaded('data-rent-notice'), 'rent panel at boot').toBe(false)
    expect(loaded('data-shop-status'), 'shop at boot').toBe(false)

    await openFromHud(page, 'Rent')
    await expect(page.getByRole('dialog', { name: 'Rent' })).toBeVisible()
    await expect
      .poll(() => loaded('data-rent-notice'), { message: 'rent panel once opened' })
      .toBe(true)
  })
})

// Fix cycle 1 probes: the inventory tap guard (busy ref + `event.detail`) must stop the second
// tap of a double tap however it arrives, and must never swallow a deliberate second action.
test.describe('inventory tap guard', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  const rowOf = (page: Page, id: string) =>
    inventoryDialog(page).locator(`[data-inventory-item="${id}"]`)
  /**
   * Waits until the last result has been painted (two animation frames). The guard ignores
   * taps for one frame after an action, far shorter than any deliberate human follow-up, but
   * Playwright can fire the next action within that frame.
   */
  const settle = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )

  test('two touch taps in a row on Sell sell only the tapped item', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'touch taps need a touch screen')
    const { wearables } = await shopList(page)
    const [first, second] = wearables
    if (first === undefined || second === undefined) throw new Error('need two wearables')
    await buyThrough(page, [first.id, second.id], 1000)
    await openInventory(page)
    const sell = rowOf(page, first.id).getByRole('button', { name: /^Sell / })
    const box = await sell.boundingBox()
    if (box === null) throw new Error('Sell is not rendered')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    // Two raw taps at one spot, back to back: the second lands where the next row slid in.
    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)
    await expect(rowOf(page, first.id)).toHaveCount(0)
    const after = await hudState(page)
    expect(after.owned).not.toContain(first.id)
    expect(after.owned).toContain(second.id)
  })

  test('two touch taps in a row on Wear leave the item worn', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'touch taps need a touch screen')
    const { wearables } = await shopList(page)
    const [item] = wearables
    if (item === undefined) throw new Error('no wearable')
    await buyThrough(page, [item.id], 1000)
    await openInventory(page)
    const wear = rowOf(page, item.id).getByRole('button', { name: /^Wear / })
    const box = await wear.boundingBox()
    if (box === null) throw new Error('Wear is not rendered')
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    await expect(inventoryDialog(page).getByRole('status')).not.toHaveText('')
    expect(Object.values((await hudState(page)).outfit)).toContain(item.id)
  })

  test('a deliberate second action after the result shows is not swallowed', async ({ page }) => {
    const { wearables, gifts } = await shopList(page)
    const [item] = wearables
    const [gift] = gifts
    if (item === undefined || gift === undefined) throw new Error('no items')
    await buyThrough(page, [item.id, gift.id, gift.id, gift.id], 1000)
    const panel = await openInventory(page)
    const status = panel.getByRole('status')

    // Sell twice from a gift stack, by mouse, waiting for each result.
    const sellGift = rowOf(page, gift.id).getByRole('button', { name: /^Sell / })
    await settle(page)
    await sellGift.click()
    await expect.poll(async () => (await hudState(page)).gifts[gift.id]).toBe(2)
    await settle(page)
    await sellGift.click()
    await expect.poll(async () => (await hudState(page)).gifts[gift.id]).toBe(1)

    // Space twice on Use (the stack's last copy goes, then the row is gone).
    const use = rowOf(page, gift.id).getByRole('button', { name: /^Use / })
    await settle(page)
    await use.focus()
    await page.keyboard.press('Space')
    await expect(rowOf(page, gift.id)).toHaveCount(0)

    // Wear, then Take off on the same row once the result shows.
    await settle(page)
    await rowOf(page, item.id)
      .getByRole('button', { name: /^Wear / })
      .click()
    await expect(status).not.toHaveText('')
    expect(Object.values((await hudState(page)).outfit)).toContain(item.id)
    await settle(page)
    await rowOf(page, item.id)
      .getByRole('button', { name: /^Take off / })
      .click()
    await expect
      .poll(async () => Object.values((await hudState(page)).outfit))
      .not.toContain(item.id)

    // Keyboard Enter twice with a result between them works too.
    const wear = rowOf(page, item.id).getByRole('button', { name: /^Wear / })
    await settle(page)
    await wear.focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => Object.values((await hudState(page)).outfit)).toContain(item.id)
    const takeOff = rowOf(page, item.id).getByRole('button', { name: /^Take off / })
    await settle(page)
    await takeOff.focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => Object.values((await hudState(page)).outfit))
      .not.toContain(item.id)
  })
})

test.describe('rent notices from events (BUG-1)', () => {
  test('an event choice that runs past the rent-day midnight shows the notice in the Rent panel', async ({
    page,
  }) => {
    await boot(page)
    await page.waitForFunction(() => window.__cloutcityTest?.events !== undefined)
    await page.evaluate(
      ([period, perDay]) => {
        const hook = window.__cloutcityPlaces
        if (hook === undefined) throw new Error('place test hook is not installed')
        const eve = period - 1
        while (Math.floor(hook.state().minute / perDay) < eve) {
          hook.setTimeOfDay((hook.state().minuteOfDay + perDay / 2) % perDay)
        }
        // Two minutes to midnight; the bodega cat's choices take longer than that.
        hook.setTimeOfDay(perDay - 2)
        if (Math.floor(hook.state().minute / perDay) !== eve) throw new Error('missed the eve')
        hook.setCash(0)
      },
      [RENT_PERIOD, DAY] as const,
    )
    const opened = await page.evaluate(() =>
      window.__cloutcityTest?.events?.open('bodega-cat', {
        borough: 'queens',
        locationId: null,
        locationCategory: 'bodega',
        itemIds: [],
      }),
    )
    expect(opened?.ok).toBe(true)
    await page.getByRole('button', { name: /Pet the cat/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await hudState(page)).lastRentEvent).toBe('missed')

    await openFromHud(page, 'Rent')
    const notice = page.getByRole('dialog', { name: 'Rent' }).locator('[data-rent-notice]')
    await expect(notice).not.toHaveText(/^No rent/)
    await expect(notice).toContainText(/owe \$\d/)
  })
})

// Fix cycle 2: held keys activate once, and a pointer cooldown after each inventory action
// (layout.json overlay.actionCooldownMs) stops a drifting double tap without blocking a
// deliberate follow-up.
test.describe('held keys and the pointer cooldown', () => {
  const COOLDOWN_MS = (
    JSON.parse(readFileSync(new URL('../../data/config/layout.json', import.meta.url), 'utf8')) as {
      readonly overlay: { readonly actionCooldownMs: number }
    }
  ).overlay.actionCooldownMs

  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  const rowOf = (page: Page, id: string) =>
    inventoryDialog(page).locator(`[data-inventory-item="${id}"]`)
  /** Two animation frames: the frame after an action has committed and painted. */
  const settle = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  const pause = (page: Page, ms: number) =>
    page.evaluate((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)), ms)
  /**
   * Holds Enter on the focused element: one press plus `repeats` auto-repeated keydowns
   * (`repeat: true`), each a couple of frames apart so a frame-long guard alone cannot hide them.
   */
  async function holdEnter(page: Page, repeats: number) {
    await page.keyboard.down('Enter')
    for (let i = 0; i < repeats; i += 1) {
      await settle(page)
      await page.keyboard.down('Enter')
    }
    await page.keyboard.up('Enter')
  }
  const centre = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('button is not rendered')
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  test('holding Enter on Wear wears the item once', async ({ page }) => {
    const { wearables } = await shopList(page)
    const [item] = wearables
    if (item === undefined) throw new Error('no wearable')
    await buyThrough(page, [item.id], 1000)
    await openInventory(page)
    await rowOf(page, item.id)
      .getByRole('button', { name: /^Wear / })
      .focus()
    // Four activations unguarded would toggle Wear, Take off, Wear, Take off.
    await holdEnter(page, 3)
    await settle(page)
    expect(Object.values((await hudState(page)).outfit)).toContain(item.id)
    await expect(rowOf(page, item.id).getByRole('button', { name: /^Take off / })).toBeFocused()
  })

  test('holding Enter on a gift stack Sell sells one', async ({ page }) => {
    const { gifts } = await shopList(page)
    const [gift] = gifts
    if (gift === undefined) throw new Error('no gift')
    await buyThrough(page, [gift.id, gift.id, gift.id], 1000)
    await openInventory(page)
    await rowOf(page, gift.id)
      .getByRole('button', { name: /^Sell / })
      .focus()
    await holdEnter(page, 3)
    await settle(page)
    expect((await hudState(page)).gifts[gift.id]).toBe(2)
  })

  test('holding Enter on a gift Buy buys one', async ({ page }) => {
    const { gifts } = await shopList(page)
    const [gift] = gifts
    if (gift === undefined) throw new Error('no gift')
    await openThrift(page, 1000)
    await shopRow(page, gift.id).getByRole('button', { name: /^Buy / }).focus()
    await holdEnter(page, 3)
    await settle(page)
    expect((await hudState(page)).gifts[gift.id]).toBe(1)
  })

  test('two separate taps 100 ms apart on Sell sell only the tapped item', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile-390', 'the drifting double tap is a phone case')
    const { wearables } = await shopList(page)
    const [first, second] = wearables
    if (first === undefined || second === undefined) throw new Error('need two wearables')
    await buyThrough(page, [first.id, second.id], 1000)
    const panel = await openInventory(page)
    const { x, y } = await centre(rowOf(page, first.id).getByRole('button', { name: /^Sell / }))
    await page.mouse.click(x, y)
    await pause(page, 100)
    await page.mouse.click(x, y)
    await expect(rowOf(page, first.id)).toHaveCount(0)
    await pause(page, COOLDOWN_MS)
    const after = await hudState(page)
    expect(after.owned).not.toContain(first.id)
    expect(after.owned).toContain(second.id)
    await expect(panel.getByRole('list').first()).toHaveAttribute('aria-busy', 'false')
  })

  test('a tap on the same spot after the cooldown acts on the row now there', async ({ page }) => {
    const { wearables } = await shopList(page)
    const [first, second] = wearables
    if (first === undefined || second === undefined) throw new Error('need two wearables')
    await buyThrough(page, [first.id, second.id], 1000)
    const panel = await openInventory(page)
    const { x, y } = await centre(rowOf(page, first.id).getByRole('button', { name: /^Sell / }))
    // Record whether the list ever says it is busy: the cooldown is short, so polling for it
    // could miss it under load.
    await page.evaluate(() => {
      const list = document.querySelector('[data-hud-panel-dialog="inventory"] ul')
      if (list === null) throw new Error('no inventory list')
      const seen = { busy: false }
      Object.assign(window, { __busySeen: seen })
      new MutationObserver(() => {
        if (list.getAttribute('aria-busy') === 'true') seen.busy = true
      }).observe(list, { attributes: true, attributeFilter: ['aria-busy'] })
    })
    await page.mouse.click(x, y)
    await expect(rowOf(page, first.id)).toHaveCount(0)
    await pause(page, COOLDOWN_MS + 50)
    expect(
      await page.evaluate(() => (window as { __busySeen?: { busy: boolean } }).__busySeen?.busy),
    ).toBe(true)
    await expect(panel.getByRole('list').first()).toHaveAttribute('aria-busy', 'false')
    // The second row slid under the same spot; a deliberate tap after the cooldown sells it.
    await page.mouse.click(x, y)
    await expect(rowOf(page, second.id)).toHaveCount(0)
    expect((await hudState(page)).owned).toEqual([])
  })

  // UX-6: on a slow phone the two taps of a double tap arrive frames apart on the same button
  // (with `detail` 1, or 2: a touch tap count spans more than the cooldown). Within the cooldown
  // after Wear ran, a touch tap inside that button is ignored though it now says Take off;
  // after the cooldown it acts.
  for (const gapMs of [100, 250, 350]) {
    test(`a second touch tap on Wear ${gapMs} ms later ${gapMs < COOLDOWN_MS ? 'is ignored' : 'takes it off'}`, async ({
      page,
    }) => {
      test.skip(!test.info().project.use.hasTouch, 'touch taps need a touch screen')
      const { wearables } = await shopList(page)
      const [item] = wearables
      if (item === undefined) throw new Error('no wearable')
      await buyThrough(page, [item.id], 1000)
      await openInventory(page)
      const { x, y } = await centre(rowOf(page, item.id).getByRole('button', { name: /^Wear / }))
      // The page's clock: when the first tap's click ran, and when the second finger came down.
      await page.evaluate(() => {
        const times = { clicks: [] as number[], downs: [] as number[] }
        Object.assign(window, { __taps: times })
        document.addEventListener('click', () => times.clicks.push(performance.now()), true)
        document.addEventListener('pointerdown', (event) => times.downs.push(event.timeStamp), true)
      })
      await page.touchscreen.tap(x, y)
      await expect(rowOf(page, item.id).getByRole('button', { name: /^Take off / })).toBeVisible()
      await pause(page, gapMs)
      await page.touchscreen.tap(x, y)
      await settle(page)
      const taps = await page.evaluate(
        () => (window as { __taps?: { clicks: number[]; downs: number[] } }).__taps,
      )
      const ran = taps?.clicks[0]
      const down = taps?.downs[1]
      if (ran === undefined || down === undefined) throw new Error('taps were not seen')
      const gap = down - ran
      expect(gap).toBeGreaterThanOrEqual(gapMs)
      test.info().annotations.push({ type: 'tap gap', description: `${Math.round(gap)} ms` })
      const outfit = async () => Object.values((await hudState(page)).outfit)
      // A short pause can overrun on a starved test machine; the rule is about the real gap,
      // so the expectation follows it (and the annotation records it).
      if (gap < COOLDOWN_MS) {
        await pause(page, COOLDOWN_MS)
        expect(await outfit()).toContain(item.id)
      } else {
        await expect.poll(outfit).not.toContain(item.id)
      }
    })
  }
})
