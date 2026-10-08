import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginContinuous, continuousSince, endContinuous, subscribeContinuous } from './continuity'

afterEach(() => {
  endContinuous('gesture')
  endContinuous('flight')
})

describe('continuous-rendering window', () => {
  it('is closed until a source opens it, and records when it opened', () => {
    expect(continuousSince()).toBeNull()
    beginContinuous('gesture', 1_000)
    expect(continuousSince()).toBe(1_000)
    endContinuous('gesture')
    expect(continuousSince()).toBeNull()
  })

  it('stays open while any source is open and keeps its start', () => {
    beginContinuous('flight', 100)
    beginContinuous('gesture', 300)
    endContinuous('flight')
    expect(continuousSince()).toBe(100)
    endContinuous('gesture')
    expect(continuousSince()).toBeNull()
  })

  it('ignores repeated begins and ends of one source', () => {
    beginContinuous('gesture', 10)
    beginContinuous('gesture', 20)
    expect(continuousSince()).toBe(10)
    endContinuous('gesture')
    endContinuous('gesture')
    expect(continuousSince()).toBeNull()
  })

  it('notifies subscribers only when the window opens or closes', () => {
    const listener = vi.fn()
    const off = subscribeContinuous(listener)
    beginContinuous('gesture', 1)
    beginContinuous('flight', 2)
    endContinuous('gesture')
    endContinuous('flight')
    off()
    beginContinuous('gesture', 3)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
