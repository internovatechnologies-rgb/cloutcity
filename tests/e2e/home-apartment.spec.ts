import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { HudTestHook } from '@/components/hud/hudTestHook'
import type { ApartmentTestHook } from '@/scene/apartment/apartmentTestHook'
import { expect, test, waitForWelcomeGate, type ExpectedConsoleMessage } from './fixtures/test'
import {
  holdGameTime,
  hudIsWide,
  hudOpener,
  moreButton,
  morePanel,
  openFromHud,
} from './helpers/hud'
import { hideSceneForScreenshot, SCENE_READY_TIMEOUT_MS, waitForMapSettled } from './helpers/scene'

// S16: the apartment. Decor is placed both ways: through the Home panel's slot list with the
// keyboard only (A11Y-3) and by tapping a slot in the 3D room. Colour variants are radios named
// in words (A11Y-1), locked homes say why in their accessible name (A11Y-2), the home score feeds
// the HUD's clout, the room survives a reload, and the room stays within its per-tier budgets
// with the S16a avatar's reserve kept free. Numbers come from data and the hooks, not literals.

const ROOT = join(import.meta.dirname, '../..')
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))

interface DecorItem {
  readonly id: string
  readonly price: number
  readonly category: string
  readonly decor?: { readonly fits: string; readonly homeScore: number }
}
const items = (readJson('data/items/items.json') as { items: DecorItem[] }).items
const decorScore = (id: string) => items.find((item) => item.id === id)?.decor?.homeScore ?? 0
const balance = readJson('data/config/balance.json') as {
  rentPerWeek: Record<string, number>
  housing: { moveInCost: Record<string, number> }
  clout: { levels: { id: string; minClout: number }[] }
  boroughs: Record<string, { access: string; level?: string }>
}
const interiors = readJson('data/homes/interiors.json') as {
  homes: Record<string, { slots: { id: string }[] }>
}
const levelClout = (level: string) =>
  balance.clout.levels.find((entry) => entry.id === level)?.minClout ?? Number.NaN

const LIGHTS = 'fairy-string-lights'
const PLANT = 'windowsill-monstera'

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForWelcomeGate(page)
  await page.waitForFunction(
    () => window.__cloutcityPlaces !== undefined && window.__cloutcityTest?.hud !== undefined,
  )
  await waitForMapSettled(page)
}

const hudState = (page: Page) =>
  page.evaluate((): ReturnType<HudTestHook['state']> => {
    const hook = window.__cloutcityTest?.hud
    if (hook === undefined) throw new Error('hud test hook is not installed')
    return hook.state()
  })

const totalClout = (page: Page) =>
  page.evaluate(() => window.__cloutcityPlaces?.state().clout ?? Number.NaN)

/** Gives the player `cash`, then buys `ids` through the store and engine. */
async function buy(page: Page, ids: readonly string[], cash = 5000) {
  await page.evaluate(
    ([list, money]) => {
      window.__cloutcityPlaces?.setCash(money)
      for (const id of list) {
        if (window.__cloutcityTest?.hud?.buy(id) !== true) throw new Error(`could not buy ${id}`)
      }
    },
    [ids, cash] as const,
  )
}

const homeDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Home' })

async function openHome(page: Page): Promise<Locator> {
  await openFromHud(page, 'Home')
  const dialog = homeDialog(page)
  await expect(dialog.getByRole('heading', { name: 'Home', exact: true })).toBeFocused()
  return dialog
}

/**
 * Waits for the panel's action guard to settle (useActionGuard.ts): presses while the last action
 * settles are ignored on purpose, so a spec acting faster than a person waits it out.
 */
const settled = (dialog: Locator) => expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0)

/** Waits until the 3D room has drawn and on-demand rendering is idle. */
async function waitForRoom(page: Page) {
  await page.waitForFunction(
    () => {
      const hook = window.__cloutcityTest?.apartment
      return hook?.ready === true && hook.pendingFrames() === 0
    },
    null,
    { polling: 'raf', timeout: SCENE_READY_TIMEOUT_MS },
  )
}

/** Reads the apartment hook (installed in test builds once the room has mounted). */
const room = <T>(page: Page, read: string, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([what, value]) => {
      const hook = window.__cloutcityTest?.apartment
      if (hook === undefined) throw new Error('apartment test hook is not installed')
      switch (what) {
        case 'slotScreen':
          return hook.slotScreen(String(value)) as T
        case 'wall-1 item':
          return (hook.slots().find((slot) => slot.id === 'wall-1')?.itemId ?? null) as T
        case 'tier':
          return hook.tier() as T
        case 'frames':
          return hook.frames() as T
        case 'info':
          return { ...hook.renderInfo(), ...hook.budget() } as T
        default:
          throw new Error(`unknown read ${what}`)
      }
    },
    [read, arg] as const,
  )

