/**
 * The only writer of "My own music" (S05b). The choice is the welcome card's sound answer in the
 * onboarding store, so it is remembered per device with the rest of the card and nothing else
 * can override it (src/lib/audio/no-override.test.ts enforces that).
 */
import { onboardingStore, type OnboardingRecord, type OnboardingStore } from '@/state/onboarding'

/** True when this device's completed welcome card says "I'll bring my own". */
export function isOwnMusic(record: OnboardingRecord | null | undefined): boolean {
  return record?.status === 'complete' && record.audioChoice === 'own'
}

/**
 * Flips "My own music" and returns the new value. Does nothing (and returns false) before the
 * welcome card is complete: there is no choice to change yet.
 */
export function toggleOwnMusic(store: OnboardingStore = onboardingStore): boolean {
  const { record, setAudioChoice } = store.getState()
  if (record?.status !== 'complete') return false
  const next = !isOwnMusic(record)
  setAudioChoice(next ? 'own' : 'ours')
  return next
}

/** Sets "My own music" to `on` (the settings checkbox). */
export function setOwnMusic(on: boolean, store: OnboardingStore = onboardingStore): boolean {
  if (isOwnMusic(store.getState().record) !== on) return toggleOwnMusic(store)
  return on
}
