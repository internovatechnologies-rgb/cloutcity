import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { holdGameTime, hudIsWide, moreButton, morePanel, waitForHudLoaded } from './helpers/hud'
import { hideSceneForScreenshot, waitForMapSettled } from './helpers/scene'

// S05: the HUD in the overlay's HUD zone (UX-1) at a phone, a desktop, a short phone and a
// landscape phone. Nothing overlaps, every target is at least 44 px, Inventory, Rent and Home
// move into More on phones and landscape phones, More (with the sound settings and Help, S06)
// shows at every width, and it closes back to its button. At 320 px (UI-1) the sound control is
// icon-only so the HUD fits the screen.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 390, height: 600 },
  { width: 844, height: 390 },
  { width: 320, height: 568 },
] as const

/** Widths at or below layout.json `hudTinyMaxWidthPx`, where the sound control is icon-only. */
const isTiny = (width: number) => width <= 341

const CELLS = ['money', 'clock', 'speed', 'clout', 'stats', 'actions'] as const

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x + 0.5 ||
  b.x + b.width <= a.x + 0.5 ||
  a.y + a.height <= b.y + 0.5 ||
  b.y + b.height <= a.y + 0.5

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5

const zone = (page: Page) => page.locator('[data-overlay-zone="hud"]')

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error(`${name} is not rendered`)
  return box
}

/** Boots with the game clock held still (a hidden page never passes time), the map settled and the HUD loaded. */
async function boot(page: Page) {
  await holdGameTime(page)
  await page.goto('/')
  // The 3D map's start-up holds the main thread on SwiftShader; measure the HUD after it.
  await waitForMapSettled(page)
  await waitForHudLoaded(page)
  await expect(zone(page).locator('[data-hud-value="money"]')).toHaveText('$150')
  await expect(zone(page).getByRole('button', { name: 'Turn on sound' })).toBeVisible()
  await expect(
    zone(page).locator('[data-cc-feature="cc-feature:hud-panel-buttons"]'),
  ).toBeAttached()
}

for (const viewport of VIEWPORTS) {
  const label = `${viewport.width}x${viewport.height}`

  test.describe(`HUD at ${label}`, () => {
    test.use({ viewport })

    test('cells and actions stay apart, inside the HUD, with 44 px targets', async ({
      page,
      checkA11y,
    }) => {
      await boot(page)
      const hudBox = await boxOf(zone(page), 'HUD zone')
      // Nothing in the HUD reaches past the screen edge (UI-1: 342 px of minimums at 320 px).
      expect(hudBox.x + hudBox.width, 'HUD inside the viewport').toBeLessThanOrEqual(
        viewport.width + 0.5,
      )
      const overflow = await zone(page)
        .locator('header[data-hud]')
        .evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow, 'HUD grid overflow').toBeLessThanOrEqual(0)
      const cells: { name: string; box: Box }[] = []
      for (const cell of CELLS) {
        const box = await boxOf(zone(page).locator(`[data-hud-cell="${cell}"]`), cell)
        expect(inside(box, hudBox), `${cell} inside the HUD`).toBe(true)
        expect(box.width, `${cell} width`).toBeGreaterThan(0)
        cells.push({ name: cell, box })
      }
      for (const [i, a] of cells.entries()) {
        for (const b of cells.slice(i + 1)) {
          expect(apart(a.box, b.box), `${a.name} overlaps ${b.name}`).toBe(true)
        }
      }

      const buttons = await zone(page).getByRole('button').filter({ visible: true }).all()
      expect(buttons.length).toBeGreaterThanOrEqual(4)
      const boxes: { name: string; box: Box }[] = []
      for (const button of buttons) {
        const name = (await button.getAttribute('aria-label')) ?? (await button.innerText())
        const box = await boxOf(button, name)
        expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44)
        expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44)
        expect(inside(box, hudBox), `${name} inside the HUD`).toBe(true)
        boxes.push({ name, box })
      }
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          expect(apart(a.box, b.box), `${a.name} overlaps ${b.name}`).toBe(true)
        }
      }

      // The sound control's two lines are visible text at every width (UX-7) but the narrowest,
      // where it is a 44 px icon whose name still says what a tap does (UI-1).
      const tapForSound = zone(page).getByText('Tap for sound', { exact: true })
      if (isTiny(viewport.width)) {
        // Screen-reader only: a 1 px clipped box.
        expect(
          await tapForSound.evaluate((el) => el.getBoundingClientRect().width),
        ).toBeLessThanOrEqual(1)
        const sound = zone(page).getByRole('button', { name: 'Turn on sound' })
        expect((await boxOf(sound, 'sound')).width).toBeLessThan(110)
      } else {
        await expect(tapForSound).toBeVisible()
      }
      // The heading is for screen readers; the HUD has no visible title to squash (UX-8).
      await expect(zone(page).getByRole('heading', { level: 1 })).toHaveClass(/\bsr-only\b/)
      await checkA11y()
    })

    test('More shows at every width; Inventory, Rent and Home leave the HUD only where it is narrow or short', async ({
      page,
    }) => {
      await boot(page)
      const wide = hudIsWide(page)
      const visible = (name: string) =>
        zone(page).getByRole('button', { name, exact: true }).filter({ visible: true })
      await expect(moreButton(page)).toBeVisible()
      for (const name of ['Inventory', 'Rent', 'Home']) {
        await expect(visible(name), name).toHaveCount(wide ? 1 : 0)
      }
      // The settings and Help live in More at every width (S06: no gear in the HUD).
      for (const name of ['Settings', 'Help: take the tour']) {
        await expect(visible(name), name).toHaveCount(0)
      }

      await moreButton(page).click()
      const panel = morePanel(page)
      await expect(panel).toBeVisible()
      await expect(moreButton(page)).toHaveAttribute('aria-expanded', 'true')
      await expect(panel.getByRole('heading', { name: 'More' })).toBeFocused()
      for (const name of ['Inventory', 'Rent', 'Home', 'Settings', 'Help: take the tour']) {
        const item = panel.getByRole('button', { name, exact: true })
        await expect(item).toBeVisible()
        expect((await boxOf(item, name)).height).toBeGreaterThanOrEqual(44)
      }
      await page.keyboard.press('Escape')
      await expect(panel).toHaveCount(0)
      await expect(moreButton(page)).toBeFocused()

      // A panel opened from More hands focus back to its own HUD button where it has one, and
      // to More elsewhere.
      await moreButton(page).click()
      await panel.getByRole('button', { name: 'Rent', exact: true }).click()
      const rent = page.getByRole('dialog', { name: 'Rent' })
      await expect(rent.getByRole('heading', { name: 'Rent', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(rent).toHaveCount(0)
      await expect(wide ? visible('Rent') : moreButton(page)).toBeFocused()

      // The settings sheet hands focus back to More at every width.
      await moreButton(page).click()
      await panel.getByRole('button', { name: 'Settings', exact: true }).click()
      const sound = page.getByRole('region', { name: 'Settings' })
      await expect(sound).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(sound).toHaveCount(0)
      await expect(moreButton(page)).toBeFocused()
    })

    test('matches its screenshot', async ({ page }) => {
      await boot(page)
      await hideSceneForScreenshot(page)
      await expect(zone(page)).toHaveScreenshot(`hud-${label}.png`)
    })
  })
}
