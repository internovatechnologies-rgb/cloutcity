import type { Page } from '@playwright/test'
import type { PlaceTestHook } from '@/components/places/placeTestHook'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

/**
 * The place hook is installed and the 3D map has finished starting: on SwiftShader the map's
 * start keeps the main thread busy for seconds (PERF-4), so the overlay checks below wait for
 * it instead of racing it.
 */
async function ready(page: Page) {
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
}

// S15: reaching Icon shows the victory screen (a modal) instead of a level-up toast, with a
// share hook, Keep playing (never shown again this run, across reloads) and a two-step prestige
// that restarts the run at Nobody with the start cash and keeps the badge it earned.

// src/state/store.ts STORE_KEY and src/engine/save.ts SAVE_VERSION, not imported: Playwright's
// loader cannot load the store's JSON imports.
const STORE_KEY = 'cloutcity:game'
const SAVE_VERSION = 8
const NOON = 12 * 60
const FOOTER = 'Tap In. Blow Up. | Clout City: NYC'

/** A v8 save a few points short of Icon (earned clout), with every goal still to reach. */
async function seedNearIcon(page: Page, run = 1) {
  const save = {
    state: {
      clock: { minute: NOON, remainderMs: 0 },
      player: {
        cash: 500,
        stats: { energy: 100, hunger: 80, mood: 80 },
        clout: {
          ledger: [],
          compacted: { entries: 1, bySource: { legacy: 4996 } },
          nextSeq: 1,
          peakLevel: 4,
          firstPaycheckPaid: true,
        },
        flex: { rngState: 0, byPlace: {} },
        home: 'queens-room',
        rent: { owed: 0, missed: 0 },
        inventory: { wearables: [], gifts: [], outfit: {} },
        clubNights: {},
        visited: {},
      },
      speed: 1,
      events: { active: null, history: {}, pending: [], rngState: 0 },
      goals: { run, achieved: {}, icon: { reachedAt: null, acknowledged: false } },
      grants: { log: [], nextSeq: 1 },
      prestige: {
        count: run - 1,
        badges: ['prestige-1', 'prestige-2', 'prestige-3'].slice(0, run - 1),
        history: Array.from({ length: run - 1 }, (_, i) => ({
          run: i + 1,
          endedAt: NOON - 10,
          issuedAtMs: 1_760_000_000_000,
          badge: `prestige-${i + 1}`,
        })),
      },
    },
    version: SAVE_VERSION,
  }
  await page.addInitScript(
    ([key, raw]) => {
      if (sessionStorage.getItem('seeded') !== null) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem(key, raw)
    },
    [STORE_KEY, JSON.stringify(save)] as const,
  )
}

/** Records every navigator.share call on `window.__shares` (no real share sheet in tests). */
async function stubShare(page: Page) {
  await page.addInitScript(() => {
    const calls: ShareData[] = []
    Object.assign(window, { __shares: calls })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: (data: ShareData) => {
        calls.push(data)
        return Promise.resolve()
      },
    })
  })
}

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await ready(page)
}

const state = (page: Page) =>
  page.evaluate((): ReturnType<PlaceTestHook['state']> => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    return places.state()
  })

const meter = (page: Page) =>
  page.locator('[data-overlay-zone="hud"]').getByRole('progressbar', { name: /^Clout: / })

const moment = (page: Page) => page.getByRole('dialog', { name: 'Icon status' })

/** One flex at the Queens ballpark: the action that crosses Icon. */
async function crossIcon(page: Page) {
  await page.evaluate(() => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    if (!places.open('queens-ballpark')) throw new Error('no queens-ballpark')
  })
  await page
    .locator('[data-place-sheet="queens-ballpark"]')
    .getByRole('button', { name: /^Flex: / })
    .click()
  await expect(moment(page)).toBeVisible()
}

