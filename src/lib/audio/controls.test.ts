import { describe, expect, it } from 'vitest'
import onboardingJson from '@data/config/onboarding.json'
import { createLogger } from '@/lib/log'
import { createOnboardingStore, type PersistedOnboarding } from '@/state/onboarding'
import { createSafeJsonStorage } from '@/state/storage'
import { isOwnMusic, setOwnMusic, toggleOwnMusic } from './controls'

const silent = createLogger({ level: 'error', sink: () => undefined })

function onboarding() {
  const storage = createSafeJsonStorage<PersistedOnboarding>(() => undefined, silent)
  return createOnboardingStore(storage, onboardingJson, silent)
}

const complete = (store: ReturnType<typeof onboarding>, audioChoice: 'ours' | 'own') =>
  store.getState().completeAdult({ consentVersion: '2026-10-06', audioChoice }, 1_000)

describe('"My own music" controls', () => {
  it('toggleOwnMusic round-trips through setAudioChoice', () => {
    const store = onboarding()
    complete(store, 'ours')
    expect(toggleOwnMusic(store)).toBe(true)
    expect(store.getState().record).toMatchObject({ audioChoice: 'own' })
    expect(isOwnMusic(store.getState().record)).toBe(true)
    expect(toggleOwnMusic(store)).toBe(false)
    expect(store.getState().record).toMatchObject({ audioChoice: 'ours' })
  })

  it('does nothing before the welcome card is complete', () => {
    const store = onboarding()
    expect(toggleOwnMusic(store)).toBe(false)
    expect(store.getState().record).toBeNull()
    store.getState().refuseUnderAge(1_000)
    expect(toggleOwnMusic(store)).toBe(false)
    expect(store.getState().record).toMatchObject({ status: 'locked' })
    expect(isOwnMusic(store.getState().record)).toBe(false)
  })

  it('setOwnMusic sets an exact value and is idempotent', () => {
    const store = onboarding()
    complete(store, 'own')
    expect(setOwnMusic(true, store)).toBe(true)
    expect(store.getState().record).toMatchObject({ audioChoice: 'own' })
    expect(setOwnMusic(false, store)).toBe(false)
    expect(setOwnMusic(false, store)).toBe(false)
    expect(store.getState().record).toMatchObject({ audioChoice: 'ours' })
  })

  it('keeps the rest of the record untouched', () => {
    const store = onboarding()
    complete(store, 'ours')
    const before = store.getState().record
    toggleOwnMusic(store)
    expect({ ...store.getState().record, audioChoice: 'ours' }).toEqual(before)
  })
})
