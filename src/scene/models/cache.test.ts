import { describe, expect, it, vi } from 'vitest'
import { createRefCountLru } from './cache'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createRefCountLru', () => {
  it('loads a key once however many users acquire it', async () => {
    const cache = createRefCountLru<string>(2, vi.fn())
    const load = vi.fn(async () => 'taxi')
    const [a, b] = await Promise.all([cache.acquire('k', load), cache.acquire('k', load)])
    expect(a).toBe('taxi')
    expect(b).toBe('taxi')
    expect(load).toHaveBeenCalledTimes(1)
    expect(cache.stats()).toEqual({ held: 1, idle: 0 })
  })

  it('keeps a released entry idle and reuses it without reloading', async () => {
    const dispose = vi.fn()
    const cache = createRefCountLru<string>(1, dispose)
    const load = vi.fn(async () => 'bed')
    await cache.acquire('bed', load)
    cache.release('bed')
    expect(cache.stats()).toEqual({ held: 0, idle: 1 })
    await cache.acquire('bed', load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()
    expect(cache.stats()).toEqual({ held: 1, idle: 0 })
  })

  it('evicts the least recently idle entry beyond the limit and disposes it', async () => {
    const dispose = vi.fn()
    const cache = createRefCountLru<string>(2, dispose)
    for (const key of ['a', 'b', 'c']) await cache.acquire(key, async () => key)
    cache.release('b')
    cache.release('a')
    cache.release('c')
    expect(dispose).toHaveBeenCalledExactlyOnceWith('b')
    expect(cache.stats()).toEqual({ held: 0, idle: 2 })
  })

  it('never evicts an entry that is still held', async () => {
    const dispose = vi.fn()
    const cache = createRefCountLru<string>(0, dispose)
    await cache.acquire('a', async () => 'a')
    await cache.acquire('a', async () => 'a')
    cache.release('a')
    expect(dispose).not.toHaveBeenCalled()
    cache.release('a')
    expect(dispose).toHaveBeenCalledExactlyOnceWith('a')
    // Extra releases are ignored rather than going negative.
    cache.release('a')
    expect(cache.stats()).toEqual({ held: 0, idle: 0 })
  })

  it('drops a failed load so the next acquire retries', async () => {
    const cache = createRefCountLru<string>(2, vi.fn())
    await expect(cache.acquire('x', () => Promise.reject(new Error('404')))).rejects.toThrow('404')
    expect(cache.stats()).toEqual({ held: 0, idle: 0 })
    await expect(cache.acquire('x', async () => 'ok')).resolves.toBe('ok')
  })

  it('disposes a value that finishes loading after the cache was cleared', async () => {
    const dispose = vi.fn()
    const cache = createRefCountLru<string>(2, dispose)
    const pending = deferred<string>()
    const acquired = cache.acquire('late', () => pending.promise)
    cache.clear()
    pending.resolve('late')
    await acquired
    expect(dispose).toHaveBeenCalledExactlyOnceWith('late')
  })

  it('clear() disposes every loaded entry', async () => {
    const dispose = vi.fn()
    const cache = createRefCountLru<string>(4, dispose)
    await cache.acquire('a', async () => 'a')
    await cache.acquire('b', async () => 'b')
    cache.release('b')
    cache.clear()
    expect(dispose.mock.calls.flat().sort()).toEqual(['a', 'b'])
    expect(cache.stats()).toEqual({ held: 0, idle: 0 })
  })

  it('rejects a negative or fractional idle limit', () => {
    expect(() => createRefCountLru(-1, vi.fn())).toThrow()
    expect(() => createRefCountLru(1.5, vi.fn())).toThrow()
  })
})
