import type { Locator, Page } from '@playwright/test'
import { expect, test, waitForWelcomeGate, type ExpectedConsoleMessage } from './fixtures/test'
import { NO_WEBGL_WARNING, placesPanel } from './helpers/fallback'
import { seedTier, waitForCityModels } from './helpers/cityModels'
import { copyText, placeName, readJson } from './helpers/places'
import { waitForMapSettled } from './helpers/scene'

// S08 part 2: travel. A new player starts at home; a place's actions and shop need them there
// (DEC-22). "Get there" rows come from the engine's plan (the travel hook reads the same data),
// the trip is in the save the moment it starts, the 3D animation and the HUD clock only show it,
// and the destination's sheet opens again on arrival with what the trip did.

const DELI = 'late-lantern-deli'

const transit = readJson<{ transit: { animation: { maxMs: number } } }>(
  'data/config/balance.json',
).transit
const perf = readJson<{ programsMax: Record<'low' | 'mid' | 'high', number> }>(
  'data/config/perf.json',
)

/** About 2.6 km on foot from the Queens home: a full-length animation. */
const FAR = 'glowmatic'

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
  // These specs are about travel: a random arrival event (a modal) must not land on the place
  // sheet they click in next (TRV-4). Events have their own specs.
  await page.waitForFunction(() => window.__cloutcityTest?.travel !== undefined)
  await page.evaluate(() => window.__cloutcityTest?.travel?.suppressArrivalEvents(true))
}

/** The avatar's position on the map, in local metres. */
const avatarAt = (page: Page) =>
  page.evaluate(() => window.__cloutcityTest?.scene?.player()?.local ?? null)
const apart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

/** Where the avatar rests at `id`: stand there, reload, read it. Leaves the player at home. */
async function restPointAt(page: Page, id: string) {
  await page.evaluate((placeId) => window.__cloutcityPlaces?.setLocation(placeId), id)
  await page.reload()
  await waitForWelcomeGate(page)
  await waitForMapSettled(page)
  const rest = await avatarAt(page)
  await page.evaluate(() => window.__cloutcityPlaces?.setLocation('home'))
  await page.reload()
  await waitForWelcomeGate(page)
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
  await page.waitForFunction(() => window.__cloutcityTest?.travel !== undefined)
  await page.evaluate(() => window.__cloutcityTest?.travel?.suppressArrivalEvents(true))
  if (rest === null) throw new Error('no avatar')
  return rest
}

const sheet = (page: Page, id = DELI): Locator => page.locator(`[data-place-sheet="${id}"]`)
const mode = (page: Page, travel: string, id = DELI): Locator =>
  sheet(page, id).locator(`[data-trip-mode="${travel}"]`)
const progress = (page: Page): Locator => page.locator('[data-trip-progress]')
const money = (page: Page): Locator =>
  page.locator('[data-overlay-zone="hud"] [data-hud-value="money"]')

async function open(page: Page, id = DELI): Promise<void> {
  await page.evaluate((placeId) => window.__cloutcityPlaces?.open(placeId), id)
  await expect(sheet(page, id)).toBeVisible()
}

/** The travel chunk's hook is ready (it installs with the chunk) and the routes are built. */
async function routesReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__cloutcityTest?.travel?.state().world === 'ready')
}

const travelState = (page: Page) =>
  page.evaluate(() => {
    const hook = window.__cloutcityTest?.travel
    if (hook === undefined) throw new Error('no travel hook')
    return hook.state()
  })

const options = (page: Page, id = DELI) =>
  page.evaluate((destination) => {
    const hook = window.__cloutcityTest?.travel
    if (hook === undefined) throw new Error('no travel hook')
    return hook.options(destination)
  }, id)

