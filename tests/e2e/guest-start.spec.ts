import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { project } from '../../src/lib/geo/projection'
import { expect, test } from './fixtures/test'
import {
  answerWelcomeCard,
  supabaseStorageKeys,
  trackCrossOriginRequests,
  welcomeDialog,
  YEAR,
} from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'

// S05: a fresh browser opens the root URL, sees the shell, passes the welcome card and lands on
// the playable 3D map centred on the Queens start, with the avatar at home and the HUD showing
// a new player's stats. No signup, and with no Supabase configuration (the e2e build blanks it,
// playwright.config.ts) the guest plays local-only without a single request off the origin.

const ROOT = join(import.meta.dirname, '../..')
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T
const homes = readJson<{ homes: Record<string, { location: { lat: number; lng: number } }> }>(
  'data/homes/homes.json',
).homes
const perf = readJson<{ shellInteractiveColdMs: number; playableColdMs: { high: number } }>(
  'data/config/perf.json',
)
const queens = homes['queens-room']?.location
if (queens === undefined) throw new Error('no queens-room home')
const HOME = project(queens)

test.use({ onboarding: 'fresh' })

/**
 * Holds the personal game clock still: the page reports itself hidden (passive time never runs
 * in a hidden tab), so the HUD keeps showing 8:00 AM however long the 3D map takes to start on
 * SwiftShader. Nothing else in the app reads page visibility for this flow.
 */
async function freezeGameTime(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' })
  })
}

const hud = (page: Page) => page.locator('[data-overlay-zone="hud"]')

test('a fresh visitor gets the shell, the card, then the map at home with the HUD', async ({
  page,
  baseURL,
}) => {
  const crossOrigin = trackCrossOriginRequests(page, baseURL)
  const scripts: Promise<string>[] = []
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') {
      scripts.push(response.text().catch(() => ''))
    }
  })
  await freezeGameTime(page)

  // The server's HTML already carries the HUD frame and its skeleton (shell first).
  const html = await (await page.request.get('/')).text()
  expect(html).toContain('data-hud=""')
  expect(html).toContain('data-hud-skeleton=""')
  expect(html).toContain('>Clout City: NYC</h1>')

  const started = Date.now()
  await page.goto('/')
  await expect(page.locator('header[data-hud]')).toBeAttached()
  const shellMs = await page.evaluate(() => {
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    return nav?.domInteractive ?? Number.NaN
  })
  expect(shellMs).toBeLessThanOrEqual(perf.shellInteractiveColdMs)

  // No signup or login anywhere: the welcome card is the only way in.
  await expect(welcomeDialog(page)).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign ?up|log ?in|sign ?in/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /sign ?up|log ?in|sign ?in/i })).toHaveCount(0)
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: "I'll bring my own" })
  await expect(welcomeDialog(page)).toHaveCount(0)

  await waitForMapSettled(page)
  const playableMs = Date.now() - started
  // Headless Chromium draws the map on the CPU (SwiftShader) with no throttling, so this is a
  // record, not the cc-mid-4g budget (npm run e2e:perf owns that).
  test.info().annotations.push({
    type: 'timings',
    description: JSON.stringify({ shellMs, playableMs, playableBudgetMs: perf.playableColdMs }),
  })
  await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'ready')

  // The avatar stands at the Queens room, the camera looks at it, and a tap there reaches the map.
  const player = await page.evaluate(() => window.__cloutcityTest?.scene?.player() ?? null)
  if (player === null) throw new Error('the avatar is not in the scene')
  expect(Math.hypot(player.local.x - HOME.x, player.local.y - HOME.y)).toBeLessThanOrEqual(1)
  expect(player.sizeM).toBeGreaterThan(0)
  const camera = await page.evaluate(() => window.__cloutcityTest?.scene?.camera() ?? null)
  if (camera === null) throw new Error('no camera state')
  expect(Math.hypot(camera.target.x - HOME.x, -camera.target.z - HOME.y)).toBeLessThanOrEqual(1)
  expect(camera.target.y).toBeCloseTo(player.groundY, 3)
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null,
    player.screen,
  )
  expect(hit).toBe('CANVAS')
  const info = await page.evaluate(() => window.__cloutcityTest?.scene?.renderInfo())
  test.info().annotations.push({ type: 'default-view', description: JSON.stringify(info) })

  // The HUD: a new player's cash, clock, stats, clout and goal line.
  await expect(hud(page).locator('[data-hud-value="money"]')).toHaveText('$150')
  await expect(hud(page).getByText('Cash $150')).toBeAttached()
  await expect(hud(page).locator('[data-hud-value="day"]')).toHaveText('Day 1')
  await expect(hud(page).locator('[data-hud-value="time"]')).toHaveText('8:00 AM')
  for (const [name, text] of [
    ['Energy', '100 of 100'],
    ['Fullness', '80 of 100'],
    ['Mood', '70 of 100'],
  ] as const) {
    await expect(hud(page).getByRole('meter', { name })).toHaveAttribute('aria-valuetext', text)
  }
  await expect(hud(page).getByRole('progressbar', { name: /^Clout: Nobody, / })).toBeVisible()
  await expect(hud(page).locator('[data-hud-goal-line]')).toHaveText('Make it in New York')
  await expect(hud(page).getByRole('button', { name: /^Goals: Make it in New York/ })).toBeVisible()
  await expect(
    hud(page).getByRole('button', { name: 'Game speed 1x, tap to change' }),
  ).toBeVisible()

  // Local-only guest session: no Supabase key in storage, no request off the origin, and the
  // sign-in code never reached the browser.
  const session = await page.evaluate(() => window.__cloutcityTest?.session?.state() ?? null)
  expect(session).toEqual({ status: 'local', reason: 'no-config', reused: false })
  expect(await supabaseStorageKeys(page)).toEqual([])
  expect(crossOrigin).toEqual([])
  const bodies = await Promise.all(scripts)
  expect(bodies.length).toBeGreaterThan(0)
  expect(bodies.filter((body) => body.includes('signInAnonymously'))).toEqual([])
})

