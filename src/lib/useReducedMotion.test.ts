import { describe, expect, it, vi } from 'vitest'
import { REDUCED_MOTION_QUERY, readReducedMotion, subscribeReducedMotion } from './useReducedMotion'

/** A matchMedia whose single query can be flipped, firing `change` like a browser. */
function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>()
  const list = {
    matches: initial,
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  }
  const matchMedia = vi.fn((query: string) => {
    void query
    return list as unknown as MediaQueryList
  })
  const set = (matches: boolean) => {
    list.matches = matches
    for (const listener of listeners) listener()
  }
  return { matchMedia, list, listeners, set }
}

describe('useReducedMotion', () => {
  it('reads the reduced-motion media query', () => {
    const media = fakeMatchMedia(true)
    expect(readReducedMotion(media.matchMedia)).toBe(true)
    expect(media.matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY)
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)')
    expect(readReducedMotion(fakeMatchMedia(false).matchMedia)).toBe(false)
  })

  it('is false without matchMedia (the server, old browsers)', () => {
    expect(readReducedMotion(undefined)).toBe(false)
    expect(readReducedMotion()).toBe(false)
    expect(() => subscribeReducedMotion(() => {}, undefined)()).not.toThrow()
  })

  it('notifies on a change and stops after unsubscribing', () => {
    const media = fakeMatchMedia(false)
    const onChange = vi.fn()
    const unsubscribe = subscribeReducedMotion(onChange, media.matchMedia)
    media.set(true)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(readReducedMotion(media.matchMedia)).toBe(true)
    unsubscribe()
    expect(media.listeners.size).toBe(0)
    media.set(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