test.describe('travel', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('away from a place, its actions wait and "Get there" offers every mode from the plan', async ({
    page,
    checkA11y,
  }) => {
    await open(page)
    await routesReady(page)
    expect((await travelState(page)).location).toEqual({ kind: 'home' })
    // Every action says why it waits, in its text and accessible name.
    const actions = sheet(page).locator('button[data-place-action]')
    await expect(actions.first()).toBeDisabled()
    await expect(actions.first()).toContainText(copyText('place.blocked.away'))
    // One row per mode, labelled from the copy, with the plan's time and fare (GR-10).
    const rows = await options(page)
    expect(rows.map((row) => row.mode)).toEqual(['walk', 'subway', 'taxi'])
    for (const row of rows) {
      const button = mode(page, row.mode)
      await expect(button).toContainText(copyText(`travel.mode.${row.mode}.action`))
      if (row.blocked === null) {
        await expect(button).toBeEnabled()
        if (row.fare !== null && row.fare > 0) await expect(button).toContainText(`$${row.fare}`)
      } else {
        await expect(button).toBeDisabled()
      }
    }
    await checkA11y()
  })

  test('a walk lands at the place: clock moved, sheet back with the arrival, actions open', async ({
    page,
  }) => {
    await open(page)
    await routesReady(page)
    const before = await page.evaluate(() => window.__cloutcityPlaces?.state().minute ?? 0)
    const walk = (await options(page)).find((row) => row.mode === 'walk')
    if (walk === undefined || walk.blocked !== null) throw new Error('the deli is not walkable')
    await mode(page, 'walk').click()

    // Committed at once: the save already holds the trip while the animation runs.
    const during = await travelState(page)
    expect(during.location).toEqual({ kind: 'place', placeId: DELI })
    if (during.active !== null) {
      expect(during.active.durationMs).toBeLessThanOrEqual(transit.animation.maxMs)
      await expect(progress(page)).toBeVisible()
      await expect(progress(page).getByRole('progressbar')).toBeVisible()
      await expect(
        progress(page).getByRole('button', { name: copyText('travel.skipLabel') }),
      ).toBeFocused()
    }
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
    await expect(progress(page)).toHaveCount(0)

    const after = await page.evaluate(() => window.__cloutcityPlaces?.state().minute ?? 0)
    expect(after - before).toBeGreaterThanOrEqual(walk.durationMin)
    await expect(sheet(page)).toHaveAttribute('data-player-here', '')
    await expect(page.locator('[data-place-announcer]')).toHaveText(
      copyText('travel.announce.arrived', { place: placeName(DELI) }),
    )
    await expect(sheet(page).locator('[data-trip-arrival]')).toContainText(placeName(DELI))
    await expect(sheet(page).locator('[data-get-there]')).toHaveCount(0)
    await expect(sheet(page).locator('button[data-place-action]:enabled').first()).toBeVisible()
    // Walking is free.
    await expect(money(page)).toHaveText('$150')
  })

  test('a taxi charges exactly the fare its row showed', async ({ page }) => {
    await open(page)
    await routesReady(page)
    const taxi = (await options(page)).find((row) => row.mode === 'taxi')
    if (taxi === undefined || taxi.blocked !== null || taxi.fare === null) {
      throw new Error('no taxi to the deli')
    }
    await mode(page, 'taxi').click()
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
    await expect(sheet(page)).toHaveAttribute('data-player-here', '')
    await expect(money(page)).toHaveText(`$${150 - taxi.fare}`)
  })

  test('a mode the player cannot pay for is disabled and says why', async ({ page }) => {
    await page.evaluate(() => window.__cloutcityPlaces?.setCash(0))
    await open(page)
    await routesReady(page)
    const taxi = mode(page, 'taxi')
    await expect(taxi).toBeDisabled()
    const required = (await options(page)).find((row) => row.mode === 'taxi')?.fare ?? 0
    await expect(taxi).toHaveAccessibleName(
      new RegExp(
        copyText('travel.blocked.funds', { required: `$${required}`, available: '$0' }).replace(
          /[.$]/g,
          '\\$&',
        ),
      ),
    )
  })

  test('the HUD clock counts up through the trip', async ({ page }) => {
    await open(page)
    await routesReady(page)
    await mode(page, 'walk').click()
    const state = await travelState(page)
    test.skip(state.active === null, 'this run cut straight to the arrival')
    await page.evaluate(() => window.__cloutcityTest?.travel?.seek(0))
    const start = await page.locator('[data-hud-value="time"]').first().textContent()
    await page.evaluate(() => window.__cloutcityTest?.travel?.seek(0.99))
    await expect(page.locator('[data-hud-value="time"]').first()).not.toHaveText(start ?? '')
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
  })

  test('Home is first in the Places panel; the player goes home from its card', async ({
    page,
  }) => {
    await page.evaluate((id) => window.__cloutcityPlaces?.setLocation(id), DELI)
    await page.locator('[data-places-button]').click()
    const home = placesPanel(page).locator('[data-place-button="home"]')
    await expect(placesPanel(page).locator('[data-place-button]').first()).toHaveAttribute(
      'data-place-button',
      'home',
    )
    await expect(placesPanel(page).locator(`[data-place-button="${DELI}"]`)).toHaveAttribute(
      'data-player-here',
      '',
    )
    await home.click()
    await expect(sheet(page, 'home')).toBeVisible()
    await routesReady(page)
    await mode(page, 'walk', 'home').click()
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
    await expect(sheet(page, 'home')).toHaveAttribute('data-player-here', '')
    await expect(sheet(page, 'home')).toContainText(copyText('travel.hereHome'))
    expect((await travelState(page)).location).toEqual({ kind: 'home' })
  })

  test('a reload mid-trip keeps the trip: the player is already there', async ({ page }) => {
    await open(page)
    await routesReady(page)
    await mode(page, 'walk').click()
    await page.reload()
    await waitForWelcomeGate(page)
    await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
    expect(await page.evaluate(() => window.__cloutcityPlaces?.state().location)).toEqual({
      kind: 'place',
      placeId: DELI,
    })
  })
})

