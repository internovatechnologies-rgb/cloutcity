import type { ConsoleMessage } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import {
  completePlaceSelection,
  expectFallbackAndPanel,
  NO_WEBGL_WARNING,
  placesPanel as panel,
} from './helpers/fallback'
import { SCENE_READY_TIMEOUT_MS, waitForMapSettled } from './helpers/scene'
import { openFromHud } from './helpers/hud'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

// S04c: when WebGL is unavailable or its context is lost, the static fallback map shows, the
// Places panel opens by itself (without taking focus) and the game stays playable; a restored
// context brings the 3D map back in place, without remounting the canvas.

test.describe('no WebGL: getContext refuses WebGL', () => {
  test.use({ expectedConsole: [NO_WEBGL_WARNING] })

  test('shows the fallback map and the Places panel, and a place can be played', async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        if (/webgl/i.test(type)) return null
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest)
      } as typeof HTMLCanvasElement.prototype.getContext
    })
    await page.goto('/')
    await waitForWelcomeGate(page)
    await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'error')
    await expect(page.locator('canvas')).toHaveCount(0)
    await expectFallbackAndPanel(page, 'map.error.device')
    await checkA11y()
    await completePlaceSelection(page, 'steam-vent-coffee')
  })
})

test.describe('a lost WebGL context', () => {
  test('falls back to the panel, then restores the map in place', async ({ page }) => {
    // Context loss is an expected condition: info level only (the console guard fails on any
    // warning), each line exactly once.
    const lines: string[] = []
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'info' || message.type() === 'log') {
        lines.push(`${message.type()}: ${message.text()}`)
      }
    })
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForMapSettled(page)
    const root = page.locator('[data-scene-root]')
    await expect(root).toHaveAttribute('data-scene-status', 'ready')
    // Tag the canvas: after the restore it must be the very same element (no remount).
    await page.locator('[data-scene-root] canvas').evaluate((canvas) => {
      canvas.setAttribute('data-e2e-canvas', 'original')
    })

    expect(await page.evaluate(() => window.__cloutcityTest?.scene?.loseContext())).toBe(true)
    await expect(root).toHaveAttribute('data-scene-status', 'lost')
    await expectFallbackAndPanel(page, 'map.lost')

    expect(await page.evaluate(() => window.__cloutcityTest?.scene?.restoreContext())).toBe(true)
    await expect(root).toHaveAttribute('data-scene-status', 'ready', {
      timeout: SCENE_READY_TIMEOUT_MS,
    })
    await expect(page.locator('[data-scene-fallback]')).toHaveCount(0)
    // The auto-opened panel closes again with the map back.
    await expect(panel(page)).toHaveCount(0)
    await expect(page.locator('canvas[data-e2e-canvas="original"]')).toHaveCount(1)
    await expect(page.locator('canvas')).toHaveCount(1)
    await waitForMapSettled(page)
    const info = await page.evaluate(() => window.__cloutcityTest?.scene?.renderInfo())
    expect(info?.calls ?? 0).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__cloutcityTest?.scene?.pinCount())).toBeGreaterThan(0)

    const count = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).length
    expect(count(/^log: THREE\.WebGLRenderer: Context Lost\.$/)).toBe(1)
    expect(count(/^log: THREE\.WebGLRenderer: Context Restored\.$/)).toBe(1)
    expect(count(/^info: .*msg: 3D map context lost; showing the Places panel,/)).toBe(1)
    expect(count(/^info: .*msg: 3D map context restored,/)).toBe(1)
  })

  test('a panel the player used during the loss stays open after the restore', async ({ page }) => {
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForMapSettled(page)
    await page.evaluate(() => window.__cloutcityTest?.scene?.loseContext())
    await expect(panel(page)).toBeVisible()
    await panel(page).locator('[data-place-button="glowmatic"]').click()
    await expect(page.locator('[data-place-sheet="glowmatic"]')).toBeVisible()
    await page.evaluate(() => window.__cloutcityTest?.scene?.restoreContext())
    await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'ready', {
      timeout: SCENE_READY_TIMEOUT_MS,
    })
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-place-sheet]')).toHaveCount(0)
    await expect(panel(page)).toBeVisible()
  })

  test('an open HUD panel is not closed by the auto-opened panel; it shows when that closes', async ({
    page,
  }) => {
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForMapSettled(page)
    // On phones Rent is in the HUD's More panel (S05).
    await openFromHud(page, 'Rent')
    const rent = page.getByRole('dialog', { name: 'Rent' })
    await expect(rent).toBeVisible()
    await rent.getByRole('button').first().focus()
    await page.evaluate(() => window.__cloutcityTest?.scene?.loseContext())
    await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'lost')
    // The player's panel stays, with focus where it was.
    await expect(rent).toBeVisible()
    expect(await rent.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    // Closing it reveals the Places panel the lost map opened.
    await page.keyboard.press('Escape')
    await expect(rent).toHaveCount(0)
    await expect(panel(page)).toBeVisible()
    await page.evaluate(() => window.__cloutcityTest?.scene?.restoreContext())
    await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'ready', {
      timeout: SCENE_READY_TIMEOUT_MS,
    })
    await expect(panel(page)).toHaveCount(0)
  })

  test('opening a HUD panel over the auto-opened panel does not lose it while the map is down', async ({
    page,
  }) => {
    await page.goto('/')
    await waitForWelcomeGate(page)
    await waitForMapSettled(page)
    await page.evaluate(() => window.__cloutcityTest?.scene?.loseContext())
    await expect(panel(page)).toBeVisible()
    await openFromHud(page, 'Rent')
    const rent = page.getByRole('dialog', { name: 'Rent' })
    await expect(rent).toBeVisible()
    await expect(panel(page)).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(rent).toHaveCount(0)
    // The map is still down: the Places panel is still the way to play.
    await expect(panel(page)).toBeVisible()
  })

  test('a loss during the flight to an open place keeps the sheet; the flight lands after the restore', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__CLOUTCITY_E2E__ = true
    })
    await page.goto('/')
    await waitForWelcomeGate(page)
    await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
    await waitForMapSettled(page)
    // In one task: the place opens (the camera starts flying to it) and the context goes.
    await page.evaluate(() => {
      if (window.__cloutcityPlaces?.open('statue-of-liberty') !== true) throw new Error('no place')
      window.__cloutcityTest?.scene?.loseContext()
    })
    const root = page.locator('[data-scene-root]')
    await expect(root).toHaveAttribute('data-scene-status', 'lost')
    const sheet = page.locator('[data-place-sheet="statue-of-liberty"]')
    await expect(sheet).toBeVisible()
    // The auto-opened panel waits behind the player's sheet.
    await expect(page.locator('[data-places-panel]')).toBeHidden()
    await page.evaluate(() => window.__cloutcityTest?.scene?.restoreContext())
    await expect(root).toHaveAttribute('data-scene-status', 'ready', {
      timeout: SCENE_READY_TIMEOUT_MS,
    })
    await waitForMapSettled(page)
    await expect(sheet).toBeVisible()
    expect(await page.evaluate(() => window.__cloutcityTest?.scene?.selectedPlaceId())).toBe(
      'statue-of-liberty',
    )
    const pin = (await page.evaluate(() => window.__cloutcityTest?.scene?.pins() ?? [])).find(
      (candidate) => candidate.id === 'statue-of-liberty',
    )
    expect(pin?.screen, 'the place is in view after the restore').not.toBeNull()
  })
})
