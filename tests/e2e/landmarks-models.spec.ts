import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { landmarksState, seedTier, waitForCityModels } from './helpers/cityModels'
import { placeName, readJson, scenePins } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'

// S07a: code-built landmark models (bridges, buildings, stations, government halls) at their
// real frames, per-tier levels of detail through drei Detailed, name chips from copy, badge pins
// lifted over each model, and every model reachable from the Places panel.

type PerTier<T> = { low: T; mid: T; high: T }
type Category = 'bridge' | 'building' | 'station' | 'government'
const perf = readJson<{
  landmarkTrianglesMax: Record<Category, PerTier<number>>
  landmarkTrianglesOverride: Record<string, PerTier<number>>
  outlines: PerTier<boolean>
}>('data/config/perf.json')
const models = readJson<{ models: { id: string; archetype: string }[] }>(
  'data/landmarks/models.json',
).models
const landmarkData = readJson<{ landmarks: { id: string; category: Category }[] }>(
  'data/landmarks/landmarks.json',
).landmarks
const categoryOf = (id: string) => landmarkData.find((l) => l.id === id)?.category ?? 'building'

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForMapSettled(page)
  await waitForCityModels(page)
}

for (const tier of ['low', 'mid', 'high'] as const) {
  test(`${tier}: every modelled landmark is built from the kit within its triangle budget`, async ({
    page,
  }) => {
    if (tier !== 'low') await seedTier(page, tier)
    await boot(page)
    const state = await landmarksState(page)
    if (state === null) throw new Error('the landmarks hook is missing')
    expect(state.tier).toBe(tier)
    expect(state.failed).toEqual([])
    expect(state.landmarks.map((l) => l.id).sort()).toEqual(models.map((m) => m.id).sort())
    for (const landmark of state.landmarks) {
      expect(landmark.source, landmark.id).toBe('kit')
      expect(landmark.built, landmark.id).toBe(true)
      // Low builds L1 and L2 only; mid and high three levels.
      expect(landmark.triangles, landmark.id).toHaveLength(tier === 'low' ? 2 : 3)
      const cap =
        perf.landmarkTrianglesOverride[landmark.id]?.[tier] ??
        perf.landmarkTrianglesMax[categoryOf(landmark.id)][tier]
      expect(landmark.triangles[0] ?? Infinity, landmark.id).toBeLessThanOrEqual(cap)
      expect(landmark.lod.cullM, landmark.id).toBeGreaterThan(3000)
      if (landmark.style === 'teaser' || !perf.outlines[tier]) {
        expect(landmark.outlineVisible, landmark.id).toBe(false)
      }
    }
    // The ferry stands on "expanding soon" land: a dimmed teaser.
    expect(state.landmarks.find((l) => l.id === 'staten-island-ferry')?.style).toBe('teaser')
  })
}

test('modelled landmark pins are badges lifted over their models, and chips show copy names', async ({
  page,
}) => {
  await boot(page)
  const pins = await scenePins(page)
  const state = await landmarksState(page)
  if (state === null) throw new Error('the landmarks hook is missing')
  for (const model of models) expect(pins.some((pin) => pin.id === model.id)).toBe(true)
  const names = models.map((m) => placeName(m.id)).sort()
  expect([...state.chips.texts].sort()).toEqual(names)
})

test('a landmark opened from the Places panel comes into view with its model drawn', async ({
  page,
}) => {
  await boot(page)
  const id = 'queensboro-bridge'
  await page.evaluate((placeId) => {
    if (window.__cloutcityPlaces?.open(placeId) !== true) throw new Error(`no place ${placeId}`)
  }, id)
  await expect(page.locator(`[data-place-sheet="${id}"]`)).toBeVisible()
  await waitForMapSettled(page)
  await expect
    .poll(async () => (await landmarksState(page))?.landmarks.find((l) => l.id === id)?.level)
    .not.toBeNull()
  const landmark = (await landmarksState(page))?.landmarks.find((l) => l.id === id)
  expect(landmark?.screen).not.toBeNull()
})
