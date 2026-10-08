import type { Page } from '@playwright/test'

export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * A multi-finger touch gesture through the Chrome DevTools Protocol
 * (Input.dispatchTouchEvent), which Chromium turns into real touch and pointer events.
 * Every finger moves in a straight line from its start to its end point in `steps` moves.
 * Coordinates are CSS pixels in the viewport. Chromium only (the e2e projects are Chromium).
 */
export async function touchGesture(
  page: Page,
  starts: readonly Point[],
  ends: readonly Point[],
  steps = 4,
): Promise<void> {
  if (starts.length !== ends.length || starts.length === 0) {
    throw new Error('touchGesture: give one end point per finger')
  }
  const session = await page.context().newCDPSession(page)
  const at = (t: number) =>
    starts.map((start, id) => {
      const end = ends[id] ?? start
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, id }
    })
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) })
    for (let step = 1; step <= steps; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: at(step / steps),
      })
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await session.detach()
  }
}
