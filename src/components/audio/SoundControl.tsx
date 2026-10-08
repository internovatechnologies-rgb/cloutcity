'use client'

/**
 * The HUD sound control (S05b). One tap toggles "My own music" (our music mutes; sound effects
 * and city sounds keep playing), and the second line says what is playing. Before audio is
 * unlocked it reads "Tap for sound" with the remembered choice, and that first tap only turns
 * sound on (GR-13). If music (or the whole runtime) failed to load, it says so and a tap retries.
 * The sound settings open from the HUD's More panel at every width (S06: More replaced the gear
 * that wide screens had).
 *
 * A boot island (SoundControlMount): it and the zod-backed stores it reads load in their own
 * chunk right after the shell (DEC-11).
 */
import { useSyncExternalStore } from 'react'
import { copy, isCopyKey } from '@/lib/copy'
import { isOwnMusic, toggleOwnMusic } from '@/lib/audio/controls'
import { nowPlaying, type NowPlaying } from '@/lib/audio/mixer'
import { playSfx } from '@/lib/audio/sfx'
import { retryAudio } from '@/lib/audio/loadRuntime'
import { unlockAudioFromGesture } from '@/lib/audio/unlock'
import { INITIAL_AUDIO_STATUS, audioStatusStore } from '@/state/audioStatus'
import { onboardingStore } from '@/state/onboarding'
import '@/lib/copy/ns/audio'

const LINE_2_ID = 'sound-control-now-playing'

const ownMusicNow = () => isOwnMusic(onboardingStore.getState().record)
const statusNow = () => audioStatusStore.getState()
const never = () => false
const initialStatus = () => INITIAL_AUDIO_STATUS

function secondLine(view: NowPlaying, ownMusic: boolean, titleKey: string | null): string {
  switch (view.kind) {
    case 'locked':
      return copy(ownMusic ? 'audio.hud.yourMusic' : 'audio.hud.modeOurs')
    case 'unsupported':
    case 'unavailable':
      return ''
    case 'off':
      return copy('audio.hud.off')
    case 'own':
      return copy('audio.hud.yourMusic')
    case 'loading':
      return copy('audio.hud.loading')
    case 'track':
      return titleKey !== null && isCopyKey(titleKey)
        ? copy('audio.hud.track', { title: copy(titleKey) })
        : copy('audio.hud.loading')
  }
}

const BUTTON =
  'flex min-h-11 min-w-11 items-center rounded-full border border-line bg-raised text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60'

export function SoundControl() {
  const ownMusic = useSyncExternalStore(onboardingStore.subscribe, ownMusicNow, never)
  const status = useSyncExternalStore(audioStatusStore.subscribe, statusNow, initialStatus)

  const view = nowPlaying({
    status: status.status,
    ownMusic,
    masterVolume: status.masterVolume,
    musicTrackId: status.musicTrackId,
    musicFailed: status.musicFailed,
    runtimeFailed: status.runtimeFailed,
  })
  const line2 = secondLine(view, ownMusic, status.musicTitleKey)

  const onMain = () => {
    // Synchronous, inside the tap: the first tap only turns sound on.
    if (view.kind === 'locked') {
      unlockAudioFromGesture()
      return
    }
    if (view.kind === 'unavailable') {
      retryAudio()
      return
    }
    toggleOwnMusic()
    playSfx('ui-tap')
  }

  const unavailableText =
    view.kind === 'unavailable'
      ? copy(view.what === 'music' ? 'audio.hud.musicUnavailable' : 'audio.hud.soundUnavailable')
      : ''
  const main =
    view.kind === 'unsupported'
      ? { 'aria-label': copy('audio.hud.unsupported'), disabled: true }
      : view.kind === 'unavailable'
        ? {}
        : view.kind === 'locked'
          ? { 'aria-label': copy('audio.hud.turnOn'), 'aria-describedby': LINE_2_ID }
          : {
              'aria-label': copy('audio.hud.ownMusic'),
              'aria-pressed': ownMusic,
              'aria-describedby': LINE_2_ID,
            }
  const line1 =
    view.kind === 'unsupported'
      ? copy('audio.hud.unsupported')
      : view.kind === 'unavailable'
        ? unavailableText
        : view.kind === 'locked'
          ? copy('audio.hud.tapForSound')
          : copy('audio.hud.ownMusic')

  return (
    <div
      className="flex min-w-0 shrink items-center gap-1.5"
      data-sound-control={view.kind}
      data-cc-feature="cc-feature:sound-control"
    >
      <button
        type="button"
        onClick={onMain}
        data-sound-main=""
        className={`${BUTTON} max-w-44 min-w-[110px] flex-col items-start justify-center px-3 text-left aria-pressed:border-taxi-ink hud-tiny:min-w-11 hud-tiny:items-center hud-tiny:px-0 ${view.kind === 'locked' ? 'border-taxi' : ''}`}
        {...main}
      >
        {/* A speaker icon only on the narrowest phones (hud-tiny, UI-1), where the two lines
            would push the HUD past the screen edge; the lines stay as the name and description. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="hidden h-5 w-5 fill-none stroke-current stroke-2 hud-tiny:block"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 9h4l5-4v14l-5-4H4V9Zm12 0a4 4 0 0 1 0 6m2.5-9a8 8 0 0 1 0 12" />
        </svg>
        {/* Two visible lines at every other width (S05 restored them on phones, UX-7): what a
            tap does, and what is playing. */}
        <span className="block max-w-full truncate text-xs font-bold hud-tiny:sr-only">
          {line1}
        </span>
        {line2 === '' ? null : (
          <span
            id={LINE_2_ID}
            className="block max-w-full truncate text-[0.6875rem] text-muted hud-tiny:sr-only"
          >
            {line2}
          </span>
        )}
      </button>
    </div>
  )
}
