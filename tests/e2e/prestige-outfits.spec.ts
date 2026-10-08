import type { Page } from '@playwright/test'
import type { PlaceTestHook } from '@/components/places/placeTestHook'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'
import { openFromHud } from './helpers/hud'

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

// S15, user ruling Q-8: prestige keeps outfits. After prestige the outfit is still worn, the HUD
// shows Nobody and the start cash, and the kept piece is a look only: the inventory says so and
// its Sell button is unusable, with the reason in its accessible name.

// src/state/store.ts STORE_KEY and src/engine/save.ts SAVE_VERSION, not imported: Playwright's
// loader cannot load the store's JSON imports.
const STORE_KEY = 'cloutcity:game'
const SAVE_VERSION = 8
const NOON = 12 * 60
const TEE = 'bodega-graphic-tee'

/** A v8 save a few earned points short of Icon, wearing a tee and holding a gift. */
async function seedDressedNearIcon(page: Page) {
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
        inventory: {
          wearables: [{ itemId: TEE, acquiredMinute: 100, worn: true }],
          gifts: [{ itemId: 'bodega-flowers', count: 2 }],
          outfit: { top: TEE },
        },
        clubNights: {},
        visited: {},
      },
      speed: 1,
      events: { active: null, history: {}, pending: [], rngState: 0 },
      goals: { run: 1, achieved: {}, icon: { reachedAt: null, acknowledged: false } },
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

const state = (page: Page) =>
  page.evaluate((): ReturnType<PlaceTestHook['state']> => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    return places.state()
  })

const meter = (page: Page) =>
  page.locator('[data-overlay-zone="hud"]').getByRole('progressbar', { name: /^Clout: / })

test('prestige keeps the outfit worn as a look only; the HUD shows Nobody and $150', async ({
  page,
  checkA11y,
}) => {
  await seedDressedNearIcon(page)
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await ready(page)
  await page.evaluate(() => {
    if (window.__cloutcityPlaces?.open('queens-ballpark') !== true) throw new Error('no place')
  })
  await page
    .locator('[data-place-sheet="queens-ballpark"]')
    .getByRole('button', { name: /^Flex: / })
    .click()
  const moment = page.getByRole('dialog', { name: 'Icon status' })
  await moment.getByRole('button', { name: 'Prestige' }).click()
  const confirm = page.getByRole('dialog', { name: 'Run it back?' })
  await expect(confirm.locator('[data-prestige-keeps]')).toContainText('Your outfits')
  await confirm.getByRole('button', { name: 'Start over at Nobody, keep your badges' }).click()
  await expect(page.locator('[data-icon-moment]')).toHaveCount(0)

  await expect(meter(page)).toHaveAccessibleName('Clout: Nobody, 0 of 100 to Local')
  expect((await state(page)).cash).toBe(150)

  // On phones Inventory is in the HUD's More panel (S05).
  await openFromHud(page, 'Inventory')
  const panel = page.locator('[data-hud-panel-dialog="inventory"]')
  const row = panel.locator(`[data-inventory-item="${TEE}"]`)
  await expect(row).toHaveAttribute('data-prestige-kept', '')
  await expect(row).toContainText('Wearing')
  await expect(row).toContainText('Kept from a past run: a look only')
  const sell = row.getByRole('button', { name: /kept from a past run, so the shop won't buy it$/ })
  await expect(sell).toHaveAttribute('aria-disabled', 'true')
  // A forced click (Playwright waits for aria-disabled buttons otherwise) still sells nothing.
  await sell.click({ force: true })
  expect((await state(page)).cash).toBe(150)
  await expect(row).toBeVisible()
  // Gifts are consumables and start over.
  await expect(panel.locator('[data-inventory-item="bodega-flowers"]')).toHaveCount(0)
  await checkA11y()

  await page.reload()
  await ready(page)
  await expect(meter(page)).toHaveAccessibleName('Clout: Nobody, 0 of 100 to Local')
})