test.describe('the Icon moment', () => {
  test.beforeEach(async ({ page }) => {
    await seedNearIcon(page)
    await stubShare(page)
    await boot(page)
  })

  test('one action past Icon shows the victory screen: focus, share, keep playing', async ({
    page,
    checkA11y,
  }) => {
    await expect(meter(page)).toHaveAccessibleName(/^Clout: Famous, /)
    await crossIcon(page)
    const dialog = moment(page)
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog.getByRole('heading', { name: 'Icon status' })).toBeFocused()
    await expect(dialog).toContainText('You made it in New York. The whole city knows your name.')
    // The moment replaces the Icon level-up toast.
    await expect(page.locator('[data-level-up="icon"]')).toHaveCount(0)
    await checkA11y()

    // Every button is a thumb-sized target, and Tab stays inside the dialog.
    const buttons = dialog.getByRole('button')
    await expect(buttons).toHaveCount(3)
    for (const box of await Promise.all((await buttons.all()).map((b) => b.boundingBox()))) {
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    }
    await dialog.getByRole('button', { name: 'Keep playing' }).focus()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Share' })).toBeFocused()

    await dialog.getByRole('button', { name: 'Share' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Shared.')
    const shares = await page.evaluate(
      () => (window as unknown as { __shares: ShareData[] }).__shares,
    )
    const origin = new URL(page.url()).origin
    expect(shares).toEqual([{ text: expect.stringContaining(FOOTER) as unknown, url: origin }])

    await dialog.getByRole('button', { name: 'Keep playing' }).click()
    await expect(dialog).toHaveCount(0)
    // Focus lands on the HUD's Goals button, not lost on the body.
    await expect(
      page.locator('[data-overlay-zone="hud"]').getByRole('button', { name: /^Goals/ }),
    ).toBeFocused()
    await expect(meter(page)).toHaveAccessibleName(/^Clout: Icon, /)

    await page.reload()
    await ready(page)
    await expect(meter(page)).toHaveAccessibleName(/^Clout: Icon, /)
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
  })

  test('prestige asks first, then restarts at Nobody with the start cash and keeps the badge', async ({
    page,
    checkA11y,
  }) => {
    await crossIcon(page)
    const dialog = moment(page)
    await dialog.getByRole('button', { name: 'Prestige' }).click()
    const confirm = page.getByRole('dialog', { name: 'Run it back?' })
    await expect(confirm.getByRole('heading', { name: 'Run it back?' })).toBeFocused()
    await expect(confirm.locator('[data-prestige-resets]')).toContainText('Your cash')
    await expect(confirm.locator('[data-prestige-keeps]')).toContainText('Your badges')
    await expect(confirm).toContainText('You earn the Prestige I badge.')
    await checkA11y()
    // Not yet: back to the moment, nothing changed.
    await confirm.getByRole('button', { name: 'Not yet' }).click()
    await expect(dialog.getByRole('heading', { name: 'Icon status' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Prestige' }).click()

    await page.getByRole('button', { name: 'Start over at Nobody, keep your badges' }).click()
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
    await expect(meter(page)).toHaveAccessibleName('Clout: Nobody, 0 of 100 to Local')
    expect((await state(page)).cash).toBe(150)

    await page.reload()
    await ready(page)
    await expect(meter(page)).toHaveAccessibleName('Clout: Nobody, 0 of 100 to Local')
    expect((await state(page)).cash).toBe(150)
    await page
      .locator('[data-overlay-zone="hud"]')
      .getByRole('button', { name: /^Goals/ })
      .click()
    const goals = page.getByRole('dialog', { name: 'Goals' })
    await expect(goals.locator('[data-badge="prestige-1"]')).toHaveText('Prestige I')
    await expect(goals).toContainText('Run 2')
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
  })
})

const goalsButton = (page: Page) =>
  page.locator('[data-overlay-zone="hud"]').getByRole('button', { name: /^Goals/ })

test.describe('the Icon moment: keyboard, focus, run 2, motion', () => {
  test('Escape steps back from the confirm, then keeps playing; focus returns to Goals', async ({
    page,
  }) => {
    await seedNearIcon(page)
    await stubShare(page)
    await boot(page)
    await crossIcon(page)
    const dialog = moment(page)
    // Shift+Tab from the title wraps to the last button; Tab from it wraps to the first.
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: 'Keep playing' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Share' })).toBeFocused()

    await dialog.getByRole('button', { name: 'Prestige' }).click()
    const confirm = page.getByRole('dialog', { name: 'Run it back?' })
    await expect(confirm.getByRole('heading', { name: 'Run it back?' })).toBeFocused()
    // The description adds to the title rather than reading it a second time.
    await expect(confirm).toHaveAccessibleDescription(/^Start from zero, keep what's yours\./)
    // Unclaimed goal rewards would be given up: the confirm says how many (grants stay explicit).
    const unclaimed = confirm.locator('[data-prestige-unclaimed]')
    await expect(unclaimed).toBeVisible()
    await expect(unclaimed).toContainText(/goal rewards? you haven't claimed/)
    // The way out is on screen without scrolling, above the tab bar.
    const notYet = confirm.getByRole('button', { name: 'Not yet' })
    await expect(notYet).toBeInViewport({ ratio: 1 })
    const tabs = await page.locator('[data-overlay-zone="tabs"]').boundingBox()
    const box = await notYet.boundingBox()
    if (tabs !== null && box !== null) expect(box.y + box.height).toBeLessThanOrEqual(tabs.y)
    // "Not yet" comes first (it stays on screen above the tab bar at 390 x 844).
    await page.keyboard.press('Shift+Tab')
    await expect(
      confirm.getByRole('button', { name: 'Start over at Nobody, keep your badges' }),
    ).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(confirm.getByRole('button', { name: 'Not yet' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog.getByRole('heading', { name: 'Icon status' })).toBeFocused()
    expect((await state(page)).level).toBe('icon')

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
    await expect(goalsButton(page)).toBeFocused()
    await page.reload()
    await ready(page)
    await expect(meter(page)).toHaveAccessibleName(/^Clout: Icon, /)
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
  })

  test('run 2 shows the moment again, earns Prestige II, and focus returns to Goals', async ({
    page,
  }) => {
    await seedNearIcon(page, 2)
    await stubShare(page)
    await boot(page)
    await crossIcon(page)
    await moment(page).getByRole('button', { name: 'Prestige' }).click()
    const confirm = page.getByRole('dialog', { name: 'Run it back?' })
    await expect(confirm).toContainText('You earn the Prestige II badge.')
    await confirm.getByRole('button', { name: 'Start over at Nobody, keep your badges' }).click()
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
    await expect(goalsButton(page)).toBeFocused()
    await goalsButton(page).click()
    const goals = page.getByRole('dialog', { name: 'Goals' })
    await expect(goals.locator('[data-badge]')).toHaveText(['Prestige I', 'Prestige II'])
    await expect(goals).toContainText('Run 3')
  })

  test('after Keep playing, claim a reward, then prestige from the Goals panel', async ({
    page,
    checkA11y,
  }) => {
    await seedNearIcon(page)
    await stubShare(page)
    await boot(page)
    await crossIcon(page)
    await moment(page).getByRole('button', { name: 'Keep playing' }).click()
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)

    // Prestige waits in Goals for an Icon player, with the badge it earns named from config.
    await goalsButton(page).click()
    const goals = page.getByRole('dialog', { name: 'Goals' })
    const entry = goals.locator('[data-goals-prestige]')
    await expect(entry).toBeVisible()
    await expect(entry).toHaveAccessibleName(
      'Prestige: start over at Nobody and earn the Prestige I badge',
    )
    await checkA11y()

    // Claim one reward first; the confirm then counts what is still unclaimed.
    const claimable = goals.locator('[data-goal] button:not([aria-disabled])')
    const before = await claimable.count()
    expect(before).toBeGreaterThan(0)
    await claimable.first().click()
    await expect(goals.locator('[data-panel-status]')).toContainText('claimed')
    await expect(claimable).toHaveCount(before - 1)

    // Opened from Goals, Not yet closes the confirm and gives focus back to the entry. The panel's
    // action guard ignores a click on another row in the spot just tapped until its cooldown ends.
    await expect(goals.locator('[aria-busy="true"]')).toHaveCount(0)
    await entry.click()
    const confirm = page.getByRole('dialog', { name: 'Run it back?' })
    await expect(confirm.getByRole('heading', { name: 'Run it back?' })).toBeFocused()
    if (before - 1 > 0) {
      await expect(confirm.locator('[data-prestige-unclaimed]')).toHaveAttribute(
        'data-prestige-unclaimed',
        String(before - 1),
      )
      await expect(confirm).toContainText('Claim them in Goals first')
    }
    await confirm.getByRole('button', { name: 'Not yet' }).click()
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
    await expect(entry).toBeFocused()

    // And the prestige itself: run 2 at Nobody with the badge, and no entry until Icon again.
    await entry.click()
    await confirm.getByRole('button', { name: 'Start over at Nobody, keep your badges' }).click()
    await expect(page.locator('[data-icon-moment]')).toHaveCount(0)
    expect((await state(page)).level).toBe('nobody')
    await expect(goals.locator('[data-badge]')).toHaveText(['Prestige I'])
    await expect(goals).toContainText('Run 2')
    await expect(goals.locator('[data-goals-prestige]')).toHaveCount(0)
  })

  test('reduced motion: the celebration does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await seedNearIcon(page)
    await stubShare(page)
    await boot(page)
    await crossIcon(page)
    const name = await page
      .locator('.icon-moment-burst')
      .evaluate((element) => getComputedStyle(element).animationName)
    expect(name).toBe('none')
  })
})

test.describe('the Icon moment: share fallbacks', () => {
  test('a cancelled share sheet does nothing more', async ({ page }) => {
    await seedNearIcon(page)
    await page.addInitScript(() => {
      const writes: string[] = []
      Object.assign(window, { __writes: writes })
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text: string) => (writes.push(text), Promise.resolve()) },
      })
    })
    await boot(page)
    await crossIcon(page)
    const dialog = moment(page)
    await dialog.getByRole('button', { name: 'Share' }).click()
    await expect(dialog.getByRole('status')).toHaveText('')
    await expect(dialog.locator('[data-share-text]')).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { __writes: string[] }).__writes),
    ).toEqual([])
    await expect(dialog.getByRole('button', { name: 'Share' })).toBeVisible()
  })

  test('no share sheet and a denied clipboard show the text to copy', async ({ page }) => {
    await seedNearIcon(page)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: () => Promise.reject(new DOMException('no', 'NotAllowedError')),
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        },
      })
    })
    await boot(page)
    await crossIcon(page)
    const dialog = moment(page)
    await dialog.getByRole('button', { name: 'Share' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Copy this and share it:')
    const origin = new URL(page.url()).origin
    await expect(dialog.locator('[data-share-text]')).toContainText(FOOTER)
    await expect(dialog.locator('[data-share-text]')).toContainText(origin)
  })
})

