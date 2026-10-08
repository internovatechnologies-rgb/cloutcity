import { expect, test } from './fixtures/test'
import { openFromHud } from './helpers/hud'
import { buildingsState, seedTier, waitForCityModels } from './helpers/cityModels'
import { readJson } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'

// S04d: district buildings and procedural blocks on the 3D map. They load after the map's first
// frame (the map is playable without them), per tier from /geo/districts/<tier>/<id> and
// /geo/blocks/<tier>, only near the view, drawn at the tier's density and distances.

type PerTier<T> = { low: T; mid: T; high: T }
const perf = readJson<{
  buildingDensity: PerTier<number>
  lodDistanceScale: PerTier<number>
  trianglesMax: PerTier<number>
  drawCallsMax: PerTier<number>
}>('data/config/perf.json')
const scene = readJson<{
  buildings: { viewM: { districts: number }; windows: PerTier<boolean> }
}>('data/config/scene.json')
const geo = readJson<{ districts: { id: string }[] }>('data/config/geo.json')

test('the map is playable before any building loads, then the nearby districts arrive', async ({
  page,
}) => {
  const districtRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/geo/districts/') || url.pathname.startsWith('/geo/blocks/')) {
      districtRequests.push(`${url.pathname}${url.search}`)
    }
  })
  await page.goto('/')
  await waitForMapSettled(page)
  await waitForCityModels(page)

  const state = await buildingsState(page)
  if (state === null) throw new Error('the buildings hook is missing')
  expect(state.tier).toBe('low')
  expect(state.density).toBe(perf.buildingDensity.low)
  expect(state.drawDistances.districts).toBeCloseTo(
    scene.buildings.viewM.districts * perf.lodDistanceScale.low,
    3,
  )
  // Every request is versioned, low tier only, and never for a district out of reach.
  expect(districtRequests.length).toBeGreaterThan(0)
  for (const url of districtRequests)
    expect(url).toMatch(/^\/geo\/(districts\/low\/[a-z-]+|blocks\/low)\?v=[0-9a-f]{12}$/)
  const loaded = state.districts.filter((d) => d.status === 'ready').map((d) => d.id)
  expect(loaded).toContain('astoria')
  expect(loaded.length).toBeLessThan(geo.districts.length)
  expect(state.districts.every((d) => d.status !== 'failed')).toBe(true)
  const astoria = state.districts.find((d) => d.id === 'astoria')
  expect(astoria?.visible).toBe(true)
  expect(astoria?.drawnMasses).toBe(Math.ceil((astoria?.masses ?? 0) * perf.buildingDensity.low))
  expect(state.blocks.status).toBe('ready')
  expect(state.blocks.drawn).toBeLessThan(state.blocks.total)
  expect(state.windows).toBe(scene.buildings.windows.low)
  // A new game starts at 08:00 (S04f): daylight, so the shared night glow is off.
  expect(state.nightGlow).toBe(0)
})

test('the high tier draws every building with windows and stays inside its budgets', async ({
  page,
}) => {
  await seedTier(page, 'high')
  await page.goto('/')
  await waitForMapSettled(page)
  await waitForCityModels(page)
  const state = await buildingsState(page)
  if (state === null) throw new Error('the buildings hook is missing')
  expect(state.tier).toBe('high')
  expect(state.density).toBe(perf.buildingDensity.high)
  expect(state.windows).toBe(scene.buildings.windows.high)
  for (const district of state.districts.filter((d) => d.status === 'ready')) {
    expect(district.drawnMasses).toBe(district.masses)
  }
  const info = await page.evaluate(() => window.__cloutcityTest?.scene?.renderInfo())
  expect(info?.triangles ?? Infinity).toBeLessThanOrEqual(perf.trianglesMax.high)
  expect(info?.calls ?? Infinity).toBeLessThanOrEqual(perf.drawCallsMax.high)
})

test('buildings follow a tier change without a reload', async ({ page }) => {
  await page.goto('/')
  await waitForMapSettled(page)
  await waitForCityModels(page)
  await openFromHud(page, 'Settings')
  await page
    .getByRole('region', { name: 'Settings' })
    .getByRole('group', { name: 'Graphics' })
    .getByRole('radio', { name: 'Mid', exact: true })
    .check()
  await expect.poll(async () => (await buildingsState(page))?.tier).toBe('mid')
  await waitForCityModels(page)
  const state = await buildingsState(page)
  expect(state?.density).toBe(perf.buildingDensity.mid)
  expect(state?.districts.some((d) => d.status === 'ready')).toBe(true)
})
