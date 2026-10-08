import type { Page, Request, Route } from '@playwright/test'
import type { EventContext } from '@/engine/events'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { ONBOARDING_KEY } from './fixtures/onboarding-seed'
import { passWelcomeCard, welcomeDialog } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'

// S08 (DEC-22): these flows are about a place's own rules, so picking a place puts the
// player there (travel itself is tests/e2e/travel.spec.ts).
test.use({ location: 'follow' })

// S05c (DEC-11): the shell of / carries only the boot path. Every other feature loads in its own
// chunk on first use, with a loading state inside its overlay zone; the welcome card loads as a
// boot island while the page behind it stays inert. Chunks outside the shell are held back or
// failed on purpose here: shell chunks are the scripts the prerendered HTML lists.

const BODEGA: EventContext = {
  borough: 'queens',
  locationId: null,
  locationCategory: 'bodega',
  itemIds: [],
}

const EVENT_MARKER = 'cc-feature:event-sheet'
const WELCOME_MARKER = 'cc-feature:welcome'
const PLACE_MARKER = 'cc-feature:place-sheet'
const MAP_MARKER = 'cc-feature:city-scene'

/** Controls chunk requests outside the shell: pass, hold until released, or fail. */
class ChunkGate {
  mode: 'pass' | 'hold' | 'fail' = 'pass'
  /** When set, only chunks whose body contains this text are held or failed. */
  only: string | null = null
  /**
   * Keeps the 3D map's chunk in flight for good, so the map never starts. For a test about the
   * overlay islands alone: starting the map on SwiftShader costs seconds of main thread.
   */
  holdMap = false
  /** Bodies of the non-shell chunks served so far, in request order. */
  readonly served: string[] = []
  private releaseHeld: () => void = () => {}
  private held = Promise.resolve()

  hold(): void {
    this.mode = 'hold'
    this.held = new Promise((resolve) => {
      this.releaseHeld = resolve
    })
  }

  release(): void {
    this.mode = 'pass'
    this.releaseHeld()
  }

  static async install(page: Page): Promise<ChunkGate> {
    const gate = new ChunkGate()
    const html = await (await page.request.get('/')).text()
    const shell = new Set(
      Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), (match) => match[1]),
    )
    await page.route('**/_next/static/chunks/**/*.js', async (route: Route, request: Request) => {
      const path = new URL(request.url()).pathname
      if (shell.has(path)) return route.continue()
      const response = await route.fetch()
      const body = await response.text()
      if (gate.holdMap && body.includes(MAP_MARKER)) return new Promise<void>(() => {})
      const targeted = gate.only === null || body.includes(gate.only)
      if (targeted && gate.mode === 'fail') return route.abort('failed')
      if (targeted && gate.mode === 'hold') await gate.held
      gate.served.push(body)
      return route.fulfill({ response, body })
    })
    return gate
  }
}

async function bootWithHooks(page: Page, map: 'settled' | 'held' = 'settled') {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await page.waitForFunction(
    () => window.__cloutcityTest?.events !== undefined && window.__cloutcityPlaces !== undefined,
  )
  if (map === 'settled') await waitForMapSettled(page)
}

const sheetZone = (page: Page) => page.locator('[data-overlay-zone="sheet"]')
const background = (page: Page) => page.locator('[data-overlay-background]')
const welcomeLoading = (page: Page) =>
  page.locator('[data-overlay-modal]').getByRole('status', { name: 'Loading the welcome card' })

/** True when keyboard focus sits inside the inert background (it must never while it is inert). */
const focusInBackground = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('[data-overlay-background]') != null)

/** Tabs through the page and reports whether focus ever reached the background. */
async function tabReachesBackground(page: Page, presses = 6): Promise<boolean> {
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab')
    if (await focusInBackground(page)) return true
  }
  return false
}

