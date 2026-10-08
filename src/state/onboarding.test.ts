import { describe, expect, it, vi } from 'vitest'
import onboardingJson from '@data/config/onboarding.json'
import { createLogger, type LogRecord } from '@/lib/log'
import {
  ONBOARDING_KEY as SEED_KEY,
  SEED_CONSENT_VERSION,
  completedOnboardingSeed,
} from '../../tests/e2e/fixtures/onboarding-seed'
import {
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  PersistedOnboardingSchema,
  createOnboardingStore,
  readNewerRecord,
  type PersistedOnboarding,
} from './onboarding'
import { createGuestSessionStarter } from './session'
import { createSafeJsonStorage } from './storage'

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
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

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new DOMException('denied', 'SecurityError')
  }
  override setItem(): void {
    throw new DOMException('denied', 'SecurityError')
  }
}

function setup(local: Storage = new MemoryStorage()) {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const storage = createSafeJsonStorage<PersistedOnboarding>(() => local, logger)
  return {
    local,
    records,
    logger,
    store: () => createOnboardingStore(storage, onboardingJson, logger),
  }
}

const saved = (local: Storage) =>
  JSON.parse(local.getItem(ONBOARDING_KEY) ?? 'null') as {
    state: PersistedOnboarding
    version: number
  } | null

const put = (local: Storage, value: unknown) =>
  local.setItem(ONBOARDING_KEY, typeof value === 'string' ? value : JSON.stringify(value))

const T0 = Date.parse('2026-06-15T16:00:00Z')
const DAY = 86_400_000
const adult = { consentVersion: onboardingJson.consentVersion, audioChoice: 'ours' } as const

