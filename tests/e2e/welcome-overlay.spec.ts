import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { waitForHudLoaded } from './helpers/hud'
import { hideSceneForScreenshot } from './helpers/scene'
import {
  T0,
  WELCOME_TITLE,
  YEAR,
  answerWelcomeCard,
  passWelcomeCard,
  welcomeDialog,
} from './fixtures/welcome'

// S05a, UX-1: the welcome card is a modal in the overlay layer system. It never covers the
// banner, HUD or tab bar, keeps focus inside, cannot be dismissed, and scrolls inside itself.

test.use({ onboarding: 'fresh' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(T0)
})

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox()
  if (!found) throw new Error(`${selector} is not rendered`)
  return found
}

test('Escape does not dismiss the card and Tab keeps focus inside it', async ({ page }) => {
  await page.goto('/')
  const dialog = welcomeDialog(page)
  await expect(dialog.getByRole('heading', { name: 'Welcome to Clout City' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()

  const insideDialog = () =>
    page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab')
    expect(await insideDialog(), `after Tab ${i + 1}`).toBe(true)
  }
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Shift+Tab')
    expect(await insideDialog(), `after Shift+Tab ${i + 1}`).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
})

test('the card can be completed with the keyboard only', async ({ page }) => {
  await page.goto('/')
  const dialog = welcomeDialog(page)
  // The card loads as a boot island; it takes focus when it appears.
  await expect(dialog.getByRole('heading', { name: WELCOME_TITLE })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('combobox')).toBeFocused()
  await dialog.getByRole('combobox').selectOption(String(YEAR - 30))
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('checkbox')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await dialog.getByRole('radio', { name: 'Play our music' }).focus()
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('radio', { name: 'Play our music' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Start playing' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('main')).toBeFocused()
})

test('the card and the lock screen pass axe', async ({ page, checkA11y }) => {
  await page.goto('/')
  await expect(welcomeDialog(page)).toBeVisible()
  await checkA11y()
  await answerWelcomeCard(page, { birthYear: YEAR - 5, consent: true, audio: 'Play our music' })
  await expect(page.getByRole('dialog', { name: "Come back when you're 18." })).toBeVisible()
  await checkA11y()
})

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 390, height: 600 },
  { width: 844, height: 390 },
] as const

for (const size of VIEWPORTS) {
  test(`${size.width}x${size.height}: the card stays off the banner, HUD and tab bar`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await page.goto('/')
    const dialog = welcomeDialog(page)
    await expect(dialog).toBeVisible()

    const card = await box(page, '[role="dialog"]')
    for (const zone of ['banner', 'hud', 'tabs'] as const) {
      const zoneBox = await box(page, `[data-overlay-zone="${zone}"]`)
      expect(intersectionArea(card, zoneBox), `card overlaps ${zone}`).toBe(0)
    }
    expect(card.y).toBeGreaterThanOrEqual(0)
    expect(card.y + card.height).toBeLessThanOrEqual(size.height)

    // The submit button is reachable by scrolling inside the card, never the page.
    const submit = dialog.getByRole('button', { name: 'Start playing' })
    await submit.scrollIntoViewIfNeeded()
    await expect(submit).toBeInViewport({ ratio: 1 })
    const submitBox = await submit.boundingBox()
    expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    for (const zone of ['hud', 'tabs'] as const) {
      const zoneBox = await box(page, `[data-overlay-zone="${zone}"]`)
      expect(intersectionArea(submitBox ?? card, zoneBox), `submit overlaps ${zone}`).toBe(0)
    }

    // Every choice control has a hit target of at least 44 px.
    for (const label of await dialog.locator('label:has(input)').all()) {
      expect((await label.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await expect(dialog.getByRole('combobox')).toHaveCSS('min-height', '44px')
  })
}

test('with reduced motion the card works the same', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(welcomeDialog(page)).toBeVisible()
  await passWelcomeCard(page)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
})

test('the welcome card matches its screenshot', async ({ page }) => {
  await page.goto('/')
  await expect(welcomeDialog(page)).toBeVisible()
  await waitForHudLoaded(page)
  await hideSceneForScreenshot(page)
  await expect(page).toHaveScreenshot('welcome-card.png')
})

test('the welcome card with every error matches its screenshot', async ({ page }) => {
  await page.goto('/')
  await welcomeDialog(page).getByRole('button', { name: 'Start playing' }).click()
  await expect(welcomeDialog(page).getByRole('combobox')).toBeFocused()
  await waitForHudLoaded(page)
  await hideSceneForScreenshot(page)
  await expect(page).toHaveScreenshot('welcome-card-errors.png')
})

test('the lock screen matches its screenshot', async ({ page }) => {
  await page.goto('/')
  await answerWelcomeCard(page, { birthYear: YEAR - 5, consent: true, audio: 'Play our music' })
  await expect(page.getByRole('dialog', { name: "Come back when you're 18." })).toBeVisible()
  await waitForHudLoaded(page)
  await hideSceneForScreenshot(page)
  await expect(page).toHaveScreenshot('welcome-card-locked.png')
})

/** What has focus: its role-ish tag and accessible label, or "outside" when not in the dialog. */
const focusedInDialog = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement
    if (active === null || active.closest('[role="dialog"]') === null) return 'outside'
    const type = active instanceof HTMLInputElement ? `:${active.type}` : ''
    return `${active.tagName.toLowerCase()}${type}`
  })

for (const size of [
  { width: 844, height: 390 },
  { width: 390, height: 600 },
] as const) {
  test(`${size.width}x${size.height}: Tab and Shift+Tab cycle inside the scrolling card`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await page.goto('/')
    const dialog = welcomeDialog(page)
    await expect(dialog).toBeVisible()
    // The card is shorter than its content here, so it scrolls inside itself.
    expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

    const forward: string[] = []
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab')
      forward.push(await focusedInDialog(page))
    }
    // select, checkbox, Terms, Privacy, the radio group, submit, then back to the select.
    expect(forward).toEqual([
      'select',
      'input:checkbox',
      'a',
      'a',
      'input:radio',
      'button',
      'select',
      'input:checkbox',
    ])

    // Reaching submit with the keyboard scrolls it into view inside the card.
    const submit = dialog.getByRole('button', { name: 'Start playing' })
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(submit).toBeFocused()
    await expect(submit).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => window.scrollY)).toBe(0)

    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(submit).toBeFocused()
  })
}

