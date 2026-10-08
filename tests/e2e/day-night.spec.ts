import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { buildingsState, seedTier, waitForCityModels } from './helpers/cityModels'
import { at, clockSave, sceneLighting, seedClockSave, STORE_KEY } from './helpers/dayNight'
import { holdGameTime } from './helpers/hud'
import { readJson } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'

// S04f: the 3D city's light follows the personal game clock: keyframed sky, sun, ambient and
// hemisphere light; lit windows, landmark windows and pins glow at night (never a memorial);
// the scene redraws only when the lighting changes, and no shader recompiles with the time.

type PerTier<T> = { low: T; mid: T; high: T }
const perf = readJson<{
  drawCallsMax: PerTier<number>
  trianglesMax: PerTier<number>
  programsMax: PerTier<number>
}>('data/config/perf.json')
const memorials = readJson<{ landmarks: { id: string; category: string }[] }>(
  'data/landmarks/landmarks.json',
).landmarks.filter((landmark) => landmark.category === 'memorial')

/** The four looks the acceptance names, and the keyframe each shows. */
const TIMES = [
  { label: '0800', minute: at(8), keyframe: 'morning', ui: 'day', nightGlow: 0 },
  { label: 'golden', minute: at(17, 45), keyframe: 'golden', ui: 'day' },
  { label: '2100', minute: at(21), keyframe: 'night', ui: 'night', nightGlow: 1 },
  { label: '0300', minute: at(3), keyframe: 'night', ui: 'night', nightGlow: 1 },
] as const

async function bootAt(page: Page, minute: number, keyframe: string): Promise<void> {
  await seedClockSave(page, minute)
  await holdGameTime(page)
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await settleAt(page, keyframe)
}

/** Waits for the map, its models, and the save's keyframe on the scene, then for idle. */
async function settleAt(page: Page, keyframe: string): Promise<void> {
  await waitForMapSettled(page)
  await waitForCityModels(page)
  // The HUD island reads the save, then the rig re-lights the scene.
  await expect.poll(async () => (await sceneLighting(page))?.keyframe).toBe(keyframe)
  await page.waitForFunction(() => window.__cloutcityTest?.scene?.pendingFrames() === 0)
}

for (const time of TIMES) {
  test(`${time.label}: the scene shows the ${time.keyframe} keyframe`, async ({ page }) => {
    await bootAt(page, time.minute, time.keyframe)
    const lighting = await sceneLighting(page)
    expect(lighting?.keyframe).toBe(time.keyframe)
    expect(lighting?.ui).toBe(time.ui)
    if ('nightGlow' in time) expect(lighting?.nightGlow).toBe(time.nightGlow)
    // District windows read the same shared uniform the rig writes.
    expect((await buildingsState(page))?.nightGlow).toBe(lighting?.nightGlow)
    // Night fades the shadow; it never switches the light off.
    expect(lighting?.sun.intensity ?? 0).toBeGreaterThan(0)

    const glowing = await page.evaluate(() => window.__cloutcityTest?.scene?.glowingMeshes() ?? [])
    expect(glowing).toEqual(expect.arrayContaining(['pins-venue']))
    for (const memorial of memorials) {
      expect(glowing.some((name) => name.includes(memorial.id))).toBe(false)
    }

    // Idle: the clock is held, so nothing redraws.
    const frames = await page.evaluate(() => window.__cloutcityTest?.scene?.frames() ?? 0)
    await page.waitForTimeout(2000)
    expect(await page.evaluate(() => window.__cloutcityTest?.scene?.frames() ?? 0)).toBe(frames)

    // Canvas only: the HUD and other overlays have their own baselines.
    await page.addStyleTag({
      content:
        'body * { visibility: hidden !important; } [data-scene-root] canvas { visibility: visible !important; }',
    })
    await expect(page.locator('[data-scene-root] canvas')).toHaveScreenshot(
      `daynight-${time.label}.png`,
      { maxDiffPixelRatio: 0.02 },
    )
  })
}

test('reduced motion steps between keyframes instead of blending', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // 06:30 lies inside the dawn-to-morning blend.
  await bootAt(page, at(6, 30), 'dawn')
  const lighting = await sceneLighting(page)
  expect(lighting?.mode).toBe('step')
  expect(lighting?.keyframe).toBe('dawn')
  expect(lighting?.t).toBe(0)
})

for (const tier of ['low', 'mid', 'high'] as const) {
  test(`${tier}: draw calls, triangles and shader programs stay in budget at day and night`, async ({
    page,
  }) => {
    if (tier !== 'low') await seedTier(page, tier)
    const programs: number[] = []
    for (const [minute, keyframe] of [
      [at(8), 'morning'],
      [at(21), 'night'],
    ] as const) {
      if (programs.length === 0) {
        await bootAt(page, minute, keyframe)
      } else {
        // Same page and tier, another time: the clock is held, so the game writes nothing back.
        await page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [
          STORE_KEY,
          clockSave(minute),
        ] as const)
        await page.reload()
        await settleAt(page, keyframe)
      }
      const info = await page.evaluate(() => window.__cloutcityTest?.scene?.renderInfo())
      expect(info?.calls ?? Infinity).toBeLessThanOrEqual(perf.drawCallsMax[tier])
      expect(info?.triangles ?? Infinity).toBeLessThanOrEqual(perf.trianglesMax[tier])
      const count = await page.evaluate(() => window.__cloutcityTest?.scene?.programs() ?? 0)
      // Reported for the budget (perf.json programsMax, measured + 10%).
      test.info().annotations.push({ type: 'programs', description: `${tier} ${minute}: ${count}` })
      expect(count).toBeLessThanOrEqual(perf.programsMax[tier])
      programs.push(count)
    }
    // The time of day changes uniforms only: the same programs at day and at night.
    expect(programs[0]).toBe(programs[1])
  })
}
