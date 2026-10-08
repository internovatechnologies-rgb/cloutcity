import { expect, type Locator, type Page } from '@playwright/test'

/**
 * The HUD's layouts (S05, data/config/layout.json): on wide screens Inventory, Rent and Home
 * (S16) sit in the HUD; on phones and landscape phones they live in the More panel. The More
 * button shows at every width and holds the sound settings and Help everywhere (S06). Specs about
 * those panels reach them through these helpers on every project.
 */
const HUD_WIDE_MIN_WIDTH_PX = 640
const HUD_COMPACT_MAX_HEIGHT_PX = 479

export type HudPanelName = 'Inventory' | 'Rent' | 'Home' | 'Settings' | 'Help: take the tour'

/** True when the HUD shows Inventory, Rent and Home itself (they are in More elsewhere). */
export function hudIsWide(page: Page): boolean {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('viewport size is not set')
  return viewport.width >= HUD_WIDE_MIN_WIDTH_PX && viewport.height > HUD_COMPACT_MAX_HEIGHT_PX
}

const hud = (page: Page) => page.locator('[data-overlay-zone="hud"]')

/** The More button (every width, S06). */
export const moreButton = (page: Page): Locator =>
  hud(page).getByRole('button', { name: 'More', exact: true })

/** The More panel. */
export const morePanel = (page: Page): Locator => page.getByRole('dialog', { name: 'More' })

/** Whether the HUD has its own button for `name` on this screen (else it is in More). */
const inHud = (page: Page, name: HudPanelName) =>
  hudIsWide(page) && (name === 'Inventory' || name === 'Rent' || name === 'Home')

/**
 * The HUD control that opens `name` and takes focus back when it closes: Inventory's, Rent's or
 * Home's own button on wide screens, the More button otherwise.
 */
export function hudOpener(page: Page, name: HudPanelName): Locator {
  return inHud(page, name) ? hud(page).getByRole('button', { name, exact: true }) : moreButton(page)
}

/** Opens Inventory, Rent, Home, the sound settings or Help the way a player on this screen would. */
export async function openFromHud(page: Page, name: HudPanelName): Promise<void> {
  if (inHud(page, name)) {
    await hud(page).getByRole('button', { name, exact: true }).click()
    return
  }
  await moreButton(page).click()
  await morePanel(page).getByRole('button', { name, exact: true }).click()
}

/**
 * Holds the personal game clock still for screenshots: the page reports itself hidden, and
 * passive time never runs in a hidden tab, so the HUD keeps showing the same time. Call before
 * `page.goto`.
 */
export async function holdGameTime(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' })
  })
}

/**
 * Waits until every HUD island has loaded (the live cells, the sound control and the panel
 * buttons), so a screenshot never catches the skeleton or a loading state.
 */
export async function waitForHudLoaded(page: Page): Promise<void> {
  const zone = hud(page)
  await expect(zone.locator('[data-hud-value="money"]')).toBeVisible()
  await expect(zone.locator('[data-hud-skeleton]')).toHaveCount(0)
  await expect(zone.locator('[data-sound-control]')).toBeVisible()
  await expect(zone.locator('[data-zone-loading]')).toHaveCount(0)
}
