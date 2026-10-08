'use client'

/**
 * Settings: sound (S05b) and graphics (S04b).
 * - Sound: "My own music" and one volume per channel plus master, applied live. Opening the
 *   sheet never starts audio; changing a sound setting while sound is still off is a deliberate
 *   tap, so it also turns sound on (GR-13).
 * - Graphics: the quality tier, automatic (the device's detected tier, stepped down at runtime
 *   when the frame rate stays low) or chosen. A choice is remembered (src/state/quality.ts) and
 *   applies at once except antialiasing, which applies next time the game opens. A data-saver
 *   request keeps the low tier, so the higher tiers are disabled with the reason.
 * A non-modal region (a labelled <section>) in the sheet zone; Escape or the close button
 * closes it and focus goes back to the HUD's More button. A feature island: it loads on the
 * first open (SoundSheetMount).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { MIXER_CHANNELS, type MixerChannel } from '@/lib/audio/channels'
import { audioConfig } from '@/lib/audio/config'
import { isOwnMusic, setOwnMusic } from '@/lib/audio/controls'
import { unlockAudioFromGesture } from '@/lib/audio/unlock'
import { copy, type CopyKey } from '@/lib/copy'
import type { QualityTier } from '@/lib/data/schemas/config'
import { formatPercent } from '@/lib/format'
import { TIER_ORDER } from '@/lib/quality/tier'
import { audioSettingsStore } from '@/state/audioSettings'
import { audioStatusStore } from '@/state/audioStatus'
import { onboardingStore } from '@/state/onboarding'
import { qualityStore, useQualityState } from '@/state/quality'
import { SOUND_SETTINGS_SHEET_ID, closeSoundSheet } from './soundSheet'
import '@/lib/copy/ns/audio'
import '@/lib/copy/ns/settings'

const LABEL: Readonly<Record<MixerChannel, CopyKey>> = {
  master: 'audio.settings.master',
  music: 'audio.settings.music',
  sfx: 'audio.settings.sfx',
  ambience: 'audio.settings.ambience',
  voice: 'audio.settings.voice',
}

const TIER_LABEL: Readonly<Record<QualityTier, CopyKey>> = {
  low: 'settings.graphics.low',
  mid: 'settings.graphics.mid',
  high: 'settings.graphics.high',
}

const TITLE_ID = 'sound-settings-title'
const HINT_ID = 'sound-settings-own-music-hint'
const SOUND_ID = 'sound-settings-sound'
const GRAPHICS_NOTE_ID = 'sound-settings-graphics-note'
const DATA_SAVER_ID = 'sound-settings-data-saver'
const AUTO = 'auto'

const volumesNow = () => audioSettingsStore.getState().volumes
const defaultVolumes = () => audioConfig.defaults
const ownMusicNow = () => isOwnMusic(onboardingStore.getState().record)
const never = () => false

/** Turns sound on if it is not running yet; a no-op once it is. */
function unlockIfLocked(): void {
  const { status } = audioStatusStore.getState()
  if (status === 'locked' || status === 'suspended' || status === 'interrupted') {
    unlockAudioFromGesture()
  }
}

const RADIO_CLASS = 'h-6 w-6 shrink-0 accent-taxi-ink'
const OPTION_CLASS = 'flex min-h-11 items-center gap-3 text-base text-fg'

