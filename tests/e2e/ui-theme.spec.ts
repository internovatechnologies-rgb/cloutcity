import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { welcomeDialog } from './fixtures/welcome'
import { seedTier } from './helpers/cityModels'
import { at, seedClockSave } from './helpers/dayNight'
import { holdGameTime, openFromHud, waitForHudLoaded } from './helpers/hud'
import { readJson } from './helpers/places'
import { hideSceneForScreenshot } from './helpers/scene'

// S04g: the interface follows the personal game clock with the scene's keyframes: light frosted
// cards by day, dark glass by night, taxi yellow the one accent. The server renders day; the
// HUD island switches the root's data-theme, cross-fading (instant under reduced motion) with
// no layout shift, and turns on frosted glass only where the device can afford it.

const theme = readJson<{
  ui: { crossFadeMs: number }
  colors: Record<string, string>
  themeColor: { day: string; night: string }
}>('data/config/theme.json')

const rootTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'))
const themeColorMeta = (page: Page) =>
  page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.getAttribute('content'))

/** Waits until the root shows `label` and its cross-fade has ended (axe reads final colours). */
async function themeSettled(page: Page, label: 'day' | 'night'): Promise<void> {
  await expect.poll(() => rootTheme(page)).toBe(label)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-theme-fading')))
    .toBe(false)
  // A busy main thread can start the colour transitions late: wait until none runs.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.getAnimations().filter((animation) => animation instanceof CSSTransition).length,
      ),
    )
    .toBe(0)
}

async function bootAt(page: Page, minute: number, hud = true): Promise<void> {
  await seedClockSave(page, minute)
  await holdGameTime(page)
  await page.goto('/')
  if (hud) await waitForHudLoaded(page)
}

test('the server renders the day palette before the clock is known', async ({ request }) => {
  const html = await (await request.get('/')).text()
  expect(html).toMatch(/<html[^>]*data-theme="day"/)
  expect(html).toMatch(/<html[^>]*data-glass="solid"/)
  expect(html).toContain(`name="theme-color" content="${theme.colors[theme.themeColor.day]}"`)
})

test('a night save turns the interface dark once the HUD has read it', async ({ page }) => {
  await bootAt(page, at(22))
  await expect.poll(() => rootTheme(page)).toBe('night')
  expect(await themeColorMeta(page)).toBe(theme.colors[theme.themeColor.night])
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
  expect(scheme).toBe('dark')
  // The legal pages and the offline page show the theme the game last showed, browser chrome
  // included (UI-14).
  for (const path of ['/terms', '/credits', '/offline']) {
    await page.goto(path)
    await expect.poll(() => rootTheme(page), path).toBe('night')
    await expect.poll(() => themeColorMeta(page), path).toBe(theme.colors[theme.themeColor.night])
  }
})

test('a day load after a night session stores day, so the other pages open light (UI-2)', async ({
  page,
}) => {
  // The last session ended at night; the server's HTML is already day, so nothing switches.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('theme-seeded') !== null) return
    sessionStorage.setItem('theme-seeded', '1')
    localStorage.setItem('cloutcity:ui-theme', 'night')
  })
  await bootAt(page, at(12))
  await expect.poll(() => rootTheme(page)).toBe('day')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('cloutcity:ui-theme')))
    .toBe('day')
  for (const path of ['/credits', '/terms']) {
    await page.goto(path)
    await expect.poll(() => rootTheme(page), path).toBe('day')
    expect(await themeColorMeta(page), path).toBe(theme.colors[theme.themeColor.day])
  }
})

