/**
 * The audio runtime (S05b): the Web Audio graph, music rotation, the ambience loop and sound
 * effects. Loaded lazily (src/lib/audio/loadRuntime.ts) only after the player's deliberate tap
 * and once the map is playable, so none of it is in the shell.
 *
 *   destination ← master ← { music ← per-track gains, sfx, ambience, voice }
 *
 * Rules it keeps:
 *  - Everything is AudioBuffer-based. No <audio>/<video> elements and no MediaElementSource
 *    (Android Chrome takes audio focus for media elements and pauses the player's music app),
 *    and navigator.mediaSession is never touched, so sfx never take over the media session.
 *  - Only same-origin files under /audio/ are fetched; no streams, no radio.
 *  - Under "My own music" the music is never fetched; sfx and ambience keep playing.
 *  - At most two decoded music buffers exist (current and next, during the crossfade).
 */
import { MIXER_CHANNELS, type MixerChannel, type SfxId } from './channels'
import { audioConfig, type AudioTier } from './config'
import { isOwnMusic } from './controls'
import {
  audioManifest,
  SAME_ORIGIN_AUDIO,
  type ClientAudioManifest,
  type ClientAudioTrack,
} from './manifest'
import { mixerGains, type Gains } from './mixer'
import { attachMusicRetry } from './loadRuntime'
import { attachSfxPlayer } from './sfx'
import type { AudioTestHook } from './testHook'
import type { AudioConfig } from '@/lib/data/schemas/config'
import { log, type Logger } from '@/lib/log'
import { audioSettingsStore, type AudioSettingsStore } from '@/state/audioSettings'
import { audioStatusStore, type AudioStatusStore } from '@/state/audioStatus'
import { onboardingStore, type OnboardingStore } from '@/state/onboarding'

type TimerHandle = ReturnType<typeof setTimeout>

/** What the runtime needs from the page: injected so tests can use fakes. */
export interface AudioRuntimeDeps {
  readonly manifest: ClientAudioManifest
  readonly config: AudioConfig
  readonly tier: AudioTier
  readonly onboarding: OnboardingStore
  readonly settings: AudioSettingsStore
  readonly status: AudioStatusStore
  /** Fetches one same-origin file; rejects on a network or HTTP error. */
  readonly fetchAudio: (url: string) => Promise<ArrayBuffer>
  /** `HTMLMediaElement.canPlayType` of an element that is never attached or played. */
  readonly canPlayType: (type: string) => string
  readonly visibility: VisibilitySource | undefined
  readonly setTimer: (callback: () => void, ms: number) => TimerHandle
  readonly clearTimer: (handle: TimerHandle) => void
  readonly attachSfx: typeof attachSfxPlayer
  /** Registers what a "Tap to retry" on the sound control does once music failed to load. */
  readonly attachMusicRetry?: typeof attachMusicRetry
  readonly installTestHook: (hook: AudioTestHook) => void
  readonly logger: Logger
}

export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface AudioRuntime {
  /** The gains the graph is moving towards. */
  targetGains(): Gains
  /** The gains the graph applies right now. */
  liveGains(): Gains
  playing(): { music: string | null; ambience: string | null }
  sfxStarted(): number
  playSfx(id: SfxId): void
  /** Stops everything and releases the graph (tests; a page keeps its runtime). */
  detach(): void
}

interface MusicVoice {
  readonly track: ClientAudioTrack
  readonly source: AudioBufferSourceNode
  readonly gain: GainNode
}

const dbToGain = (db: number) => 10 ** (db / 20)

const errorName = (error: unknown) => (error instanceof Error ? error.name : String(error))

