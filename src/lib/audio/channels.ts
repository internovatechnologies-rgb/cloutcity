/**
 * The audio channels (CLAUDE.md "Sound is the player's choice"). Plain constants with no imports,
 * so client code, the classic-zod manifest schema (src/lib/data/schemas/world.ts) and Node
 * scripts can all share them without pulling zod into the shell.
 */

/** Separate channels, each with its own volume, under one master. */
export const AUDIO_CHANNELS = ['music', 'sfx', 'ambience', 'voice'] as const
export type AudioChannel = (typeof AUDIO_CHANNELS)[number]

/** Every volume the player can set: the master plus one per channel. */
export const MIXER_CHANNELS = ['master', ...AUDIO_CHANNELS] as const
export type MixerChannel = (typeof MIXER_CHANNELS)[number]

/** Sound effects other features play by id (S10a purchases, S13 clout). */
export const SFX_IDS = ['ui-tap', 'purchase', 'clout-up'] as const
export type SfxId = (typeof SFX_IDS)[number]

/** Encodings the pipeline ships, in the order the runtime tries them. */
export const AUDIO_SOURCE_TYPES = [
  'audio/webm; codecs=opus',
  'audio/mp4; codecs=mp4a.40.2',
] as const
export type AudioSourceType = (typeof AUDIO_SOURCE_TYPES)[number]