test.describe('home and apartment', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page)
  })

  test('places decor through the slot list with the keyboard only, and clout rises by its score', async ({
    page,
    checkA11y,
  }) => {
    await buy(page, [PLANT])
    const before = await totalClout(page)

    // Into the panel by keyboard: the HUD button, or More and its Home item on phones.
    if (hudIsWide(page)) {
      await hudOpener(page, 'Home').focus()
      await page.keyboard.press('Enter')
    } else {
      await moreButton(page).focus()
      await page.keyboard.press('Enter')
      await morePanel(page).getByRole('button', { name: 'Home', exact: true }).focus()
      await page.keyboard.press('Enter')
    }
    const dialog = homeDialog(page)
    await expect(dialog.getByRole('heading', { name: 'Home', exact: true })).toBeFocused()

    const pick = dialog.locator(`[data-home-stored="${PLANT}"]`).getByRole('button', {
      name: /^Pick up .+ to place it$/,
    })
    await pick.focus()
    await page.keyboard.press('Enter')
    // Holding it moves focus to the first spot it fits.
    const placeHere = dialog.locator('[data-home-slot="surface-1"] [data-home-place-here]')
    await expect(placeHere).toBeFocused()
    await expect(placeHere).toHaveAccessibleName(/^Place .+ on the Windowsill$/)
    // The action guard ignores presses while the last action settles (useActionGuard.ts).
    await settled(dialog)
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await hudState(page)).placed['surface-1']).toBe(PLANT)
    await expect(
      dialog
        .locator('[data-home-slot="surface-1"]')
        .getByRole('button', { name: /^Put .+ in storage$/ }),
    ).toBeFocused()
    await expect(dialog.locator('[data-panel-status]')).toContainText('Windowsill')

    // Home clout is the placed decor's score, and the HUD meter counts it.
    const gain = decorScore(PLANT)
    expect(gain).toBeGreaterThan(0)
    await expect.poll(() => totalClout(page)).toBe(before + gain)
    await expect(
      page.locator('[data-overlay-zone="hud"] [data-clout-meter] progress'),
    ).toHaveAccessibleName(new RegExp(`^Clout: \\w+, ${before + gain} of `))
    await expect(dialog.locator('[data-home-score]')).toContainText(`+${gain} clout`)

    // Put away by keyboard too: back in storage, clout back down.
    await settled(dialog)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await hudState(page)).placed['surface-1']).toBeUndefined()
    await expect.poll(() => totalClout(page)).toBe(before)
    await checkA11y()
  })

  test('the Map data chip leaves with the map while the room shows, and comes back (UI-16)', async ({
    page,
  }) => {
    const chip = page.locator('[data-map-attribution]')
    await expect(chip).toBeVisible()
    const dialog = await openHome(page)
    await waitForRoom(page)
    await expect(chip).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(chip).toBeVisible()
  })

  test('places decor by tapping its slot in the 3D room', async ({ page }) => {
    await buy(page, [LIGHTS])
    const dialog = await openHome(page)
    await waitForRoom(page)
    await expect(page.locator('[data-cc-feature="cc-feature:city-scene"]')).toHaveAttribute(
      'data-scene-hidden',
      '',
    )

    await dialog.locator(`[data-home-stored="${LIGHTS}"] [data-home-pick]`).click()
    const target = await room<{ x: number; y: number } | null>(page, 'slotScreen', 'wall-1')
    if (target === null) throw new Error('wall-1 is not on screen')
    // The tap lands on the room, not on an overlay zone.
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-scene-slot]') !== null,
      [target.x, target.y] as const,
    )
    expect(hit).toBe(true)
    if (test.info().project.use.hasTouch === true) await page.touchscreen.tap(target.x, target.y)
    else await page.mouse.click(target.x, target.y)

    await expect.poll(async () => (await hudState(page)).placed['wall-1']).toBe(LIGHTS)
    await expect.poll(() => room<string | null>(page, 'wall-1 item')).toBe(LIGHTS)

    // Closing the panel gives the city the screen back.
    await dialog.getByRole('button', { name: 'Close Home' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-scene-slot="room"] canvas')).toHaveCount(0)
    await expect(page.locator('[data-cc-feature="cc-feature:city-scene"]')).not.toHaveAttribute(
      'data-scene-hidden',
      '',
    )
  })

  test('colours are radios named in words, and the choice and placement survive a reload', async ({
    page,
  }) => {
    await buy(page, [LIGHTS])
    let dialog = await openHome(page)
    const pink = dialog.getByRole('radio', { name: 'Hot pink', exact: true })
    await pink.check()
    await expect(pink).toBeChecked()
    await expect.poll(async () => (await hudState(page)).decor[LIGHTS]).toBe('pink')
    for (const radio of await dialog.getByRole('radio').all()) {
      await expect(radio).toHaveAccessibleName(/^[A-Z][a-z]+( [a-z]+)?$/)
    }
    await settled(dialog)
    await dialog.locator(`[data-home-stored="${LIGHTS}"] [data-home-pick]`).click()
    await settled(dialog)
    await dialog.locator('[data-home-slot="wall-1"] [data-home-place-here]').click()
    await expect.poll(async () => (await hudState(page)).placed['wall-1']).toBe(LIGHTS)

    await page.reload()
    await waitForWelcomeGate(page)
    await page.waitForFunction(() => window.__cloutcityTest?.hud !== undefined)
    await waitForMapSettled(page)
    dialog = await openHome(page)
    await expect(dialog.locator('[data-home-slot="wall-1"]')).toContainText('Hot pink')
    await expect(dialog.getByRole('radio', { name: 'Hot pink', exact: true })).toBeChecked()
  })

  test('on a fresh save every other home is locked and says why', async ({ page, checkA11y }) => {
    const dialog = await openHome(page)
    for (const [id, name] of [
      ['brooklyn-1br', 'Brooklyn 1BR'],
      ['manhattan-loft', 'Manhattan loft'],
    ] as const) {
      const button = dialog.locator(`[data-home-move="${id}"] [data-home-move-button]`)
      await expect(button).toHaveAttribute('aria-disabled', 'true')
      await expect(button).toHaveAccessibleName(new RegExp(`^${name}\\. .+clout.+`))
      // aria-disabled keeps the reason readable and focusable; a forced press does nothing.
      await button.click({ force: true })
      await expect(dialog.locator('[data-home-confirm]')).toHaveCount(0)
    }
    expect((await hudState(page)).home).toBe('queens-room')
    await checkA11y()
  })

  test('moves to Brooklyn after a confirm, with its rent and slots', async ({ page }) => {
    const brooklyn = 'brooklyn-1br'
    const rent = balance.rentPerWeek[brooklyn] ?? Number.NaN
    const slots = interiors.homes[brooklyn]?.slots.length ?? 0
    expect(rent).toBe(520)
    expect(slots).toBe(5)
    const level = balance.boroughs.brooklyn?.level ?? ''
    await page.evaluate(
      ([clout]) => {
        window.__cloutcityPlaces?.setClout(clout)
        window.__cloutcityPlaces?.setCash(5000)
      },
      [levelClout(level)] as const,
    )
    const dialog = await openHome(page)
    const move = dialog.locator(`[data-home-move="${brooklyn}"] [data-home-move-button]`)
    await expect(move).toHaveAccessibleName(
      `Move to Brooklyn 1BR: move-in $${balance.housing.moveInCost[brooklyn]}, rent $${rent}/wk, ${slots} slots`,
    )
    await move.click()
    await settled(dialog)
    const confirm = dialog.locator(`[data-home-move="${brooklyn}"] [data-home-confirm]`)
    await expect(confirm).toBeFocused()
    await expect(dialog.locator('[data-home-confirm-text]')).toContainText(`$${rent}/wk`)
    // The first press only asks: nothing has moved yet.
    expect((await hudState(page)).home).toBe('queens-room')
    await confirm.click()

    await expect.poll(async () => (await hudState(page)).home).toBe(brooklyn)
    await expect(dialog.locator('[data-home-current]')).toHaveText(`Brooklyn 1BR, rent $${rent}/wk`)
    await expect(dialog.locator('[data-home-slot]')).toHaveCount(slots)
    await expect(dialog.locator('[data-panel-status]')).toContainText('Brooklyn 1BR')
  })

  test('the room stays within every tier budget with the avatar reserve kept free, and idles', async ({
    page,
  }) => {
    // The biggest room, every slot it can fill.
    await page.evaluate(
      ([clout]) => {
        window.__cloutcityPlaces?.setClout(clout)
        window.__cloutcityPlaces?.setCash(100_000)
      },
      [levelClout(balance.boroughs.manhattan?.level ?? '')] as const,
    )
    const decor = items.filter((item) => item.category === 'decor')
    await buy(
      page,
      decor.map((item) => item.id),
      100_000,
    )
    const dialog = await openHome(page)
    await dialog.locator('[data-home-move="manhattan-loft"] [data-home-move-button]').click()
    await settled(dialog)
    await dialog.locator('[data-home-move="manhattan-loft"] [data-home-confirm]').click()
    await expect.poll(async () => (await hudState(page)).home).toBe('manhattan-loft')
    for (const item of decor) {
      await settled(dialog)
      await dialog.locator(`[data-home-stored="${item.id}"] [data-home-pick]`).click()
      await settled(dialog)
      // An empty spot, so no item sends another back to storage.
      await dialog
        .locator('[data-home-slot]:not(:has([data-home-remove])) [data-home-place-here]')
        .first()
        .click()
      await expect.poll(async () => Object.values((await hudState(page)).placed)).toContain(item.id)
    }
    await waitForRoom(page)

    const cityFrames = await page.evaluate(() => window.__cloutcityTest?.scene?.frames() ?? -1)
    for (const tier of ['low', 'mid', 'high'] as const) {
      await page.evaluate((t) => window.__cloutcityTest?.apartment?.setTier(t), tier)
      await expect.poll(() => room<string>(page, 'tier')).toBe(tier)
      await waitForRoom(page)
      const info = await room<
        ReturnType<ApartmentTestHook['renderInfo']> & ReturnType<ApartmentTestHook['budget']>
      >(page, 'info')
      // The main pass plus, on the high tier, the shadow pass three leaves out of its counters.
      const calls = info.calls + info.shadowCalls
      const triangles = info.triangles + info.shadowTriangles
      test.info().annotations.push({
        type: `room-${tier}`,
        description: `${calls} draw calls (${info.shadowCalls} shadow), ${triangles} triangles (caps ${info.drawCallsMax} / ${info.trianglesMax}, reserve ${info.avatarReserve.drawCalls} / ${info.avatarReserve.triangles})`,
      })
      expect(info.calls, `${tier} draw calls`).toBeGreaterThan(0)
      // Shadows by tier (perf.json): one PCF shadow map on high only.
      expect(info.shadowMap, `${tier} shadow map`).toBe(tier === 'high')
      expect(info.pcf, `${tier} shadow type`).toBe(true)
      expect(calls + info.avatarReserve.drawCalls, `${tier} draw calls`).toBeLessThanOrEqual(
        info.drawCallsMax,
      )
      expect(triangles + info.avatarReserve.triangles, `${tier} triangles`).toBeLessThanOrEqual(
        info.trianglesMax,
      )
    }

    // Idle: no frames while nothing changes, in the room or the paused city.
    const frames = await room<number>(page, 'frames')
    await page.waitForTimeout(500)
    expect(await room<number>(page, 'frames')).toBe(frames)
    expect(await page.evaluate(() => window.__cloutcityTest?.scene?.frames() ?? -1)).toBe(
      cityFrames,
    )
  })
})

