import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { PlaceTestHook } from '@/components/places/placeTestHook'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

// S13: flexing at a landmark earns clout, the HUD clout meter follows it, and crossing a level
// shows the level-up toast in the toast zone. Places are opened and the player set up through
// the place test hook (src/components/places/placeTestHook.ts); actions still run through the
// engine. Numbers come from the hook, so the spec does not move when balance.json is tuned.

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  // The toast specs time a 6 s toast against a fake clock; the 3D map's start-up blocks the main
  // thread for seconds on SwiftShader (FLAKE-3), so it must be over before anything is timed.
  await waitForMapSettled(page)
}

/**
 * Pauses the fake clock just ahead of the page's time. A busy main thread can let the page's
 * clock pass the target before the pause lands ("Cannot fast-forward to the past"): read the
 * clock again and retry, so the pause always lands in the future.
 */
async function pauseSoon(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const now = await page.evaluate(() => Date.now())
    try {
      await page.clock.pauseAt(now + 100)
      return
    } catch (error) {
      if (attempt >= 5 || !/past/i.test(String(error))) throw error
    }
  }
}

async function openPlace(page: Page, id: string, minuteOfDay: number, clout: number) {
  await page.evaluate(
    ([placeId, minute, points]) => {
      const places = window.__cloutcityPlaces
      if (places === undefined) throw new Error('place test hook is not installed')
      places.setTimeOfDay(minute)
      places.setClout(points)
      if (!places.open(placeId)) throw new Error(`no place ${placeId}`)
    },
    [id, minuteOfDay, clout] as const,
  )
}

const state = (page: Page) =>
  page.evaluate((): ReturnType<PlaceTestHook['state']> => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    return places.state()
  })

const meter = (page: Page) =>
  page.locator('[data-overlay-zone="hud"]').getByRole('progressbar', { name: /^Clout: / })

const NOON = 12 * 60
/** data/config/layout.json `overlay.toastMs`, read from the file (the spec cannot import JSON). */
const TOAST_MS = (
  JSON.parse(readFileSync(new URL('../../data/config/layout.json', import.meta.url), 'utf8')) as {
    overlay: { toastMs: number }
  }
).overlay.toastMs

test.describe('clout, flexing and levels', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('a flex at a landmark shows its result and the HUD meter advances', async ({
    page,
    checkA11y,
  }) => {
    await openPlace(page, 'queens-ballpark', NOON, 0)
    await expect(meter(page)).toHaveAccessibleName('Clout: Nobody, 0 of 100 to Local')
    const card = page.getByRole('dialog', { name: 'Queens ballpark' })
    const flex = card.getByRole('button', { name: /^Flex: \d+ min, \d+ energy, \+\d+ clout$/ })
    await expect(flex).toBeEnabled()
    await checkA11y()

    await flex.click()
    await expect(card.getByRole('status')).toHaveText(
      // Noon: the flex copy names the light it was posted in (S04f keyframe `day`).
      /^(Queens ballpark in broad daylight\. The algorithm is about to eat\.|Gone viral\. The whole city's reposting\.) \+\d+ clout$/,
    )
    const after = await state(page)
    expect(after.clout).toBeGreaterThan(0)
    await expect(meter(page)).toHaveAccessibleName(`Clout: Nobody, ${after.clout} of 100 to Local`)
    await expect(meter(page)).toHaveAttribute('value', String(after.clout))
    // Nothing crossed a level: no toast.
    await expect(page.locator('[data-level-up]')).toHaveCount(0)
  })

  test('a used-up flex is disabled and its accessible name says why', async ({ page }) => {
    await openPlace(page, 'queens-ballpark', NOON, 0)
    const card = page.getByRole('dialog', { name: 'Queens ballpark' })
    await card.getByRole('button', { name: /^Flex: / }).click()
    await card.getByRole('button', { name: 'Dismiss' }).click()
    const flex = card.getByRole('button', { name: /^Flex: / })
    await expect(flex).toBeDisabled()
    await expect(flex).toHaveAccessibleName(
      /\. You already flexed here today\. Try another spot\.$/,
    )
  })

  test('crossing into Local shows the level-up toast in the toast zone without taking focus', async ({
    page,
    checkA11y,
  }) => {
    // The toast closes itself after toastMs: the clock is paused while it is inspected, so
    // the checks cannot outlast it. axe and clicks need running timers and frames, so the clock
    // runs again for the scan and the close.
    await page.clock.install()
    await openPlace(page, 'queens-ballpark', NOON, 98)
    const card = page.getByRole('dialog', { name: 'Queens ballpark' })
    await card.getByRole('button', { name: /^Flex: / }).click()
    const toast = page.locator('[data-overlay-zone="toast"] [data-level-up="local"]')
    await expect(toast).toBeVisible()
    await pauseSoon(page)
    await expect(toast).toContainText('New level: Local')
    await expect(toast).toContainText("Your name's starting to ring. Brooklyn noticed.")
    await expect(toast).toContainText(/Unlocked: Brooklyn/)
    // The sheet's result keeps focus; the toast only announces itself (polite live region).
    await expect(card.getByRole('button', { name: 'Dismiss' })).toBeFocused()
    await expect(page.locator('[data-overlay-zone="toast"]')).toHaveAttribute('aria-live', 'polite')
    await expect(meter(page)).toHaveAccessibleName(/^Clout: Local, \d+ of 300 to Scene Regular$/)
    const close = toast.getByRole('button', { name: 'Close the Local message' })
    await page.clock.resume()
    // Measured once the pop has finished (it scales the toast while it plays).
    // A pop that is cancelled (the toast re-rendered) rejects `finished`; either way it is over.
    await toast.evaluate((el) =>
      Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))),
    )
    const box = await close.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    // Hold the toast open through the scan (it pauses while hovered, WCAG 2.2.1): a slow axe run
    // on a busy machine could otherwise outlast toastMs and close it before the click.
    await close.hover()
    await checkA11y()
    await close.click()
    await expect(toast).toHaveCount(0)
    expect((await state(page)).level).toBe('local')
  })

  test('the level-up toast stays while hovered or focused (WCAG 2.2.1), then closes itself', async ({
    page,
  }) => {
    await openPlace(page, 'queens-ballpark', NOON, 98)
    const card = page.getByRole('dialog', { name: 'Queens ballpark' })
    await card.getByRole('button', { name: /^Flex: / }).click()
    const toast = page.locator('[data-overlay-zone="toast"] [data-level-up="local"]')
    await expect(toast).toBeVisible()

    await toast.hover()
    await expect(toast).toHaveAttribute('data-paused', '')
    await page.waitForTimeout(TOAST_MS + 500)
    await expect(toast).toBeVisible()

    // Focus inside it keeps it too, even with the pointer gone.
    await toast.getByRole('button', { name: 'Close the Local message' }).focus()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(TOAST_MS + 500)
    await expect(toast).toBeVisible()

    // Neither hovered nor focused: the timer runs again and the toast closes itself.
    await card.getByRole('button', { name: 'Dismiss' }).focus()
    await expect(toast).not.toHaveAttribute('data-paused')
    await page.waitForTimeout(TOAST_MS + 500)
    await expect(toast).toHaveCount(0)
  })

  test('a memorial sheet has no Flex', async ({ page }) => {
    await openPlace(page, 'september-11-memorial', NOON, 5000)
    const card = page.locator('[data-place-sheet="september-11-memorial"]')
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: /^Flex/ })).toHaveCount(0)
    await expect(card.getByText(/clout/i)).toHaveCount(0)
  })
})

