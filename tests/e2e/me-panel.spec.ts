import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S18a part 2: the Me tab opens the Me panel. The default suite builds with no Supabase
// configuration, so the panel shows the honest not-connected state: no made-up handle, why the
// player is solo, and the Code of Conduct. (The online card and handle form are covered by
// me-panel.supabase.spec.ts.)

const meTab = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Me' })
const panel = (page: Page) => page.getByRole('dialog', { name: 'Me' })

async function boot(page: Page) {
  await page.goto('/')
  await waitForMapSettled(page)
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (found === null) throw new Error('not rendered')
  return found
}

test.describe('Me panel', () => {
  test('the Me tab opens the panel with the honest solo state, and closing gives focus back', async ({
    page,
    checkA11y,
  }) => {
    await boot(page)
    await meTab(page).click()
    const me = panel(page)
    await expect(me).toBeVisible()
    await expect(me).toHaveAttribute('data-cc-feature', 'cc-feature:me-panel')
    await expect(meTab(page)).toHaveAttribute('aria-current', 'page')
    await expect(me.locator('[data-me-offline="no-config"]')).toContainText(
      'This version of the game plays solo only.',
    )
    await expect(me).toContainText("Other players can't see you right now")
    await expect(me.locator('[data-me-handle]')).toHaveCount(0)
    await expect(me.getByRole('link', { name: 'Code of Conduct' })).toHaveAttribute(
      'href',
      '/conduct',
    )
    await checkA11y()

    await me.getByRole('button', { name: 'Close Me' }).click()
    await expect(me).toHaveCount(0)
    await expect(meTab(page)).toBeFocused()
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Map' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('the Map tab closes the Me panel; Escape closes it too', async ({ page }) => {
    await boot(page)
    await meTab(page).click()
    await expect(panel(page)).toBeVisible()
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: 'Map', exact: true })
      .click()
    await expect(panel(page)).toHaveCount(0)

    await meTab(page).click()
    await expect(panel(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
  })

  test('fits the sheet zone without covering the HUD or the tab bar', async ({ page }) => {
    await boot(page)
    await meTab(page).click()
    const me = await box(panel(page))
    const sheet = await box(page.locator('[data-overlay-zone="sheet"]'))
    const tabs = await box(page.locator('[data-overlay-zone="tabs"]'))
    const hud = await box(page.locator('[data-overlay-zone="hud"]'))
    expect(me.y).toBeGreaterThanOrEqual(sheet.y - 1)
    expect(me.y + me.height).toBeLessThanOrEqual(sheet.y + sheet.height + 1)
    expect(me.y + me.height).toBeLessThanOrEqual(tabs.y + 1)
    expect(me.y).toBeGreaterThanOrEqual(hud.y + hud.height - 1)
  })

  test('the game page never loads the /mod console or its session client', async ({ page }) => {
    const scripts: string[] = []
    page.on('response', async (response) => {
      if (response.request().resourceType() !== 'script') return
      scripts.push(await response.text().catch(() => ''))
    })
    await boot(page)
    await meTab(page).click()
    await expect(panel(page)).toBeVisible()
    expect(scripts.length).toBeGreaterThan(0)
    for (const text of scripts) {
      expect(text).not.toContain('cloutcity-mod-auth')
      expect(text).not.toContain('/api/mod/')
      expect(text).not.toContain('MODERATOR_EMAILS')
    }
  })
})
