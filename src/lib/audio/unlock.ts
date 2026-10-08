/**
 * Unlocks audio from a deliberate tap (GR-13). The only place an AudioContext is created
 * (src/lib/audio/no-override.test.ts enforces it), and only from the welcome card's submit or a
 * tap on the sound control or the sound settings, never on load and never from any other
 * gesture: Chrome resumes a context on any later gesture, so one must not exist before the tap.
 *
 * Call it synchronously inside the event handler, before anything async: Safari only lets a
 * context start inside the gesture. One context per page, replaced only if it was closed.
 */
import { log, type Logger } from '@/lib/log'
import { audioStatusStore, type AudioStatusStore } from '@/state/audioStatus'
import type { AudioStatus } from './mixer'
import { startRuntimeWhenPlayable } from './loadRuntime'

/**
 * W3C Audio Session (Safari 16.4+; MDN marks it experimental), not yet in TypeScript's DOM lib.
 * Only the member used here is declared.
 */
interface AudioSessionLike {
  type: string
}

export interface UnlockEnvironment {
  readonly AudioContext: typeof AudioContext | undefined
  readonly navigator: Navigator | undefined
}

export interface AudioUnlockerDeps {
  readonly env: () => UnlockEnvironment
  readonly status: AudioStatusStore
  readonly startRuntime: (context: AudioContext) => void
  readonly logger: Logger
}

const CONTEXT_STATUS: Readonly<Record<string, AudioStatus>> = {
  running: 'running',
  suspended: 'suspended',
  // iOS: a phone call, Siri or another app's exclusive audio took over.
  interrupted: 'interrupted',
  closed: 'suspended',
}

/**
 * 'ambient' mixes with the player's own music app instead of pausing it, and leaves our sounds
 * out of the lock screen and Control Center. Set before the context exists. Never 'playback'
 * (interrupts other apps) or 'transient'/'transient-solo' (WebKit bug 264473: no sound on iOS 18).
 */
export function setMixingSession(navigatorRef: Navigator | undefined, logger: Logger): void {
  if (navigatorRef === undefined || !('audioSession' in navigatorRef)) return
  try {
    ;(navigatorRef as Navigator & { audioSession: AudioSessionLike }).audioSession.type = 'ambient'
  } catch (error) {
    logger.info('The browser refused the mixing audio session', {
      error: error instanceof Error ? error.name : String(error),
    })
  }
}

export function createAudioUnlocker({ env, status, startRuntime, logger }: AudioUnlockerDeps) {
  let context: AudioContext | null = null

  const mirrorState = (target: AudioContext) => {
    status.setState({ status: CONTEXT_STATUS[target.state] ?? 'suspended' })
  }

  /**
   * Creates (once) or resumes the audio context. Returns it, or null when this browser has no
   * Web Audio (the sound control then says so).
   */
  return function unlockAudioFromGesture(): AudioContext | null {
    // A closed context can never resume (the browser or the OS shut it): start a fresh one,
    // still synchronously inside this tap, and the runtime moves over to it.
    if (context?.state === 'closed') {
      context.onstatechange = null
      context = null
    }
    if (context === null) {
      const { AudioContext: Context, navigator: navigatorRef } = env()
      if (typeof Context !== 'function') {
        status.setState({ status: 'unsupported' })
        logger.info('Sound is unavailable: this browser has no Web Audio')
        return null
      }
      setMixingSession(navigatorRef, logger)
      try {
        context = new Context({ latencyHint: 'interactive' })
      } catch (error) {
        status.setState({ status: 'unsupported' })
        logger.info('Sound is unavailable: the audio context could not start', {
          error: error instanceof Error ? error.name : String(error),
        })
        return null
      }
      const created = context
      created.onstatechange = () => mirrorState(created)
      startRuntime(created)
    }
    const current = context
    if (current.state === 'running') {
      mirrorState(current)
      return current
    }
    status.setState({ status: 'starting' })
    // Still inside the gesture: no await before this call.
    current.resume().then(
      () => mirrorState(current),
      (error: unknown) => {
        mirrorState(current)
        logger.info('The browser kept sound paused', {
          error: error instanceof Error ? error.name : String(error),
        })
      },
    )
    return current
  }
}

const browserEnvironment = (): UnlockEnvironment =>
  typeof window === 'undefined'
    ? { AudioContext: undefined, navigator: undefined }
    : { AudioContext: window.AudioContext, navigator: window.navigator }

/** Unlocks audio for this page. See {@link createAudioUnlocker}. */
export const unlockAudioFromGesture: () => AudioContext | null = createAudioUnlocker({
  env: browserEnvironment,
  status: audioStatusStore,
  startRuntime: startRuntimeWhenPlayable,
  logger: log,
})
