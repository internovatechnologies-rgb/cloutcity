/**
 * data/audio/manifest.json for the audio runtime, typed without zod (AudioManifestSchema
 * validates the file, its files and their hashes in src/lib/data/data.test.ts). Imported only
 * by the lazy runtime, so the manifest stays out of the shell.
 */
import manifestJson from '@data/audio/manifest.json'
import type { SfxId } from './channels'

export interface ClientAudioSource {
  readonly file: string
  readonly type: string
}

export interface ClientAudioTrack {
  readonly id: string
  readonly channel: string
  readonly titleKey?: string
  readonly sources: readonly ClientAudioSource[]
  readonly loop: boolean
  readonly loopStartMs?: number
  readonly loopEndMs?: number
  readonly gainDb: number
}

export interface ClientAudioManifest {
  readonly tracks: readonly ClientAudioTrack[]
  readonly playlists: { readonly music: readonly string[]; readonly ambience: readonly string[] }
  readonly sfx: Readonly<Record<SfxId, string>>
}

export const audioManifest: ClientAudioManifest = manifestJson

/** Only our own files under /audio/: no other origin, no streams. */
export const SAME_ORIGIN_AUDIO = /^\/audio\/[a-z0-9/_-]+\.(?:webm|m4a)$/