/** Builds the graph on `context` and starts the channels the player's choice allows. */
export function createAudioRuntime(context: AudioContext, deps: AudioRuntimeDeps): AudioRuntime {
  const { manifest, config, onboarding, settings, status, logger } = deps
  const tierConfig = config.tiers[deps.tier]
  const tracks = new Map(manifest.tracks.map((track) => [track.id, track]))

  const nodes = Object.fromEntries(
    MIXER_CHANNELS.map((channel) => [channel, context.createGain()]),
  ) as Record<MixerChannel, GainNode>
  nodes.master.connect(context.destination)
  for (const channel of MIXER_CHANNELS) {
    if (channel !== 'master') nodes[channel].connect(nodes.master)
  }

  const targetGains = (): Gains =>
    mixerGains({
      volumes: settings.getState().volumes,
      ownMusic: isOwnMusic(onboarding.getState().record),
      unlocked: true,
    })

  // A short linear ramp from the current value lands exactly on the target without a click
  // (setTargetAtTime only approaches it).
  const rampTo = (param: AudioParam, target: number) => {
    const now = context.currentTime
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(target, now + config.rampSeconds)
  }

  const applyGains = (immediate: boolean) => {
    const gains = targetGains()
    for (const channel of MIXER_CHANNELS) {
      if (immediate) nodes[channel].gain.value = gains[channel]
      else rampTo(nodes[channel].gain, gains[channel])
    }
  }
  applyGains(true)
  status.setState({ masterVolume: settings.getState().volumes.master })

  /** Tries each encoding the browser can play, in manifest order; null if none decodes. */
  async function loadTrack(track: ClientAudioTrack): Promise<AudioBuffer | null> {
    for (const source of track.sources) {
      if (deps.canPlayType(source.type) === '') continue
      if (!SAME_ORIGIN_AUDIO.test(source.file)) {
        logger.error('Refusing an audio file outside /audio/', { id: track.id })
        continue
      }
      try {
        const data = await deps.fetchAudio(source.file)
        return await context.decodeAudioData(data)
      } catch (error) {
        logger.info('An audio file did not load; trying the next format', {
          id: track.id,
          type: source.type,
          error: errorName(error),
        })
      }
    }
    logger.info('No playable format for a sound', { id: track.id })
    return null
  }

  function startSource(
    track: ClientAudioTrack,
    buffer: AudioBuffer,
    output: GainNode,
    loop: boolean,
  ): { source: AudioBufferSourceNode; gain: GainNode } {
    const gain = context.createGain()
    gain.gain.value = dbToGain(track.gainDb)
    const source = context.createBufferSource()
    source.buffer = buffer
    if (loop) {
      source.loop = true
      if (track.loopStartMs !== undefined) source.loopStart = track.loopStartMs / 1000
      if (track.loopEndMs !== undefined) source.loopEnd = track.loopEndMs / 1000
    }
    source.connect(gain)
    gain.connect(output)
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
    }
    source.start()
    return { source, gain }
  }

  let detached = false

  // --- music -------------------------------------------------------------------------------
  //
  // A small state machine keyed by a generation number. Every start and every stop takes a new
  // generation, so a newer request always supersedes an older one still loading: when a load
  // settles, it plays only if its generation is still current, and otherwise drops its buffer.
  // A start never waits on (or is blocked by) an older start, so the end state always matches
  // the player's latest choice, and at most one track is audible outside a crossfade.

  const playlist = manifest.playlists.music
  /** The audible track. */
  let music: MusicVoice | null = null
  /** The previous track while it fades out during a crossfade. */
  let fading: MusicVoice | null = null
  let musicIndex = 0
  let musicGeneration = 0
  /** The next track, loading or decoded, fetched ahead of the switch (one fetch per switch). */
  let prefetch: { index: number; generation: number; buffer: Promise<AudioBuffer | null> } | null =
    null
  const timers = new Set<TimerHandle>()

  const later = (callback: () => void, seconds: number) => {
    const handle = deps.setTimer(() => {
      timers.delete(handle)
      callback()
    }, seconds * 1000)
    timers.add(handle)
  }
  const clearTimers = () => {
    for (const handle of timers) deps.clearTimer(handle)
    timers.clear()
  }

  const announce = (voice: MusicVoice | null) => {
    status.setState({
      musicTrackId: voice?.track.id ?? null,
      musicTitleKey: voice?.track.titleKey ?? null,
    })
  }

  const trackAt = (index: number) => {
    const id = playlist[index]
    return id === undefined ? undefined : tracks.get(id)
  }

  function playMusic(track: ClientAudioTrack, buffer: AudioBuffer, fadeSeconds: number) {
    const { source, gain } = startSource(track, buffer, nodes.music, track.loop)
    if (fadeSeconds > 0) {
      const now = context.currentTime
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(dbToGain(track.gainDb), now + fadeSeconds)
    }
    return { track, source, gain }
  }

  function fadeOut(voice: MusicVoice, seconds: number) {
    const now = context.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
    voice.gain.gain.linearRampToValueAtTime(0, now + seconds)
    voice.source.stop(now + seconds)
  }

  function scheduleNext(generation: number) {
    if (playlist.length < 2) return
    later(() => void switchTrack(generation), config.musicTrackPlaySeconds)
    if (tierConfig.prefetchNextMusic) {
      later(
        () => prefetchNext(generation),
        config.musicTrackPlaySeconds - config.prefetchAheadSeconds,
      )
    }
  }

  /** Starts loading the track after the current one, once per switch. */
  function prefetchNext(generation: number) {
    const index = (musicIndex + 1) % playlist.length
    if (prefetch?.index === index && prefetch.generation === generation) return prefetch.buffer
    const track = trackAt(index)
    const buffer = track === undefined ? Promise.resolve(null) : loadTrack(track)
    prefetch = { index, generation, buffer }
    return buffer
  }

  async function switchTrack(generation: number) {
    if (generation !== musicGeneration || music === null) return
    const index = (musicIndex + 1) % playlist.length
    const track = trackAt(index)
    if (track === undefined) return
    // Waits for an in-flight prefetch rather than fetching the same file again.
    const buffer = await prefetchNext(generation)
    prefetch = null
    if (generation !== musicGeneration || music === null) return
    if (buffer === null) {
      // Keep the current track and try again next round.
      scheduleNext(generation)
      return
    }
    fading?.source.stop()
    fading = music
    music = playMusic(track, buffer, config.musicCrossfadeSeconds)
    musicIndex = index
    fadeOut(fading, config.musicCrossfadeSeconds)
    announce(music)
    scheduleNext(generation)
  }

  /** Starts our music unless it is playing already. Supersedes any start still loading. */
  async function startMusic() {
    if (music !== null) return
    musicGeneration += 1
    const generation = musicGeneration
    status.setState({ musicFailed: false })
    for (let attempt = 0; attempt < playlist.length; attempt += 1) {
      const index = (musicIndex + attempt) % playlist.length
      const track = trackAt(index)
      if (track === undefined) continue
      const buffer = await loadTrack(track)
      if (generation !== musicGeneration || detached) return
      if (buffer === null) continue
      music = playMusic(track, buffer, 0)
      musicIndex = index
      announce(music)
      scheduleNext(generation)
      return
    }
    logger.info('No music track could be played', { tracks: playlist.length })
    status.setState({ musicFailed: true })
  }

  function stopMusic() {
    musicGeneration += 1
    clearTimers()
    prefetch = null
    // The music channel is already ramping to 0; stop once it is silent.
    const stopAt = context.currentTime + config.rampSeconds
    for (const voice of [music, fading]) voice?.source.stop(stopAt)
    music = null
    fading = null
    announce(null)
    status.setState({ musicFailed: false })
  }

  /** Brings music in line with the player's choice: playing for ours, stopped for theirs. */
  function reconcileMusic() {
    if (isOwnMusic(onboarding.getState().record)) stopMusic()
    else void startMusic()
  }

  // --- ambience ----------------------------------------------------------------------------

  let ambience: { id: string; source: AudioBufferSourceNode } | null = null
  const ambienceTrack = tracks.get(manifest.playlists.ambience[0] ?? '')
  if (ambienceTrack !== undefined) {
    void loadTrack(ambienceTrack).then((buffer) => {
      if (buffer === null || detached) return
      const { source } = startSource(ambienceTrack, buffer, nodes.ambience, true)
      ambience = { id: ambienceTrack.id, source }
    })
  }

  // --- sound effects -----------------------------------------------------------------------

  const sfxBuffers = new Map<SfxId, Promise<AudioBuffer | null>>()
  let sfxCount = 0

  const sfxBuffer = (id: SfxId) => {
    let pending = sfxBuffers.get(id)
    if (pending === undefined) {
      const track = tracks.get(manifest.sfx[id])
      pending = track === undefined ? Promise.resolve(null) : loadTrack(track)
      sfxBuffers.set(id, pending)
    }
    return pending
  }

  const playSfx = (id: SfxId) => {
    const track = tracks.get(manifest.sfx[id])
    if (track === undefined) return
    void sfxBuffer(id).then((buffer) => {
      if (buffer === null || detached) return
      startSource(track, buffer, nodes.sfx, false)
      sfxCount += 1
    })
  }

  if (tierConfig.preloadSfx) {
    for (const id of Object.keys(manifest.sfx) as SfxId[]) void sfxBuffer(id)
  }
  const detachSfx = deps.attachSfx(playSfx)

  // --- the player's choices and the page lifecycle -----------------------------------------

  let ownMusic = isOwnMusic(onboarding.getState().record)
  reconcileMusic()

  const unsubscribeOnboarding = onboarding.subscribe((state) => {
    const next = isOwnMusic(state.record)
    if (next === ownMusic) return
    ownMusic = next
    applyGains(false)
    reconcileMusic()
  })
  const detachRetry = (deps.attachMusicRetry ?? (() => () => undefined))(() => {
    if (!isOwnMusic(onboarding.getState().record) && music === null) void startMusic()
  })
  const unsubscribeSettings = settings.subscribe((state, previous) => {
    if (state.volumes === previous.volumes) return
    applyGains(false)
    status.setState({ masterVolume: state.volumes.master })
  })

  const onVisibility = () => {
    const visible = deps.visibility?.visibilityState === 'visible'
    const change = visible ? context.resume() : context.suspend()
    change.catch((error: unknown) => {
      // The sound control offers "Tap for sound" while the context stays suspended.
      logger.info('The browser did not change the sound state', {
        visible,
        error: errorName(error),
      })
    })
  }
  deps.visibility?.addEventListener('visibilitychange', onVisibility)
  if (deps.visibility?.visibilityState === 'hidden') onVisibility()

  const runtime: AudioRuntime = {
    targetGains,
    liveGains: () =>
      Object.fromEntries(
        MIXER_CHANNELS.map((channel) => [channel, nodes[channel].gain.value]),
      ) as Gains,
    playing: () => ({ music: music?.track.id ?? null, ambience: ambience?.id ?? null }),
    sfxStarted: () => sfxCount,
    playSfx,
    detach: () => {
      detached = true
      stopMusic()
      ambience?.source.stop()
      ambience = null
      detachSfx()
      detachRetry()
      unsubscribeOnboarding()
      unsubscribeSettings()
      deps.visibility?.removeEventListener('visibilitychange', onVisibility)
      nodes.master.disconnect()
    },
  }

  deps.installTestHook({
    contextState: () => context.state,
    gains: runtime.liveGains,
    targetGains,
    playing: runtime.playing,
    sfxStarted: runtime.sfxStarted,
    playSfx,
  })

  return runtime
}

