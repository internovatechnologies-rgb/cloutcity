/**
 * The welcome card's outcome on this device (S05a), persisted to localStorage under
 * `cloutcity:onboarding`, separate from the game save so a corrupt or reset save never brings
 * the card back (and the card never touches the save).
 *
 * Two records exist:
 *  - `complete`: an 18+ attestation (boolean and timestamp), the consent version and when it was
 *    given, and the sound choice. The birth year is never stored, logged or sent.
 *  - `locked`: an under-age answer locks the gate until `lockedUntil` (CLAUDE.md "Age").
 *
 * Stored data is untrusted: it is validated on load and ignored (the card shows) if it does not
 * fit. A record written by a newer build is read loosely and respected (complete skips the card,
 * a lock holds) but never overwritten. Like the game store, it hydrates synchronously when this
 * module loads in a browser, so components must read it after mount.
 */
import onboardingJson from '@data/config/onboarding.json'
import { persist, type PersistStorage } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import * as z from 'zod/mini'
import { isLocked, lockUntil, type AgeGateConfig } from '@/engine/ageGate'
import type { OnboardingConfig } from '@/lib/data/schemas/config'
import { AUDIO_CHOICES, type AudioChoice } from '@/lib/forms/welcome'
import { log, type Logger } from '@/lib/log'
import { browserLocalStorage, createSafeJsonStorage, guardNewerVersion } from './storage'

export const ONBOARDING_KEY = 'cloutcity:onboarding'
export const ONBOARDING_VERSION = 1

/** data/config/onboarding.json, validated by OnboardingConfigSchema in src/lib/data/data.test.ts. */
export const onboardingConfig: OnboardingConfig = onboardingJson

const timestamp = z.int().check(z.gte(0))

const CompleteRecordSchema = z.strictObject({
  status: z.literal('complete'),
  attested: z.literal(true),
  attestedAt: timestamp,
  consentVersion: z.string().check(z.minLength(1)),
  consentedAt: timestamp,
  audioChoice: z.enum(AUDIO_CHOICES),
})

const LockedRecordSchema = z.strictObject({
  status: z.literal('locked'),
  lockedUntil: timestamp,
})

export const OnboardingRecordSchema = z.discriminatedUnion('status', [
  CompleteRecordSchema,
  LockedRecordSchema,
])
export type OnboardingRecord = z.infer<typeof OnboardingRecordSchema>

export const PersistedOnboardingSchema = z.strictObject({
  record: z.nullable(OnboardingRecordSchema),
})
export type PersistedOnboarding = z.infer<typeof PersistedOnboardingSchema>

// A newer build may add fields; these are the ones this build understands.
const NewerCompleteSchema = z.looseObject({
  status: z.literal('complete'),
  attested: z.literal(true),
  attestedAt: timestamp,
  consentVersion: z.string().check(z.minLength(1)),
  consentedAt: timestamp,
  audioChoice: z.enum(AUDIO_CHOICES),
})
const NewerLockedSchema = z.looseObject({ status: z.literal('locked'), lockedUntil: timestamp })
const NewerEnvelopeSchema = z.looseObject({ record: z.unknown() })

export interface OnboardingActions {
  /**
   * Records a passing 18+ attestation and consent. Returns false (and changes nothing) while an
   * under-age lock holds: a lock is never weakened.
   */
  completeAdult(
    choice: { consentVersion: string; audioChoice: AudioChoice },
    nowMs: number,
  ): boolean
  /** Locks the gate on this device for `underAgeLockHours`. */
  refuseUnderAge(nowMs: number): void
  /** Forgets a lock that has run out, so the card shows again. */
  clearExpiredLock(nowMs: number): void
  /** Changes the stored sound choice of a completed card (S05b). */
  setAudioChoice(choice: AudioChoice): void
}

export interface OnboardingState extends OnboardingActions {
  /**
   * undefined until storage has been read (hydration is synchronous, so only while the store is
   * being created); null when nothing usable is stored.
   */
  readonly record: OnboardingRecord | null | undefined
}

/**
 * Reads a record written by a newer build, keeping only what this build understands. Anything
 * unreadable counts as no record, which shows the card again rather than guessing.
 */
export function readNewerRecord(persisted: unknown): OnboardingRecord | null {
  const envelope = NewerEnvelopeSchema.safeParse(persisted)
  if (!envelope.success) return null
  const complete = NewerCompleteSchema.safeParse(envelope.data.record)
  if (complete.success) {
    const { status, attested, attestedAt, consentVersion, consentedAt, audioChoice } = complete.data
    return { status, attested, attestedAt, consentVersion, consentedAt, audioChoice }
  }
  const locked = NewerLockedSchema.safeParse(envelope.data.record)
  if (locked.success) return { status: locked.data.status, lockedUntil: locked.data.lockedUntil }
  return null
}

export function createOnboardingStore(
  storage: PersistStorage<PersistedOnboarding>,
  config: AgeGateConfig = onboardingConfig,
  logger: Logger = log,
) {
  return createStore<OnboardingState>()(
    persist(
      (set, get) => ({
        record: undefined,
        completeAdult: ({ consentVersion, audioChoice }, nowMs) => {
          const { record } = get()
          if (record?.status === 'locked' && isLocked(record.lockedUntil, nowMs)) return false
          set({
            record: {
              status: 'complete',
              attested: true,
              attestedAt: nowMs,
              consentVersion,
              consentedAt: nowMs,
              audioChoice,
            },
          })
          return true
        },
        refuseUnderAge: (nowMs) => {
          set({ record: { status: 'locked', lockedUntil: lockUntil(nowMs, config) } })
        },
        clearExpiredLock: (nowMs) => {
          const { record } = get()
          if (record?.status === 'locked' && !isLocked(record.lockedUntil, nowMs)) {
            set({ record: null })
          }
        },
        setAudioChoice: (audioChoice) => {
          const { record } = get()
          if (record?.status === 'complete') set({ record: { ...record, audioChoice } })
        },
      }),
      {
        name: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        storage: guardNewerVersion(storage, ONBOARDING_VERSION),
        partialize: ({ record }): PersistedOnboarding => ({ record: record ?? null }),
        migrate: (persisted, version): PersistedOnboarding => {
          if (version > ONBOARDING_VERSION) {
            logger.info('Reading welcome-card answers saved by a newer build', { version })
            return { record: readNewerRecord(persisted) }
          }
          logger.info('Ignoring welcome-card answers in an unknown older format', { version })
          return { record: null }
        },
        merge: (persisted, current) => {
          // Reaching merge means storage was read: from here on `record` is never undefined.
          if (persisted === undefined || persisted === null) return { ...current, record: null }
          const result = PersistedOnboardingSchema.safeParse(persisted)
          if (!result.success) {
            logger.info('Ignoring welcome-card answers that failed validation')
            return { ...current, record: null }
          }
          return { ...current, record: result.data.record }
        },
      },
    ),
  )
}

export type OnboardingStore = ReturnType<typeof createOnboardingStore>

export const onboardingStore: OnboardingStore = createOnboardingStore(
  createSafeJsonStorage<PersistedOnboarding>(browserLocalStorage),
)
