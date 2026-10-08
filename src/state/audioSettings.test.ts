import { describe, expect, it } from 'vitest'
import audioJson from '@data/config/audio.json'
import { createLogger, type LogRecord } from '@/lib/log'
import {
  AUDIO_SETTINGS_KEY,
  AUDIO_SETTINGS_VERSION,
  createAudioSettingsStore,
  readNewerAudioSettings,
  type PersistedAudioSettings,
} from './audioSettings'
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

function setup(seed?: unknown) {
  const local = new MemoryStorage()
  if (seed !== undefined) local.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(seed))
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const storage = createSafeJsonStorage<PersistedAudioSettings>(() => local as Storage, logger)
  return { local, records, store: () => createAudioSettingsStore(storage, audioJson, logger) }
}

const stored = (local: MemoryStorage) => JSON.parse(local.getItem(AUDIO_SETTINGS_KEY) ?? 'null')

describe('audio settings store', () => {
  it('starts from the configured defaults', () => {
    const { store } = setup()
    expect(store().getState().volumes).toEqual(audioJson.defaults)
    expect(store().getState().updatedAt).toBe(0)
  })

  it('round-trips volumes and updatedAt through storage', () => {
    const { local, store } = setup()
    const first = store()
    first.getState().setVolume('sfx', 35, 1_000)
    expect(stored(local)).toEqual({
      state: { volumes: { ...audioJson.defaults, sfx: 35 }, updatedAt: 1_000 },
      version: AUDIO_SETTINGS_VERSION,
    })
    expect(store().getState()).toMatchObject({ volumes: { sfx: 35 }, updatedAt: 1_000 })
  })

  it('snaps to the slider step, clamps, ignores NaN and skips no-op writes', () => {
    const { local, store } = setup()
    const settings = store()
    settings.getState().setVolume('music', 63, 5)
    expect(settings.getState().volumes.music).toBe(65)
    settings.getState().setVolume('music', 900, 6)
    expect(settings.getState().volumes.music).toBe(100)
    settings.getState().setVolume('music', Number.NaN, 7)
    expect(settings.getState()).toMatchObject({ volumes: { music: 100 }, updatedAt: 6 })
    local.clear()
    settings.getState().setVolume('music', 100, 8)
    expect(local.getItem(AUDIO_SETTINGS_KEY)).toBeNull()
  })

  it('setting one channel leaves the others alone', () => {
    const { store } = setup()
    const settings = store()
    settings.getState().setVolume('master', 0, 1)
    expect(settings.getState().volumes).toEqual({ ...audioJson.defaults, master: 0 })
  })

  it('replaces corrupt settings with the defaults and logs at info', () => {
    const corrupt = { state: { volumes: { master: 'loud' }, updatedAt: -1 }, version: 1 }
    const { records, store } = setup(corrupt)
    expect(store().getState().volumes).toEqual(audioJson.defaults)
    expect(records.some((r) => r.level === 'info' && /failed validation/.test(r.msg))).toBe(true)
    expect(records.some((r) => r.level === 'warn' || r.level === 'error')).toBe(false)
  })

  it('treats invalid JSON as nothing stored', () => {
    const { local, store } = setup()
    local.setItem(AUDIO_SETTINGS_KEY, '{not json')
    expect(store().getState().volumes).toEqual(audioJson.defaults)
  })

  describe('settings from a newer build', () => {
    const newer = {
      state: { volumes: { ...audioJson.defaults, music: 10, chat: 50 }, updatedAt: 9, extra: true },
      version: AUDIO_SETTINGS_VERSION + 1,
    }

    it('are read loosely and respected', () => {
      const { store } = setup(newer)
      expect(store().getState()).toMatchObject({ volumes: { music: 10 }, updatedAt: 9 })
      expect(store().getState().volumes).not.toHaveProperty('chat')
    })

    it('are never overwritten', () => {
      const { local, store } = setup(newer)
      store().getState().setVolume('music', 90, 10)
      expect(stored(local)).toEqual(newer)
    })

    it('fall back to the defaults when unreadable', () => {
      expect(readNewerAudioSettings({ volumes: { master: 'x' } })).toBeNull()
      const { store } = setup({ state: { nope: 1 }, version: 9 })
      expect(store().getState().volumes).toEqual(audioJson.defaults)
    })
  })

  it('ignores an unknown older format', () => {
    const { store, records } = setup({ state: { volumes: {} }, version: 0 })
    expect(store().getState().volumes).toEqual(audioJson.defaults)
    expect(records.some((r) => r.level === 'info' && /older format/.test(r.msg))).toBe(true)
  })
})