// src/state/store.ts STORE_KEY and src/engine/save.ts SAVE_VERSION, not imported: Playwright's
// loader cannot load the store's JSON imports.
const STORE_KEY = 'cloutcity:game'
const SAVE_VERSION = 8

/**
 * A save whose player holds `earned` clout but has only ever reached Nobody, so the next gain
 * past Icon is one level-up listing every unlock on the way: the longest toast there is. Its
 * run has already reached Icon and seen the Icon moment (S15), so the level-up shows as a toast
 * rather than the victory screen taking over (tests/e2e/icon-moment.spec.ts covers that).
 */
async function seedUnreachedClout(page: Page, earned: number) {
  const save = {
    state: {
      clock: { minute: NOON, remainderMs: 0 },
      player: {
        cash: 500,
        stats: { energy: 100, hunger: 80, mood: 80 },
        clout: {
          ledger: [],
          compacted: { entries: 1, bySource: { legacy: earned } },
          nextSeq: 1,
          peakLevel: 0,
          firstPaycheckPaid: true,
        },
        flex: { rngState: 0, byPlace: {} },
        home: 'queens-room',
        rent: { owed: 0, missed: 0 },
        inventory: { wearables: [], gifts: [], outfit: {} },
        clubNights: {},
      },
      speed: 1,
      events: { active: null, history: {}, pending: [], rngState: 0 },
      goals: {
        run: 1,
        achieved: { 'reach-icon': NOON },
        icon: { reachedAt: NOON, acknowledged: true },
      },
      grants: { log: [], nextSeq: 1 },
      prestige: { count: 0, badges: [], history: [] },
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

async function flexAt(page: Page, placeId: string) {
  await page.evaluate((id) => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    if (!places.open(id)) throw new Error(`no place ${id}`)
  }, placeId)
  const card = page.locator(`[data-place-sheet="${placeId}"]`)
  await card.getByRole('button', { name: /^Flex: / }).click()
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible()
}

async function fitsTheToastZone(page: Page) {
  const zone = page.locator('[data-overlay-zone="toast"]')
  const toast = zone.locator('[data-level-up]')
  await expect(toast).toBeVisible()
  const [zoneBox, toastBox] = await Promise.all([zone.boundingBox(), toast.boundingBox()])
  if (zoneBox === null || toastBox === null) throw new Error('no toast box')
  expect(toastBox.y).toBeGreaterThanOrEqual(zoneBox.y)
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(zoneBox.y + zoneBox.height)
  expect(toastBox.x).toBeGreaterThanOrEqual(zoneBox.x)
  expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(zoneBox.x + zoneBox.width)
  // Nothing inside is clipped or scrolled out of sight.
  const overflow = await toast.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(overflow).toBeLessThanOrEqual(0)
  const close = await toast.getByRole('button', { name: /^Close the / }).boundingBox()
  expect(close?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(close?.width ?? 0).toBeGreaterThanOrEqual(44)
}

test.describe('the level-up toast', () => {
  // Clicks wait for animation frames, so the clock is paused only between clicks.
  const pause = pauseSoon

  test('the longest unlock list fits the toast zone on a phone held either way', async ({
    page,
  }) => {
    // Layout only: no pop, so the toast is measured at its full size.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.clock.install()
    await seedUnreachedClout(page, 4995)
    await boot(page)
    await flexAt(page, 'queens-ballpark')
    const toast = page.locator('[data-overlay-zone="toast"] [data-level-up="icon"]')
    await expect(toast).toContainText(
      'Unlocked: Brooklyn, Manhattan, Junior dev, Glowmatic, Brickwave, Afterglass',
    )
    // Paused: the toast cannot close itself while it is measured.
    await pause(page)
    try {
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(viewport)
        await fitsTheToastZone(page)
      }
    } finally {
      // A paused clock would stall the console guard's frame wait.
      await page.clock.resume()
    }
  })

  test('closes itself after toastMs; a new level-up replaces the one showing and restarts it', async ({
    page,
  }) => {
    await page.clock.install()
    await boot(page)
    await openPlace(page, 'queens-ballpark', NOON, 98)
    await page
      .locator('[data-place-sheet="queens-ballpark"]')
      .getByRole('button', { name: /^Flex: / })
      .click()
    const toasts = page.locator('[data-overlay-zone="toast"] [data-level-up]')
    await expect(toasts).toHaveAttribute('data-level-up', 'local')
    try {
      await pause(page)
      await page.clock.runFor(3000)
      await page.clock.resume()

      await page.evaluate(() => window.__cloutcityPlaces?.setClout(298))
      await flexAt(page, 'dumbo')
      await expect(toasts).toHaveCount(1)
      await expect(toasts).toHaveAttribute('data-level-up', 'scene-regular')
      await pause(page)
      // Past the first toast's 6 s, but not the replacement's: it got its own full time.
      await page.clock.runFor(4500)
      await expect(toasts).toHaveAttribute('data-level-up', 'scene-regular')
      await page.clock.runFor(1600)
      await expect(toasts).toHaveCount(0)
    } finally {
      // A paused clock would stall the console guard's frame wait.
      await page.clock.resume()
    }
  })

  test('pops only when motion is welcome', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await boot(page)
    await openPlace(page, 'queens-ballpark', NOON, 98)
    await page
      .locator('[data-place-sheet="queens-ballpark"]')
      .getByRole('button', { name: /^Flex: / })
      .click()
    const toast = page.locator('[data-overlay-zone="toast"] [data-level-up]')
    await expect(toast).toBeVisible()
    expect(await toast.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await toast.evaluate((el) => getComputedStyle(el).animationName)).toBe('level-up-pop')
  })
})

test.describe('the HUD clout meter', () => {
  // S05: the meter moved from the one-row HUD's title area into the clout cell, under the goal
  // line; the intent stays: it fits its place and covers nothing else, at every HUD layout.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
    { width: 390, height: 600 },
    { width: 844, height: 390 },
  ] as const) {
    test(`sits under the goal line inside the clout cell, clear of every other cell at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await boot(page)
      await expect(meter(page)).toBeVisible()
      const box = (selector: string) => page.locator(selector).first().boundingBox()
      const [cell, meterBox, goalLine] = await Promise.all([
        box('[data-hud-cell="clout"]'),
        box('[data-clout-meter]'),
        box('[data-hud-goal-line]'),
      ])
      if (cell === null || meterBox === null || goalLine === null) {
        throw new Error('missing HUD boxes')
      }
      expect(meterBox.x).toBeGreaterThanOrEqual(cell.x)
      expect(meterBox.x + meterBox.width).toBeLessThanOrEqual(cell.x + cell.width + 0.5)
      expect(meterBox.y + meterBox.height).toBeLessThanOrEqual(cell.y + cell.height + 0.5)
      expect(meterBox.y).toBeGreaterThanOrEqual(goalLine.y + goalLine.height - 0.5)
      for (const other of ['money', 'clock', 'speed', 'stats', 'actions']) {
        const otherBox = await box(`[data-hud-cell="${other}"]`)
        if (otherBox === null) throw new Error(`no ${other} cell`)
        const apart =
          otherBox.x + otherBox.width <= meterBox.x ||
          meterBox.x + meterBox.width <= otherBox.x ||
          otherBox.y + otherBox.height <= meterBox.y ||
          meterBox.y + meterBox.height <= otherBox.y
        expect(apart, other).toBe(true)
      }
    })
  }
})
