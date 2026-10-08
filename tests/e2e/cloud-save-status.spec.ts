import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { hudIsWide, moreButton, morePanel, waitForHudLoaded } from './helpers/hud'
import { waitForMapSettled } from './helpers/scene'

// S18c: the cloud save status. The default e2e build has no Supabase configuration and no
// network to an account, so the save lives on this device, and the HUD says so: a cloud chip on
// wide screens, a row in More on phones. Its panel explains it in a sentence.

const zone = (page: Page) => page.locator('[data-overlay-zone="hud"]')
const LABEL = 'Cloud save: Saved on this device'
/** The chip shows where the actions cell has room for it (HudPanelButtons). */
const CHIP_MIN_WIDTH_PX = 704
const chipShown = (page: Page) =>
  hudIsWide(page) && (page.viewportSize()?.width ?? 0) >= CHIP_MIN_WIDTH_PX

/** Opens the cloud save panel the way a player on this screen would. */
async function openCloudSave(page: Page): Promise<void> {
  if (chipShown(page)) {
    await zone(page).getByRole('button', { name: LABEL, exact: true }).click()
    return
  }
  await moreButton(page).click()
  await morePanel(page).getByRole('button', { name: LABEL, exact: true }).click()
}

test('says the save is on this device, and the panel explains it', async ({ page, checkA11y }) => {
  await page.goto('/')
  await waitForMapSettled(page)
  await waitForHudLoaded(page)
  const chip = zone(page).locator('[data-hud-panel="cloud"]')
  await expect(chip).toHaveAttribute('aria-label', LABEL)
  if (chipShown(page)) await expect(chip).toBeVisible()
  else await expect(chip).toBeHidden()

  await openCloudSave(page)
  const panel = page.getByRole('dialog', { name: 'Cloud save' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-sync-status-line]')).toHaveText('Saved on this device')
  await expect(panel).toContainText('Your progress lives on this device.')
  // Nothing to press without a session: no retry or conflict choice.
  await expect(panel.getByRole('button')).toHaveText(['Close'])
  await checkA11y()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

for (const width of [640, CHIP_MIN_WIDTH_PX]) {
  test.describe(`a wide HUD ${width} px across`, () => {
    test.use({ viewport: { width, height: 720 } })

    const boxOf = async (locator: Locator) => {
      const box = await locator.boundingBox()
      if (box === null) throw new Error('not rendered')
      return box
    }

    test('every action fits its cell, 44 px, overlapping nothing; the chip from 704 px', async ({
      page,
    }) => {
      await page.goto('/')
      await waitForMapSettled(page)
      await waitForHudLoaded(page)
      const actions = await boxOf(zone(page).locator('[data-hud-cell="actions"]'))
      const buttons = await zone(page)
        .locator('[data-hud-cell="actions"]')
        .getByRole('button')
        .filter({ visible: true })
        .all()
      const names = await Promise.all(
        buttons.map(async (b) => (await b.getAttribute('aria-label')) ?? (await b.innerText())),
      )
      if (width >= CHIP_MIN_WIDTH_PX) expect(names).toContain(LABEL)
      else expect(names).not.toContain(LABEL)
      const boxes = await Promise.all(buttons.map(boxOf))
      for (const [i, box] of boxes.entries()) {
        expect(box.width, names[i]).toBeGreaterThanOrEqual(44)
        expect(box.x, names[i]).toBeGreaterThanOrEqual(actions.x - 0.5)
        expect(box.x + box.width, names[i]).toBeLessThanOrEqual(actions.x + actions.width + 0.5)
        for (const other of boxes.slice(i + 1)) {
          expect(box.x + box.width <= other.x + 0.5 || other.x + other.width <= box.x + 0.5).toBe(
            true,
          )
        }
      }
    })
  })
}
