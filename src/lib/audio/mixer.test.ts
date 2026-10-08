import { describe, expect, it } from 'vitest'
import { MIXER_CHANNELS } from './channels'
import {
  AUDIO_STATUSES,
  clampVolume,
  mixerGains,
  nowPlaying,
  sliderToGain,
  type Volumes,
} from './mixer'

const VOLUMES: Volumes = { master: 80, music: 60, sfx: 80, ambience: 40, voice: 80 }

describe('clampVolume', () => {
  it('snaps to the step and clamps to 0-100', () => {
    expect(clampVolume(42, 5, 0)).toBe(40)
    expect(clampVolume(43, 5, 0)).toBe(45)
    expect(clampVolume(-10, 5, 50)).toBe(0)
    expect(clampVolume(140, 5, 50)).toBe(100)
    expect(clampVolume(100, 5, 50)).toBe(100)
    expect(clampVolume(0, 5, 50)).toBe(0)
  })

  it('turns NaN and infinities into the fallback', () => {
    expect(clampVolume(Number.NaN, 5, 60)).toBe(60)
    expect(clampVolume(Number.POSITIVE_INFINITY, 5, 60)).toBe(60)
    expect(clampVolume(Number.NEGATIVE_INFINITY, 5, 60)).toBe(60)
  })

  it('never returns -0', () => {
    expect(Object.is(clampVolume(-1, 5, 0), -0)).toBe(false)
  })
})

describe('sliderToGain', () => {
  it('follows a squared curve with exact end points', () => {
    expect(sliderToGain(0)).toBe(0)
    expect(sliderToGain(100)).toBe(1)
    expect(sliderToGain(50)).toBe(0.25)
  })

  it('clamps out-of-range input and rises monotonically', () => {
    expect(sliderToGain(-20)).toBe(0)
    expect(sliderToGain(250)).toBe(1)
    for (let v = 0; v < 100; v += 5) expect(sliderToGain(v + 5)).toBeGreaterThan(sliderToGain(v))
  })
})

describe('mixerGains', () => {
  it('gives every channel its own gain', () => {
    const gains = mixerGains({ volumes: VOLUMES, ownMusic: false, unlocked: true })
    for (const channel of MIXER_CHANNELS)
      expect(gains[channel]).toBe(sliderToGain(VOLUMES[channel]))
  })

  it('silences the master while locked', () => {
    expect(mixerGains({ volumes: VOLUMES, ownMusic: false, unlocked: false }).master).toBe(0)
  })

  it('"My own music" changes only the music gain, for any volumes', () => {
    const values = [0, 5, 35, 60, 100]
    for (const master of values) {
      for (const music of values) {
        for (const sfx of values) {
          const volumes = { master, music, sfx, ambience: 100 - sfx, voice: music }
          for (const unlocked of [true, false]) {
            const ours = mixerGains({ volumes, ownMusic: false, unlocked })
            const own = mixerGains({ volumes, ownMusic: true, unlocked })
            expect(own.music).toBe(0)
            expect({ ...own, music: ours.music }).toEqual(ours)
          }
        }
      }
    }
  })
})

describe('nowPlaying', () => {
  const base = { status: 'running' as const, ownMusic: false, masterVolume: 80, musicTrackId: 'a' }

  it('covers every state', () => {
    expect(nowPlaying(base)).toEqual({ kind: 'track', trackId: 'a' })
    expect(nowPlaying({ ...base, musicTrackId: null })).toEqual({ kind: 'loading' })
    expect(nowPlaying({ ...base, status: 'starting', musicTrackId: null })).toEqual({
      kind: 'loading',
    })
    expect(nowPlaying({ ...base, ownMusic: true })).toEqual({ kind: 'own' })
    expect(nowPlaying({ ...base, masterVolume: 0 })).toEqual({ kind: 'off' })
    expect(nowPlaying({ ...base, masterVolume: null })).toEqual({ kind: 'track', trackId: 'a' })
    expect(nowPlaying({ ...base, status: 'unsupported' })).toEqual({ kind: 'unsupported' })
    for (const status of ['locked', 'suspended', 'interrupted'] as const) {
      expect(nowPlaying({ ...base, status })).toEqual({ kind: 'locked' })
    }
  })

  it('a locked or unsupported context wins over the master and "My own music"', () => {
    for (const status of AUDIO_STATUSES) {
      const view = nowPlaying({ status, ownMusic: true, masterVolume: 0, musicTrackId: null })
      if (status === 'unsupported') expect(view.kind).toBe('unsupported')
      else if (status === 'running' || status === 'starting') expect(view.kind).toBe('off')
      else expect(view.kind).toBe('locked')
    }
  })
})
