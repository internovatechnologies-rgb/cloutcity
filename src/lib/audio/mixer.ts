/**
 * The audio mixer's state, as pure functions (S05b). Volumes are what the player sets on the
 * sliders (whole percent, 0-100, multiples of `audio.volumeStep`); gains are what the Web Audio
 * graph applies. Nothing here touches Web Audio, storage or the clock.
 */
import { MIXER_CHANNELS, type MixerChannel } from './channels'

export type Volumes = Readonly<Record<MixerChannel, number>>
export type Gains = Readonly<Record<MixerChannel, number>>

export const VOLUME_MIN = 0
export const VOLUME_MAX = 100

/**
 * A slider value made safe to store: snapped to the nearest step and clamped to 0-100. Anything
 * that is not a finite number (NaN from a bad input, a corrupt save) becomes `fallback`.
 */
export function clampVolume(value: number, step: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const snapped = Math.round(value / step) * step
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, snapped))
}

/**
 * Slider position to linear gain. Loudness is perceived roughly logarithmically, so a squared
 * curve makes the middle of the slider sound like the middle: 0 → 0, 50 → 0.25, 100 → 1.
 */
export function sliderToGain(volume: number): number {
  const clamped = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume))
  return (clamped / VOLUME_MAX) ** 2
}

export interface MixerInput {
  readonly volumes: Volumes
  /** "My own music": our music is muted, every other channel keeps playing. */
  readonly ownMusic: boolean
  /** False until the player's deliberate tap (GR-13): nothing is heard before it. */
  readonly unlocked: boolean
}

/**
 * The gain of each node in the graph. Toggling `ownMusic` changes only `music`; nothing else in
 * the mix depends on it.
 */
export function mixerGains({ volumes, ownMusic, unlocked }: MixerInput): Gains {
  const gains = Object.fromEntries(
    MIXER_CHANNELS.map((channel) => [channel, sliderToGain(volumes[channel])]),
  ) as Record<MixerChannel, number>
  if (!unlocked) gains.master = 0
  if (ownMusic) gains.music = 0
  return gains
}

/** Where the audio context is (src/state/audioStatus.ts). */
export const AUDIO_STATUSES = [
  'locked',
  'starting',
  'running',
  'suspended',
  'interrupted',
  'unsupported',
] as const
export type AudioStatus = (typeof AUDIO_STATUSES)[number]

export type NowPlaying =
  /** No sound yet, or the browser suspended it: the next tap on the sound control resumes. */
  | { readonly kind: 'locked' }
  /** This browser has no Web Audio. */
  | { readonly kind: 'unsupported' }
  /** The master volume is at 0. */
  | { readonly kind: 'off' }
  /** "My own music" is on. */
  | { readonly kind: 'own' }
  /** Sound or our music failed to load; the next tap on the sound control retries. */
  | { readonly kind: 'unavailable'; readonly what: 'sound' | 'music' }
  /** Our music is on but no track has started yet. */
  | { readonly kind: 'loading' }
  | { readonly kind: 'track'; readonly trackId: string }

export interface NowPlayingInput {
  readonly status: AudioStatus
  readonly ownMusic: boolean
  /** The master slider, or null while it is unknown (the runtime has not loaded yet). */
  readonly masterVolume: number | null
  readonly musicTrackId: string | null
  /** No music track could be loaded (src/state/audioStatus.ts). */
  readonly musicFailed?: boolean
  /** The audio runtime did not load after the tap. */
  readonly runtimeFailed?: boolean
}

/** What the sound control says. */
export function nowPlaying({
  status,
  ownMusic,
  masterVolume,
  musicTrackId,
  musicFailed = false,
  runtimeFailed = false,
}: NowPlayingInput): NowPlaying {
  if (status === 'unsupported') return { kind: 'unsupported' }
  if (status === 'locked' || status === 'suspended' || status === 'interrupted') {
    return { kind: 'locked' }
  }
  if (runtimeFailed) return { kind: 'unavailable', what: 'sound' }
  if (masterVolume !== null && masterVolume <= VOLUME_MIN) return { kind: 'off' }
  if (ownMusic) return { kind: 'own' }
  if (musicFailed) return { kind: 'unavailable', what: 'music' }
  if (musicTrackId === null) return { kind: 'loading' }
  return { kind: 'track', trackId: musicTrackId }
}
