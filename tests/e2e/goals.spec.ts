import type { Page } from '@playwright/test'
import type { PlaceTestHook } from '@/components/places/placeTestHook'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

/**
 * The place hook is installed and the 3D map has finished starting: on SwiftShader the map's
 * start keeps the main thread busy for seconds (PERF-4), so the overlay checks below wait for
 * it instead of racing it.
 */
async function ready(page: Page) {
  await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
  await waitForMapSettled(page)
}

// S15: the Goals panel opens from the HUD, a reached goal's reward is claimed through the grant
// function for exactly the amount its button names, and the claim survives a reload. The goal is
// reached through a real landmark visit (the place test hook only opens the place); amounts are
// read from the button, so the spec does not move when progression.json is tuned.

async function boot(page: Page) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await ready(page)
}

const state = (page: Page) =>
  page.evaluate((): ReturnType<PlaceTestHook['state']> => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    return places.state()
  })

const goalsButton = (page: Page) =>
  page.locator('[data-overlay-zone="hud"]').getByRole('button', { name: /^Goals/ })

const panel = (page: Page) => page.getByRole('dialog', { name: 'Goals' })

async function visitLandmark(page: Page) {
  await page.evaluate(() => {
    const places = window.__cloutcityPlaces
    if (places === undefined) throw new Error('place test hook is not installed')
    places.setTimeOfDay(10 * 60)
    if (!places.open('flushing-meadows')) throw new Error('no flushing-meadows')
  })
  const card = page.locator('[data-place-sheet="flushing-meadows"]')
  await card.getByRole('button', { name: /^Visit: / }).click()
  await expect(card.getByRole('status')).not.toBeEmpty()
}

