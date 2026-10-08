import type { Page } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { holdGameTime, waitForHudLoaded } from './helpers/hud'
import { hideSceneForScreenshot, waitForMapSettled } from './helpers/scene'

// UX-1: overlays never cover each other. Runs at mobile-390 and desktop-1280.

const ZONES = ['banner', 'hud', 'toast', 'sheet', 'tabs'] as const
type Zone = (typeof ZONES)[number]

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function zoneBoxes(page: Page): Promise<Record<Zone, Box>> {
  const entries = await Promise.all(
    ZONES.map(async (zone) => {
      const box = await page.locator(`[data-overlay-zone="${zone}"]`).boundingBox()
      if (!box) throw new Error(`zone ${zone} is not rendered`)
      return [zone, box] as const
    }),
  )
  return Object.fromEntries(entries) as Record<Zone, Box>
}

function intersectionArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Fills every zone with oversized placeholder content, as a worst case. */
async function fillZonesWithPlaceholders(page: Page): Promise<void> {
  await page.evaluate((zones) => {
    const colours: Record<string, string> = {
      banner: '#ffd23f',
      hud: '#ff4fa3',
      toast: '#4fd1ff',
      sheet: '#7cff4f',
      tabs: '#ff8a3d',
    }
    for (const zone of zones) {
      const host = document.querySelector<HTMLElement>(`[data-overlay-zone="${zone}"]`)
      if (!host) throw new Error(`zone ${zone} missing`)
      const placeholder = document.createElement('div')
      placeholder.dataset.placeholder = zone
      placeholder.textContent = `${zone} placeholder`
      Object.assign(placeholder.style, {
        pointerEvents: 'auto',
        height: '2000px',
        width: '100%',
        background: colours[zone],
        opacity: '0.85',
        color: '#0d0a24',
        font: '600 14px sans-serif',
        padding: '4px',
      })
      host.replaceChildren(placeholder)
    }
  }, ZONES)
}

test.describe('overlay layer system', () => {
  test('reserves non-overlapping safe zones inside the viewport', async ({ page }) => {
    await page.goto('/')
    await waitForWelcomeGate(page)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('viewport size is not set')
    const boxes = await zoneBoxes(page)

    for (const zone of ZONES) {
      const box = boxes[zone]
      expect(box.height, `${zone} height`).toBeGreaterThan(0)
      expect(box.y, `${zone} top`).toBeGreaterThanOrEqual(0)
      expect(box.x, `${zone} left`).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height, `${zone} bottom`).toBeLessThanOrEqual(viewport.height)
      expect(box.x + box.width, `${zone} right`).toBeLessThanOrEqual(viewport.width)
    }
    for (const [i, a] of ZONES.entries()) {
      for (const b of ZONES.slice(i + 1)) {
        expect(intersectionArea(boxes[a], boxes[b]), `${a} overlaps ${b}`).toBe(0)
      }
    }

    // Top to bottom: banner, HUD, (free scene), toast, sheet, tab bar.
    const order = [...ZONES].sort((a, b) => boxes[a].y - boxes[b].y)
    expect(order).toEqual(['banner', 'hud', 'toast', 'sheet', 'tabs'])
    expect(boxes.tabs.y + boxes.tabs.height).toBe(viewport.height)
    expect(boxes.toast.y).toBeGreaterThan(boxes.hud.y + boxes.hud.height)
  })

  test('oversized content stays inside its own zone', async ({ page }) => {
    await page.goto('/')
    await waitForWelcomeGate(page)
    const before = await zoneBoxes(page)
    await fillZonesWithPlaceholders(page)
    const after = await zoneBoxes(page)
    expect(after, 'content must not resize zones').toEqual(before)

    // Whatever is on top at points across each zone belongs to that zone.
    const strays = await page.evaluate((zones) => {
      const found: string[] = []
      for (const zone of zones) {
        const host = document.querySelector(`[data-overlay-zone="${zone}"]`)
        if (!host) throw new Error(`zone ${zone} missing`)
        const r = host.getBoundingClientRect()
        for (const fx of [0.05, 0.5, 0.95]) {
          for (const fy of [0.1, 0.5, 0.9]) {
            const x = r.left + r.width * fx
            const y = r.top + r.height * fy
            const hit = document.elementFromPoint(x, y)?.closest('[data-overlay-zone]')
            const owner = hit?.getAttribute('data-overlay-zone') ?? 'none'
            if (owner !== zone)
              found.push(`${zone} at (${x.toFixed(0)},${y.toFixed(0)}) is ${owner}`)
          }
        }
      }
      return found
    }, ZONES)
    expect(strays).toEqual([])

    await hideSceneForScreenshot(page)
    await expect(page).toHaveScreenshot('overlay-zones-filled.png')
  })

  test('the shell as shipped matches its screenshot', async ({ page }) => {
    await holdGameTime(page)
    await page.goto('/')
    await waitForWelcomeGate(page)
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    // The map's start-up on SwiftShader keeps the page from settling for a stable capture.
    await waitForMapSettled(page)
    await waitForHudLoaded(page)
    await hideSceneForScreenshot(page)
    await expect(page).toHaveScreenshot('overlay-shell.png')
  })
})

// Short and landscape viewports: the grid must shrink the flexible zones, never push the tab bar
// or HUD off screen or let zones overlap.
const CRAMPED_VIEWPORTS = [
  { width: 390, height: 600 },
  { width: 390, height: 480 },
  { width: 844, height: 390 },
] as const

test.describe('overlay layer system on cramped viewports', () => {
  for (const size of CRAMPED_VIEWPORTS) {
    test(`${size.width}x${size.height}: tab bar and HUD fully on screen, no overlap`, async ({
      page,
    }) => {
      await page.setViewportSize(size)
      await page.goto('/')
      await waitForWelcomeGate(page)

      // The real tab bar first (the placeholder fill below replaces it).
      const nav = page.getByRole('navigation', { name: 'Main' })
      const navBox = await nav.boundingBox()
      if (!navBox) throw new Error('tab bar is not rendered')
      expect(navBox.y + navBox.height).toBe(size.height)
      expect(navBox.height).toBeGreaterThanOrEqual(44)
      for (const name of ['Map', 'Phone', 'Shop', 'Me']) {
        const tab = nav.getByRole('button', { name })
        await expect(tab).toBeInViewport({ ratio: 1 })
        const box = await tab.boundingBox()
        expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(44)
      }

      await fillZonesWithPlaceholders(page)
      const boxes = await zoneBoxes(page)
      for (const zone of ZONES) {
        const box = boxes[zone]
        expect(box.y, `${zone} top`).toBeGreaterThanOrEqual(0)
        expect(box.y + box.height, `${zone} bottom`).toBeLessThanOrEqual(size.height)
      }
      for (const [i, a] of ZONES.entries()) {
        for (const b of ZONES.slice(i + 1)) {
          expect(intersectionArea(boxes[a], boxes[b]), `${a} overlaps ${b}`).toBe(0)
        }
      }
      expect(boxes.hud.height, 'HUD keeps its reserved height').toBeGreaterThanOrEqual(44)
    })
  }
})
