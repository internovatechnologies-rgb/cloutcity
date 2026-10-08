import { beforeEach, describe, expect, it, vi } from 'vitest'
import audioJson from '@data/config/audio.json'
import onboardingJson from '@data/config/onboarding.json'
import { createLogger, type LogRecord } from '@/lib/log'
import { createAudioSettingsStore, type PersistedAudioSettings } from '@/state/audioSettings'
import { createAudioStatusStore } from '@/state/audioStatus'
import { createOnboardingStore, type PersistedOnboarding } from '@/state/onboarding'
import { createSafeJsonStorage } from '@/state/storage'
import type { AudioConfig } from '@/lib/data/schemas/config'
import type { AudioTier } from './config'
import { FakeAudioContext, FakeGain, FakeSource, flush } from './fakeWebAudio'
import type { ClientAudioManifest } from './manifest'
import { sliderToGain } from './mixer'
import { createAudioRuntime, type AudioRuntimeDeps, type VisibilitySource } from './runtime'
import type { AudioTestHook } from './testHook'

const track = (id: string, channel: string, extra: object = {}) => ({
  id,
  channel,
  sources: [
    { file: `/audio/${channel}/${id}.webm`, type: 'audio/webm; codecs=opus' },
    { file: `/audio/${channel}/${id}.m4a`, type: 'audio/mp4; codecs=mp4a.40.2' },
  ],
  loop: channel !== 'sfx',
  gainDb: 0,
  ...extra,
})

const MANIFEST: ClientAudioManifest = {
  tracks: [
    track('song-a', 'music', {
      titleKey: 'audio.track.lofiLoop',
      loopStartMs: 1000,
      loopEndMs: 9000,
    }),
    track('song-b', 'music', { titleKey: 'audio.track.lofiAgain' }),
    track('night', 'ambience'),
    track('tap', 'sfx'),
    track('buy', 'sfx'),
    track('clout', 'sfx'),
  ],
  playlists: { music: ['song-a', 'song-b'], ambience: ['night'] },
  sfx: { 'ui-tap': 'tap', purchase: 'buy', 'clout-up': 'clout' },
}

const config = audioJson as AudioConfig
const silent = createLogger({ level: 'error', sink: () => undefined })

class FakeDocument implements VisibilitySource {
  visibilityState: DocumentVisibilityState = 'visible'
  listener: (() => void) | null = null
  addEventListener(_: 'visibilitychange', listener: () => void) {
    this.listener = listener
  }
  removeEventListener() {
    this.listener = null
  }
  set(state: DocumentVisibilityState) {
    this.visibilityState = state
    this.listener?.()
  }
}

function setup({
  audioChoice = 'ours' as 'ours' | 'own',
  tier = 'mid' as AudioTier,
  canPlay = (type: string): string => (type.includes('opus') ? 'probably' : 'maybe'),
  manifest = MANIFEST,
  fetchAudio = undefined as ((url: string) => Promise<ArrayBuffer>) | undefined,
} = {}) {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const onboarding = createOnboardingStore(
    createSafeJsonStorage<PersistedOnboarding>(() => undefined, silent),
    onboardingJson,
    silent,
  )
  onboarding.getState().completeAdult({ consentVersion: '2026-10-06', audioChoice }, 1)
  const settings = createAudioSettingsStore(
    createSafeJsonStorage<PersistedAudioSettings>(() => undefined, silent),
    config,
    silent,
  )
  const status = createAudioStatusStore()
  const fetched: string[] = []
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  const visibility = new FakeDocument()
  let hook: AudioTestHook | undefined
  const sfxPlayers: ((id: 'ui-tap' | 'purchase' | 'clout-up') => void)[] = []
  const context = new FakeAudioContext()
  const deps: AudioRuntimeDeps = {
    manifest,
    config,
    tier,
    onboarding,
    settings,
    status,
    fetchAudio: (url) => {
      fetched.push(url)
      if (fetchAudio !== undefined) return fetchAudio(url)
      return Promise.resolve(new TextEncoder().encode(url).buffer as ArrayBuffer)
    },
    canPlayType: canPlay,
    visibility,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      ;(handle as unknown as { cleared: boolean }).cleared = true
    },
    attachSfx: (player) => {
      sfxPlayers.push(player)
      return () => undefined
    },
    installTestHook: (installed) => {
      hook = installed
    },
    logger,
  }
  const runtime = createAudioRuntime(context as unknown as AudioContext, deps)
  const runTimer = (ms: number) => {
    const timer = timers.find((entry) => entry.ms === ms && !entry.cleared)
    if (timer === undefined) throw new Error(`no live timer at ${ms} ms`)
    timer.cleared = true
    timer.callback()
  }
  const musicSources = () =>
    context.sources.filter((source) => source.buffer?.url.startsWith('/audio/music/'))
  return {
    runtime,
    context,
    onboarding,
    settings,
    status,
    fetched,
    timers,
    visibility,
    records,
    hook: () => hook,
    sfxPlayers,
    runTimer,
    musicSources,
  }
}

