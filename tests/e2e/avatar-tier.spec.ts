import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { seedTier, waitForCityModels } from './helpers/cityModels'
import { openFromHud } from './helpers/hud'
import { waitForMapSettled } from './helpers/scene'

// 3D-1: the player's hand-made avatar (S04h) is drawn on mid and high and swapped for the capsule
// on low (scene.json models.player.capsuleTiers). A live switch to low unmounts the model; the
// capsule must come back with it, or the player is invisible. Back on mid, the model returns.

test.setTimeout(120_000)

const player = (page: Page) =>
  page.evaluate(() => {
    const scene = window.__cloutcityTest?.scene
    return {
      tier: scene?.quality().active,
      model: scene?.player()?.model,
      avatarMeshes: (scene?.glowingMeshes() ?? []).filter((name) => name.endsWith('-mesh')),
      pending: scene?.pendingFrames(),
    }
  })

async function chooseGraphics(page: Page, name: 'Low' | 'Mid') {
  const settings = page.getByRole('region', { name: 'Settings' })
  if (!(await settings.isVisible())) await openFromHud(page, 'Settings')
  await settings
    .getByRole('group', { name: 'Graphics' })
    .getByRole('radio', { name, exact: true })
    .check()
}

test('a live switch to Low shows the capsule, and Mid brings the avatar back', async ({ page }) => {
  await seedTier(page, 'mid')
  await page.goto('/')
  await waitForMapSettled(page)
  await waitForCityModels(page)
  await expect.poll(async () => (await player(page)).model, { timeout: 30_000 }).toBe(true)

  await chooseGraphics(page, 'Low')
  await expect.poll(async () => (await player(page)).tier).toBe('low')
  // The capsule is visible (model false) and no avatar mesh is left in the scene.
  await expect
    .poll(async () => {
      const state = await player(page)
      return { model: state.model, meshes: state.avatarMeshes, pending: state.pending }
    })
    .toEqual({ model: false, meshes: [], pending: 0 })

  await chooseGraphics(page, 'Mid')
  await expect.poll(async () => (await player(page)).tier).toBe('mid')
  await expect.poll(async () => (await player(page)).model, { timeout: 30_000 }).toBe(true)
})
