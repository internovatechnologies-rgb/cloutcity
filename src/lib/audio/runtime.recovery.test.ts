/** Recovery paths of the audio runtime (S05b fix cycle 1): failed music, retry, prefetch reuse. */
import { describe, expect, it } from 'vitest'
import audioJson from '@data/config/audio.json'
import onboardingJson from '@data/config/onboarding.json'
import { createLogger } from '@/lib/log'
import type { AudioConfig } from '@/lib/data/schemas/config'
import { createAudioSettingsStore, type PersistedAudioSettings } from '@/state/audioSettings'
import { createAudioStatusStore } from '@/state/audioStatus'
import { createOnboardingStore, type PersistedOnboarding } from '@/state/onboarding'
import { createSafeJsonStorage } from '@/state/storage'
import { FakeAudioContext, flush } from './fakeWebAudio'
import type { ClientAudioManifest } from './manifest'
import { createAudioRuntime } from './runtime'

const config = audioJson as AudioConfig
const silent = createLogger({ level: 'error', sink: () => undefined })
const PLAY_MS = config.musicTrackPlaySeconds * 1000
const PREFETCH_MS = PLAY_MS - config.prefetchAheadSeconds * 1000

const track = (id: string, channel: string) => ({
  id,
  channel,
  sources: [{ file: `/audio/${channel}/${id}.webm`, type: 'audio/webm; codecs=opus' }],
  loop: channel !== 'sfx',
  gainDb: 0,
  ...(channel === 'music' ? { titleKey: 'audio.track.lofiLoop' } : {}),
})

const MANIFEST: ClientAudioManifest = {
  tracks: [track('song-a', 'music'), track('song-b', 'music'), track('night', 'ambience')],
  playlists: { music: ['song-a', 'song-b'], ambience: ['night'] },
  sfx: { 'ui-tap': 'night', purchase: 'night', 'clout-up': 'night' },
}

function setup({ startGated = false } = {}) {
  const onboarding = createOnboardingStore(
    createSafeJsonStorage<PersistedOnboarding>(() => undefined, silent),
    onboardingJson,
    silent,
  )
  onboarding.getState().completeAdult({ consentVersion: '2026-10-06', audioChoice: 'ours' }, 1)
  const status = createAudioStatusStore()
  const context = new FakeAudioContext()
  const fetched: string[] = []
  const gates = new Map<string, (() => void)[]>()
  let gated = startGated
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  let retry: (() => void) | null = null
  const runtime = createAudioRuntime(context as unknown as AudioContext, {
    manifest: MANIFEST,
    config,
    tier: 'mid',
    onboarding,
    settings: createAudioSettingsStore(
      createSafeJsonStorage<PersistedAudioSettings>(() => undefined, silent),
      config,
      silent,
    ),
    status,
    fetchAudio: (url) => {
      fetched.push(url)
      const data = new TextEncoder().encode(url).buffer as ArrayBuffer
      if (!gated) return Promise.resolve(data)
      return new Promise((resolve) => {
        gates.set(url, [...(gates.get(url) ?? []), () => resolve(data)])
      })
    },
    canPlayType: () => 'probably',
    visibility: undefined,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      ;(handle as unknown as { cleared: boolean }).cleared = true
    },
    attachSfx: () => () => undefined,
    attachMusicRetry: (next) => {
      retry = next
      return () => {
        retry = null
      }
    },
    installTestHook: () => undefined,
    logger: silent,
  })
  const runTimer = (ms: number) => {
    const timer = timers.find((entry) => entry.ms === ms && !entry.cleared)
    if (timer === undefined) throw new Error(`no live timer at ${ms} ms`)
    timer.cleared = true
    timer.callback()
  }
  const release = (url: string) => {
    for (const done of gates.get(url) ?? []) done()
    gates.delete(url)
  }
  return {
    runtime,
    context,
    status,
    fetched,
    runTimer,
    release,
    gate: (on: boolean) => {
      gated = on
    },
    retry: () => retry?.(),
  }
}

describe('audio runtime recovery', () => {
  it('marks music unavailable when no track decodes, and a retry plays it', async () => {
    const { context, status, runtime, retry } = setup()
    context.undecodable.add('/audio/music/song-a.webm')
    context.undecodable.add('/audio/music/song-b.webm')
    await flush()
    expect(status.getState()).toMatchObject({ musicFailed: true, musicTrackId: null })
    expect(runtime.playing()).toEqual({ music: null, ambience: 'night' })

    context.undecodable.clear()
    retry()
    expect(status.getState().musicFailed).toBe(false)
    await flush()
    expect(runtime.playing().music).toBe('song-a')
    expect(status.getState().musicTrackId).toBe('song-a')
  })

  it('an ambience failure does not mark music unavailable', async () => {
    const { context, status, runtime } = setup()
    context.undecodable.add('/audio/ambience/night.webm')
    await flush()
    expect(status.getState().musicFailed).toBe(false)
    expect(runtime.playing()).toEqual({ music: 'song-a', ambience: null })
  })

  it('a switch waits for a slow prefetch instead of fetching the track again', async () => {
    const { fetched, runTimer, release, gate, runtime, context } = setup()
    await flush()
    gate(true)
    runTimer(PREFETCH_MS)
    await flush()
    runTimer(PLAY_MS)
    await flush()
    expect(fetched.filter((url) => url === '/audio/music/song-b.webm')).toHaveLength(1)
    release('/audio/music/song-b.webm')
    await flush()
    expect(runtime.playing().music).toBe('song-b')
    expect(fetched.filter((url) => url === '/audio/music/song-b.webm')).toHaveLength(1)
    const live = context.sources.filter(
      (source) => source.buffer?.url.includes('/music/') && !source.disconnected,
    )
    expect(live.length).toBeLessThanOrEqual(2)
  })

  it('detach stops music and ignores loads that finish afterwards', async () => {
    const { runtime, release, context } = setup({ startGated: true })
    await flush()
    runtime.detach()
    release('/audio/music/song-a.webm')
    release('/audio/ambience/night.webm')
    await flush()
    expect(context.sources.filter((source) => source.started)).toEqual([])
  })
})
