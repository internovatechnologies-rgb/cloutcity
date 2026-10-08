import type { Page } from '@playwright/test'
import type { EventContext } from '@/engine/events'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S14: an event opens as a modal in the overlay sheet zone, the player picks an option by
// touch, click or keyboard, and the outcome lands in the game state. Events are opened through
// the test-only hook (src/components/events/eventTestHook.ts), which still applies the engine's
// conditions and safety rules.

const BODEGA: EventContext = {
  borough: 'queens',
  locationId: null,
  locationCategory: 'bodega',
  itemIds: [],
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(() => window.__cloutcityTest?.events !== undefined)
  await waitForMapSettled(page)
}

function openEvent(page: Page, eventId: string, context: EventContext) {
  return page.evaluate(
    ([id, ctx]) => {
      const hook = window.__cloutcityTest?.events
      if (hook === undefined) throw new Error('event test hook is not installed')
      return hook.open(id, ctx)
    },
    [eventId, context] as const,
  )
}

function gameState(page: Page) {
  return page.evaluate(() => {
    const hook = window.__cloutcityTest?.events
    if (hook === undefined) throw new Error('event test hook is not installed')
    return hook.state()
  })
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).boundingBox()
  if (!found) throw new Error(`${selector} is not rendered`)
  return found
}

