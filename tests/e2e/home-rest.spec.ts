import type { Locator, Page } from '@playwright/test'
import type { HudTestHook } from '@/components/hud/hudTestHook'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { openFromHud } from './helpers/hud'
import { copyText, readJson } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'

// B1 (slice QA): energy comes back at home. A player works a shift, gets too tired for the
// next one (the shift row says to head home and sleep), finds the way home from the Home panel,
// walks home, sleeps (the clock fast-forwards to the morning), and works a shift the next
// morning. Travel is real (the default `home` location): the home actions are only offered at
// home (DEC-22). Durations and costs come from data/config/balance.json, never literals.

const COFFEE = 'steam-vent-coffee'
const MIN_PER_DAY = 24 * 60

const balance = readJson<{
  actions: { catalog: Record<string, { durationMin: number; statEffects: { energy?: number } }> }
  jobs: { energyCostPerShift: Record<string, number> }
}>('data/config/balance.json')
const sleep = balance.actions.catalog.sleep
const shiftEnergy = balance.jobs.energyCostPerShift.barista ?? 0

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(
    () => window.__cloutcityPlaces !== undefined && window.__cloutcityTest?.hud !== undefined,
  )
  await waitForMapSettled(page)
}

const hudState = (page: Page) =>
  page.evaluate((): ReturnType<HudTestHook['state']> => {
    const hook = window.__cloutcityTest?.hud
    if (hook === undefined) throw new Error('hud test hook is not installed')
    return hook.state()
  })

const sheet = (page: Page, id: string): Locator => page.locator(`[data-place-sheet="${id}"]`)
const action = (page: Page, id: string, actionId: string): Locator =>
  sheet(page, id).locator(`[data-place-action="${actionId}"]`)

async function open(page: Page, id: string) {
  await page.evaluate((placeId) => window.__cloutcityPlaces?.open(placeId), id)
  await expect(sheet(page, id)).toBeVisible()
}

/** Walks to the open sheet's place (or home), cutting the animation, and waits for arrival. */
async function walkTo(page: Page, id: string) {
  await page.waitForFunction(() => window.__cloutcityTest?.travel?.state().world === 'ready')
  // A random arrival event (a modal) must not land on the sheet clicked in next (TRV-4).
  await page.evaluate(() => window.__cloutcityTest?.travel?.suppressArrivalEvents(true))
  await sheet(page, id).locator('[data-trip-mode="walk"]').click()
  await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
  await expect(sheet(page, id)).toHaveAttribute('data-player-here', '')
}

async function dismissResult(page: Page, id: string) {
  await sheet(page, id).getByRole('button', { name: 'Dismiss', exact: true }).click()
}

test('a tired player heads home, sleeps till morning and works again', async ({
  page,
  checkA11y,
}) => {
  if (sleep === undefined) throw new Error('balance.json has no sleep action')
  await boot(page)
  await page.evaluate(() => window.__cloutcityPlaces?.setTimeOfDay(8 * 60))

  // Morning: walk to the coffee shop and work a shift.
  await open(page, COFFEE)
  await walkTo(page, COFFEE)
  const shift = action(page, COFFEE, 'shift-barista')
  await expect(shift).toBeEnabled()
  await expect(shift).toContainText(`${shiftEnergy} energy`)
  await expect(shift).not.toContainText('free')
  await shift.click()
  await expect(sheet(page, COFFEE).getByRole('status').last()).not.toHaveText('')
  await dismissResult(page, COFFEE)

  // A long day later: too tired for the next shift, and the row says where energy comes back.
  await page.evaluate((energy) => window.__cloutcityTest?.hud?.setEnergy(energy), shiftEnergy - 5)
  await expect(shift).toBeDisabled()
  await expect(shift).toContainText(/Head home and sleep/)
  await expect(shift).toHaveAccessibleName(/Head home and sleep/)

  // The Home panel shows the rest actions waiting at home, and the way there.
  await openFromHud(page, 'Home')
  // The HUD panel, not the home card (both are named Home).
  const panel = page.locator('[data-hud-panel-dialog="home"]')
  await expect(panel).toBeVisible()
  const panelSleep = panel.locator('[data-place-action="sleep"]')
  await expect(panelSleep).toBeDisabled()
  await expect(panelSleep).toHaveAccessibleName(
    new RegExp(`${copyText('place.blocked.awayHome').replace(/[.?]/g, '\\$&')}$`),
  )
  await panel.getByRole('button', { name: copyText('home.rest.headHome') }).click()
  await expect(sheet(page, 'home')).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect(action(page, 'home', 'sleep')).toBeDisabled()
  await checkA11y()

  // Walk home; late evening, sleep.
  await walkTo(page, 'home')
  await page.evaluate(() => window.__cloutcityPlaces?.setTimeOfDay(23 * 60))
  const bed = action(page, 'home', 'sleep')
  await expect(bed).toBeEnabled()
  await expect(bed).toHaveAccessibleName(/^Sleep: 8 h, \+\d+ energy/)
  await expect(action(page, 'home', 'nap')).toBeEnabled()
  await expect(action(page, 'home', 'home-meal')).toBeEnabled()
  const before = await hudState(page)
  await bed.click()
  await expect(sheet(page, 'home').getByRole('status').last()).toContainText(/energy/)
  const after = await hudState(page)
  expect(after.minute).toBe(before.minute + sleep.durationMin)
  expect(Math.floor(after.minute / MIN_PER_DAY)).toBe(Math.floor(before.minute / MIN_PER_DAY) + 1)
  expect(after.energy).toBeGreaterThanOrEqual(shiftEnergy)
  await checkA11y()
  await dismissResult(page, 'home')

  // Next morning: back to work.
  await open(page, COFFEE)
  await walkTo(page, COFFEE)
  await expect(shift).toBeEnabled()
  const rested = await hudState(page)
  await shift.click()
  await expect(sheet(page, COFFEE).getByRole('status').last()).not.toHaveText('')
  expect((await hudState(page)).cash).toBeGreaterThan(rested.cash)
})