beforeEach(() => {
  FakeAudioContext.instances = []
})

const PLAY_MS = config.musicTrackPlaySeconds * 1000

describe('audio runtime', () => {
  it('builds destination ← master ← music, sfx, ambience, voice', () => {
    const { context } = setup()
    const [master, ...channels] = context.gains as FakeGain[]
    expect(master?.connections).toEqual([context.destination])
    expect(channels.slice(0, 4).every((gain) => gain.connections[0] === master)).toBe(true)
  })

  it('starts at the mixer gains, set directly', () => {
    const { runtime } = setup()
    expect(runtime.liveGains()).toEqual({
      master: sliderToGain(80),
      music: sliderToGain(60),
      sfx: sliderToGain(80),
      ambience: sliderToGain(40),
      voice: sliderToGain(80),
    })
    expect(runtime.targetGains()).toEqual(runtime.liveGains())
  })

  it('plays the first music track looped at its loop points, and the ambience loop', async () => {
    const { runtime, status, musicSources, fetched } = setup()
    await flush()
    expect(runtime.playing()).toEqual({ music: 'song-a', ambience: 'night' })
    const [song] = musicSources()
    expect(song).toMatchObject({ loop: true, loopStart: 1, loopEnd: 9, started: true })
    expect(status.getState()).toMatchObject({
      musicTrackId: 'song-a',
      musicTitleKey: 'audio.track.lofiLoop',
      masterVolume: 80,
    })
    expect(fetched.every((url) => url.startsWith('/audio/'))).toBe(true)
  })

  it('under "My own music" never fetches music, but plays ambience and sfx', async () => {
    const { runtime, fetched, sfxPlayers } = setup({ audioChoice: 'own' })
    await flush()
    expect(fetched.some((url) => url.includes('/music/'))).toBe(false)
    expect(runtime.liveGains().music).toBe(0)
    expect(runtime.liveGains().sfx).toBeGreaterThan(0)
    expect(runtime.playing()).toEqual({ music: null, ambience: 'night' })
    sfxPlayers[0]?.('ui-tap')
    await flush()
    expect(runtime.sfxStarted()).toBe(1)
  })

  it('toggling "My own music" moves only the music gain, then restores it', async () => {
    const { runtime, onboarding, fetched, status } = setup({ audioChoice: 'own' })
    await flush()
    const before = runtime.liveGains()
    onboarding.getState().setAudioChoice('ours')
    await flush()
    expect(runtime.liveGains()).toEqual({ ...before, music: sliderToGain(60) })
    expect(fetched.filter((url) => url.includes('/music/'))).toEqual(['/audio/music/song-a.webm'])
    expect(status.getState().musicTrackId).toBe('song-a')
    onboarding.getState().setAudioChoice('own')
    expect(runtime.liveGains()).toEqual(before)
    expect(runtime.playing().music).toBeNull()
    expect(status.getState().musicTrackId).toBeNull()
  })

  it('follows the volume sliders and mirrors the master', () => {
    const { runtime, settings, status } = setup()
    settings.getState().setVolume('sfx', 20, 5)
    expect(runtime.liveGains().sfx).toBe(sliderToGain(20))
    settings.getState().setVolume('master', 0, 6)
    expect(runtime.liveGains().master).toBe(0)
    expect(status.getState().masterVolume).toBe(0)
    expect(runtime.liveGains().music).toBe(sliderToGain(60))
  })

  it('falls back to the next encoding when decoding fails', async () => {
    const { context, fetched } = setup()
    context.undecodable.add('/audio/music/song-a.webm')
    await flush()
    expect(fetched).toContain('/audio/music/song-a.m4a')
  })

  it('skips encodings the browser cannot play', async () => {
    const { fetched } = setup({ canPlay: (type) => (type.includes('mp4') ? 'maybe' : '') })
    await flush()
    expect(fetched.every((url) => url.endsWith('.m4a'))).toBe(true)
  })

  it('crossfades to the next track after a track has played, prefetching ahead on mid', async () => {
    const { runTimer, musicSources, status, fetched, runtime } = setup()
    await flush()
    runTimer(PLAY_MS - config.prefetchAheadSeconds * 1000)
    await flush()
    expect(fetched).toContain('/audio/music/song-b.webm')
    runTimer(PLAY_MS)
    await flush()
    const [first, second] = musicSources()
    expect(first?.stoppedAt).toBe(config.musicCrossfadeSeconds)
    expect(second?.started).toBe(true)
    expect(status.getState().musicTrackId).toBe('song-b')
    expect(runtime.playing().music).toBe('song-b')
    // The old track's buffer is released once it has stopped.
    first?.onended?.()
    expect(first?.disconnected).toBe(true)
  })

  it('on low tier fetches the next track only at the switch and does not preload sfx', async () => {
    const { timers, fetched, runTimer } = setup({ tier: 'low' })
    await flush()
    expect(timers.map((timer) => timer.ms)).toEqual([PLAY_MS])
    expect(fetched.some((url) => url.includes('/sfx/'))).toBe(false)
    runTimer(PLAY_MS)
    await flush()
    expect(fetched).toContain('/audio/music/song-b.webm')
  })

  it('preloads sfx on mid tier', async () => {
    const { fetched } = setup()
    await flush()
    expect(fetched.filter((url) => url.includes('/sfx/'))).toHaveLength(3)
  })

  it('suspends while the page is hidden and resumes when visible', () => {
    const { context, visibility } = setup()
    visibility.set('hidden')
    expect(context.calls).toEqual(['suspend'])
    visibility.set('visible')
    expect(context.calls).toEqual(['suspend', 'resume'])
  })

  it('never touches the media session and creates no media elements', async () => {
    const mediaSession = vi.fn()
    vi.stubGlobal('navigator', {
      get mediaSession() {
        mediaSession()
        return {}
      },
    })
    const createElement = vi.fn()
    vi.stubGlobal('document', { createElement })
    setup()
    await flush()
    expect(mediaSession).not.toHaveBeenCalled()
    expect(createElement).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('exposes the test hook with live and target gains', async () => {
    const { hook, context } = setup()
    await flush()
    const installed = hook()
    expect(installed?.contextState()).toBe(context.state)
    expect(installed?.targetGains().music).toBe(sliderToGain(60))
    expect(installed?.playing()).toEqual({ music: 'song-a', ambience: 'night' })
  })

  it('logs failed loads at info only', async () => {
    const { context, records } = setup()
    for (const source of MANIFEST.tracks.flatMap((entry) => entry.sources)) {
      context.undecodable.add(source.file)
    }
    await flush()
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((record) => record.level === 'info')).toBe(true)
  })

  it('stops everything on detach', async () => {
    const { runtime, context } = setup()
    await flush()
    runtime.detach()
    expect(
      context.sources.every((source: FakeSource) => source.stoppedAt !== null || !source.loop),
    ).toBe(true)
  })
})

/** A fetch that waits until the test releases each URL (a slow network). */
function gatedFetch() {
  const pending = new Map<string, () => void>()
  const fetchAudio = (url: string) =>
    new Promise<ArrayBuffer>((resolve) => {
      pending.set(url, () => resolve(new TextEncoder().encode(url).buffer as ArrayBuffer))
    })
  const release = (url: string) => {
    const done = pending.get(url)
    if (done === undefined) throw new Error(`no pending fetch for ${url}`)
    pending.delete(url)
    done()
  }
  const releaseAll = () => {
    for (const url of [...pending.keys()]) release(url)
  }
  return { fetchAudio, release, releaseAll, pending }
}

/** Music sources started and not told to stop: what the player hears. */
const audible = (sources: FakeSource[]) =>
  sources.filter((source) => source.started && source.stoppedAt === null)

describe('audio runtime: "My own music" races and the playlist', () => {
  it('rapid toggling while the first track is still loading ends with our music playing', async () => {
    const gate = gatedFetch()
    const { runtime, onboarding, musicSources, status } = setup({
      audioChoice: 'own',
      fetchAudio: gate.fetchAudio,
    })
    // Off, on, off, on before the first music file arrives (a double tap on a slow network).
    onboarding.getState().setAudioChoice('ours')
    onboarding.getState().setAudioChoice('own')
    onboarding.getState().setAudioChoice('ours')
    await flush()
    gate.releaseAll()
    await flush()
    gate.releaseAll()
    await flush()
    expect(runtime.targetGains().music).toBe(sliderToGain(60))
    expect(runtime.playing().music).toBe('song-a')
    expect(audible(musicSources())).toHaveLength(1)
    expect(status.getState().musicTrackId).toBe('song-a')
  })

  it('rapid toggling while music plays never leaves two tracks audible', async () => {
    const { runtime, onboarding, musicSources } = setup()
    await flush()
    for (const choice of ['own', 'ours', 'own', 'ours', 'own', 'ours'] as const) {
      onboarding.getState().setAudioChoice(choice)
    }
    await flush()
    expect(runtime.playing().music).not.toBeNull()
    expect(audible(musicSources())).toHaveLength(1)
  })

  it('turning "My own music" on during the prefetch window drops the prefetch and every timer', async () => {
    const gate = gatedFetch()
    const { runtime, onboarding, timers, runTimer, musicSources, fetched } = setup({
      fetchAudio: gate.fetchAudio,
    })
    gate.releaseAll()
    await flush()
    expect(runtime.playing().music).toBe('song-a')
    runTimer(PLAY_MS - config.prefetchAheadSeconds * 1000)
    await flush()
    expect(gate.pending.has('/audio/music/song-b.webm')).toBe(true)

    onboarding.getState().setAudioChoice('own')
    gate.releaseAll()
    await flush()
    expect(timers.filter((timer) => !timer.cleared)).toEqual([])
    expect(runtime.playing().music).toBeNull()
    expect(audible(musicSources())).toEqual([])

    // Back on: the late prefetch was dropped, so the first track starts again, alone.
    onboarding.getState().setAudioChoice('ours')
    await flush()
    gate.releaseAll()
    await flush()
    expect(runtime.playing().music).toBe('song-a')
    expect(audible(musicSources())).toHaveLength(1)
    expect(fetched.filter((url) => url === '/audio/music/song-a.webm')).toHaveLength(2)
  })

  it('turning "My own music" on mid-crossfade stops both tracks', async () => {
    const { runtime, onboarding, runTimer, musicSources } = setup()
    await flush()
    runTimer(PLAY_MS - config.prefetchAheadSeconds * 1000)
    await flush()
    runTimer(PLAY_MS)
    await flush()
    expect(musicSources().filter((source) => source.started)).toHaveLength(2)

    onboarding.getState().setAudioChoice('own')
    expect(audible(musicSources())).toEqual([])
    expect(runtime.playing().music).toBeNull()
    expect(runtime.targetGains().music).toBe(0)
  })

  it('a single-track playlist loops forever and schedules no switch or prefetch', async () => {
    const single: ClientAudioManifest = {
      ...MANIFEST,
      playlists: { music: ['song-a'], ambience: ['night'] },
    }
    const { runtime, timers, musicSources } = setup({ manifest: single })
    await flush()
    expect(runtime.playing().music).toBe('song-a')
    expect(musicSources()[0]?.loop).toBe(true)
    expect(timers).toEqual([])
  })

  it('keeps at most two music tracks connected across many crossfades', async () => {
    const { runTimer, musicSources, runtime } = setup()
    await flush()
    for (let round = 0; round < 5; round += 1) {
      runTimer(PLAY_MS - config.prefetchAheadSeconds * 1000)
      await flush()
      runTimer(PLAY_MS)
      await flush()
      const connected = musicSources().filter((source) => !source.disconnected)
      expect(connected.length, `round ${round}`).toBeLessThanOrEqual(2)
      expect(audible(musicSources()), `round ${round}`).toHaveLength(1)
      // The faded-out track ends and is released.
      for (const source of connected) if (source.stoppedAt !== null) source.onended?.()
    }
    expect(runtime.playing().music).toBe('song-b')
  })

  it('when no music file decodes, nothing plays, no switch is scheduled, and logs stay at info', async () => {
    const { context, runtime, timers, records, status } = setup()
    for (const source of MANIFEST.tracks
      .filter((entry) => entry.channel === 'music')
      .flatMap((entry) => entry.sources)) {
      context.undecodable.add(source.file)
    }
    await flush()
    expect(runtime.playing()).toEqual({ music: null, ambience: 'night' })
    expect(timers).toEqual([])
    expect(status.getState().musicTrackId).toBeNull()
    expect(records.every((record) => record.level === 'info')).toBe(true)
  })

  it('a refused resume after the tab comes back is logged at info, not thrown', async () => {
    const { context, visibility, records } = setup()
    visibility.set('hidden')
    context.resume = () => Promise.reject(new DOMException('no', 'InvalidStateError'))
    visibility.set('visible')
    await flush()
    expect(records.some((record) => /did not change the sound state/.test(record.msg))).toBe(true)
    expect(records.every((record) => record.level === 'info' || record.level === 'debug')).toBe(
      true,
    )
  })
})
