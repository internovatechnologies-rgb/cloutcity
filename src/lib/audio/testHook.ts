/**
 * Test-mode hook for the e2e suite: the live mixer on `window.__cloutcityTest.audio`. Only
 * builds with NEXT_PUBLIC_TEST_HOOKS=1 (inlined at build time; the e2e build sets it and writes
 * to its own distDir) install it: the lazy audio runtime imports this module behind that check,
 * so in every other build it is dead code and never ships (scripts/shell-guard.ts checks).
 */
import type { SfxId } from './channels'
import type { Gains } from './mixer'

export interface AudioTestHook {
  contextState(): string
  /** Gain values the graph applies right now. */
  gains(): Gains
  /** Gains the mixer computed from the stores (exact). */
  targetGains(): Gains
  /** Ids of the music and ambience tracks playing, or null. */
  playing(): { music: string | null; ambience: string | null }
  /** How many sound effects have started. */
  sfxStarted(): number
  playSfx(id: SfxId): void
}

declare global {
  /** One property per feature hook (merged with the events and scene hooks' declarations). */
  interface CloutcityTestHooks {
    audio?: AudioTestHook
  }
}

export function installAudioTestHook(hook: AudioTestHook): void {
  if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
  window.__cloutcityTest = { ...window.__cloutcityTest, audio: hook }
}