test.describe('lazy features', () => {
  test('the event sheet loads only when an event opens, with a loading state in the sheet zone', async ({
    page,
    checkA11y,
  }) => {
    const gate = await ChunkGate.install(page)
    await bootWithHooks(page)
    expect(gate.served.some((body) => body.includes(EVENT_MARKER))).toBe(false)

    gate.hold()
    const before = gate.served.length
    await page.evaluate(
      (context) => window.__cloutcityTest?.events?.open('bodega-cat', context),
      BODEGA,
    )

    const loading = sheetZone(page).getByRole('status', { name: 'Loading the event' })
    await expect(loading).toBeVisible()
    await expect(loading).toHaveAttribute('aria-busy', 'true')
    await checkA11y()

    gate.release()
    const dialog = sheetZone(page).getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(loading).toHaveCount(0)
    expect(gate.served.slice(before).some((body) => body.includes(EVENT_MARKER))).toBe(true)
  })

  test('the place sheet loads only when a place opens, with a loading state in the sheet zone', async ({
    page,
    checkA11y,
  }) => {
    const gate = await ChunkGate.install(page)
    await bootWithHooks(page)
    expect(gate.served.some((body) => body.includes(PLACE_MARKER))).toBe(false)

    gate.hold()
    const before = gate.served.length
    await page.evaluate(() => window.__cloutcityPlaces?.open('steam-vent-coffee'))

    const loading = sheetZone(page).getByRole('status', { name: 'Loading this place' })
    await expect(loading).toBeVisible()
    await checkA11y()

    gate.release()
    await expect(page.locator('[data-place-sheet="steam-vent-coffee"]')).toBeVisible()
    await expect(loading).toHaveCount(0)
    expect(gate.served.slice(before).some((body) => body.includes(PLACE_MARKER))).toBe(true)
  })
})

test.describe('lazy features: a failed load', () => {
  // The test aborts the chunk itself, which Chromium reports as a resource error.
  test.use({ injectedConsoleErrors: [/^Failed to load resource: net::ERR_FAILED$/] })

  test('a feature whose chunk fails offers a retry in its zone, which loads it', async ({
    page,
    checkA11y,
  }) => {
    const gate = await ChunkGate.install(page)
    await bootWithHooks(page)

    gate.mode = 'fail'
    await page.evaluate(() => window.__cloutcityPlaces?.open('steam-vent-coffee'))
    const retry = sheetZone(page).getByRole('button', { name: 'Try again' })
    await expect(retry).toBeVisible()
    await expect(sheetZone(page)).toContainText("That didn't load")
    await checkA11y()

    gate.mode = 'pass'
    await retry.click()
    await expect(page.locator('[data-place-sheet="steam-vent-coffee"]')).toBeVisible()
    await expect(retry).toHaveCount(0)
  })
})

test.describe('welcome boot island', () => {
  test.use({ onboarding: 'fresh' })

  test('a fresh visitor sees the loading card with the page inert, then the welcome card, with no gap', async ({
    page,
    checkA11y,
  }) => {
    // Every change to the background's `inert`, with whether the card was showing at the time.
    await page.addInitScript(() => {
      const log: { inert: boolean; dialog: boolean }[] = []
      Object.assign(window, { __inertLog: log })
      const record = () => {
        const background = document.querySelector('[data-overlay-background]')
        if (background === null) return
        const entry = {
          inert: background.hasAttribute('inert'),
          dialog: document.querySelector('[data-welcome-dialog]') !== null,
        }
        const last = log.at(-1)
        if (last?.inert !== entry.inert || last.dialog !== entry.dialog) log.push(entry)
      }
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['inert'],
      })
    })
    const gate = await ChunkGate.install(page)
    gate.hold()
    await page.goto('/', { waitUntil: 'commit' })

    const loading = page
      .locator('[data-overlay-modal]')
      .getByRole('status', { name: 'Loading the welcome card' })
    await expect(loading).toBeVisible()
    await expect(page.locator('[data-overlay-background]')).toHaveAttribute('inert', '')
    await checkA11y()

    gate.release()
    await expect(page.getByRole('dialog', { name: 'Welcome to Clout City' })).toBeVisible()
    await expect(page.locator('[data-overlay-background]')).toHaveAttribute('inert', '')

    const log = await page.evaluate(
      () => (window as unknown as { __inertLog: { inert: boolean; dialog: boolean }[] }).__inertLog,
    )
    const closed = log.findIndex((entry) => entry.inert)
    const shown = log.findIndex((entry) => entry.dialog)
    expect(closed, 'the page goes inert before the card shows').toBeGreaterThanOrEqual(0)
    expect(shown).toBeGreaterThan(closed)
    expect(
      log.slice(closed).every((entry) => entry.inert),
      JSON.stringify(log),
    ).toBe(true)
  })
})

