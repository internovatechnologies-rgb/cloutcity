import { expect, test } from '@playwright/test'
import { QUALITY_TIERS, type QualityTier } from '@/lib/data/schemas/config'
import type { SceneGlState, SceneQualityState } from '@/scene/testHooks'
import { waitForCityModels } from '../e2e/helpers/cityModels'
import { perf, seedPlayer, waitForPlayable, writeReport } from './measure'

// Draw calls and triangles at the default (Queens start) view on every tier, and the tier's
// renderer settings: DPR cap, antialias, PCFShadowMap shadows (high only), outlines. Counted
// once the district buildings, blocks (S04d) and landmark models (S07a) that load after the
// first frame have arrived, so the budgets cover the finished city, not the empty one. Counts do
// not depend on the network or CPU, so these loads are not throttled. Headless Chromium renders
// on SwiftShader, which the picker puts on the low tier: each tier is chosen in settings.

interface TierResult {
  readonly calls: number
  readonly triangles: number
  readonly gl: SceneGlState
  readonly quality: SceneQualityState
  /** Triangles the buildings and landmark models add to the view (S04d, S07a). */
  readonly buildings: {
    readonly districts: number
    readonly blocks: number
    readonly loaded: readonly string[]
  }
  readonly landmarks: { readonly drawn: readonly string[]; readonly triangles: number }
}

const results: Partial<Record<QualityTier, TierResult>> = {}

test.describe.configure({ mode: 'serial' })

for (const tier of QUALITY_TIERS) {
  test(`${tier} tier at the default view`, async ({ page }) => {
    await seedPlayer(page, tier)
    await page.goto('/')
    await waitForPlayable(page)
    // Buildings and models have loaded and the view has settled: nothing left to draw.
    await waitForCityModels(page)
    const result = await page.evaluate(() => {
      const scene = window.__cloutcityTest?.scene
      if (scene === undefined) throw new Error('the scene test hook is missing')
      const buildings = scene.buildings()
      const landmarks = scene.landmarks()
      const visible = buildings?.districts.filter((d) => d.visible) ?? []
      const drawn = landmarks?.landmarks.filter((l) => l.level !== null) ?? []
      return {
        ...scene.renderInfo(),
        gl: scene.gl(),
        quality: scene.quality(),
        buildings: {
          districts: visible.reduce((sum, d) => sum + d.triangles, 0),
          blocks: buildings?.blocks.triangles ?? 0,
          loaded: buildings?.districts.filter((d) => d.status === 'ready').map((d) => d.id) ?? [],
        },
        landmarks: {
          drawn: drawn.map((l) => l.id),
          // Low builds L1 and L2 only, so its first entry is level 1.
          triangles: drawn.reduce((sum, l) => {
            const offset = l.triangles.length === 2 ? 1 : 0
            return sum + (l.triangles[(l.level ?? 0) - offset] ?? 0)
          }, 0),
        },
      }
    })
    results[tier] = result
    test.info().annotations.push({ type: tier, description: JSON.stringify(result) })

    expect(result.quality.active).toBe(tier)
    expect(result.gl.dprCap).toBe(perf.dprCap[tier])
    expect(result.gl.pixelRatio).toBeLessThanOrEqual(perf.dprCap[tier])
    expect(result.gl.antialias).toBe(perf.antialias[tier])
    expect(result.gl.shadowMap.type).toBe('PCFShadowMap')
    const shadows = perf.shadows[tier] === 'pcf-directional'
    expect(result.gl.shadowMap.enabled).toBe(shadows)
    expect(result.gl.sun).toEqual({
      castShadow: shadows,
      mapSizePx: perf.shadowMapSizePx[tier],
    })
    expect(result.gl.outlines).toBe(perf.outlines[tier])
    expect.soft(result.calls, `${tier}: draw calls`).toBeLessThanOrEqual(perf.drawCallsMax[tier])
    expect(result.triangles, `${tier}: triangles`).toBeLessThanOrEqual(perf.trianglesMax[tier])
    // The buildings alone stay inside the geo build's per-tier building cap (TUNE-7), and the
    // Queens start view loads its own district (Astoria) without loading the whole city.
    expect(
      result.buildings.districts + result.buildings.blocks,
      `${tier}: building triangles`,
    ).toBeLessThanOrEqual(perf.buildingTrianglesMax[tier])
    expect(result.buildings.loaded, `${tier}: loaded districts`).toContain('astoria')
    expect(result.buildings.loaded.length, `${tier}: loaded districts`).toBeLessThan(8)
  })
}

test.afterAll(() => {
  writeReport('tiers', {
    view: 'default (Queens start)',
    results,
    budget: { drawCallsMax: perf.drawCallsMax, trianglesMax: perf.trianglesMax },
  })
})
