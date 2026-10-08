/**
 * The quality tier on this device (S04b), persisted to localStorage under `cloutcity:quality`.
 *
 * Only the settings choice (`override`) is stored. The picked tier, the data-saver request and
 * the runtime step-downs are session state: the picker runs again on every load, and step-downs
 * start over (a slow moment should not cost the player detail forever).
 *
 * Stored data is untrusted: it is validated on load and replaced by the default (automatic) if it
 * does not fit. A choice written by a newer build is read loosely and respected but never
 * overwritten. Like the other stores, it hydrates synchronously when this module loads in a
 * browser, and storage problems never throw (src/state/storage.ts).
 */
import { useSyncExternalStore } from 'react'
import { persist, type PersistStorage } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import * as z from 'zod/mini'
import type { QualityTier } from '@/lib/data/schemas/config'
import { resolveActive } from '@/lib/quality/stepDown'
import { TIER_ORDER, type TierPick, type TierReason } from '@/lib/quality/tier'
import { log, type Logger } from '@/lib/log'
import { browserLocalStorage, createSafeJsonStorage, guardNewerVersion } from './storage'

export const QUALITY_KEY = 'cloutcity:quality'
export const QUALITY_VERSION = 1

const OverrideSchema = z.nullable(z.enum(TIER_ORDER))

export const PersistedQualitySchema = z.strictObject({
  /** The tier chosen in settings, or null for automatic. */
  override: OverrideSchema,
})
export type PersistedQuality = z.infer<typeof PersistedQualitySchema>

// A newer build may add fields; `override` is the one this build understands.
const NewerQualitySchema = z.looseObject({ override: OverrideSchema })

const DEFAULTS: PersistedQuality = { override: null }

export interface QualityState extends PersistedQuality {
  /** The picker's tier for this device, or null before the shell has probed it. */
  readonly auto: QualityTier | null
  readonly autoReasons: readonly TierReason[]
  /** A Save-Data or prefers-reduced-data request: forces low. */
  readonly dataSaver: boolean
  /** Runtime step-downs this session. */
  readonly steps: number
  readonly lastStepAtMs: number | null
  /** Records the picker's result. Step-downs are kept: they describe this session's frame rate. */
  setDetected(pick: TierPick, dataSaver: boolean): void
  /** The settings choice; null returns to automatic. No change, no write. */
  setOverride(override: QualityTier | null): void
  /** Records one runtime step-down (the caller has checked it with stepDecision). */
  recordStepDown(nowMs: number): void
}

/** Reads a choice saved by a newer build, or null when it is not one this build understands. */
export function readNewerQuality(persisted: unknown): PersistedQuality | null {
  const result = NewerQualitySchema.safeParse(persisted)
  return result.success ? { override: result.data.override } : null
}

/** The tier in use, or null before the shell has probed the device. */
export function selectActiveTier(state: QualityState): QualityTier | null {
  if (state.auto === null) return null
  return resolveActive({
    auto: state.auto,
    steps: state.steps,
    override: state.override,
    dataSaver: state.dataSaver,
  })
}

export function createQualityStore(
  storage: PersistStorage<PersistedQuality>,
  logger: Logger = log,
) {
  return createStore<QualityState>()(
    persist(
      (set, get) => ({
        ...DEFAULTS,
        auto: null,
        autoReasons: [],
        dataSaver: false,
        steps: 0,
        lastStepAtMs: null,
        setDetected: (pick, dataSaver) =>
          set({ auto: pick.tier, autoReasons: pick.reasons, dataSaver }),
        setOverride: (override) => {
          if (override === get().override) return
          set({ override })
        },
        recordStepDown: (nowMs) => set({ steps: get().steps + 1, lastStepAtMs: nowMs }),
      }),
      {
        name: QUALITY_KEY,
        version: QUALITY_VERSION,
        storage: guardNewerVersion(storage, QUALITY_VERSION),
        partialize: ({ override }): PersistedQuality => ({ override }),
        migrate: (persisted, version): PersistedQuality => {
          if (version > QUALITY_VERSION) {
            logger.info('Reading graphics settings saved by a newer build', { version })
            return readNewerQuality(persisted) ?? DEFAULTS
          }
          logger.info('Ignoring graphics settings in an unknown older format', { version })
          return DEFAULTS
        },
        merge: (persisted, current) => {
          if (persisted === undefined || persisted === null) return current
          const result = PersistedQualitySchema.safeParse(persisted)
          if (!result.success) {
            logger.info('Ignoring graphics settings that failed validation; using automatic')
            return { ...current, ...DEFAULTS }
          }
          return { ...current, ...result.data }
        },
      },
    ),
  )
}

export type QualityStore = ReturnType<typeof createQualityStore>

export const qualityStore: QualityStore = createQualityStore(
  createSafeJsonStorage<PersistedQuality>(browserLocalStorage),
)

const qualityNow = () => qualityStore.getState()
const qualityAtStart = () => qualityStore.getInitialState()
const activeNow = () => selectActiveTier(qualityStore.getState())
const serverActive = () => null

/** The whole quality state (the settings sheet). */
export function useQualityState(): QualityState {
  return useSyncExternalStore(qualityStore.subscribe, qualityNow, qualityAtStart)
}

/** The tier in use, or null before the shell has probed the device (and on the server). */
export function useActiveTier(): QualityTier | null {
  return useSyncExternalStore(qualityStore.subscribe, activeNow, serverActive)
}