describe('onboarding store', () => {
  it('starts with no record and writes nothing until the card is answered', () => {
    const { local, store } = setup()
    expect(store().getState().record).toBeNull()
    expect(local.getItem(ONBOARDING_KEY)).toBeNull()
  })

  it('stores the attestation, consent and sound choice, never the birth year', () => {
    const { local, store } = setup()
    expect(store().getState().completeAdult(adult, T0)).toBe(true)
    const value = saved(local)
    expect(value?.version).toBe(ONBOARDING_VERSION)
    expect(value?.state.record).toEqual({
      status: 'complete',
      attested: true,
      attestedAt: T0,
      consentVersion: onboardingJson.consentVersion,
      consentedAt: T0,
      audioChoice: 'ours',
    })
    expect(local.getItem(ONBOARDING_KEY)).not.toMatch(/birth|year/i)
  })

  it('a returning player is still complete after a reload', () => {
    const local = new MemoryStorage()
    setup(local).store().getState().completeAdult(adult, T0)
    expect(setup(local).store().getState().record?.status).toBe('complete')
  })

  it('locks for 24 hours storing only the status and lockedUntil', () => {
    const { local, store } = setup()
    store().getState().refuseUnderAge(T0)
    expect(saved(local)?.state.record).toEqual({ status: 'locked', lockedUntil: T0 + DAY })
  })

  it('a lock is never weakened: completing while locked changes nothing', () => {
    const { local, store } = setup()
    const onboarding = store()
    onboarding.getState().refuseUnderAge(T0)
    expect(onboarding.getState().completeAdult(adult, T0 + DAY - 1)).toBe(false)
    expect(saved(local)?.state.record).toEqual({ status: 'locked', lockedUntil: T0 + DAY })
  })

  it('clears a lock only once it has run out', () => {
    const { local, store } = setup()
    const onboarding = store()
    onboarding.getState().refuseUnderAge(T0)
    onboarding.getState().clearExpiredLock(T0 + DAY - 1)
    expect(onboarding.getState().record?.status).toBe('locked')
    onboarding.getState().clearExpiredLock(T0 - DAY)
    expect(onboarding.getState().record?.status).toBe('locked')
    onboarding.getState().clearExpiredLock(T0 + DAY)
    expect(onboarding.getState().record).toBeNull()
    expect(saved(local)?.state.record).toBeNull()
  })

  it('setAudioChoice changes a completed record only', () => {
    const { store } = setup()
    const onboarding = store()
    onboarding.getState().setAudioChoice('own')
    expect(onboarding.getState().record).toBeNull()
    onboarding.getState().completeAdult(adult, T0)
    onboarding.getState().setAudioChoice('own')
    expect(onboarding.getState().record).toMatchObject({ status: 'complete', audioChoice: 'own' })
  })

  it.each([
    ['not JSON', '{not json'],
    ['the wrong envelope', { nope: 1 }],
    ['an unknown status', { state: { record: { status: 'maybe' } }, version: 1 }],
    [
      'a stored birth year',
      {
        state: { record: { ...completedOnboardingSeed().state.record, birthYear: 1990 } },
        version: 1,
      },
    ],
    [
      'attested false',
      {
        state: { record: { ...completedOnboardingSeed().state.record, attested: false } },
        version: 1,
      },
    ],
    [
      'a fractional lock',
      { state: { record: { status: 'locked', lockedUntil: 1.5 } }, version: 1 },
    ],
  ])('ignores %s (the card shows) and logs at info', (_label, value) => {
    const { local, records, store } = setup()
    put(local, value)
    expect(store().getState().record).toBeNull()
    expect(records.every((record) => record.level === 'info' || record.level === 'debug')).toBe(
      true,
    )
  })

  it('treats an older format as no record', () => {
    const { local, store } = setup()
    put(local, { state: { attested: true }, version: 0 })
    expect(store().getState().record).toBeNull()
  })

  describe('a record from a newer build', () => {
    const newer = (record: unknown) => ({ state: { record, extra: 'x' }, version: 2 })

    it('a complete record skips the card and is never overwritten', () => {
      const { local, store } = setup()
      const value = newer({ ...completedOnboardingSeed().state.record, futureField: 1 })
      put(local, value)
      const onboarding = store()
      expect(onboarding.getState().record?.status).toBe('complete')
      onboarding.getState().setAudioChoice('ours')
      expect(onboarding.getState().record).toMatchObject({ audioChoice: 'ours' })
      expect(JSON.parse(local.getItem(ONBOARDING_KEY) ?? '')).toEqual(value)
    })

    it('a lock holds and is never overwritten', () => {
      const { local, store } = setup()
      const value = newer({ status: 'locked', lockedUntil: T0 + DAY, reason: 'future' })
      put(local, value)
      const onboarding = store()
      expect(onboarding.getState().record).toEqual({ status: 'locked', lockedUntil: T0 + DAY })
      expect(onboarding.getState().completeAdult(adult, T0)).toBe(false)
      onboarding.getState().refuseUnderAge(T0 + 1)
      expect(JSON.parse(local.getItem(ONBOARDING_KEY) ?? '')).toEqual(value)
    })

    it('an unreadable newer record shows the card but is still not overwritten', () => {
      const { local, store } = setup()
      const value = newer({ status: 'something-new' })
      put(local, value)
      const onboarding = store()
      expect(onboarding.getState().record).toBeNull()
      onboarding.getState().completeAdult(adult, T0)
      expect(onboarding.getState().record?.status).toBe('complete')
      expect(JSON.parse(local.getItem(ONBOARDING_KEY) ?? '')).toEqual(value)
    })

    it('readNewerRecord keeps only known fields', () => {
      expect(readNewerRecord({ record: { status: 'locked', lockedUntil: 5, x: 1 } })).toEqual({
        status: 'locked',
        lockedUntil: 5,
      })
      expect(readNewerRecord('nope')).toBeNull()
    })
  })

  it('keeps working in memory when storage throws (the card shows on each load)', () => {
    const { records, store } = setup(new ThrowingStorage())
    const onboarding = store()
    expect(onboarding.getState().record).toBeNull()
    expect(onboarding.getState().completeAdult(adult, T0)).toBe(true)
    expect(onboarding.getState().record?.status).toBe('complete')
    expect(records.some((record) => record.level === 'warn' || record.level === 'error')).toBe(
      false,
    )
  })
})

describe('the e2e onboarding seed', () => {
  it('parses with the real schema, and its key and consent version match the app', () => {
    const seed = completedOnboardingSeed()
    expect(PersistedOnboardingSchema.safeParse(seed.state).success).toBe(true)
    expect(seed.version).toBe(ONBOARDING_VERSION)
    expect(SEED_KEY).toBe(ONBOARDING_KEY)
    expect(SEED_CONSENT_VERSION).toBe(onboardingJson.consentVersion)
  })

  it('loads as a completed card', () => {
    const { local, store } = setup()
    put(local, completedOnboardingSeed())
    expect(store().getState().record?.status).toBe('complete')
  })
})

describe('guest session hook', () => {
  it('refuses without a passing attestation, and after a lock', () => {
    const { logger, store } = setup()
    const onboarding = store()
    const start = createGuestSessionStarter(onboarding, logger)
    expect(start()).toEqual({ mode: 'refused' })
    onboarding.getState().refuseUnderAge(T0)
    expect(start()).toEqual({ mode: 'refused' })
  })

  it('starts once after the attestation and returns the same session after', () => {
    const { logger, records, store } = setup()
    const onboarding = store()
    const info = vi.spyOn(logger, 'info')
    const start = createGuestSessionStarter(onboarding, logger)
    onboarding.getState().completeAdult(adult, T0)
    const first = start()
    expect(first).toEqual({ mode: 'local' })
    expect(start()).toBe(first)
    expect(info.mock.calls.filter(([msg]) => msg === 'Guest session started')).toHaveLength(1)
    expect(JSON.stringify(records)).not.toMatch(/birth/i)
  })
})