test.describe('welcome boot island: what loads behind it', () => {
  test('a returning player with an event open: after a reload under a slow welcome chunk the event waits inert, then takes focus', async ({
    page,
    checkA11y,
  }) => {
    const gate = await ChunkGate.install(page)
    gate.holdMap = true
    await bootWithHooks(page, 'held')
    await waitForWelcomeGate(page)
    await page.evaluate(
      (context) => window.__cloutcityTest?.events?.open('bodega-cat', context),
      BODEGA,
    )
    await expect(sheetZone(page).getByRole('dialog')).toBeVisible()

    gate.only = WELCOME_MARKER
    gate.hold()
    await page.reload({ waitUntil: 'commit' })
    await expect(welcomeLoading(page)).toBeVisible()
    // The restored event draws behind the loading card, but the page stays inert and unfocused.
    await expect(page.locator('[data-event="bodega-cat"]')).toBeVisible()
    await expect(background(page)).toHaveAttribute('inert', '')
    expect(await focusInBackground(page)).toBe(false)
    expect(await tabReachesBackground(page), 'Tab never reaches the event or the tabs').toBe(false)
    await checkA11y()

    gate.release()
    await expect(page.locator('[data-welcome-gate="done"]')).toBeAttached()
    await expect(background(page)).not.toHaveAttribute('inert')
    const dialog = sheetZone(page).getByRole('dialog', { name: 'The bodega cat chose you' })
    await expect(dialog.getByRole('button', { name: /Pet the cat/ })).toBeFocused()
    await expect(page.locator('[data-overlay-zone="tabs"]')).toHaveAttribute('inert', '')
  })

  test('a place opened while the welcome card loads waits inert, then takes focus', async ({
    page,
  }) => {
    const gate = await ChunkGate.install(page)
    gate.only = WELCOME_MARKER
    gate.hold()
    await page.addInitScript(() => {
      window.__CLOUTCITY_E2E__ = true
    })
    await page.goto('/', { waitUntil: 'commit' })
    await expect(welcomeLoading(page)).toBeVisible()
    await page.waitForFunction(() => window.__cloutcityPlaces !== undefined)
    await waitForMapSettled(page)
    await page.evaluate(() => window.__cloutcityPlaces?.open('steam-vent-coffee'))

    const sheet = page.locator('[data-place-sheet="steam-vent-coffee"]')
    await expect(sheet).toBeVisible()
    await expect(background(page)).toHaveAttribute('inert', '')
    expect(await focusInBackground(page)).toBe(false)
    expect(await tabReachesBackground(page), 'Tab never reaches the place sheet').toBe(false)

    gate.release()
    await expect(page.locator('[data-welcome-gate="done"]')).toBeAttached()
    await expect(background(page)).not.toHaveAttribute('inert')
    await expect(sheet.getByRole('heading', { level: 2 })).toBeFocused()
  })
})

test.describe('welcome boot island: the card over a restored event', () => {
  test.use({ onboarding: 'fresh' })

  test('a player whose welcome record is gone but whose save has an event open can still answer the card', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__CLOUTCITY_E2E__ = true
    })
    await page.goto('/')
    await passWelcomeCard(page)
    await page.waitForFunction(() => window.__cloutcityTest?.events !== undefined)
    await page.evaluate(
      (context) => window.__cloutcityTest?.events?.open('bodega-cat', context),
      BODEGA,
    )
    await expect(sheetZone(page).getByRole('dialog')).toBeVisible()
    // The onboarding record is lost (cleared, or unreadable) while the game save keeps the event.
    await page.evaluate((key) => localStorage.removeItem(key), ONBOARDING_KEY)

    await page.reload()
    await expect(welcomeDialog(page)).toBeVisible()
    await expect(page.locator('[data-event="bodega-cat"]')).toBeVisible()
    // The card outranks the event: it must stay usable, with the event behind it inert.
    await expect(page.locator('[data-overlay-modal]')).not.toHaveAttribute('inert')
    await expect(background(page)).toHaveAttribute('inert', '')
    await passWelcomeCard(page)
    await expect(background(page)).not.toHaveAttribute('inert')
    const dialog = sheetZone(page).getByRole('dialog', { name: 'The bodega cat chose you' })
    await expect(dialog.getByRole('button', { name: /Pet the cat/ })).toBeFocused()
  })
})

