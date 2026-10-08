/**
 * The player's volumes on this device (S05b), persisted to localStorage under `cloutcity:audio`.
 * S18c syncs them to the account: the newer `updatedAt` wins.
 *
 * "My own music" is not stored here. Its single source of truth is the welcome card's sound
 * choice in the onboarding store (`audioChoice: 'own'`), changed only through
 * src/lib/audio/controls.ts, so nothing else can override the player's choice.
 *
 * Stored data is untrusted: it is validated on load and replaced by the defaults if it does not
 * fit. Volumes written by a newer build are read loosely and respected but never overwritten.
 * Like the other stores, it hydrates synchronously when this module loads in a browser.
 */
import { persist, type PersistStorage } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import * as z from 'zod/mini'
import { MIXER_CHANNELS, type MixerChannel } from '@/lib/audio/channels'
import { audioConfig } from '@/lib/audio/config'
import { clampVolume, VOLUME_MAX, VOLUME_MIN, type Volumes } from '@/lib/audio/mixer'
import type { AudioConfig } from '@/lib/data/schemas/config'
import { log, type Logger } from '@/lib/log'
import { browserLocalStorage, createSafeJsonStorage, guardNewerVersion } from './storage'

export const AUDIO_SETTINGS_KEY = 'cloutcity:audio'
export const AUDIO_SETTINGS_VERSION = 1

const volume = z.int().check(z.gte(VOLUME_MIN), z.lte(VOLUME_MAX))

const VolumesSchema = z.strictObject({
  master: volume,
  music: volume,
  sfx: volume,
  ambience: volume,
  voice: volume,
})

export const PersistedAudioSettingsSchema = z.strictObject({
  volumes: VolumesSchema,
  /** When the player last changed a volume (epoch ms); 0 for untouched defaults. */
  updatedAt: z.int().check(z.gte(0)),
})
export type PersistedAudioSettings = z.infer<typeof PersistedAudioSettingsSchema>

// A newer build may add channels or fields; these are the ones this build understands.
const NewerSettingsSchema = z.looseObject({
  volumes: z.looseObject({
    master: volume,
    music: volume,
    sfx: volume,
    ambience: volume,
    voice: volume,
  }),
  updatedAt: z.int().check(z.gte(0)),
})

export interface AudioSettingsState extends PersistedAudioSettings {
  /** Sets one volume (snapped to the slider step). No change, no write. */
  setVolume(channel: MixerChannel, value: number, nowMs: number): void
}

function defaultSettings(config: AudioConfig): PersistedAudioSettings {
  return { volumes: { ...config.defaults }, updatedAt: 0 }
}

/** Reads volumes saved by a newer build, keeping only the channels this build knows. */
export function readNewerAudioSettings(persisted: unknown): PersistedAudioSettings | null {
  const result = NewerSettingsSchema.safeParse(persisted)
  if (!result.success) return null
  const volumes = Object.fromEntries(
    MIXER_CHANNELS.map((channel) => [channel, result.data.volumes[channel]]),
  ) as Record<MixerChannel, number>
  return { volumes, updatedAt: result.data.updatedAt }
}

export function createAudioSettingsStore(
  storage: PersistStorage<PersistedAudioSettings>,
  config: AudioConfig = audioConfig,
  logger: Logger = log,
) {
  const defaults = defaultSettings(config)
  return createStore<AudioSettingsState>()(
    persist(
      (set, get) => ({
        ...defaults,
        setVolume: (channel, value, nowMs) => {
          const next = clampVolume(value, config.volumeStep, get().volumes[channel])
          if (next === get().volumes[channel]) return
          const volumes: Volumes = { ...get().volumes, [channel]: next }
          set({ volumes, updatedAt: nowMs })
        },
      }),
      {
        name: AUDIO_SETTINGS_KEY,
        version: AUDIO_SETTINGS_VERSION,
        storage: guardNewerVersion(storage, AUDIO_SETTINGS_VERSION),
        partialize: ({ volumes, updatedAt }): PersistedAudioSettings => ({ volumes, updatedAt }),
        migrate: (persisted, version): PersistedAudioSettings => {
          if (version > AUDIO_SETTINGS_VERSION) {
            logger.info('Reading sound settings saved by a newer build', { version })
            return readNewerAudioSettings(persisted) ?? defaults
          }
          logger.info('Ignoring sound settings in an unknown older format', { version })
          return defaults
        },
        merge: (persisted, current) => {
          if (persisted === undefined || persisted === null) return current
          const result = PersistedAudioSettingsSchema.safeParse(persisted)
          if (!result.success) {
            logger.info('Ignoring sound settings that failed validation; using the defaults')
            return { ...current, ...defaults }
          }
          return { ...current, ...result.data }
        },
      },
    ),
  )
}

export type AudioSettingsStore = ReturnType<typeof createAudioSettingsStore>

export const audioSettingsStore: AudioSettingsStore = createAudioSettingsStore(
  createSafeJsonStorage<PersistedAudioSettings>(browserLocalStorage),
)