const SCENE_FAILED_MSG = '3D scene failed to start; showing the static map background'
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const noWebglWarning: ExpectedConsoleMessage = {
  type: 'warning',
  text: new RegExp(
    `^\\{"level":"warn","msg":"${escape(SCENE_FAILED_MSG)}","time":"[^"]+","correlationId":"[^"]+","context":\\{"reason":"no-webgl"\\}\\}$`,
  ),
  count: 1,
}

test.describe('home without WebGL', () => {
  test.use({ expectedConsole: [noWebglWarning] })

  test('the slot list still places decor and nothing draws in the room slot', async ({ page }) => {
    await page.addInitScript(() => {
      window.__CLOUTCITY_E2E__ = true
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
    await page.goto('/')
    await waitForWelcomeGate(page)
    await page.waitForFunction(
      () => window.__cloutcityPlaces !== undefined && window.__cloutcityTest?.hud !== undefined,
    )
    await buy(page, [PLANT])
    // The Places panel opens by itself without the map; it waits behind the Home panel.
    const dialog = await openHome(page)
    await dialog.locator(`[data-home-stored="${PLANT}"] [data-home-pick]`).click()
    await settled(dialog)
    await dialog.locator('[data-home-slot="surface-1"] [data-home-place-here]').click()
    await expect.poll(async () => (await hudState(page)).placed['surface-1']).toBe(PLANT)
    await expect(page.locator('[data-scene-slot="room"] > *')).toHaveCount(0)
  })
})

const SHOTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 844, height: 390 },
] as const

for (const viewport of SHOTS) {
  const label = `${viewport.width}x${viewport.height}`
  test.describe(`Home panel at ${label}`, () => {
    test.use({ viewport })

    test('matches its screenshot', async ({ page }) => {
      await holdGameTime(page)
      await boot(page)
      await buy(page, [LIGHTS, PLANT], 150)
      const dialog = await openHome(page)
      await waitForRoom(page)
      await expect(dialog.locator(`[data-home-stored="${LIGHTS}"]`)).toBeVisible()
      await hideSceneForScreenshot(page)
      await expect(page).toHaveScreenshot(`home-${label}.png`)
    })
  })
}