test.describe('travel with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('cuts straight to the arrival: no animation', async ({ page }) => {
    await boot(page)
    await open(page)
    await routesReady(page)
    await mode(page, 'walk').click()
    expect((await travelState(page)).active).toBeNull()
    await expect(progress(page)).toHaveCount(0)
    await expect(sheet(page)).toHaveAttribute('data-player-here', '')
  })
})

test.describe('travel on a short landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  test('the progress card fits the sheet zone', async ({ page }) => {
    await boot(page)
    await open(page)
    await routesReady(page)
    await mode(page, 'walk').click()
    const state = await travelState(page)
    test.skip(state.active === null, 'this run cut straight to the arrival')
    const zone = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
    const card = await progress(page).boundingBox()
    if (zone === null || card === null) throw new Error('no zone or card')
    expect(card.y).toBeGreaterThanOrEqual(zone.y)
    expect(card.y + card.height).toBeLessThanOrEqual(zone.y + zone.height)
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
  })
})

test.describe('travel without WebGL', () => {
  test.use({ expectedConsole: [NO_WEBGL_WARNING] })

  test('the trip lands at once and the place plays', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        if (/webgl/i.test(type)) return null
        return (original as (...a: unknown[]) => unknown).call(this, type, ...rest)
      } as typeof HTMLCanvasElement.prototype.getContext
    })
    await boot(page)
    await placesPanel(page).locator(`[data-place-button="${DELI}"]`).click()
    await routesReady(page)
    await mode(page, 'walk').click()
    expect((await travelState(page)).active).toBeNull()
    await expect(sheet(page)).toHaveAttribute('data-player-here', '')
    await sheet(page).locator('button[data-place-action]:enabled').first().click()
  })
})

const GEO_500_WARNING: ExpectedConsoleMessage = {
  type: 'warning',
  text: /"context":\{"reason":"geo-http","status":500\}/,
  count: 1,
}
const FAILED_RESOURCE_500: ExpectedConsoleMessage = {
  type: 'error',
  text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
}

test.describe('travel when the routes cannot load', () => {
  test.use({ expectedConsole: [[GEO_500_WARNING, FAILED_RESOURCE_500], { scope: 'test' }] })

  test('shows a taxi estimate and a Retry; the estimate still gets the player there', async ({
    page,
  }) => {
    await page.route('**/geo/base*', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }),
    )
    await boot(page)
    await open(page)
    await page.waitForFunction(() => window.__cloutcityTest?.travel?.state().world === 'failed')
    await expect(sheet(page).locator('[data-travel-retry]')).toBeVisible()
    await expect(sheet(page).getByText(copyText('travel.status.failed'))).toBeVisible()
    await expect(mode(page, 'walk')).toBeDisabled()
    await expect(mode(page, 'taxi')).toBeEnabled()
    await expect(mode(page, 'taxi')).toContainText(copyText('travel.option.estimate'))
    await mode(page, 'taxi').click()
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
    await expect(sheet(page)).toHaveAttribute('data-player-here', '')
  })
})

test.describe('travel: the avatar and focus when a trip ends early', () => {
  test('Skip mid-trip stands the avatar at the destination, not mid-route (TRV-2)', async ({
    page,
  }) => {
    await boot(page)
    const rest = await restPointAt(page, FAR)
    await open(page, FAR)
    await routesReady(page)
    await mode(page, 'walk', FAR).click()
    test.skip((await travelState(page)).active === null, 'this run cut straight to the arrival')
    await page.evaluate(() => window.__cloutcityTest?.travel?.seek(0.3))
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
    await waitForMapSettled(page)
    const after = await avatarAt(page)
    if (after === null) throw new Error('no avatar')
    expect(apart(after, rest)).toBeLessThan(5)
  })

  test('a trip left to finish ends on the destination rest point', async ({ page }) => {
    await boot(page)
    const rest = await restPointAt(page, FAR)
    await open(page, FAR)
    await routesReady(page)
    await mode(page, 'walk', FAR).click()
    test.skip((await travelState(page)).active === null, 'this run cut straight to the arrival')
    await expect(progress(page)).toHaveCount(0, { timeout: transit.animation.maxMs + 5000 })
    await waitForMapSettled(page)
    const after = await avatarAt(page)
    if (after === null) throw new Error('no avatar')
    expect(apart(after, rest)).toBeLessThan(5)
  })

  test('a held Enter starts the trip once and does not also press Skip (TRV-6)', async ({
    page,
  }) => {
    await boot(page)
    await open(page, FAR)
    await routesReady(page)
    await mode(page, 'walk', FAR).focus()
    await page.keyboard.down('Enter')
    test.skip((await travelState(page)).active === null, 'this run cut straight to the arrival')
    await expect(page.locator('[data-trip-skip]')).toBeFocused()
    await page.keyboard.down('Enter') // the auto-repeat
    await page.keyboard.up('Enter')
    expect((await travelState(page)).active).not.toBeNull()
    await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
  })
})

