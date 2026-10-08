import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { E2E_DIST_DIR } from '../../playwright.config'
import { project } from '../../src/lib/geo/projection'
import { expect, test } from './fixtures/test'
import { waitForCityModels } from './helpers/cityModels'
import { touchGesture, type Point } from './helpers/touch'

// S04a: the lazy 3D city. Reads camera state and renderer counters through the test-mode hook
// (src/scene/testHooks.tsx, built only into the e2e build). Never asserts FPS: headless
// Chromium renders on SwiftShader.

const ROOT = join(import.meta.dirname, '../..')
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T

const perf = readJson<{
  drawCallsMax: { mid: number }
  trianglesMax: { mid: number }
}>('data/config/perf.json')
const scene = readJson<{
  camera: {
    minDistanceM: number
    maxDistanceM: number
    polarDeg: { min: number; max: number }
    azimuthDeg: { min: number; max: number }
  }
}>('data/config/scene.json')
const bounds = readJson<{ west: number; south: number; east: number; north: number }>(
  'data/geo/bounds.json',
)
const sw = project({ lat: bounds.south, lng: bounds.west })
const ne = project({ lat: bounds.north, lng: bounds.east })

/** Sanity floors: the default view really draws the city, not an empty canvas. */
const MIN_CALLS = 8
const MIN_TRIANGLES = 50_000
const READY_TIMEOUT_MS = 30_000
const IDLE_WINDOW_MS = 2_000
const ANGLE_EPSILON = 0.01
/**
 * Touch moves per long gesture in the edge-clamp specs (FLAKE-4). Each CDP touch move waits for
 * a software-rendered frame of the zoomed-out city (seconds on a loaded SwiftShader), so a step
 * costs a frame. A pan is linear in the finger travel, so one big move pans as far as many small
 * ones; every finger still moves in its own pointer event and the clamp runs on each. A one-move
 * pinch zooms out less than a stepped one (zoom-to-cursor re-anchors per move), so the spec that
 * needs the full zoom-out keeps its stepped pinch, and the others assert where they end up.
 */
const GESTURE_STEPS = 1
/**
 * Full-width one-finger drags at full zoom-out that reach the extent edge from the Queens start:
 * one drag pans about 12.5 km, the west and north-west edges are under two drags away, and a
 * third leaves margin. Each spec asserts the edge was reached, so too few would fail, not pass.
 */
const EDGE_PANS = 3

interface CameraState {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  distance: number
  polarDeg: number
  azimuthDeg: number
  near: number
  far: number
}

async function waitForScene(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__cloutcityTest?.scene?.ready === true, null, {
    timeout: READY_TIMEOUT_MS,
  })
  await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'ready')
  await settle(page)
}

/**
 * Waits until on-demand rendering is idle: no frame requested and none in flight. Reads the
 * scene's pending-frame counter once per animation frame instead of sleeping between polls, so
 * it returns as soon as the last requested frame has drawn.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__cloutcityTest?.scene?.pendingFrames() === 0, null, {
    polling: 'raf',
    timeout: READY_TIMEOUT_MS,
  })
}

const frames = (page: Page) => page.evaluate(() => window.__cloutcityTest?.scene?.frames() ?? -1)

async function camera(page: Page): Promise<CameraState> {
  const state = await page.evaluate(() => window.__cloutcityTest?.scene?.camera() ?? null)
  if (state === null) throw new Error('camera state is not available')
  return state
}

/** A point in the free scene row (between the HUD and the toast zone), where gestures land on the map. */
async function freeArea(page: Page): Promise<{ top: number; bottom: number; centre: Point }> {
  const hud = await page.locator('[data-overlay-zone="hud"]').boundingBox()
  const toast = await page.locator('[data-overlay-zone="toast"]').boundingBox()
  const viewport = page.viewportSize()
  if (!hud || !toast || !viewport) throw new Error('overlay zones are not rendered')
  const top = hud.y + hud.height
  const bottom = toast.y
  return { top, bottom, centre: { x: viewport.width / 2, y: (top + bottom) / 2 } }
}

