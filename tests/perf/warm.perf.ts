import { expect, test, type Page } from '@playwright/test'
import { applyThrottle } from './throttle'
import {
  median,
  medianMarks,
  perf,
  profile,
  seedPlayer,
  waitForPlayable,
  writeReport,
  type LoadTimings,
} from './measure'
import { warmTier, watchNetwork } from './serviceWorker'

// Warm load under the cc-mid-4g profile (S04b, S04e): the same browser context loads `/` once,
// waits for the service worker to be active, reloads once so the worker controls the page and
// caches what the scene loads, has the worker warm the tier, then reloads perfRun.coldRuns times;
// the median time to playable is asserted. "Warm" means the service worker: every same-origin
// request before playable must be answered by it, with no network fetch of its own (the
// browser's update check of the worker script aside). That also settles the CDP question: the
// page-level throttle may not apply to the worker's own fetches, but a warm load makes none.
// The worker's CPU work is not slowed by the 4x CPU throttle (a small, known optimistic bias).

const tier = perf.perfRun.coldTier
const runs: (LoadTimings & { readonly network: readonly string[] })[] = []
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }, testInfo) => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, baseURL } = testInfo.project.use
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    baseURL,
    serviceWorkers: 'allow',
  })
  page = await context.newPage()
  await seedPlayer(page, tier)
  await applyThrottle(page, profile)
  await page.goto('/')
  await waitForPlayable(page)
  // The worker installs after the map is playable; warm loads start once it is active.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  // It never claims an open page: this load is the first it serves, and the scene's runtime
  // requests (districts, models) pass through its caches.
  await page.reload()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await waitForPlayable(page)
  const warmed = await warmTier(page, tier)
  expect(warmed.failed, 'tier warm fetched every district asset').toBe(0)
})

test.afterAll(async () => {
  await page.context().close()
})

for (let run = 1; run <= perf.perfRun.coldRuns; run += 1) {
  test(`warm load ${run} of ${perf.perfRun.coldRuns} (${tier} tier)`, async ({ baseURL }) => {
    const network = watchNetwork(page.context(), page, new URL(baseURL ?? '').origin)
    await page.reload()
    const timings = await waitForPlayable(page)
    const playableWallMs = await page.evaluate(
      (playable) => performance.timeOrigin + playable,
      timings.playableMs,
    )
    network.stop()
    const fetched = await network.networkBefore(playableWallMs)
    test.info().annotations.push({ type: 'timings', description: JSON.stringify(timings) })
    runs.push({ ...timings, network: fetched })
    expect(fetched, 'requests before playable that reached the network').toEqual([])
  })
}

test(`warm median is within budget (${tier} tier)`, () => {
  expect(runs).toHaveLength(perf.perfRun.coldRuns)
  const playableMs = median(runs.map((run) => run.playableMs))
  const shellInteractiveMs = median(runs.map((run) => run.shellInteractiveMs))
  writeReport('warm', {
    profile: perf.perfRun.profile,
    tier,
    cache: 'service-worker',
    runs,
    median: { shellInteractiveMs, playableMs, scene: medianMarks(runs) },
    budget: { playableMs: perf.playableWarmMs },
  })
  expect(playableMs, 'playable, warm (median)').toBeLessThanOrEqual(perf.playableWarmMs)
})
