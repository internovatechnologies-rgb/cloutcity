import { describe, expect, it } from 'vitest'
import { createLogger, type LogRecord } from '@/lib/log'
import {
  createQualityStore,
  QUALITY_KEY,
  QUALITY_VERSION,
  readNewerQuality,
  selectActiveTier,
  type PersistedQuality,
} from './quality'
import { createSafeJsonStorage } from './storage'

class MemoryStorage {
  readonly map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
}

function setup(seed?: unknown, getStorage?: () => Storage | undefined) {
  const local = new MemoryStorage()
  if (seed !== undefined) local.setItem(QUALITY_KEY, JSON.stringify(seed))
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const storage = createSafeJsonStorage<PersistedQuality>(
    getStorage ?? (() => local as Storage),
    logger,
  )
  return { local, records, store: () => createQualityStore(storage, logger) }
}

const stored = (local: MemoryStorage) => JSON.parse(local.getItem(QUALITY_KEY) ?? 'null')
const noWarnings = (records: readonly LogRecord[]) =>
  records.every((record) => record.level !== 'warn' && record.level !== 'error')

describe('quality store', () => {
  it('starts automatic, undetected, with no step-downs', () => {
    const state = setup().store().getState()
    expect(state).toMatchObject({
      override: null,
      auto: null,
      dataSaver: false,
      steps: 0,
      lastStepAtMs: null,
    })
    expect(selectActiveTier(state)).toBeNull()
  })

  it('persists only the override', () => {
    const { local, store } = setup()
    const quality = store()
    quality.getState().setDetected({ tier: 'high', reasons: ['high-capable'] }, false)
    quality.getState().recordStepDown(5_000)
    quality.getState().setOverride('mid')
    expect(stored(local)).toEqual({ state: { override: 'mid' }, version: QUALITY_VERSION })
    expect(store().getState()).toMatchObject({ override: 'mid', auto: null, steps: 0 })
  })

  it('returns to automatic with a null override', () => {
    const { local, store } = setup({ state: { override: 'low' }, version: QUALITY_VERSION })
    const quality = store()
    expect(quality.getState().override).toBe('low')
    quality.getState().setOverride(null)
    expect(stored(local).state).toEqual({ override: null })
  })

  it('skips a write when the override does not change', () => {
    const { local, store } = setup()
    const quality = store()
    quality.getState().setOverride('high')
    local.clear()
    quality.getState().setOverride('high')
    expect(local.getItem(QUALITY_KEY)).toBeNull()
  })

  it('records the picked tier and step-downs for this session', () => {
    const quality = setup().store()
    quality.getState().setDetected({ tier: 'high', reasons: ['high-capable'] }, false)
    expect(selectActiveTier(quality.getState())).toBe('high')
    quality.getState().recordStepDown(1_000)
    quality.getState().recordStepDown(12_000)
    expect(quality.getState()).toMatchObject({ steps: 2, lastStepAtMs: 12_000 })
    expect(selectActiveTier(quality.getState())).toBe('low')
  })

  it('resolves the active tier: data saver, then override, then auto minus steps', () => {
    const quality = setup().store()
    quality.getState().setDetected({ tier: 'mid', reasons: ['default'] }, false)
    quality.getState().setOverride('high')
    expect(selectActiveTier(quality.getState())).toBe('high')
    quality.getState().setDetected({ tier: 'low', reasons: ['data-saver'] }, true)
    expect(selectActiveTier(quality.getState())).toBe('low')
  })

  it.each([
    ['an unknown tier', { override: 'ultra' }],
    ['a missing override', {}],
    ['an extra field', { override: 'mid', steps: 3 }],
    ['a non-object state', 'high'],
  ])('replaces %s with automatic and logs at info', (_label, state) => {
    const { records, store } = setup({ state, version: QUALITY_VERSION })
    expect(store().getState().override).toBeNull()
    expect(records.some((r) => r.level === 'info' && /failed validation/.test(r.msg))).toBe(true)
    expect(noWarnings(records)).toBe(true)
  })

  it('treats invalid JSON as nothing stored', () => {
    const { local, store } = setup()
    local.setItem(QUALITY_KEY, '{not json')
    expect(store().getState().override).toBeNull()
  })

  it('never throws when storage is unavailable', () => {
    const { records, store } = setup(undefined, () => {
      throw new Error('SecurityError')
    })
    const quality = store()
    expect(() => quality.getState().setOverride('low')).not.toThrow()
    expect(quality.getState().override).toBe('low')
    expect(noWarnings(records)).toBe(true)
  })

  describe('settings from a newer build', () => {
    const newer = {
      state: { override: 'high', antialias: false },
      version: QUALITY_VERSION + 1,
    }

    it('are read loosely and respected', () => {
      expect(setup(newer).store().getState().override).toBe('high')
    })

    it('are never overwritten', () => {
      const { local, store } = setup(newer)
      store().getState().setOverride('low')
      expect(stored(local)).toEqual(newer)
    })

    it('fall back to automatic when unreadable', () => {
      expect(readNewerQuality({ override: 'ultra' })).toBeNull()
      expect(readNewerQuality(null)).toBeNull()
      expect(
        setup({ state: { nope: 1 }, version: 9 })
          .store()
          .getState().override,
      ).toBeNull()
    })
  })

  it('ignores an unknown older format', () => {
    const { store, records } = setup({ state: { override: 'high' }, version: 0 })
    expect(store().getState().override).toBeNull()
    expect(records.some((r) => r.level === 'info' && /older format/.test(r.msg))).toBe(true)
  })
})