/**
 * Many wheel steps at `point`, dispatched on the canvas in one go. Each `page.mouse.wheel` waits
 * for its input ack, which waits for a software-rendered (SwiftShader) frame of the zoomed-out
 * city, so 30 real steps take most of the test timeout when workers share the CPU. The camera
 * rig handles these events exactly like real ones (MapControls listens for `wheel` on the
 * canvas); each spec still drives a real wheel step first.
 */
async function wheelBurst(page: Page, point: Point, deltaY: number, count: number) {
  await page.locator('[data-scene-root] canvas').evaluate(
    (canvas, { x, y, delta, n }) => {
      for (let i = 0; i < n; i++) {
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: delta,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        )
      }
    },
    { x: point.x, y: point.y, delta: deltaY, n: count },
  )
}

function expectInsideLimits(state: CameraState): void {
  const { camera: rig } = scene
  expect(state.distance).toBeGreaterThanOrEqual(rig.minDistanceM - 1)
  expect(state.distance).toBeLessThanOrEqual(rig.maxDistanceM + 1)
  expect(state.polarDeg).toBeGreaterThanOrEqual(rig.polarDeg.min - ANGLE_EPSILON)
  expect(state.polarDeg).toBeLessThanOrEqual(rig.polarDeg.max + ANGLE_EPSILON)
  expect(state.azimuthDeg).toBeGreaterThanOrEqual(rig.azimuthDeg.min - ANGLE_EPSILON)
  expect(state.azimuthDeg).toBeLessThanOrEqual(rig.azimuthDeg.max + ANGLE_EPSILON)
  // Target inside the NYC extent (scene z = -north).
  expect(state.target.x).toBeGreaterThanOrEqual(sw.x - 1)
  expect(state.target.x).toBeLessThanOrEqual(ne.x + 1)
  expect(-state.target.z).toBeGreaterThanOrEqual(sw.y - 1)
  expect(-state.target.z).toBeLessThanOrEqual(ne.y + 1)
}

