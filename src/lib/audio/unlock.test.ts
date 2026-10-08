import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger, type LogRecord } from '@/lib/log'
import { createAudioStatusStore } from '@/state/audioStatus'
import { FakeAudioContext, flush } from './fakeWebAudio'
import { createAudioUnlocker, setMixingSession, type UnlockEnvironment } from './unlock'

function setup(env: Partial<UnlockEnvironment> = {}) {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const status = createAudioStatusStore()
  const startRuntime = vi.fn()
  const order: string[] = []
  const session = {
    _type: 'auto',
    get type() {
      return this._type
    },
    set type(value: string) {
      order.push(`session:${value}`)
      this._type = value
    },
  }
  class Context extends FakeAudioContext {
    constructor(options?: unknown) {
      order.push('context')
      super(options)
    }
  }
  const environment: UnlockEnvironment = {
    AudioContext: Context as unknown as typeof AudioContext,
    navigator: { audioSession: session } as unknown as Navigator,
    ...env,
  }
  const unlock = createAudioUnlocker({ env: () => environment, status, startRuntime, logger })
  return { unlock, status, startRuntime, order, session, records }
}

beforeEach(() => {
  FakeAudioContext.instances = []
})

describe('unlockAudioFromGesture', () => {
  it('sets the mixing audio session before the context exists', () => {
    const { unlock, order, session } = setup()
    unlock()
    expect(order).toEqual(['session:ambient', 'context'])
    expect(session.type).toBe('ambient')
  })

  it('creates one interactive context and starts the runtime once', () => {
    const { unlock, startRuntime, status } = setup()
    const first = unlock()
    const second = unlock()
    expect(first).toBe(second)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0]?.options).toEqual({ latencyHint: 'interactive' })
    expect(startRuntime).toHaveBeenCalledTimes(1)
    expect(status.getState().status).toBe('running')
  })

  it('works without an audioSession (every browser but Safari)', () => {
    const { unlock, status } = setup({ navigator: {} as Navigator })
    expect(unlock()).not.toBeNull()
    expect(status.getState().status).toBe('running')
  })

  it('reports unsupported without Web Audio and creates nothing', () => {
    const { unlock, status, startRuntime, records } = setup({ AudioContext: undefined })
    expect(unlock()).toBeNull()
    expect(status.getState().status).toBe('unsupported')
    expect(startRuntime).not.toHaveBeenCalled()
    expect(records.every((r) => r.level === 'info')).toBe(true)
  })

  it('reports unsupported when the constructor throws', () => {
    class Broken {
      constructor() {
        throw new DOMException('no', 'NotSupportedError')
      }
    }
    const { unlock, status } = setup({ AudioContext: Broken as unknown as typeof AudioContext })
    expect(unlock()).toBeNull()
    expect(status.getState().status).toBe('unsupported')
  })

  it('calls resume() synchronously, inside the gesture, for a suspended context', () => {
    const { unlock, status } = setup()
    const context = unlock() as unknown as FakeAudioContext
    context.setState('suspended')
    expect(status.getState().status).toBe('suspended')
    const resume = vi.spyOn(context, 'resume').mockReturnValue(new Promise(() => undefined))
    unlock()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(status.getState().status).toBe('starting')
  })

  it('mirrors interruptions and keeps a refused resume at info', async () => {
    const { unlock, status, records } = setup()
    const context = unlock() as unknown as FakeAudioContext
    context.setState('interrupted')
    expect(status.getState().status).toBe('interrupted')
    vi.spyOn(context, 'resume').mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    unlock()
    await flush()
    expect(status.getState().status).toBe('interrupted')
    expect(records.filter((r) => r.level !== 'info')).toEqual([])
  })

  it('a session that refuses the type is logged at info, not thrown', () => {
    const records: LogRecord[] = []
    const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
    const navigator = {
      audioSession: {
        set type(_: string) {
          throw new TypeError('read-only')
        },
      },
    } as unknown as Navigator
    expect(() => setMixingSession(navigator, logger)).not.toThrow()
    expect(records.map((r) => r.level)).toEqual(['info'])
  })
})
