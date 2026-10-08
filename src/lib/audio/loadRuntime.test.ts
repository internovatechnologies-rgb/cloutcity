import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ fail: true, attached: [] as unknown[], tiers: [] as unknown[] }))

vi.mock('./runtime', () => {
  if (state.fail) throw new Error('ChunkLoadError')
  return {
    attach: (context: unknown, tier: unknown) => {
      state.attached.push(context)
      state.tiers.push(tier)
    },
  }
})

/** A loaded runtime that records the tier it was started on (the retry test re-mocks it). */
function useTierRecordingRuntime(): void {
  state.fail = false
  vi.doMock('./runtime', () => ({
    attach: (_context: unknown, tier: unknown) => state.tiers.push(tier),
  }))
}

describe('loading the audio runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    state.fail = true
    state.attached = []
    state.tiers = []
  })

  it('reports a runtime that did not load, and a retry loads it again', async () => {
    const { markMapPlayable } = await import('@/state/mapPlayable')
    const { audioStatusStore } = await import('@/state/audioStatus')
    const { startRuntimeWhenPlayable, retryAudio } = await import('./loadRuntime')
    markMapPlayable()
    const context = {} as AudioContext
    startRuntimeWhenPlayable(context)
    await vi.waitFor(() => expect(audioStatusStore.getState().runtimeFailed).toBe(true))

    state.fail = false
    vi.doUnmock('./runtime')
    vi.doMock('./runtime', () => ({
      attach: (attached: unknown) => state.attached.push(attached),
    }))
    retryAudio()
    expect(audioStatusStore.getState().runtimeFailed).toBe(false)
    await vi.waitFor(() => expect(state.attached).toEqual([context]))
  })

  it('a retry with a running runtime asks it to reload music', async () => {
    const { attachMusicRetry, retryAudio } = await import('./loadRuntime')
    const retry = vi.fn()
    const detach = attachMusicRetry(retry)
    retryAudio()
    expect(retry).toHaveBeenCalledTimes(1)
    detach()
    retryAudio()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('starts the runtime on the quality tier in use (S04b)', async () => {
    useTierRecordingRuntime()
    const { qualityStore } = await import('@/state/quality')
    const { markMapPlayable } = await import('@/state/mapPlayable')
    const { startRuntimeWhenPlayable } = await import('./loadRuntime')
    qualityStore.getState().setDetected({ tier: 'high', reasons: ['high-capable'] }, false)
    qualityStore.getState().setOverride('mid')
    markMapPlayable()
    startRuntimeWhenPlayable({} as AudioContext)
    await vi.waitFor(() => expect(state.tiers).toEqual(['mid']))
  })

  it('a data-saver request plays the low tier whatever was chosen', async () => {
    useTierRecordingRuntime()
    const { qualityStore } = await import('@/state/quality')
    const { markMapPlayable } = await import('@/state/mapPlayable')
    const { startRuntimeWhenPlayable } = await import('./loadRuntime')
    qualityStore.getState().setDetected({ tier: 'low', reasons: ['data-saver'] }, true)
    qualityStore.getState().setOverride('high')
    markMapPlayable()
    startRuntimeWhenPlayable({} as AudioContext)
    await vi.waitFor(() => expect(state.tiers).toEqual(['low']))
  })

  it('plays the low tier when the device was never probed', async () => {
    useTierRecordingRuntime()
    const { markMapPlayable } = await import('@/state/mapPlayable')
    const { startRuntimeWhenPlayable } = await import('./loadRuntime')
    markMapPlayable()
    startRuntimeWhenPlayable({} as AudioContext)
    await vi.waitFor(() => expect(state.tiers).toEqual(['low']))
  })
})
