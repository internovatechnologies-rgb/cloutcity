import { describe, expect, it } from 'vitest'
import onboardingJson from '@data/config/onboarding.json'
import { engineConfig } from '@/engine/config'
import { createLogger } from '@/lib/log'
import { fakeClockEnv } from '@/lib/testing/fakeClockEnv'
import { isGameClockRunning, startGameClock } from './gameClock'
import { createOnboardingStore, type PersistedOnboarding } from './onboarding'
import { createSafeJsonStorage } from './storage'
import { createGameStore, type PersistedState } from './store'

const START = engineConfig.time.startMinuteOfDay
const T0 = Date.UTC(2026, 9, 7, 12)
const adult = { consentVersion: onboardingJson.consentVersion, audioChoice: 'ours' } as const

function setup() {
  const logger = createLogger({ level: 'error', sink: () => {} })
  const game = createGameStore(
    createSafeJsonStorage<PersistedState>(() => undefined, logger),
    logger,
  )
  const onboarding = createOnboardingStore(
    createSafeJsonStorage<PersistedOnboarding>(() => undefined, logger),
    onboardingJson,
    logger,
  )
  const fake = fakeClockEnv()
  return { game, onboarding, fake, minute: () => game.getState().clock.minute }
}

describe('startGameClock (S05)', () => {
  it('runs passive time once the welcome card is complete', () => {
    const { game, onboarding, fake, minute } = setup()
    onboarding.getState().completeAdult(adult, T0)
    const stop = startGameClock({ game, onboarding, env: fake.env })
    expect(isGameClockRunning(game)).toBe(true)
    fake.run(60_000)
    expect(minute()).toBe(START + 10)
    stop()
    expect(isGameClockRunning(game)).toBe(false)
    expect(fake.running).toBe(false)
  })

  it('waits behind the welcome card and starts when it is completed', () => {
    const { game, onboarding, fake, minute } = setup()
    const stop = startGameClock({ game, onboarding, env: fake.env })
    expect(fake.running).toBe(false)
    fake.run(60_000)
    expect(minute()).toBe(START)
    onboarding.getState().completeAdult(adult, T0)
    expect(fake.running).toBe(true)
    fake.run(6000)
    expect(minute()).toBe(START + 1)
    stop()
  })

  it('never runs for an under-age lock', () => {
    const { game, onboarding, fake, minute } = setup()
    onboarding.getState().refuseUnderAge(T0)
    const stop = startGameClock({ game, onboarding, env: fake.env })
    fake.run(60_000)
    expect(fake.running).toBe(false)
    expect(minute()).toBe(START)
    stop()
  })

  it('runs one driver however many callers start it (StrictMode mounts effects twice)', () => {
    const { game, onboarding, fake, minute } = setup()
    onboarding.getState().completeAdult(adult, T0)
    const first = startGameClock({ game, onboarding, env: fake.env })
    first()
    const second = startGameClock({ game, onboarding, env: fake.env })
    const third = startGameClock({ game, onboarding, env: fake.env })
    fake.run(60_000)
    // Two drivers on one store would count every second twice.
    expect(minute()).toBe(START + 10)
    second()
    expect(isGameClockRunning(game)).toBe(true)
    third()
    expect(isGameClockRunning(game)).toBe(false)
  })

  it('disposing twice, or before the card is completed, is harmless', () => {
    const { game, onboarding, fake } = setup()
    const stop = startGameClock({ game, onboarding, env: fake.env })
    stop()
    stop()
    onboarding.getState().completeAdult(adult, T0)
    expect(fake.running).toBe(false)
    expect(isGameClockRunning(game)).toBe(false)
  })

  it('raises no store change on the ticks inside a game minute (Q9)', () => {
    const { game, onboarding, fake } = setup()
    onboarding.getState().completeAdult(adult, T0)
    let changes = 0
    game.subscribe(() => (changes += 1))
    const stop = startGameClock({ game, onboarding, env: fake.env })
    fake.run(5000)
    expect(changes).toBe(0)
    fake.run(1000)
    expect(changes).toBe(1)
    stop()
  })
})
