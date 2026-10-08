/**
 * Minimal Web Audio fakes for unit tests of src/lib/audio (the node test environment has no
 * Web Audio). Only what the unlock and runtime modules use. Never imported by app code.
 */

export class FakeParam {
  value: number
  readonly events: string[] = []
  constructor(value = 1) {
    this.value = value
  }
  cancelScheduledValues(time: number) {
    this.events.push(`cancel@${time}`)
    return this
  }
  setValueAtTime(value: number, time: number) {
    this.events.push(`value ${value}@${time}`)
    this.value = value
    return this
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push(`ramp ${value}@${time}`)
    this.value = value
    return this
  }
}

export class FakeNode {
  readonly connections: FakeNode[] = []
  disconnected = false
  connect<T extends FakeNode>(target: T): T {
    this.connections.push(target)
    return target
  }
  disconnect() {
    this.disconnected = true
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1)
}

export class FakeBuffer {
  constructor(readonly url: string) {}
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null
  loop = false
  loopStart = 0
  loopEnd = 0
  started = false
  stoppedAt: number | null = null
  onended: (() => void) | null = null
  start() {
    this.started = true
  }
  stop(when = 0) {
    this.stoppedAt = when
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: string = 'running'
  currentTime = 0
  onstatechange: (() => void) | null = null
  readonly destination = new FakeNode()
  readonly gains: FakeGain[] = []
  readonly sources: FakeSource[] = []
  readonly calls: string[] = []
  /** Files whose decode rejects (the "browser cannot decode this format" case). */
  readonly undecodable = new Set<string>()
  constructor(readonly options?: unknown) {
    FakeAudioContext.instances.push(this)
  }
  createGain() {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
  createBufferSource() {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    const url = new TextDecoder().decode(data)
    if (this.undecodable.has(url)) return Promise.reject(new DOMException('bad', 'EncodingError'))
    return Promise.resolve(new FakeBuffer(url))
  }
  setState(state: string) {
    this.state = state
    this.onstatechange?.()
  }
  resume() {
    this.calls.push('resume')
    this.setState('running')
    return Promise.resolve()
  }
  suspend() {
    this.calls.push('suspend')
    this.setState('suspended')
    return Promise.resolve()
  }
}

/** Lets every pending promise callback run. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}
