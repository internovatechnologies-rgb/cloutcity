import { describe, expect, it } from 'vitest'
import { attachTapDetector, type TapPointerEvent, type TapTarget } from './tap'

type Listener = (event: TapPointerEvent) => void

function target(): TapTarget & {
  fire(type: string, event: Partial<TapPointerEvent>): void
  count(): number
} {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    fire(type, event) {
      const full: TapPointerEvent = {
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 0,
        clientY: 0,
        timeStamp: 0,
        ...event,
      }
      for (const listener of listeners.get(type) ?? []) listener(full)
    },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

const options = { slopPx: 8, maxMs: 400 }

function setup() {
  const el = target()
  const taps: [number, number][] = []
  const detach = attachTapDetector(el, options, (x, y) => taps.push([x, y]))
  return { el, taps, detach }
}

describe('attachTapDetector', () => {
  it('reports a quick, still press as a tap at the release point', () => {
    const { el, taps } = setup()
    el.fire('pointerdown', { clientX: 100, clientY: 200, timeStamp: 1000 })
    el.fire('pointermove', { clientX: 103, clientY: 204, timeStamp: 1100 })
    el.fire('pointerup', { clientX: 104, clientY: 205, timeStamp: 1300 })
    expect(taps).toEqual([[104, 205]])
  })

  it('ignores a drag beyond the slop, even one that comes back', () => {
    const { el, taps } = setup()
    el.fire('pointerdown', { clientX: 100, clientY: 100, timeStamp: 0 })
    el.fire('pointermove', { clientX: 120, clientY: 100, timeStamp: 50 })
    el.fire('pointerup', { clientX: 100, clientY: 100, timeStamp: 100 })
    el.fire('pointerdown', { clientX: 100, clientY: 100, timeStamp: 200 })
    el.fire('pointerup', { clientX: 109, clientY: 100, timeStamp: 250 })
    expect(taps).toEqual([])
  })

  it('ignores a long press', () => {
    const { el, taps } = setup()
    el.fire('pointerdown', { timeStamp: 0 })
    el.fire('pointerup', { timeStamp: 401 })
    el.fire('pointerdown', { timeStamp: 1000 })
    el.fire('pointerup', { timeStamp: 1400 })
    expect(taps).toHaveLength(1)
  })

  it('ignores secondary buttons, non-primary pointers and multi-touch', () => {
    const { el, taps } = setup()
    el.fire('pointerdown', { button: 2 })
    el.fire('pointerup', { button: 2 })
    el.fire('pointerdown', { pointerId: 7, isPrimary: false })
    el.fire('pointerup', { pointerId: 7, isPrimary: false })
    // A pinch: the second finger cancels the first finger's tap.
    el.fire('pointerdown', { pointerId: 1 })
    el.fire('pointerdown', { pointerId: 2, isPrimary: false })
    el.fire('pointerup', { pointerId: 2 })
    el.fire('pointerup', { pointerId: 1 })
    expect(taps).toEqual([])
    // Afterwards a plain tap works again.
    el.fire('pointerdown', { pointerId: 3, clientX: 5, clientY: 6 })
    el.fire('pointerup', { pointerId: 3, clientX: 5, clientY: 6 })
    expect(taps).toEqual([[5, 6]])
  })

  it('drops a cancelled pointer', () => {
    const { el, taps } = setup()
    el.fire('pointerdown', {})
    el.fire('pointercancel', {})
    el.fire('pointerup', {})
    expect(taps).toEqual([])
  })

  it('detaches every listener', () => {
    const { el, detach } = setup()
    expect(el.count()).toBe(4)
    detach()
    expect(el.count()).toBe(0)
  })
})