/** The quality tier choice: Auto plus one radio per tier. */
function GraphicsSettings() {
  const quality = useQualityState()
  const choose = (choice: QualityTier | null) => qualityStore.getState().setOverride(choice)
  const autoLabel =
    quality.auto === null
      ? copy('settings.graphics.auto')
      : copy('settings.graphics.autoDetected', { tier: copy(TIER_LABEL[quality.auto]) })
  const describedBy = quality.dataSaver ? `${GRAPHICS_NOTE_ID} ${DATA_SAVER_ID}` : GRAPHICS_NOTE_ID

  return (
    <fieldset aria-describedby={describedBy} className="flex flex-col">
      <legend className="text-base font-extrabold text-fg">
        {copy('settings.graphics.title')}
      </legend>
      <label className={`${OPTION_CLASS} cursor-pointer`}>
        <input
          type="radio"
          name="graphics-tier"
          value={AUTO}
          checked={quality.override === null}
          onChange={() => choose(null)}
          className={RADIO_CLASS}
        />
        {autoLabel}
      </label>
      {TIER_ORDER.map((tier) => {
        // A data-saver request keeps the low tier whatever is chosen (CLAUDE.md "Quality tiers").
        const locked = quality.dataSaver && tier !== 'low'
        const label = copy(TIER_LABEL[tier])
        return (
          <label
            key={tier}
            className={`${OPTION_CLASS} ${locked ? 'cursor-not-allowed text-muted' : 'cursor-pointer'}`}
          >
            <input
              type="radio"
              name="graphics-tier"
              value={tier}
              checked={quality.override === tier}
              disabled={locked}
              aria-label={
                locked ? copy('settings.graphics.lockedDataSaver', { tier: label }) : undefined
              }
              onChange={() => choose(tier)}
              className={RADIO_CLASS}
            />
            {label}
          </label>
        )
      })}
      <p id={GRAPHICS_NOTE_ID} className="text-sm text-muted">
        {copy('settings.graphics.nextTime')}
      </p>
      {quality.dataSaver ? (
        <p id={DATA_SAVER_ID} className="text-sm text-muted">
          {copy('settings.graphics.dataSaver')}
        </p>
      ) : null}
    </fieldset>
  )
}

export function SoundSettingsSheet() {
  const volumes = useSyncExternalStore(audioSettingsStore.subscribe, volumesNow, defaultVolumes)
  const ownMusic = useSyncExternalStore(onboardingStore.subscribe, ownMusicNow, never)
  const region = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    title.current?.focus()
    const element = region.current
    if (element === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeSoundSheet()
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section
      ref={region}
      id={SOUND_SETTINGS_SHEET_ID}
      aria-labelledby={TITLE_ID}
      data-cc-feature="cc-feature:sound-settings"
      className="flex min-h-full flex-col gap-3 rounded-t-3xl border border-line glass p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2
          ref={title}
          id={TITLE_ID}
          tabIndex={-1}
          className="text-lg font-extrabold text-fg focus:outline-none"
        >
          {copy('audio.settings.title')}
        </h2>
        <button
          type="button"
          onClick={closeSoundSheet}
          aria-label={copy('audio.settings.close')}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-xl text-fg focus-visible:outline-2 focus-visible:outline-focus"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <h3 id={SOUND_ID} className="text-base font-extrabold text-fg">
        {copy('audio.settings.sound')}
      </h3>
      <div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base text-fg">
          <input
            type="checkbox"
            checked={ownMusic}
            aria-describedby={HINT_ID}
            onChange={(event) => {
              unlockIfLocked()
              setOwnMusic(event.target.checked)
            }}
            className="h-6 w-6 shrink-0 accent-taxi-ink"
          />
          {copy('audio.settings.ownMusic')}
        </label>
        <p id={HINT_ID} className="text-sm text-muted">
          {copy('audio.settings.ownMusicHint')}
        </p>
      </div>

      {MIXER_CHANNELS.map((channel) => {
        const id = `sound-volume-${channel}`
        return (
          <div key={channel} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-sm text-fg">
              <label htmlFor={id} className="font-semibold">
                {copy(LABEL[channel])}
              </label>
              <output htmlFor={id} className="tabular-nums text-muted">
                {formatPercent(volumes[channel])}
              </output>
            </div>
            <input
              id={id}
              type="range"
              min={0}
              max={100}
              step={audioConfig.volumeStep}
              value={volumes[channel]}
              onChange={(event) => {
                unlockIfLocked()
                audioSettingsStore
                  .getState()
                  .setVolume(channel, Number(event.target.value), Date.now())
              }}
              className="min-h-11 w-full accent-taxi-ink"
            />
          </div>
        )
      })}

      <GraphicsSettings />
    </section>
  )
}