test.describe('goals and rewards', () => {
  test('the Goals button opens the panel from the HUD, listing every goal with progress', async ({
    page,
    checkA11y,
  }) => {
    await boot(page)
    const button = goalsButton(page)
    await expect(button).toHaveAccessibleName('Goals: Make it in New York')
    const box = await button.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    await button.click()
    const dialog = panel(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Goals' })).toBeFocused()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.locator('[data-goal]')).toHaveCount(10)
    await expect(
      dialog.getByRole('progressbar', { name: 'Reach Local: 0 of 100 earned clout' }),
    ).toBeVisible()
    await expect(dialog.locator('[data-goal="first-friend"]')).toContainText('Friends unlock soon.')
    await expect(dialog.locator('[data-goals-note]')).toHaveText(
      'Rewards never count toward your goals. Only clout you earn does.',
    )
    // A reward not reached yet: focusable, not usable, and its name says why.
    const locked = dialog.getByRole('button', { name: /for First paycheck: reach the goal first$/ })
    await expect(locked).toHaveAttribute('aria-disabled', 'true')
    await checkA11y()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test('a reached reward is claimed for exactly the amount on its button, and stays claimed', async ({
    page,
    checkA11y,
  }) => {
    await boot(page)
    await visitLandmark(page)
    const button = goalsButton(page)
    await expect(button).toHaveAccessibleName('Goals: Make it in New York, 1 reward ready')
    await button.click()
    const dialog = panel(page)
    const claim = dialog.getByRole('button', {
      name: /^Claim \$\d+ and \d+ clout for First landmark visit$/,
    })
    await expect(claim).toBeVisible()
    await checkA11y()
    const name = (await claim.getAttribute('aria-label')) ?? ''
    const [, cash, clout] = /^Claim \$(\d+) and (\d+) clout/.exec(name) ?? []
    const before = await state(page)
    await claim.click()
    await expect(dialog.getByRole('status')).toHaveText(
      `First landmark visit: claimed $${cash} and ${clout} clout.`,
    )
    const after = await state(page)
    expect(after.cash).toBe(before.cash + Number(cash))
    expect(after.clout).toBe(before.clout + Number(clout))
    const row = dialog.locator('[data-goal="first-landmark-visit"]')
    await expect(row).toHaveAttribute('data-goal-status', 'claimed')
    await expect(button).toHaveAccessibleName('Goals: Make it in New York')
    // Focus stays in the panel when the claimed row's button goes away.
    await expect(dialog.getByRole('heading', { name: 'Goals' })).toBeFocused()

    await page.reload()
    await ready(page)
    expect((await state(page)).cash).toBe(after.cash)
    await goalsButton(page).click()
    const reloaded = panel(page).locator('[data-goal="first-landmark-visit"]')
    await expect(reloaded).toHaveAttribute('data-goal-status', 'claimed')
    await expect(reloaded).toContainText(`Reward: $${cash} and ${clout} clout`)
    await expect(panel(page).getByRole('button', { name: /First landmark visit/ })).toHaveCount(0)
  })
})

// src/state/store.ts STORE_KEY and src/engine/save.ts SAVE_VERSION, not imported: Playwright's
// loader cannot load the store's JSON imports.
const STORE_KEY = 'cloutcity:game'
const SAVE_VERSION = 8
const NOON = 12 * 60

/** A v8 save at `earned` clout whose run has reached `achieved` (rewards unclaimed). */
async function seed(page: Page, earned: number, achieved: readonly string[]) {
  const save = {
    state: {
      clock: { minute: NOON, remainderMs: 0 },
      player: {
        cash: 200,
        stats: { energy: 100, hunger: 80, mood: 80 },
        clout: {
          ledger: [],
          compacted:
            earned === 0
              ? { entries: 0, bySource: {} }
              : { entries: 1, bySource: { legacy: earned } },
          nextSeq: 1,
          peakLevel: [0, 100, 300, 800, 2000, 5000].filter((min) => earned >= min).length - 1,
          firstPaycheckPaid: true,
        },
        flex: { rngState: 0, byPlace: {} },
        home: 'queens-room',
        rent: { owed: 0, missed: 0 },
        inventory: { wearables: [], gifts: [], outfit: {} },
        clubNights: {},
        visited: {},
      },
      speed: 1,
      events: { active: null, history: {}, pending: [], rngState: 0 },
      goals: {
        run: 1,
        achieved: Object.fromEntries(achieved.map((id) => [id, NOON])),
        icon: { reachedAt: null, acknowledged: false },
      },
      grants: { log: [], nextSeq: 1 },
      prestige: { count: 0, badges: [], history: [] },
    },
    version: SAVE_VERSION,
  }
  await page.addInitScript(
    ([key, raw]) => {
      if (sessionStorage.getItem('seeded') !== null) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem(key, raw)
    },
    [STORE_KEY, JSON.stringify(save)] as const,
  )
}

const grantLog = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    const saved =
      raw === null ? null : (JSON.parse(raw) as { state: { grants: { log: unknown[] } } })
    return saved?.state.grants.log.length ?? 0
  }, STORE_KEY)

test.describe('goals: double claims, open events, small screens', () => {
  test('a double click and two quick taps on Claim pay once', async ({ page }) => {
    await seed(page, 120, ['first-paycheck', 'reach-local'])
    await boot(page)
    await expect(goalsButton(page)).toHaveAccessibleName(
      'Goals: Make it in New York, 2 rewards ready',
    )
    await goalsButton(page).click()
    const dialog = panel(page)
    const before = await state(page)

    const paycheck = dialog.getByRole('button', { name: /for First paycheck$/ })
    await paycheck.dblclick()
    await expect(dialog.locator('[data-goal="first-paycheck"]')).toHaveAttribute(
      'data-goal-status',
      'claimed',
    )
    const local = dialog.getByRole('button', { name: /for Reach Local$/ })
    await local.scrollIntoViewIfNeeded()
    const box = await local.boundingBox()
    if (box === null) throw new Error('no Reach Local claim')
    const { x, y } = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    if (test.info().project.name === 'mobile-390') {
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
    } else {
      await page.mouse.click(x, y)
      await page.mouse.click(x, y)
    }
    await expect(dialog.locator('[data-goal="reach-local"]')).toHaveAttribute(
      'data-goal-status',
      'claimed',
    )
    await expect(goalsButton(page)).toHaveAccessibleName('Goals: Make it in New York')
    const log = dialog.locator('[data-goal-status="claimed"]')
    await expect(log).toHaveCount(2)
    const after = await state(page)
    // Exactly the two configured rewards (both uncapped at 120 clout in a Queens room).
    expect(after.cash - before.cash).toBe(25 + 50)
    expect(after.clout - before.clout).toBe(5 + 15)
    expect(await grantLog(page)).toBe(2)
  })

  test('an event opening under the panel blocks the claim, and its name says why', async ({
    page,
  }) => {
    await seed(page, 0, ['first-paycheck'])
    await boot(page)
    await page.waitForFunction(() => window.__cloutcityTest?.events !== undefined)
    await goalsButton(page).click()
    const dialog = panel(page)
    await expect(dialog.getByRole('button', { name: /for First paycheck$/ })).toBeVisible()
    const opened = await page.evaluate(() =>
      window.__cloutcityTest?.events?.open('bodega-cat', {
        borough: 'queens',
        locationId: null,
        locationCategory: 'bodega',
        itemIds: [],
      }),
    )
    expect(opened?.ok).toBe(true)
    // Whether or not the event sheet replaced the panel, the reward must not be claimable now.
    const before = await state(page)
    if ((await dialog.count()) === 0) await goalsButton(page).click()
    const blocked = panel(page).getByRole('button', {
      name: /for First paycheck: finish the event first$/,
    })
    await expect(blocked).toHaveAttribute('aria-disabled', 'true')
    // aria-disabled keeps it focusable: activating it changes nothing.
    await blocked.focus()
    await page.keyboard.press('Enter')
    expect((await state(page)).cash).toBe(before.cash)
    expect(await grantLog(page)).toBe(0)
  })

  // A v8 seed is older than the current save, so loading derives every level goal its clout
  // already holds (src/engine/save.ts `migrateSave` → `syncGoals`): at Famous that adds Known and
  // Famous to the three seeded goals.
  for (const [label, earned, ready] of [
    ['Scene Regular', 400, 3],
    ['Famous', 2500, 5],
  ] as const) {
    test(`HUD with ${label} and a ready count: nothing overlaps, targets are 44 px`, async ({
      page,
    }) => {
      await seed(page, earned, ['first-paycheck', 'reach-local', 'reach-scene-regular'])
      await boot(page)
      const zone = page.locator('[data-overlay-zone="hud"]')
      await expect(zone.locator('[data-clout-meter]')).toContainText(label)
      await expect(goalsButton(page)).toHaveAccessibleName(
        `Goals: Make it in New York, ${ready} rewards ready`,
      )
      // S05's HUD layouts: phone, desktop, short phone, landscape phone.
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1280, height: 720 },
        { width: 390, height: 600 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(viewport)
        // S05: the clout meter is drawn inside the Goals button's cell, so the cell stands for
        // both; every other cell and every visible action must stay clear of it.
        const parts = [
          ...['money', 'clock', 'speed', 'stats'].map((cell) => ({
            name: cell,
            locator: zone.locator(`[data-hud-cell="${cell}"]`),
          })),
          { name: 'Goals', locator: goalsButton(page) },
          ...(await zone.locator('[data-hud-cell="actions"] button:visible').all()).map(
            (locator, index) => ({ name: `action ${index}`, locator }),
          ),
        ]
        const row = await zone.boundingBox()
        if (row === null) throw new Error('the HUD zone is not rendered')
        const boxes = []
        for (const part of parts) {
          const found = await part.locator.boundingBox()
          if (found === null) throw new Error(`${part.name} is not rendered`)
          expect(found.width, `${part.name} width at ${viewport.width}`).toBeGreaterThan(0)
          expect(found.x + found.width, `${part.name} right`).toBeLessThanOrEqual(
            row.x + row.width + 0.5,
          )
          boxes.push({ name: part.name, box: found })
        }
        for (const [i, a] of boxes.entries()) {
          for (const b of boxes.slice(i + 1)) {
            const apart =
              a.box.x + a.box.width <= b.box.x + 0.5 ||
              b.box.x + b.box.width <= a.box.x + 0.5 ||
              a.box.y + a.box.height <= b.box.y + 0.5 ||
              b.box.y + b.box.height <= a.box.y + 0.5
            expect(apart, `${a.name} overlaps ${b.name} at ${viewport.width}`).toBe(true)
          }
        }
        const goals = await goalsButton(page).boundingBox()
        expect(goals?.width ?? 0).toBeGreaterThanOrEqual(44)
        expect(goals?.height ?? 0).toBeGreaterThanOrEqual(44)
      }
    })
  }

  test('at 844x390 the panel fits the screen and its list scrolls to the last goal', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 })
    await seed(page, 0, [])
    await boot(page)
    await goalsButton(page).click()
    const dialog = panel(page)
    await expect(dialog).toBeVisible()
    const frame = await dialog.boundingBox()
    expect(frame?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect((frame?.y ?? 0) + (frame?.height ?? 0)).toBeLessThanOrEqual(390)
    const last = dialog.locator('[data-goal="reach-icon"]')
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    // The title and Close stay in view while the body scrolls.
    await expect(dialog.getByRole('heading', { name: 'Goals' })).toBeInViewport()
    await expect(dialog.getByRole('button', { name: /^Close/ })).toBeInViewport()
    // The scrolling body is a named region a keyboard can focus and scroll (UI-6).
    const body = dialog.getByRole('region', { name: 'Goals' })
    await expect(body).toHaveAttribute('tabindex', '0')
    await body.focus()
    await expect(body).toBeFocused()
    await checkA11y()
  })
})
