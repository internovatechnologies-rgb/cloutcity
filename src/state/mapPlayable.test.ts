import { describe, expect, it } from 'vitest'
import { createMapPlayableSignal } from './mapPlayable'

describe('map playable signal', () => {
  it('resolves waiters once marked, and later waiters at once', async () => {
    const signal = createMapPlayableSignal()
    let resolved = false
    const waiting = signal.whenMapPlayable().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(signal.isMapPlayable()).toBe(false)
    signal.markMapPlayable()
    await waiting
    expect(resolved).toBe(true)
    expect(signal.isMapPlayable()).toBe(true)
    signal.markMapPlayable()
    await expect(signal.whenMapPlayable()).resolves.toBeUndefined()
  })
})