test.describe('travel: focus after a cut arrival', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('reduced motion: focus moves to the arrival, never to the page (TRV-3)', async ({
    page,
  }) => {
    await boot(page)
    await open(page, FAR)
    await routesReady(page)
    await mode(page, 'walk', FAR).focus()
    await page.keyboard.press('Enter')
    await expect(sheet(page, FAR)).toHaveAttribute('data-player-here', '')
    const dismiss = sheet(page, FAR)
      .locator('[data-trip-arrival]')
      .getByRole('button', { name: copyText('place.result.dismiss') })
    await expect(dismiss).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(sheet(page, FAR).getByRole('heading', { level: 2 })).toBeFocused()
  })
})

test.describe('travel: shader programs during a trip (3D-2)', () => {
  for (const tier of ['low', 'mid'] as const) {
    test(`${tier}: a taxi trip compiles no program past programsMax`, async ({ page }) => {
      if (tier !== 'low') await seedTier(page, tier)
      await boot(page)
      await waitForCityModels(page)
      const programs = () =>
        page.evaluate(() => window.__cloutcityTest?.scene?.programs() ?? Number.NaN)
      expect(await page.evaluate(() => window.__cloutcityTest?.scene?.quality().active)).toBe(tier)
      await open(page)
      await routesReady(page)
      const taxi = mode(page, 'taxi')
      await expect(taxi).toBeEnabled()
      await taxi.click()
      test.skip((await travelState(page)).active === null, 'this run cut straight to the arrival')
      await page.evaluate(() => window.__cloutcityTest?.travel?.seek(0.5))
      await expect.poll(programs).toBeGreaterThan(0)
      expect(await programs()).toBeLessThanOrEqual(perf.programsMax[tier])
      await page.evaluate(() => window.__cloutcityTest?.travel?.skip())
      await waitForMapSettled(page)
      expect(await programs()).toBeLessThanOrEqual(perf.programsMax[tier])
    })
  }
})

test.describe('travel when the routes come back', () => {
  test.use({ expectedConsole: [[GEO_500_WARNING, FAILED_RESOURCE_500], { scope: 'test' }] })

  test('Retry rebuilds the routes once /geo/base answers again (TRV-1)', async ({ page }) => {
    let fail = true
    let requests = 0
    await page.route('**/geo/base*', async (route) => {
      requests++
      if (fail) await route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' })
      else await route.continue()
    })
    await boot(page)
    await open(page)
    await page.waitForFunction(() => window.__cloutcityTest?.travel?.state().world === 'failed')
    fail = false
    const before = requests
    await sheet(page).locator('[data-travel-retry]').click()
    await routesReady(page)
    expect(requests).toBeGreaterThan(before)
    await expect(sheet(page).locator('[data-travel-retry]')).toHaveCount(0)
    await expect(mode(page, 'walk')).toBeEnabled()
  })
})

test.describe('travel: the map after a reload at a place', () => {
  test('the camera starts over the avatar standing at the place, not over home', async ({
    page,
  }) => {
    await boot(page)
    await page.evaluate((id) => window.__cloutcityPlaces?.setLocation(id), FAR)
    await page.reload()
    await waitForWelcomeGate(page)
    await waitForMapSettled(page)
    const avatar = await avatarAt(page)
    const target = await page.evaluate(() => {
      const camera = window.__cloutcityTest?.scene?.camera()
      return camera === null || camera === undefined
        ? null
        : { x: camera.target.x, y: -camera.target.z }
    })
    if (avatar === null || target === null) throw new Error('no scene')
    // FreeRowFraming offsets the view, not the target: the target sits at the avatar.
    expect(apart(avatar, target)).toBeLessThan(50)
  })
})

test.describe('travel: "Get there" on a short landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  test('every row scrolls into the sheet zone', async ({ page }) => {
    await boot(page)
    await open(page, FAR)
    await routesReady(page)
    const zone = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
    if (zone === null) throw new Error('no sheet zone')
    for (const travel of ['walk', 'subway', 'taxi']) {
      const row = mode(page, travel, FAR)
      await row.scrollIntoViewIfNeeded()
      const box = await row.boundingBox()
      if (box === null) throw new Error(`no ${travel} row`)
      expect(box.y, travel).toBeGreaterThanOrEqual(zone.y - 1)
      expect(box.y + box.height, travel).toBeLessThanOrEqual(zone.y + zone.height + 1)
    }
  })
})
