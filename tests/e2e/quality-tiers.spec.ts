import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { openFromHud } from './helpers/hud'
import { waitForMapSettled } from './helpers/scene'

// S04b: quality tiers. Headless Chromium renders on SwiftShader, which the tier picker puts on
// the low tier; the Graphics setting overrides it, is remembered, and a data-saver request
// keeps the low tier whatever is chosen.

const ROOT = join(import.meta.dirname, '../..')
type PerTier<T> = { low: T; mid: T; high: T }
const perf = JSON.parse(readFileSync(join(ROOT, 'data/config/perf.json'), 'utf8')) as {
  dprCap: PerTier<number>
  antialias: PerTier<boolean>
  outlines: PerTier<boolean>
  shadows: PerTier<string>
  shadowMapSizePx: PerTier<number>
}
type Tier = keyof PerTier<unknown>

const QUALITY_KEY = 'cloutcity:quality'

const quality = (page: Page) =>
  page.evaluate(() => {
    const scene = window.__cloutcityTest?.scene
    if (scene === undefined) throw new Error('the scene test hook is missing')
    return scene.quality()
  })
const glState = (page: Page) =>
  page.evaluate(() => {
    const scene = window.__cloutcityTest?.scene
    if (scene === undefined) throw new Error('the scene test hook is missing')
    return scene.gl()
  })

/** The renderer follows `tier`'s perf.json settings (antialias only when created on it). */
async function expectRendererOn(page: Page, tier: Tier, { antialias }: { antialias: Tier }) {
  await expect.poll(async () => (await quality(page)).active).toBe(tier)
  const shadows = perf.shadows[tier] === 'pcf-directional'
  await expect
    .poll(() => glState(page))
    .toMatchObject({
      dprCap: perf.dprCap[tier],
      antialias: perf.antialias[antialias],
      shadowMap: { enabled: shadows, type: 'PCFShadowMap' },
      sun: { castShadow: shadows },
      outlines: perf.outlines[tier],
    })
  const gl = await glState(page)
  expect(gl.pixelRatio).toBeLessThanOrEqual(perf.dprCap[tier])
  if (shadows) expect(gl.sun?.mapSizePx).toBe(perf.shadowMapSizePx[tier])
}

const settings = (page: Page) => page.getByRole('region', { name: 'Settings' })
const graphics = (page: Page) => settings(page).getByRole('group', { name: 'Graphics' })

async function openGraphics(page: Page) {
  await openFromHud(page, 'Settings')
  await expect(graphics(page)).toBeVisible()
}

const storedOverride = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw === null
      ? undefined
      : (JSON.parse(raw) as { state: { override: unknown } }).state.override
  }, QUALITY_KEY)

test('the picker chooses the low tier for software rendering, shown as Auto', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/')
  await waitForMapSettled(page)
  expect(await quality(page)).toMatchObject({
    auto: 'low',
    active: 'low',
    override: null,
    steps: 0,
  })
  expect((await quality(page)).reasons).toContain('low-renderer')
  await expectRendererOn(page, 'low', { antialias: 'low' })

  await openGraphics(page)
  await expect(graphics(page).getByRole('radio', { name: 'Auto (detected: Low)' })).toBeChecked()
  for (const name of ['Low', 'Mid', 'High']) {
    await expect(graphics(page).getByRole('radio', { name, exact: true })).toBeEnabled()
  }
  await expect(graphics(page)).toContainText('Some changes apply next time you open the game.')
  await checkA11y()
})

test('a chosen tier applies at once, is remembered, and Auto returns to the detected tier', async ({
  page,
}) => {
  await page.goto('/')
  await waitForMapSettled(page)
  await openGraphics(page)

  await graphics(page).getByRole('radio', { name: 'High', exact: true }).check()
  // Live: DPR cap, shadows and outlines; antialiasing waits for the next load.
  await expectRendererOn(page, 'high', { antialias: 'low' })
  expect(await storedOverride(page)).toBe('high')

  await page.reload()
  await waitForMapSettled(page)
  await expectRendererOn(page, 'high', { antialias: 'high' })
  await openGraphics(page)
  await expect(graphics(page).getByRole('radio', { name: 'High', exact: true })).toBeChecked()

  await graphics(page).getByRole('radio', { name: 'Auto (detected: Low)' }).check()
  await expectRendererOn(page, 'low', { antialias: 'high' })
  expect(await storedOverride(page)).toBeNull()
})

test.describe('with a data-saver request', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'connection', {
        configurable: true,
        get: () => ({ saveData: true }),
      })
      localStorage.setItem(
        'cloutcity:quality',
        JSON.stringify({ state: { override: 'high' }, version: 1 }),
      )
    })
  })

  test('the low tier wins over a chosen tier, and the higher tiers say why they are off', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/')
    await waitForMapSettled(page)
    expect(await quality(page)).toMatchObject({ dataSaver: true, override: 'high', active: 'low' })
    await expectRendererOn(page, 'low', { antialias: 'low' })

    await openGraphics(page)
    for (const tier of ['Mid', 'High']) {
      await expect(
        graphics(page).getByRole('radio', { name: `${tier}, off while data saver is on` }),
      ).toBeDisabled()
    }
    await expect(graphics(page).getByRole('radio', { name: 'Low', exact: true })).toBeEnabled()
    await expect(graphics(page)).toContainText('Data saver is on, so graphics stay on Low.')
    await checkA11y()
  })
})
