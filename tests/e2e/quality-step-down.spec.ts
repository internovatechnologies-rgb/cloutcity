import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S04b: the runtime step-down. A device the picker puts on the high tier (signals forced through
// WebGL and navigator stubs) pans the map while its frame rate reads far below the floor: the
// page's clock (performance.now, which PerformanceMonitor times frames with) runs CLOCK_SCALE
// times fast, so the measured FPS drops by that factor without loading the CPU. One tier is
// dropped once the floor has been missed for sustainMs of continuous rendering, and never while
// idle or over a settings choice (no automatic step up: src/lib/quality/stepDown.test.ts).

const ROOT = join(import.meta.dirname, '../..')
const perf = JSON.parse(readFileSync(join(ROOT, 'data/config/perf.json'), 'utf8')) as {
  fpsStepDown: { belowFps: number; sustainMs: number; sampleMs: number; cooldownMs: number }
  dprCap: { mid: number }
}
/** Any real frame rate under the floor times this reads as under the floor. */
const CLOCK_SCALE = 20

test.skip(({ isMobile }) => isMobile, 'the pan uses the mouse (desktop project)')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // High-tier signals: an unmasked high-end renderer, a large texture limit, memory and cores.
    const RENDERER = 0x1f01
    const MAX_TEXTURE_SIZE = 0x0d33
    const getParameter = WebGL2RenderingContext.prototype.getParameter
    WebGL2RenderingContext.prototype.getParameter = function (
      this: WebGL2RenderingContext,
      name: number,
    ) {
      if (name === RENDERER) return 'Apple M2 (stub)'
      if (name === MAX_TEXTURE_SIZE) return 16384
      return getParameter.call(this, name) as unknown
    }
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 })
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      configurable: true,
      get: () => 8,
    })
    // A page clock that runs `scale` times fast from the moment it is set.
    const realNow = performance.now.bind(performance)
    let base = realNow()
    let virtualBase = base
    let scale = 1
    performance.now = () => virtualBase + (realNow() - base) * scale
    ;(window as { __clockScale?: (next: number) => void }).__clockScale = (next) => {
      virtualBase = performance.now()
      base = realNow()
      scale = next
    }
  })
})

const setClockScale = (page: Page, scale: number) =>
  page.evaluate((next) => {
    ;(window as { __clockScale?: (value: number) => void }).__clockScale?.(next)
  }, scale)

const quality = (page: Page) =>
  page.evaluate(() => {
    const scene = window.__cloutcityTest?.scene
    if (scene === undefined) throw new Error('the scene test hook is missing')
    return scene.quality()
  })

/**
 * Holds a mouse pan on the map, moving a little every sample, for `ms` or until `done` holds.
 * SwiftShader may draw only a few frames a second on the high tier, so the monitor's
 * sustainMs / sampleMs samples can take several seconds of panning to fill.
 */
async function pan(page: Page, ms: number, done: () => Promise<boolean> = async () => false) {
  const box = await page.locator('[data-scene-root] canvas').boundingBox()
  if (box === null) throw new Error('no canvas')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  const steps = Math.ceil(ms / perf.fpsStepDown.sampleMs)
  for (let step = 1; step <= steps && !(await done()); step += 1) {
    await page.mouse.move(x + (step % 2 === 0 ? 4 : -4), y + (step % 20))
    await page.waitForTimeout(perf.fpsStepDown.sampleMs)
  }
  await page.mouse.up()
}

const PAN_MS = perf.fpsStepDown.sustainMs * 1.5
/** The longest pan waiting for a step-down: within the test timeout, whatever the frame rate. */
const STEP_PAN_MAX_MS = perf.fpsStepDown.sustainMs * 5

test('a sustained low frame rate steps the auto tier down once', async ({ page }) => {
  await page.goto('/')
  await waitForMapSettled(page)
  expect(await quality(page)).toMatchObject({ auto: 'high', active: 'high', steps: 0 })

  // Idle time is not a low frame rate: nothing renders, nothing steps down.
  await setClockScale(page, CLOCK_SCALE)
  await page.waitForTimeout(perf.fpsStepDown.sampleMs * 4)
  expect((await quality(page)).steps).toBe(0)

  await pan(page, STEP_PAN_MAX_MS, async () => (await quality(page)).steps > 0)
  expect(await quality(page)).toMatchObject({ active: 'mid', steps: 1, continuous: false })
  // The lower tier's settings apply at once: no shadow, the mid DPR cap.
  const gl = await page.evaluate(() => window.__cloutcityTest?.scene?.gl())
  expect(gl).toMatchObject({ dprCap: perf.dprCap.mid, shadowMap: { enabled: false } })
})

test('a tier chosen in settings is never stepped down', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'cloutcity:quality',
      JSON.stringify({ state: { override: 'high' }, version: 1 }),
    )
  })
  await page.goto('/')
  await waitForMapSettled(page)
  await setClockScale(page, CLOCK_SCALE)
  await pan(page, PAN_MS)
  expect(await quality(page)).toMatchObject({ override: 'high', active: 'high', steps: 0 })
})

const programsMax = (
  JSON.parse(readFileSync(join(ROOT, 'data/config/perf.json'), 'utf8')) as {
    programsMax: { low: number; mid: number; high: number }
  }
).programsMax

const settledPrograms = async (page: Page) => {
  await page.waitForFunction(() => window.__cloutcityTest?.scene?.pendingFrames() === 0, null, {
    polling: 'raf',
    timeout: 60_000,
  })
  return page.evaluate(() => window.__cloutcityTest?.scene?.programs() ?? Number.NaN)
}

// 3D-3: a shadow change used to leave every lit material's old programs compiled next to the new
// ones (mid reached 21 against programsMax 11). Each step-down now releases them.
test('programs stay within the new tier budget after high -> mid -> low step-downs', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await page.goto('/')
  await waitForMapSettled(page)
  expect(await quality(page)).toMatchObject({ active: 'high' })
  expect(await settledPrograms(page)).toBeLessThanOrEqual(programsMax.high)

  await setClockScale(page, CLOCK_SCALE)
  await pan(page, STEP_PAN_MAX_MS, async () => (await quality(page)).steps > 0)
  await setClockScale(page, 1)
  expect(await quality(page)).toMatchObject({ active: 'mid', steps: 1 })
  expect(await settledPrograms(page)).toBeLessThanOrEqual(programsMax.mid)

  // The next step waits out the cooldown.
  await page.waitForTimeout(perf.fpsStepDown.cooldownMs + 500)
  await setClockScale(page, CLOCK_SCALE)
  await pan(page, STEP_PAN_MAX_MS * 2, async () => (await quality(page)).steps > 1)
  await setClockScale(page, 1)
  expect(await quality(page)).toMatchObject({ active: 'low', steps: 2 })
  expect(await settledPrograms(page)).toBeLessThanOrEqual(programsMax.low)
})
