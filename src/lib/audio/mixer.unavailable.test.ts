import { describe, expect, it } from 'vitest'
import { nowPlaying } from './mixer'

describe('nowPlaying when something failed to load', () => {
  const base = { status: 'running' as const, ownMusic: false, masterVolume: 80, musicTrackId: null }

  it('music that failed offers a retry, unless the player brings their own', () => {
    expect(nowPlaying({ ...base, musicFailed: true })).toEqual({
      kind: 'unavailable',
      what: 'music',
    })
    expect(nowPlaying({ ...base, musicFailed: true, ownMusic: true })).toEqual({ kind: 'own' })
    expect(nowPlaying({ ...base, musicFailed: true, masterVolume: 0 })).toEqual({ kind: 'off' })
  })

  it('a runtime that did not load offers a retry in every mode, but never before the tap', () => {
    expect(nowPlaying({ ...base, runtimeFailed: true, ownMusic: true })).toEqual({
      kind: 'unavailable',
      what: 'sound',
    })
    expect(nowPlaying({ ...base, runtimeFailed: true, status: 'locked' })).toEqual({
      kind: 'locked',
    })
  })
})