test.describe('3D city scene', () => {
  test('the shell is interactive before the 3D chunk and geo arrive', async ({ page }) => {
    // Hold the 3D chunk and the geo body until released. The 3D chunk is the file of the
    // dynamic import (e2e build's react-loadable-manifest.json) that renders the scene's
    // feature marker; the import's other files are shared with the welcome boot island (zod/mini)
    // and must load, or the page stays inert behind the welcome loading card.
    const manifest = readJson<Record<string, { files: string[] }>>(
      `${E2E_DIST_DIR}/server/app/page/react-loadable-manifest.json`,
    )
    const lazyChunks = new Set(
      Object.values(manifest)
        .flatMap((entry) => entry.files)
        .filter((file) =>
          readFileSync(join(ROOT, E2E_DIST_DIR, file), 'utf8').includes('cc-feature:city-scene'),
        )
        .map((file) => `/_next/${file}`),
    )
    expect(lazyChunks.size).toBe(1)
    const held: Route[] = []
    let release = false
    const hold = async (route: Route) => {
      if (release) await route.continue()
      else held.push(route)
    }
    await page.route('**/_next/static/chunks/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (lazyChunks.has(path)) await hold(route)
      else await route.continue()
    })
    await page.route('**/geo/base*', hold)

    await page.goto('/')
    await expect(page.locator('[data-scene-root]')).toHaveAttribute('data-scene-status', 'loading')
    await expect(page.getByRole('status').filter({ hasText: 'Loading the city' })).toBeVisible()
    const me = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Me' })
    await me.click()
    await expect(me).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => held.length).toBeGreaterThan(0)
    expect(await page.locator('canvas').count()).toBe(0)

    release = true
    for (const route of held.splice(0)) await route.continue()
    await waitForScene(page)
    await expect(page.getByRole('img', { name: '3D map of New York City' })).toBeVisible()
  })

  test('the default view starts over the Queens room within the mid-tier budget', async ({
    page,
  }) => {
    await page.goto('/')
    await waitForScene(page)
    const info = await page.evaluate(() => window.__cloutcityTest?.scene?.renderInfo())
    test.info().annotations.push({ type: 'default-view', description: JSON.stringify(info) })
    expect(info?.calls).toBeGreaterThanOrEqual(MIN_CALLS)
    expect(info?.calls).toBeLessThanOrEqual(perf.drawCallsMax.mid)
    expect(info?.triangles).toBeGreaterThanOrEqual(MIN_TRIANGLES)
    expect(info?.triangles).toBeLessThanOrEqual(perf.trianglesMax.mid)

    const state = await camera(page)
    // data/homes/homes.json queens-room: every new player's home (S05).
    const start = project({ lat: 40.7651, lng: -73.9247 })
    expect(state.target.x).toBeCloseTo(start.x, 0)
    expect(-state.target.z).toBeCloseTo(start.y, 0)
    expect(state.polarDeg).toBeCloseTo(48, 1)
    expect(state.azimuthDeg).toBeCloseTo(0, 1)
    expectInsideLimits(state)
  })

  test('an idle map renders zero frames, before and after an interaction', async ({ page }) => {
    await page.goto('/')
    await waitForScene(page)
    // District buildings and landmark models stream in after the first frame (S04d, S07a).
    await waitForCityModels(page)
    const before = await frames(page)
    await page.waitForTimeout(IDLE_WINDOW_MS)
    expect(await frames(page)).toBe(before)

    const { centre } = await freeArea(page)
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.wheel(0, -200)
    await expect.poll(() => frames(page)).toBeGreaterThan(before)
    await settle(page)
    const after = await frames(page)
    await page.waitForTimeout(IDLE_WINDOW_MS)
    expect(await frames(page)).toBe(after)
  })

  // Camera state changes synchronously in the controls' input handlers, and CDP input dispatch
  // resolves only after the page has handled the event, so each gesture is read back at once;
  // rendering is only waited for where frames matter (settle()).

  test('mobile: a one-finger drag left pans the target east', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'touch gestures run on the mobile project')
    await page.goto('/')
    await waitForScene(page)
    const { centre } = await freeArea(page)
    const start = await camera(page)
    await touchGesture(
      page,
      [{ x: centre.x + 120, y: centre.y }],
      [{ x: centre.x - 120, y: centre.y }],
    )
    const panned = await camera(page)
    expect(panned.target.x).toBeGreaterThan(start.target.x + 50)
    expect(Math.abs(panned.distance - start.distance)).toBeLessThan(1)
    expectInsideLimits(panned)
    await settle(page)
  })

  test('mobile: pinch out zooms in, and a huge pinch in clamps at the zoom-out limit', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'touch gestures run on the mobile project')
    await page.goto('/')
    await waitForScene(page)
    const { centre, top, bottom } = await freeArea(page)
    const span = Math.min(120, (bottom - top) / 2 - 10)
    const fingersApart = (gap: number): Point[] => [
      { x: centre.x - gap, y: centre.y },
      { x: centre.x + gap, y: centre.y },
    ]
    const start = await camera(page)
    await touchGesture(page, fingersApart(20), fingersApart(span))
    const zoomedIn = await camera(page)
    expect(zoomedIn.distance).toBeLessThan(start.distance * 0.8)
    expectInsideLimits(zoomedIn)

    // Fingers from far apart to almost touching: well past the zoom-out limit, so it clamps.
    await touchGesture(page, fingersApart(span + 40), fingersApart(4))
    await touchGesture(page, fingersApart(span + 40), fingersApart(4))
    const zoomedOut = await camera(page)
    expect(zoomedOut.distance).toBeCloseTo(scene.camera.maxDistanceM, -1)
    expectInsideLimits(zoomedOut)
    await settle(page)
  })

  test('mobile: two-finger drags tilt and turn, and clamp at their limits', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'touch gestures run on the mobile project')
    await page.goto('/')
    await waitForScene(page)
    const { centre, top, bottom } = await freeArea(page)
    const twoFingers = (dx: number, dy: number): [Point[], Point[]] => {
      const from = [
        { x: centre.x - 60, y: centre.y },
        { x: centre.x + 60, y: centre.y },
      ]
      return [from, from.map((p) => ({ x: p.x + dx, y: p.y + dy }))]
    }
    const rig = scene.camera

    // Vertical: the tilt changes, then a long drag either way stops at the tilt limits.
    const start = await camera(page)
    await touchGesture(page, ...twoFingers(0, -(bottom - top) / 3))
    const tilted = await camera(page)
    expect(Math.abs(tilted.polarDeg - start.polarDeg)).toBeGreaterThan(1)
    expectInsideLimits(tilted)
    await touchGesture(page, ...twoFingers(0, bottom - top - 20))
    const tiltedFar = await camera(page)
    expectInsideLimits(tiltedFar)
    const atTiltLimit = [rig.polarDeg.min, rig.polarDeg.max].some(
      (limit) => Math.abs(tiltedFar.polarDeg - limit) < ANGLE_EPSILON,
    )
    expect(atTiltLimit, `polar ${tiltedFar.polarDeg} should sit at a tilt limit`).toBe(true)

    // Horizontal: the turn changes, then a long drag stops at a turn limit.
    const beforeTurn = await camera(page)
    await touchGesture(page, ...twoFingers(60, 0))
    const turned = await camera(page)
    expect(Math.abs(turned.azimuthDeg - beforeTurn.azimuthDeg)).toBeGreaterThan(1)
    expectInsideLimits(turned)
    await touchGesture(page, ...twoFingers(300, 0))
    const turnedFar = await camera(page)
    expectInsideLimits(turnedFar)
    const atTurnLimit = [rig.azimuthDeg.min, rig.azimuthDeg.max].some(
      (limit) => Math.abs(turnedFar.azimuthDeg - limit) < ANGLE_EPSILON,
    )
    expect(atTurnLimit, `azimuth ${turnedFar.azimuthDeg} should sit at a turn limit`).toBe(true)
    await settle(page)
  })

  test('mobile: long pans at full zoom-out stop at the edge of the NYC extent', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'touch gestures run on the mobile project')
    await page.goto('/')
    await waitForScene(page)
    const { centre, top, bottom } = await freeArea(page)
    const span = Math.min(120, (bottom - top) / 2 - 10)
    const start = await camera(page)
    await touchGesture(
      page,
      [
        { x: centre.x - span - 40, y: centre.y },
        { x: centre.x + span + 40, y: centre.y },
      ],
      [
        { x: centre.x - 4, y: centre.y },
        { x: centre.x + 4, y: centre.y },
      ],
    )
    expect((await camera(page)).distance).toBeGreaterThan(start.distance * 2)

    // Fingers dragged right move the target west, until it stops at the west edge.
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('no viewport')
    for (let i = 0; i < EDGE_PANS; i++) {
      await touchGesture(
        page,
        [{ x: 10, y: centre.y }],
        [{ x: viewport.width - 10, y: centre.y }],
        GESTURE_STEPS,
      )
    }
    const edge = await camera(page)
    expectInsideLimits(edge)
    expect(edge.target.x).toBeCloseTo(sw.x, 0)
    await settle(page)
  })

  test('desktop: a mouse drag left pans the target east', async ({ page }, testInfo) => {
    test.skip(!!testInfo.project.use.hasTouch, 'mouse gestures run on the desktop project')
    await page.goto('/')
    await waitForScene(page)
    const { centre } = await freeArea(page)
    const start = await camera(page)
    await page.mouse.move(centre.x + 150, centre.y)
    await page.mouse.down()
    await page.mouse.move(centre.x - 150, centre.y, { steps: 4 })
    await page.mouse.up()
    const panned = await camera(page)
    expect(panned.target.x).toBeGreaterThan(start.target.x + 50)
    expect(Math.abs(panned.distance - start.distance)).toBeLessThan(1)
    expectInsideLimits(panned)
    await settle(page)
  })

  test('desktop: the wheel zooms in and out and clamps at both zoom limits', async ({
    page,
  }, testInfo) => {
    test.skip(!!testInfo.project.use.hasTouch, 'mouse gestures run on the desktop project')
    await page.goto('/')
    await waitForScene(page)
    const { centre } = await freeArea(page)
    const start = await camera(page)
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.wheel(0, -400)
    await expect.poll(async () => (await camera(page)).distance).toBeLessThan(start.distance)
    expectInsideLimits(await camera(page))

    // Zoom-to-cursor re-anchors the target after each clamped step, so the distance converges
    // on the limit over repeated events rather than landing on it at the first overshoot.
    await wheelBurst(page, centre, 2000, 30)
    await expect
      .poll(async () => (await camera(page)).distance)
      .toBeCloseTo(scene.camera.maxDistanceM, -1)
    expectInsideLimits(await camera(page))

    await wheelBurst(page, centre, -2000, 30)
    await expect
      .poll(async () => (await camera(page)).distance)
      .toBeCloseTo(scene.camera.minDistanceM, 0)
    expectInsideLimits(await camera(page))
    await settle(page)
  })

  test('the map attribution is one tap away in the free scene row and links to /credits', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/')
    await waitForScene(page)
    // UX-9: a compact "Map data" chip in the free row's corner; a tap shows the attribution.
    const attribution = page.locator('[data-map-attribution]')
    await expect(attribution).toBeVisible()
    const chip = attribution.locator('summary')
    await expect(chip).toHaveText(/Map data/)
    const chipBox = await chip.boundingBox()
    expect(chipBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(chipBox?.width ?? Infinity).toBeLessThanOrEqual(140)
    await expect(attribution.getByRole('link', { name: 'Credits' })).toBeHidden()
    await chip.click()
    await expect(attribution).toContainText('Map: NYC Open Data (NYC DCP)')
    await expect(attribution).toContainText('not endorsed by the MTA, may be inaccurate')
    const box = await attribution.boundingBox()
    const { top, bottom } = await freeArea(page)
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(top)
    expect((box?.y ?? 0) + (box?.height ?? Infinity)).toBeLessThanOrEqual(bottom)
    await checkA11y()

    const credits = attribution.getByRole('link', { name: 'Credits' })
    const linkBox = await credits.boundingBox()
    expect(linkBox?.height ?? 0).toBeGreaterThanOrEqual(44)
    await credits.click()
    await expect(page).toHaveURL(/\/credits$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Credits' })).toBeVisible()
    await expect(
      page.getByText(/not endorsed by, licensed by or affiliated with the MTA/),
    ).toBeVisible()
    await checkA11y()
  })
})

