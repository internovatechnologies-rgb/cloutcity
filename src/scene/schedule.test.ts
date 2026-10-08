import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSlicer, whenIdle, yieldToMain } from './schedule'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('whenIdle', () => {
  it('uses requestIdleCallback with the timeout when the browser has it', () => {
    const requestIdleCallback = vi.fn<
      (callback: () => void, options?: { timeout: number }) => number
    >(() => 7)
    const cancelIdleCallback = vi.fn()
    vi.stubGlobal('window', { requestIdleCallback, cancelIdleCallback })
    const callback = vi.fn()
    const stop = whenIdle(callback, 300)
    expect(requestIdleCallback).toHaveBeenCalledWith(callback, { timeout: 300 })
    stop()
    expect(cancelIdleCallback).toHaveBeenCalledWith(7)
  })

  it('falls back to a timer (Safari) that can be cancelled', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const callback = vi.fn()
    whenIdle(callback, 300)
    vi.runAllTimers()
    expect(callback).toHaveBeenCalledTimes(1)
    const cancelled = vi.fn()
    whenIdle(cancelled, 300)()
    vi.runAllTimers()
    expect(cancelled).not.toHaveBeenCalled()
  })
})

describe('yieldToMain', () => {
  it('uses scheduler.yield where it exists', async () => {
    const scheduler = { yield: vi.fn(() => Promise.resolve()) }
    vi.stubGlobal('window', { scheduler })
    await yieldToMain()
    expect(scheduler.yield).toHaveBeenCalledTimes(1)
  })

  it('resolves through a MessageChannel task otherwise', async () => {
    vi.stubGlobal('window', {})
    await expect(yieldToMain()).resolves.toBeUndefined()
  })
})

describe('createSlicer', () => {
  it('yields only once a slice has run for sliceMs, then starts a new slice', async () => {
    let now = 0
    let yields = 0
    const step = createSlicer(
      8,
      async () => {
        yields++
      },
      () => now,
    )
    await step()
    now = 7
    await step()
    expect(yields).toBe(0)
    now = 8
    await step()
    expect(yields).toBe(1)
    now = 15
    await step()
    expect(yields).toBe(1)
    now = 16
    await step()
    expect(yields).toBe(2)
  })
})