async function fetchSameOrigin(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.arrayBuffer()
}

let probe: HTMLAudioElement | undefined
/** Never attached to the document and never given a source: it only answers canPlayType. */
const canPlayType = (type: string) => {
  probe ??= document.createElement('audio')
  return probe.canPlayType(type)
}

let active: { context: AudioContext; runtime: AudioRuntime } | null = null

/**
 * Starts the runtime on the page's audio context. Once per context; a new context (the old one
 * was closed) replaces the old runtime, which is detached first.
 */
export function attach(context: AudioContext, tier: AudioTier): AudioRuntime {
  if (active?.context === context) return active.runtime
  active?.runtime.detach()
  const runtime = createAudioRuntime(context, {
    manifest: audioManifest,
    config: audioConfig,
    tier,
    onboarding: onboardingStore,
    settings: audioSettingsStore,
    status: audioStatusStore,
    fetchAudio: fetchSameOrigin,
    canPlayType,
    visibility: document,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle),
    attachSfx: attachSfxPlayer,
    attachMusicRetry,
    installTestHook: (hook) => {
      // Inlined at build time (next.config.ts): production builds drop the hook entirely, and
      // test builds load it from its own chunk.
      if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
      void import('./testHook').then((module) => module.installAudioTestHook(hook))
    },
    logger: log,
  })
  active = { context, runtime }
  return runtime
}
