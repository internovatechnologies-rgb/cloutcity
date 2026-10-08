/**
 * Sound effects for every feature (S05b; S10a purchases and S13 clout gains call it). Part of
 * the shell and tiny: until the audio runtime has loaded (after the player's sound choice and a
 * playable map), `playSfx` does nothing, so callers never need to know whether sound is on.
 */
import { SFX_IDS, type SfxId } from './channels'

export { SFX_IDS, type SfxId }

type SfxPlayer = (id: SfxId) => void

let player: SfxPlayer | null = null

/** Plays a one-shot sound effect on the sfx channel, if audio is running. */
export function playSfx(id: SfxId): void {
  player?.(id)
}

/** Called by the audio runtime once it is attached. Returns a detach function. */
export function attachSfxPlayer(next: SfxPlayer): () => void {
  player = next
  return () => {
    if (player === next) player = null
  }
}
