/**
 * Loads the audio runtime once the map is playable (S05b). A plain `import()` (not
 * next/dynamic), so the runtime is its own small lazy chunk outside the shell and outside the
 * 3D chunk. Also the shell's way back in when something failed: `retryAudio()` reloads a
 * runtime chunk that did not arrive, or asks a running runtime to load its music again.
 *
 * The runtime plays the quality tier in use when it starts (S04b, src/state/quality.ts). The 3D
 * map's mount records the device's tier before the map becomes playable, so it is known here;
 * if the quality chunk itself did not load, sound starts on the low tier.
 */
import type { QualityTier } from '@/lib/data/schemas/config'
import { log } from '@/lib/log'
import { audioStatusStore } from '@/state/audioStatus'
import { whenMapPlayable } from '@/state/mapPlayable'

let lastContext: AudioContext | null = null
let musicRetry: (() => void) | null = null

function load(context: AudioContext): void {
  audioStatusStore.setState({ runtimeFailed: false })
  whenMapPlayable()
    .then(() => Promise.all([import('./runtime'), activeTier()]))
    .then(([runtime, tier]) => {
      // A newer context (the old one was closed) took over while this chunk loaded.
      if (context === lastContext) runtime.attach(context, tier)
    })
    .catch((error: unknown) => {
      // Expected when the player goes offline before the chunk arrives: play goes on silently
      // and the sound control offers a retry.
      log.info('Sound could not start: the audio runtime did not load', {
        error: error instanceof Error ? error.name : String(error),
      })
      if (context === lastContext) audioStatusStore.setState({ runtimeFailed: true })
    })
}

function activeTier(): Promise<QualityTier> {
  return import('@/state/quality').then(
    ({ qualityStore, selectActiveTier }) => selectActiveTier(qualityStore.getState()) ?? 'low',
    () => 'low' as const,
  )
}

export function startRuntimeWhenPlayable(context: AudioContext): void {
  lastContext = context
  load(context)
}

/** Called by the runtime: what a retry does once its music failed. Returns a detach function. */
export function attachMusicRetry(retry: () => void): () => void {
  musicRetry = retry
  return () => {
    if (musicRetry === retry) musicRetry = null
  }
}

/** The sound control's "Tap to retry". */
export function retryAudio(): void {
  if (audioStatusStore.getState().runtimeFailed) {
    if (lastContext !== null) load(lastContext)
    return
  }
  musicRetry?.()
}