for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
] as const) {
  test(`${size.width}x${size.height} at 200% text size: the card fits and submit is reachable`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await page.goto('/')
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
    const dialog = welcomeDialog(page)
    await expect(dialog).toBeVisible()

    const card = await box(page, '[role="dialog"]')
    expect(card.y).toBeGreaterThanOrEqual(0)
    expect(card.y + card.height).toBeLessThanOrEqual(size.height)
    expect(card.x).toBeGreaterThanOrEqual(0)
    expect(card.x + card.width).toBeLessThanOrEqual(size.width)

    const submit = dialog.getByRole('button', { name: 'Start playing' })
    await submit.scrollIntoViewIfNeeded()
    await expect(submit).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0])
    // Text reflows: nothing in the card scrolls sideways.
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

    await passWelcomeCard(page)
  })
}

test('the lock screen has nothing to focus and Tab never leaves it', async ({ page }) => {
  await page.goto('/')
  await answerWelcomeCard(page, { birthYear: YEAR - 5, consent: true, audio: 'Play our music' })
  const lock = page.getByRole('dialog', { name: "Come back when you're 18." })
  await expect(lock).toBeVisible()
  const tabbable = await lock.evaluate(
    (el) =>
      Array.from(
        el.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
      ).filter((node) => node.tabIndex >= 0).length,
  )
  expect(tabbable).toBe(0)

  const heading = lock.getByRole('heading', { name: "Come back when you're 18." })
  await expect(heading).toBeFocused()
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab', 'Escape', 'Shift+Tab']) {
    await page.keyboard.press(key)
    await expect(heading, `after ${key}`).toBeFocused()
  }
})

test('the inert background cannot be focused or clicked while the card is open', async ({
  page,
}) => {
  await page.goto('/')
  await expect(welcomeDialog(page)).toBeVisible()
  // Me: a tab that acts (Phone and Shop are disabled until they have a screen, UI-16).
  const tab = page.locator('[data-overlay-zone="tabs"] [data-tab="me"]')
  await expect(tab).toBeAttached()
  expect(await tab.evaluate((el) => el.closest('[inert]') !== null)).toBe(true)

  await tab.evaluate((el) => (el as HTMLElement).focus())
  await expect(tab).not.toBeFocused()

  const target = await tab.boundingBox()
  if (target === null) throw new Error('Me tab is not rendered')
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
  await expect(tab).not.toHaveAttribute('aria-current', 'page')
  await expect(welcomeDialog(page)).toBeVisible()

  await passWelcomeCard(page)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Me' }).click()
  await expect(tab).toHaveAttribute('aria-current', 'page')
})