test.describe('events', () => {
  test('no event, no dialog: the empty sheet zone lets touches through', async ({ page }) => {
    await boot(page)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const passThrough = await page.evaluate(() => {
      const sheet = document.querySelector('[data-overlay-zone="sheet"]')
      const r = sheet?.getBoundingClientRect()
      if (!r) throw new Error('sheet zone missing')
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return hit?.closest('[data-overlay-zone]') === null
    })
    expect(passThrough, 'touches in the empty sheet zone reach the scene').toBe(true)
  })

  test('opens as a modal in the sheet zone, chosen by keyboard, outcome applied', async ({
    page,
    checkA11y,
  }) => {
    await boot(page)
    const before = await gameState(page)
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)

    const dialog = page.getByRole('dialog', { name: 'The bodega cat chose you' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toContainText('Bodega cat hops on the counter')

    // UX-1: inside the sheet zone, inside the viewport, clear of the HUD and tab bar.
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('viewport size is not set')
    const dialogBox = await box(page, '[role="dialog"]')
    const sheet = await box(page, '[data-overlay-zone="sheet"]')
    expect(dialogBox.y).toBeGreaterThanOrEqual(sheet.y)
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(sheet.y + sheet.height)
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width)
    for (const zone of ['banner', 'hud', 'toast', 'tabs']) {
      const other = await box(page, `[data-overlay-zone="${zone}"]`)
      expect(overlaps(dialogBox, other), `dialog overlaps ${zone}`).toBe(false)
    }

    // 44 px targets, labelled with what each choice does.
    const pet = dialog.getByRole('button', { name: /Pet the cat/ })
    const treat = dialog.getByRole('button', { name: /Buy the cat a treat.*Costs \$2/ })
    for (const button of [pet, treat]) {
      const target = await button.boundingBox()
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(target?.width ?? 0).toBeGreaterThanOrEqual(44)
    }

    // Modal: the rest of the screen is inert; focus starts on the first choice and is trapped.
    await expect(page.locator('[data-overlay-zone="tabs"]')).toHaveAttribute('inert', '')
    await expect(pet).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(treat).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(pet).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(treat).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(pet).toBeFocused()

    await checkA11y()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(dialog).toContainText('Treat secured.')
    await expect(dialog).toContainText('Costs $2, 5 min, +10 mood')
    const proceed = dialog.getByRole('button', { name: 'Continue' })
    await expect(proceed).toBeFocused()
    expect(await gameState(page)).toMatchObject({
      cash: before.cash - 2,
      minute: before.minute + 5,
      stats: { ...before.stats, mood: Math.min(100, before.stats.mood + 10) },
      activeEvent: null,
    })

    await checkA11y()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await expect(page.locator('[data-overlay-zone="tabs"]')).not.toHaveAttribute('inert')
  })

  test('chosen by touch or click; the clout lands at once', async ({ page }) => {
    await boot(page)
    // The viral moment needs mood of at least 60; a new player starts at 70.
    expect(
      (
        await openEvent(page, 'viral-moment', {
          ...BODEGA,
          locationId: null,
          locationCategory: null,
        })
      ).ok,
    ).toBe(true)
    const post = page.getByRole('dialog', { name: 'Viral moment' }).getByRole('button', {
      name: /Post it.*\+6 clout/,
    })
    if (test.info().project.use.hasTouch) await post.tap()
    else await post.click()
    await expect(page.getByRole('dialog')).toContainText('Notifications won')
    // S13: event clout is applied now (no outfit, so unscaled), not kept pending.
    await expect(page.getByRole('dialog')).toContainText('+6 clout')
    const state = await gameState(page)
    expect(state.clout).toBe(6)
    expect(state.pendingEffects).toBe(0)
    expect(state.activeEvent).toBeNull()
  })

  test('an open event survives a reload', async ({ page }) => {
    await boot(page)
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('dialog', { name: 'The bodega cat chose you' })).toBeVisible()
  })

  test('nothing opens at a memorial', async ({ page }) => {
    await boot(page)
    const memorial: EventContext = {
      ...BODEGA,
      locationId: 'a-memorial',
      locationCategory: 'memorial',
    }
    const result = await openEvent(page, 'bodega-cat', memorial)
    expect(result).toEqual({
      ok: false,
      error: { code: 'EVENT_NOT_ELIGIBLE', eventId: 'bodega-cat' },
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

// src/state/store.ts STORE_KEY. Not imported: Playwright's loader cannot load the store's JSON imports.
const STORE_KEY = 'cloutcity:game'
// src/engine/save.ts SAVE_VERSION (v5 adds event state, v6 club nights, v7 the clout ledger, v8
// goals, grants and prestige), not imported for the same reason. A seeded save without the v8
// fields loads with them fresh.
const SAVE_VERSION = 8
// The version every load re-saves as (src/engine/save.ts SAVE_VERSION: v9 apartment, v10 location and
// transit, v11 cloud sync), not imported for the same reason.
const CURRENT_SAVE_VERSION = 11

/** True when a click at the centre of the sheet zone lands outside every overlay zone. */
function sheetPassesThrough(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-overlay-zone="sheet"]')
    const r = sheet?.getBoundingClientRect()
    if (!r) throw new Error('sheet zone missing')
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit !== null && hit.closest('[data-overlay-zone]') === null
  })
}

/** Seeds a save before the app's first script runs, only on the first load of the page. */
async function seedSave(page: Page, value: string) {
  await page.addInitScript(
    ([key, raw]) => {
      if (sessionStorage.getItem('seeded') !== null) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem(key, raw)
    },
    [STORE_KEY, value] as const,
  )
}

test.describe('events: edge cases', () => {
  test('the empty sheet zone lets touches through before the event host loads, and after', async ({
    page,
  }) => {
    // Hold back the boot island with the game store (the only chunk that names its save key).
    // The event host, and so the test hook, cannot run until it loads.
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    await page.route('**/_next/static/chunks/**/*.js', async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      if (body.includes(STORE_KEY)) {
        held = true
        await released
      }
      await route.fulfill({ response, body })
    })
    await page.addInitScript(() => {
      window.__CLOUTCITY_E2E__ = true
    })
    // A held boot-island chunk delays the load event, so do not wait for it.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await expect.poll(() => held, { message: 'the store chunk is requested at boot' }).toBe(true)
    expect(await page.evaluate(() => window.__cloutcityTest?.events)).toBeUndefined()
    expect(await sheetPassesThrough(page), 'before the chunk loads').toBe(true)

    release()
    await page.waitForFunction(() => window.__cloutcityTest?.events !== undefined)
    expect(await sheetPassesThrough(page), 'after the chunk loads').toBe(true)

    // And again once an event has opened and closed.
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)
    expect(await sheetPassesThrough(page), 'an open event takes the zone').toBe(false)
    await page.getByRole('button', { name: /Pet the cat/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await sheetPassesThrough(page), 'after the event closes').toBe(true)
  })

  test('Escape does not close a forced choice; focus returns to where it was', async ({ page }) => {
    await boot(page)
    const shop = page.locator('[data-tab="shop"]')
    await shop.focus()
    await expect(shop).toBeFocused()
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)
    const dialog = page.getByRole('dialog', { name: 'The bodega cat chose you' })
    await expect(dialog.getByRole('button', { name: /Pet the cat/ })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    expect((await gameState(page)).activeEvent).toBe('bodega-cat')

    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    for (const zone of ['banner', 'hud', 'toast', 'tabs']) {
      await expect(page.locator(`[data-overlay-zone="${zone}"]`)).not.toHaveAttribute('inert')
    }
    await expect(shop).toBeFocused()
  })

  test('after a reload with an event open, the dialog is modal, in the sheet zone, and closes cleanly', async ({
    page,
    checkA11y,
  }) => {
    await boot(page)
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)
    await page.reload()
    const dialog = page.getByRole('dialog', { name: 'The bodega cat chose you' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Pet the cat/ })).toBeFocused()
    await expect(page.locator('[data-overlay-zone="tabs"]')).toHaveAttribute('inert', '')

    const dialogBox = await box(page, '[role="dialog"]')
    const sheet = await box(page, '[data-overlay-zone="sheet"]')
    expect(dialogBox.y).toBeGreaterThanOrEqual(sheet.y)
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(sheet.y + sheet.height)
    await checkA11y()

    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: /Pet the cat/ })).toBeFocused()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('[data-overlay-zone="tabs"]')).not.toHaveAttribute('inert')
    await page.locator('[data-tab="me"]').click()
    await expect(page.locator('[data-tab="me"]')).toHaveAttribute('aria-current', 'page')
  })

  test('a choice the player cannot afford is disabled and says so; the free one works', async ({
    page,
    checkA11y,
  }) => {
    await seedSave(
      page,
      JSON.stringify({
        state: {
          clock: { minute: 720, remainderMs: 0 },
          player: {
            cash: 1,
            stats: { energy: 80, hunger: 50, mood: 60 },
            clout: {
              ledger: [],
              compacted: { entries: 0, bySource: {} },
              nextSeq: 1,
              peakLevel: 0,
              firstPaycheckPaid: false,
            },
            flex: { rngState: 0, byPlace: {} },
            home: 'queens-room',
            rent: { owed: 0, missed: 0 },
            inventory: { wearables: [], gifts: [], outfit: {} },
            clubNights: {},
          },
          speed: 1,
          events: { active: null, history: {}, pending: [], rngState: 0 },
        },
        version: SAVE_VERSION,
      }),
    )
    await boot(page)
    expect((await gameState(page)).cash).toBe(1)
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)
    const dialog = page.getByRole('dialog', { name: 'The bodega cat chose you' })
    const treat = dialog.getByRole('button', { name: /Buy the cat a treat.*Not enough cash/ })
    await expect(treat).toBeDisabled()
    await checkA11y()
    // The trap skips the disabled choice.
    const pet = dialog.getByRole('button', { name: /Pet the cat/ })
    await expect(pet).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(treat).not.toBeFocused()
    await treat.click({ force: true })
    expect((await gameState(page)).cash).toBe(1)
    expect((await gameState(page)).activeEvent).toBe('bodega-cat')
    await pet.click()
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeVisible()
    expect((await gameState(page)).cash).toBe(1)
  })

  test('a v2 save boots with its progress and no event, and is re-saved as the current version', async ({
    page,
  }) => {
    await seedSave(
      page,
      JSON.stringify({
        state: {
          clock: { minute: 2000, remainderMs: 0 },
          player: { cash: 321, stats: { energy: 40, hunger: 50, mood: 60 } },
          speed: 1,
        },
        version: 2,
      }),
    )
    await boot(page)
    const state = await gameState(page)
    expect(state).toMatchObject({ cash: 321, activeEvent: null, pendingEffects: 0 })
    expect(state.minute).toBeGreaterThanOrEqual(2000)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').version, STORE_KEY),
      )
      .toBe(CURRENT_SAVE_VERSION)
  })

  test('a save from a newer build is not overwritten by opening or resolving an event', async ({
    page,
  }) => {
    const newer = JSON.stringify({ state: { future: true }, version: 99 })
    await seedSave(page, newer)
    await boot(page)
    expect((await openEvent(page, 'bodega-cat', BODEGA)).ok).toBe(true)
    await page.getByRole('button', { name: /Pet the cat/ }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    expect(await page.evaluate((key) => localStorage.getItem(key), STORE_KEY)).toBe(newer)
  })
})
