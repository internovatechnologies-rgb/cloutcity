import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { answerWelcomeCard, YEAR } from './fixtures/welcome'
import { holdGameTime } from './helpers/hud'
import { waitForMapSettled } from './helpers/scene'

// S18c, opt-in (`npm run e2e:supabase`, playwright.supabase.config.ts): against the local stack
// and the real POST /api/save, the guest's save syncs to the account, offline play queues and
// syncs when the network returns, a reload keeps the synced save, and a save tampered in
// localStorage is refused by the server: sync pauses, play goes on. The stack is shared by
// every checkout: this only creates anonymous users and never resets it.

test.use({
  onboarding: 'fresh',
  // The browser itself reports the server's refusal of the tampered save (HTTP 422) once.
  expectedConsole: [
    [{ type: 'error', text: /status of 422 \(Unprocessable Entity\)/, count: 1 }],
    { scope: 'test' },
  ],
})

const STORE_KEY = 'cloutcity:game'
const status = (page: Page) => page.locator('[data-hud-panel="cloud"]')

async function expectStatus(page: Page, value: string, timeout = 20_000): Promise<void> {
  await expect(status(page)).toHaveAttribute('data-sync-status', value, { timeout })
}

async function setEnergy(page: Page, energy: number): Promise<void> {
  await page.waitForFunction(() => window.__cloutcityTest?.hud !== undefined)
  await page.evaluate((value) => window.__cloutcityTest?.hud?.setEnergy(value), energy)
}

test('syncs, queues offline, survives a reload, and pauses on a tampered save', async ({
  page,
  context,
}) => {
  await holdGameTime(page)
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  const uploads: number[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname === '/api/save' && response.request().method() === 'POST') {
      uploads.push(response.status())
    }
  })

  await page.goto('/')
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: "I'll bring my own" })
  await waitForMapSettled(page)
  // The HUD panel buttons (with the hook) load after the welcome card.
  await page.locator('[data-hud-panel="cloud"]').waitFor({ state: 'attached' })

  // 1. The first upload lands.
  await expectStatus(page, 'synced')
  expect(uploads).toEqual([200])

  // 2. Offline: the change waits, then goes up when the network is back.
  await context.setOffline(true)
  await setEnergy(page, 42)
  await expectStatus(page, 'offline', 15_000)
  // That nothing goes up while offline, however long it waits, is covered by
  // src/state/cloudSync.test.ts; here the queued change goes up once the network is back.
  expect(uploads).toEqual([200])
  await context.setOffline(false)
  await expectStatus(page, 'synced')
  expect(uploads).toEqual([200, 200])

  // 3. A reload keeps the synced save, with nothing to upload.
  await page.reload()
  await waitForMapSettled(page)
  await expectStatus(page, 'synced')
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? '{}').state?.player?.stats?.energy,
      STORE_KEY,
    ),
  ).toBe(42)
  expect(uploads).toEqual([200, 200])

  // 4. A save tampered on the device is refused by the server: sync pauses, play goes on.
  await page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
    saved.state.player.cash = 999_999
    localStorage.setItem(key, JSON.stringify(saved))
  }, STORE_KEY)
  await page.reload()
  await waitForMapSettled(page)
  await expectStatus(page, 'paused')
  expect(uploads.at(-1)).toBe(422)
  await expect(page.locator('[data-hud-value="money"]')).toBeVisible()
})
