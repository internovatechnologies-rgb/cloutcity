/**
 * data/config/audio.json for client code, typed without zod (the shell stays off classic zod).
 * AudioConfigSchema validates the file in src/lib/data/data.test.ts.
 */
import audioJson from '@data/config/audio.json'
import type { AudioConfig, QualityTier } from '@/lib/data/schemas/config'

export const audioConfig: AudioConfig = audioJson

export type AudioTier = QualityTier