/** Near plane as the rig sets it (src/scene/camera/limits.ts nearFar), from data/config/scene.json. */
function expectNearFollowsDistance(state: CameraState): void {
  const rig = scene.camera as typeof scene.camera & {
    nearPerDistance: number
    nearMinM: number
    nearMaxM: number
  }
  const expected = Math.min(
    Math.max(state.distance * rig.nearPerDistance, rig.nearMinM),
    rig.nearMaxM,
  )
  expect(state.near).toBeCloseTo(expected, 3)
}

async function expectWithinMidBudget(page: Page, view: string): Promise<void> {
  const info = await page.evaluate(() => window.__cloutcityTest?.scene?.renderInfo())
  test.info().annotations.push({ type: view, description: JSON.stringify(info) })
  expect(info?.calls, `${view}: draw calls`).toBeLessThanOrEqual(perf.drawCallsMax.mid)
  expect(info?.triangles, `${view}: triangles`).toBeLessThanOrEqual(perf.trianglesMax.mid)
  expect(info?.calls, `${view}: something is drawn`).toBeGreaterThan(0)
}

test.describe('3D city scene: limits, budgets and layout under stress', () => {
  test('desktop: budgets hold at max zoom-out', async ({ page }, testInfo) => {
    test.skip(!!testInfo.project.use.hasTouch, 'mouse gestures run on the desktop project')
    await page.goto('/')
    await waitForScene(page)
    const { centre } = await freeArea(page)

    await page.mouse.move(centre.x, centre.y)
    await wheelBurst(page, centre, 2000, 30)
    await settle(page)
    const out = await camera(page)
    expect(out.distance).toBeCloseTo(scene.camera.maxDistanceM, -1)
    expectNearFollowsDistance(out)
    await expectWithinMidBudget(page, 'max-zoom-out')
  })

  test('desktop: budgets hold at max zoom-in over Manhattan', async ({ page }, testInfo) => {
    test.skip(!!testInfo.project.use.hasTouch, 'mouse gestures run on the desktop project')
    await page.goto('/')
    await waitForScene(page)
    const { centre } = await freeArea(page)

    // From the default view, drag the map until the target is over Midtown Manhattan, then zoom
    // all the way in there. The ground scale (metres per pixel) is measured from each drag.
    const midtown = project({ lat: 40.754, lng: -73.984 })
    let metresPerPx = 5
    for (let i = 0; i < 6; i++) {
      const now = await camera(page)
      const dxM = midtown.x - now.target.x
      const dyM = midtown.y + now.target.z
      if (Math.hypot(dxM, dyM) < 300) break
      const clampPx = (m: number) => Math.max(-250, Math.min(250, m / metresPerPx))
      const px = { x: clampPx(dxM), y: clampPx(dyM) }
      // The ground follows the cursor: dragging right moves the target west, down moves it north.
      await page.mouse.move(centre.x, centre.y)
      await page.mouse.down()
      await page.mouse.move(centre.x - px.x, centre.y + px.y, { steps: 5 })
      await page.mouse.up()
      const moved = await camera(page)
      const movedM = Math.hypot(moved.target.x - now.target.x, moved.target.z - now.target.z)
      const movedPx = Math.hypot(px.x, px.y)
      if (movedM > 0 && movedPx > 0) metresPerPx = movedM / movedPx
    }
    // Zoom towards the target itself: the camera frames it at the free row's centre (S05), so
    // zoom-to-cursor does not pull the view away from Midtown.
    await page.mouse.move(centre.x, centre.y)
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -20_000)
    await settle(page)
    const over = await camera(page)
    expect(Math.hypot(midtown.x - over.target.x, midtown.y + over.target.z)).toBeLessThan(1500)
    // Zoom-to-cursor re-anchors the target after the clamp, so the closest distance lands a
    // few metres above minDistanceM rather than exactly on it.
    expect(over.distance).toBeLessThanOrEqual(scene.camera.minDistanceM * 1.05)
    expectNearFollowsDistance(over)
    expectInsideLimits(over)
    await expectWithinMidBudget(page, 'max-zoom-in-manhattan')
  })

  test('mobile: extreme two-finger tilts both ways stay inside the polar limits', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'touch gestures run on the mobile project')
    await page.goto('/')
    await waitForScene(page)
    const { centre, top, bottom } = await freeArea(page)
    const pair = (c: Point, gap: number): Point[] => [
      { x: c.x - gap, y: c.y },
      { x: c.x + gap, y: c.y },
    ]
    for (const dy of [-(bottom - top) + 40, bottom - top - 40]) {
      await touchGesture(
        page,
        pair(centre, 60),
        pair(centre, 60).map((p) => ({ x: p.x, y: p.y + dy })),
      )
      expectInsideLimits(await camera(page))
    }
    await settle(page)
  })

  test('mobile: pinches at the extent edge while fully tilted keep every limit', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'touch gestures run on the mobile project')
    await page.goto('/')
    await waitForScene(page)
    const { centre, top, bottom } = await freeArea(page)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('no viewport')
    const pair = (c: Point, gap: number): Point[] => [
      { x: c.x - gap, y: c.y },
      { x: c.x + gap, y: c.y },
    ]
    const twoFingerDrag = (dx: number, dy: number) =>
      touchGesture(
        page,
        pair(centre, 60),
        pair(centre, 60).map((p) => ({ x: p.x + dx, y: p.y + dy })),
        GESTURE_STEPS,
      )

    // Tilt as far as it goes (an extreme gesture), inside the polar limits.
    await twoFingerDrag(0, bottom - top - 40)
    expectInsideLimits(await camera(page))

    // Pan to the north-west edge of the extent with long one-finger drags.
    // Zoomed out first so a few drags cover the whole extent.
    await touchGesture(page, pair(centre, 120), pair(centre, 4), GESTURE_STEPS)
    for (let i = 0; i < EDGE_PANS; i++) {
      await touchGesture(
        page,
        [{ x: 20, y: top + 10 }],
        [{ x: viewport.width - 20, y: bottom - 10 }],
        GESTURE_STEPS,
      )
    }
    await settle(page)
    const edge = await camera(page)
    expectInsideLimits(edge)
    expectNearFollowsDistance(edge)
    // At the north-west corner: the pinches below start at the extent edge.
    expect(edge.target.x).toBeCloseTo(sw.x, 0)
    expect(-edge.target.z).toBeCloseTo(ne.y, 0)

    // Pinch in and out at the screen corners (zoom-to-cursor pulls towards a point off the
    // extent); the target must stay clamped and the near plane must follow the distance.
    const corners: Point[] = [
      { x: 60, y: top + 30 },
      { x: viewport.width - 60, y: bottom - 30 },
    ]
    for (const corner of corners) {
      await touchGesture(page, pair(corner, 4), pair(corner, 55), GESTURE_STEPS)
      const zoomedIn = await camera(page)
      expectInsideLimits(zoomedIn)
      expectNearFollowsDistance(zoomedIn)
      await touchGesture(page, pair(corner, 55), pair(corner, 4), GESTURE_STEPS)
      const zoomedOut = await camera(page)
      expectInsideLimits(zoomedOut)
      expectNearFollowsDistance(zoomedOut)
    }
  })

  test('a resize renders the scene again, then it goes back to zero idle frames', async ({
    page,
  }) => {
    await page.goto('/')
    await waitForScene(page)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('no viewport')
    const before = await frames(page)
    // An orientation change: width and height swap.
    await page.setViewportSize({ width: viewport.height, height: viewport.width })
    await expect.poll(() => frames(page)).toBeGreaterThan(before)
    await settle(page)
    const after = await frames(page)
    await page.waitForTimeout(IDLE_WINDOW_MS)
    expect(await frames(page)).toBe(after)
    expectInsideLimits(await camera(page))
  })

  for (const size of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
    { width: 390, height: 480 },
    { width: 844, height: 390 },
  ]) {
    test(`the attribution sits in the free scene row at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size)
      await page.goto('/')
      await waitForScene(page)
      const attribution = page.locator('[data-map-attribution]')
      await expect(attribution).toBeVisible()
      // Opened (UX-9): the chip and its text together must still stay in the free scene row.
      await attribution.locator('summary').click()
      const box = await attribution.evaluate((element) => {
        const rects = [...element.querySelectorAll('summary, summary ~ div')].map((child) =>
          child.getBoundingClientRect(),
        )
        const x = Math.min(...rects.map((r) => r.left))
        const y = Math.min(...rects.map((r) => r.top))
        return {
          x,
          y,
          width: Math.max(...rects.map((r) => r.right)) - x,
          height: Math.max(...rects.map((r) => r.bottom)) - y,
        }
      })
      const { top, bottom } = await freeArea(page)
      expect(box.y, 'below the HUD').toBeGreaterThanOrEqual(top)
      expect(box.y + box.height, 'above the toast zone').toBeLessThanOrEqual(bottom)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(size.width)
      for (const zone of ['banner', 'hud', 'toast', 'sheet', 'tabs']) {
        const zoneBox = await page.locator(`[data-overlay-zone="${zone}"]`).boundingBox()
        if (!zoneBox || zoneBox.height === 0) continue
        const overlaps =
          box.x < zoneBox.x + zoneBox.width &&
          zoneBox.x < box.x + box.width &&
          box.y < zoneBox.y + zoneBox.height &&
          zoneBox.y < box.y + box.height
        expect(overlaps, `attribution overlaps the ${zone} zone`).toBe(false)
      }
      const link = attribution.getByRole('link', { name: 'Credits' })
      await expect(link).toBeVisible()
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
      // The required attribution is read in full, never cut off with an ellipsis or clipped.
      const clipped = await attribution.evaluate((element) =>
        [...element.querySelectorAll('summary ~ div p')]
          .filter((p) => p.getClientRects().length > 0)
          .filter((p) => p.scrollWidth > p.clientWidth || p.scrollHeight > p.clientHeight)
          .map((p) => p.textContent),
      )
      expect(clipped, 'attribution text cut off').toEqual([])
    })
  }
})
