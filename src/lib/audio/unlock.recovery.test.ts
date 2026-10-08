import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@/lib/log'
import { createAudioStatusStore } from '@/state/audioStatus'
import { FakeAudioContext } from './fakeWebAudio'
import { createAudioUnlocker } from './unlock'

describe('unlockAudioFromGesture after the context was closed', () => {
  it('creates a fresh context inside the tap and starts the runtime on it', () => {
    const status = createAudioStatusStore()
    const startRuntime = vi.fn()
    const unlock = createAudioUnlocker({
      env: () => ({
        AudioContext: FakeAudioContext as unknown as typeof AudioContext,
        navigator: undefined,
      }),
      status,
      startRuntime,
      logger: createLogger({ level: 'error', sink: () => undefined }),
    })
    const first = unlock() as unknown as FakeAudioContext
    first.setState('closed')
    expect(status.getState().status).toBe('suspended')

    const second = unlock() as unknown as FakeAudioContext
    expect(second).not.toBe(first)
    expect(second.state).toBe('running')
    expect(startRuntime.mock.calls.map(([context]) => context)).toEqual([first, second])
    expect(status.getState().status).toBe('running')
    // The old context no longer reports into the status.
    first.setState('suspended')
    expect(status.getState().status).toBe('running')
    expect(unlock()).toBe(second)
  })
})