test.describe('the Icon moment: the HUD island fails to load', () => {
  // The test aborts the chunk itself, which Chromium reports as a resource error.
  test.use({ injectedConsoleErrors: [/^Failed to load resource: net::ERR_FAILED$/] })

  test('a pending moment shows once the HUD retry loads the island', async ({ page }) => {
    const save = {
      state: {
        clock: { minute: NOON, remainderMs: 0 },
        player: {
          cash: 500,
          stats: { energy: 100, hunger: 80, mood: 80 },
          clout: {
            ledger: [],
            compacted: { entries: 1, bySource: { legacy: 5000 } },
            nextSeq: 1,
            peakLevel: 5,
            firstPaycheckPaid: true,
          },
          flex: { rngState: 0, byPlace: {} },
          home: 'queens-room',
          rent: { owed: 0, missed: 0 },
          inventory: { wearables: [], gifts: [], outfit: {} },
          clubNights: {},
          visited: {},
        },
        speed: 1,
        events: { active: null, history: {}, pending: [], rngState: 0 },
        goals: {
          run: 1,
          achieved: { 'reach-icon': NOON },
          icon: { reachedAt: NOON, acknowledged: false },
        },
        grants: { log: [], nextSeq: 1 },
        prestige: { count: 0, badges: [], history: [] },
      },
      version: SAVE_VERSION,
    }
    await page.addInitScript(([key, raw]) => localStorage.setItem(key, raw), [
      STORE_KEY,
      JSON.stringify(save),
    ] as const)
    const gate = { fail: true }
    const html = await (await page.request.get('/')).text()
    const shell = new Set(
      Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), (match) => match[1]),
    )
    await page.route('**/_next/static/chunks/**/*.js', async (route) => {
      if (shell.has(new URL(route.request().url()).pathname)) return route.continue()
      const response = await route.fetch()
      const body = await response.text()
      // The 3D map's chunk stays in flight: this test is about the HUD island, and starting the
      // map on SwiftShader blocks the main thread for seconds (PERF-4), long enough to delay the
      // island's failure past the retry check (as lazy-features.spec.ts `holdMap` does).
      if (body.includes('cc-feature:city-scene')) return new Promise<void>(() => {})
      if (gate.fail && body.includes('cc-feature:clout-hud')) return route.abort('failed')
      return route.fulfill({ response, body })
    })
    await page.goto('/')
    const hud = page.locator('[data-overlay-zone="hud"]')
    const retry = hud.getByRole('button', { name: 'Try again' })
    await expect(retry).toBeVisible()
    gate.fail = false
    await retry.click()
    await expect(moment(page)).toBeVisible()
    await expect(moment(page).getByRole('heading', { name: 'Icon status' })).toBeFocused()
  })
})
