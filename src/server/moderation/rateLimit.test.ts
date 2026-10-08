import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rateLimit'

describe('createRateLimiter', () => {
  it('allows max hits per key per window, then opens again', () => {
    const limiter = createRateLimiter(2, 1000)
    expect([limiter.take('a', 0), limiter.take('a', 10), limiter.take('a', 20)]).toEqual([
      true,
      true,
      false,
    ])
    expect(limiter.take('b', 20)).toBe(true)
    expect(limiter.take('a', 1000)).toBe(true)
  })

  it('never grows past maxKeys: stale windows are dropped, live ones refuse newcomers', () => {
    const limiter = createRateLimiter(1, 1000, 2)
    expect(limiter.take('a', 0)).toBe(true)
    expect(limiter.take('b', 0)).toBe(true)
    expect(limiter.take('c', 10)).toBe(false)
    expect(limiter.take('c', 1000)).toBe(true)
  })
})