test('an under-18 answer gets no guest session and no HUD clock', async ({ page }) => {
  await freezeGameTime(page)
  await page.goto('/')
  await answerWelcomeCard(page, { birthYear: YEAR - 10, consent: true, audio: 'Play our music' })
  await expect(page.getByRole('dialog', { name: "Come back when you're 18." })).toBeVisible()
  await page.waitForFunction(() => window.__cloutcityTest?.clock !== undefined)
  expect(await page.evaluate(() => window.__cloutcityTest?.clock?.running())).toBe(false)
  // The card never starts a session for an under-age answer (CLAUDE.md "Age").
  expect(['idle', 'refused']).toContain(
    await page.evaluate(() => window.__cloutcityTest?.session?.state().status),
  )
  expect(await supabaseStorageKeys(page)).toEqual([])
})

// The camera frames the player at the centre of the free scene row, not the canvas centre, so
// the HUD, a toast or a sheet never covers them (S05; on a phone the canvas centre is in the
// toast zone).
test.describe('the player is framed in the free scene row', () => {
  test.use({ onboarding: 'complete' })
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1280, height: 720 },
  ]) {
    test(`at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await freezeGameTime(page)
      await page.goto('/')
      await waitForMapSettled(page)
      const row = await page.locator('[data-free-scene-row]').boundingBox()
      if (row === null) throw new Error('no free scene row')
      const player = await page.evaluate(() => window.__cloutcityTest?.scene?.player() ?? null)
      if (player === null) throw new Error('the avatar is not in the scene')
      const { x, y } = player.screen
      expect(y, 'below the HUD').toBeGreaterThan(row.y)
      expect(y, 'above the toast zone').toBeLessThan(row.y + row.height)
      expect(Math.abs(y - (row.y + row.height / 2)), 'at the row centre').toBeLessThanOrEqual(2)
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(viewport.width)
      const hit = await page.evaluate(
        ({ px, py }) => document.elementFromPoint(px, py)?.tagName ?? null,
        { px: x, py: y },
      )
      expect(hit).toBe('CANVAS')
      // The camera still looks at home: the framing moves the picture, not the target.
      const camera = await page.evaluate(() => window.__cloutcityTest?.scene?.camera() ?? null)
      expect(
        Math.hypot((camera?.target.x ?? 0) - HOME.x, -(camera?.target.z ?? 0) - HOME.y),
      ).toBeLessThanOrEqual(1)
    })
  }
})
