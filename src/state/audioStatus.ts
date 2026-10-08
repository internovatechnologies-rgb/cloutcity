/**
 * Live audio state for the UI (S05b): where the audio context is and which music track is
 * playing. Not persisted; it starts `locked` on every page load, because audio may only start
 * from a deliberate tap (GR-13).
 */
import { createStore } from 'zustand/vanilla'
import type { AudioStatus } from '@/lib/audio/mixer'

export interface AudioStatusState {
  readonly status: AudioStatus
  /** The music track now audible, or null (none started yet, or "My own music"). */
  readonly musicTrackId: string | null
  /**
   * The copy key of that track's "Title by Artist", so the sound control can name it without the
   * manifest in the shell.
   */
  readonly musicTitleKey: string | null
  /**
   * The master volume, mirrored by the audio runtime so the sound control can say "Sound off"
   * without the settings store in the shell. Null until the runtime has loaded.
   */
  readonly masterVolume: number | null
  /** No music track could be loaded or decoded; a tap on the sound control retries. */
  readonly musicFailed: boolean
  /** The audio runtime chunk did not load after the tap (offline); a tap retries. */
  readonly runtimeFailed: boolean
}

export const INITIAL_AUDIO_STATUS: AudioStatusState = {
  status: 'locked',
  musicTrackId: null,
  musicTitleKey: null,
  masterVolume: null,
  musicFailed: false,
  runtimeFailed: false,
}

export function createAudioStatusStore() {
  return createStore<AudioStatusState>()(() => INITIAL_AUDIO_STATUS)
}

export type AudioStatusStore = ReturnType<typeof createAudioStatusStore>

export const audioStatusStore: AudioStatusStore = createAudioStatusStore()