test.describe('welcome boot island: offline', () => {
  test.use({
    onboarding: 'fresh',
    injectedConsoleErrors: [/^Failed to load resource: net::ERR_FAILED$/],
  })

  test('the card fails to load: the retry keeps the page inert throughout, and loads the card once online', async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript(() => {
      const log: boolean[] = []
      Object.assign(window, { __inertLog: log })
      new MutationObserver(() => {
        const node = document.querySelector('[data-overlay-background]')
        if (node === null) return
        const inert = node.hasAttribute('inert')
        if (log.at(-1) !== inert) log.push(inert)
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['inert'],
      })
    })
    const gate = await ChunkGate.install(page)
    gate.only = WELCOME_MARKER
    gate.mode = 'fail'
    await page.goto('/')
    await waitForMapSettled(page)

    const modal = page.locator('[data-overlay-modal]')
    const retry = modal.getByRole('button', { name: 'Try again' })
    await expect(retry).toBeVisible()
    await expect(background(page)).toHaveAttribute('inert', '')
    expect(await tabReachesBackground(page), 'Tab never reaches the game behind').toBe(false)
    await checkA11y()

    // Still offline: the retry fails again, and the page never un-inerts in between.
    await retry.click()
    await expect(retry).toBeVisible()
    await expect(background(page)).toHaveAttribute('inert', '')
    expect(await tabReachesBackground(page)).toBe(false)

    gate.mode = 'pass'
    await retry.click()
    await expect(welcomeDialog(page)).toBeVisible()
    await expect(background(page)).toHaveAttribute('inert', '')

    const log = await page.evaluate(
      () => (window as unknown as { __inertLog: boolean[] }).__inertLog,
    )
    const first = log.indexOf(true)
    expect(first, JSON.stringify(log)).toBeGreaterThanOrEqual(0)
    expect(log.slice(first).every(Boolean), JSON.stringify(log)).toBe(true)
  })
})

/**
 * Records, from the first byte the parser hands over, every change of the background's `inert`
 * and whether the welcome island had decided at the time.
 */
async function recordInertFromFirstByte(page: Page) {
  await page.addInitScript(() => {
    const log: string[] = []
    Object.assign(window, { __inertFromStart: log })
    new MutationObserver(() => {
      const node = document.querySelector('[data-overlay-background]')
      if (node === null) return
      const entry = `${node.hasAttribute('inert') ? 'inert' : 'open'}/${
        document.querySelector('[data-welcome-gate]') === null ? 'undecided' : 'decided'
      }`
      if (log.at(-1) !== entry) log.push(entry)
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['inert', 'data-welcome-gate'],
    })
  })
}

const inertLogFromStart = (page: Page) =>
  page.evaluate(() => (window as unknown as { __inertFromStart: string[] }).__inertFromStart)

test.describe('the 18+ gate fails closed from the first byte', () => {
  test('the prerendered page is already inert behind the modal slot', async ({ page }) => {
    const html = await (await page.request.get('/')).text()
    expect(html).toMatch(/<div[^>]*data-overlay-background=""[^>]*\binert=""/)
  })

  test('a returning player: inert from the first byte until the island decides, then open', async ({
    page,
  }) => {
    await recordInertFromFirstByte(page)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await expect(background(page)).not.toHaveAttribute('inert')
    expect(await inertLogFromStart(page)).toEqual([
      'inert/undecided',
      'inert/decided',
      'open/decided',
    ])
  })
})

test.describe('the 18+ gate fails closed from the first byte: a fresh visitor', () => {
  test.use({ onboarding: 'fresh' })

  test('never un-inert, from the first byte to the card', async ({ page }) => {
    await recordInertFromFirstByte(page)
    await page.goto('/')
    await expect(welcomeDialog(page)).toBeVisible()
    expect(await inertLogFromStart(page)).toEqual(['inert/undecided', 'inert/decided'])
  })
})
