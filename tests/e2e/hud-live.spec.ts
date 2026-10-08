import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S05: the live HUD over a seeded save. Its skeleton holds the exact boxes of the live cells, the
// speed button persists, passive time runs at the chosen speed (1 real minute = 10 game minutes
// at 1x) and never while the tab is hidden. Only page.clock.setFixedTime is used: the game clock
// runs on performance.now and timers, which stay real.

const CELLS = ['money', 'clock', 'speed', 'clout', 'stats'] as const

/** Turns the e2e hooks on, and lets the test hide and show the page (window.__ccHidden). */
async function controllableVisibility(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
    Object.defineProperty(document, 'visibilityState', {
      get: () =>
        (window as unknown as { __ccHidden?: boolean }).__ccHidden === true ? 'hidden' : 'visible',
    })
  })
}

const hud = (page: Page) => page.locator('[data-overlay-zone="hud"]')
const minute = (page: Page) => page.evaluate(() => window.__cloutcityTest?.clock?.minute() ?? -1)

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    ;(window as unknown as { __ccHidden?: boolean }).__ccHidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test.describe('the live HUD', () => {
  test('the skeleton holds every live cell’s box, within 1 px', async ({ page }) => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const html = await (await page.request.get('/')).text()
    const shell = new Set(
      Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), (match) => match[1]),
    )
    await page.route('**/_next/static/chunks/**/*.js', async (route: Route) => {
      if (shell.has(new URL(route.request().url()).pathname)) return route.continue()
      const response = await route.fetch()
      const body = await response.text()
      if (body.includes('data-hud-goal-line')) await held
      return route.fulfill({ response, body })
    })
    await page.goto('/')
    await expect(hud(page).locator('[data-hud-skeleton]')).toBeAttached()
    const boxes = async () =>
      Object.fromEntries(
        await Promise.all(
          CELLS.map(async (cell) => [
            cell,
            await hud(page).locator(`[data-hud-cell="${cell}"]`).boundingBox(),
          ]),
        ),
      ) as Record<(typeof CELLS)[number], { x: number; y: number; width: number; height: number }>
    const skeleton = await boxes()
    release()
    await expect(hud(page).locator('[data-hud-value="money"]')).toBeVisible()
    await expect(hud(page).locator('[data-hud-skeleton]')).toHaveCount(0)
    const live = await boxes()
    for (const cell of CELLS) {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(
          Math.abs(live[cell][key] - skeleton[cell][key]),
          `${cell} ${key}`,
        ).toBeLessThanOrEqual(1)
      }
    }
  })

  test('a played save shows its cash, day and time; the speed persists over a reload', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__CLOUTCITY_E2E__ = true
      // Held still while checking values; the next test covers time passing.
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' })
    })
    await page.goto('/')
    await page.waitForFunction(() => window.__cloutcityTest?.hud !== undefined)
    await page.evaluate(() => {
      const hook = window.__cloutcityTest?.hud
      if (hook === undefined) throw new Error('no hud hook')
      // Day 3, 9:59 PM: 2 days and 13 h 59 min after the 8:00 AM start. Rent and decay apply
      // on the way, as in play; the save is what the reload below boots from.
      hook.advanceMinutes(2 * 24 * 60 + 13 * 60 + 59)
    })
    await page.reload()
    await expect(hud(page).locator('[data-hud-value="day"]')).toHaveText('Day 3')
    await expect(hud(page).locator('[data-hud-value="time"]')).toHaveText('9:59 PM')
    const view = await page.evaluate(() => window.__cloutcityTest?.clock?.view())
    await expect(hud(page).locator('[data-hud-value="money"]')).toHaveText(view?.money ?? '')

    const speed = hud(page).getByRole('button', { name: /^Game speed / })
    await expect(speed).toHaveAccessibleName('Game speed 1x, tap to change')
    await speed.click()
    await expect(speed).toHaveAccessibleName('Game speed 2x, tap to change')
    await expect(speed).toHaveText('2x')
    await page.reload()
    await expect(
      hud(page).getByRole('button', { name: 'Game speed 2x, tap to change' }),
    ).toBeVisible()
    await hud(page)
      .getByRole('button', { name: /^Game speed / })
      .click()
    await expect(
      hud(page).getByRole('button', { name: 'Game speed 1x, tap to change' }),
    ).toBeVisible()
  })

  test('time passes at 2x while visible and stops while hidden', async ({ page }) => {
    await controllableVisibility(page)
    await page.clock.setFixedTime(Date.UTC(2026, 9, 7, 12))
    await page.goto('/')
    // The 3D map's start-up holds the main thread on SwiftShader, delaying the clock's timer.
    await waitForMapSettled(page)
    await page.waitForFunction(() => window.__cloutcityTest?.clock?.running() === true)
    await hud(page).getByRole('button', { name: 'Game speed 1x, tap to change' }).click()
    expect(await page.evaluate(() => window.__cloutcityTest?.clock?.speed())).toBe(2)

    // 2x: a game minute every 3 real seconds (6 s at 1x).
    const start = await minute(page)
    await expect.poll(() => minute(page), { timeout: 8_000 }).toBeGreaterThan(start)
    const shown = await page.evaluate(() => window.__cloutcityTest?.clock?.view().time)
    await expect(hud(page).locator('[data-hud-value="time"]')).toHaveText(shown ?? '')

    // Hidden longer than a 2x game minute: nothing passes.
    await setHidden(page, true)
    const frozen = await minute(page)
    await page.waitForTimeout(4_000)
    expect(await minute(page)).toBe(frozen)

    await setHidden(page, false)
    await expect.poll(() => minute(page), { timeout: 8_000 }).toBeGreaterThan(frozen)
  })
})