test('the interface switches at dusk with the scene, cross-fading, with no layout shift', async ({
  page,
}) => {
  // 18:58: dusk is two game minutes (12 real seconds at 1x) away.
  await seedClockSave(page, at(18, 58))
  await page.goto('/')
  await waitForHudLoaded(page)
  expect(await rootTheme(page)).toBe('day')
  await page.evaluate(() => {
    const w = window as unknown as { __shift: number; __fading: boolean }
    w.__shift = 0
    w.__fading = false
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__shift += (entry as unknown as { value: number }).value
      }
    }).observe({ type: 'layout-shift', buffered: false })
    new MutationObserver(() => {
      if (document.documentElement.hasAttribute('data-theme-fading')) w.__fading = true
    }).observe(document.documentElement, { attributes: true })
  })
  const hud = page.locator('[data-hud]')
  const before = await hud.boundingBox()
  await expect.poll(() => rootTheme(page), { timeout: 30_000 }).toBe('night')
  expect(await page.evaluate(() => (window as unknown as { __fading: boolean }).__fading)).toBe(
    true,
  )
  const duration = await page.evaluate(() => getComputedStyle(document.body).transitionDuration)
  // Read during or after the fade: the configured duration, or none once it has ended.
  expect([`${theme.ui.crossFadeMs / 1000}s`, '0s']).toContain(duration)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-theme-fading')))
    .toBe(false)
  expect(await hud.boundingBox()).toEqual(before)
  expect(await page.evaluate(() => (window as unknown as { __shift: number }).__shift)).toBe(0)
})

test('under reduced motion the switch is instant', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const w = window as unknown as { __fading: boolean }
    w.__fading = false
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        if (document.documentElement.hasAttribute('data-theme-fading')) w.__fading = true
      }).observe(document.documentElement, { attributes: true })
    })
  })
  await bootAt(page, at(22))
  await expect.poll(() => rootTheme(page)).toBe('night')
  expect(await page.evaluate(() => (window as unknown as { __fading: boolean }).__fading)).toBe(
    false,
  )
})

test.describe('frosted glass (PERF-2)', () => {
  test('stays solid on the low tier', async ({ page }) => {
    await bootAt(page, at(12))
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.glass))
      .toBe('solid')
    const filter = await page
      .locator('[data-hud]')
      .evaluate((element) => getComputedStyle(element).backdropFilter)
    expect(filter).toBe('none')
  })

  test('frosts on the high tier', async ({ page }) => {
    await seedTier(page, 'high')
    await bootAt(page, at(12))
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.glass))
      .toBe('blur')
    const filter = await page
      .locator('[data-hud]')
      .evaluate((element) => getComputedStyle(element).backdropFilter)
    expect(filter).toMatch(/^blur\(/)
  })
})

for (const [label, minute] of [
  ['day', at(12)],
  ['night', at(22)],
] as const) {
  test.describe(`${label} palette`, () => {
    test(`HUD and an open sheet pass axe and match the baseline (${label})`, async ({
      page,
      checkA11y,
    }) => {
      await bootAt(page, minute)
      await themeSettled(page, label)
      await openFromHud(page, 'Inventory')
      await checkA11y()
      await hideSceneForScreenshot(page)
      await expect(page).toHaveScreenshot(`theme-${label}-hud-sheet.png`)
    })

    test(`Settings and the Places panel pass axe (${label})`, async ({ page, checkA11y }) => {
      await bootAt(page, minute)
      await themeSettled(page, label)
      await openFromHud(page, 'Settings')
      await checkA11y()
      await page.keyboard.press('Escape')
      await page
        .getByRole('button', { name: /Places/ })
        .first()
        .click()
      await checkA11y()
    })

    test(`a legal page passes axe and matches the baseline (${label})`, async ({
      page,
      checkA11y,
    }) => {
      await bootAt(page, minute)
      await themeSettled(page, label)
      await page.goto('/terms')
      await themeSettled(page, label)
      await checkA11y()
      await expect(page).toHaveScreenshot(`theme-${label}-legal.png`)
    })
  })
}

test.describe('welcome card', () => {
  test.use({ onboarding: 'fresh' })

  for (const [label, minute] of [
    ['day', at(12)],
    ['night', at(22)],
  ] as const) {
    test(`passes axe in the ${label} palette`, async ({ page, checkA11y }) => {
      await bootAt(page, minute, false)
      await expect(welcomeDialog(page)).toBeVisible()
      await themeSettled(page, label)
      await checkA11y()
    })
  }
})
