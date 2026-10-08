import { describe, expect, it, vi } from 'vitest'
import { probeSignals, type ProbeGl, type ProbeInput } from './probe'

// WebGL enum values (WebGL 1.0 spec, section 5.14; WEBGL_debug_renderer_info).
const RENDERER = 0x1f01
const MAX_TEXTURE_SIZE = 0x0d33
const UNMASKED_RENDERER_WEBGL = 0x9246

interface FakeGlOptions {
  readonly renderer?: unknown
  readonly unmasked?: unknown
  readonly maxTextureSize?: unknown
  /** False: the extension is unavailable. */
  readonly extension?: boolean
}

function fakeGl(options: FakeGlOptions = {}) {
  const values = new Map<number, unknown>([
    [RENDERER, 'renderer' in options ? options.renderer : 'Apple M2'],
    [MAX_TEXTURE_SIZE, 'maxTextureSize' in options ? options.maxTextureSize : 16384],
    [UNMASKED_RENDERER_WEBGL, 'unmasked' in options ? options.unmasked : 'Apple M2 Pro'],
  ])
  const getExtension = vi.fn((name: string) =>
    name === 'WEBGL_debug_renderer_info' && options.extension !== false
      ? { UNMASKED_RENDERER_WEBGL }
      : null,
  )
  const gl: ProbeGl = {
    RENDERER,
    MAX_TEXTURE_SIZE,
    getParameter: (name) => values.get(name) ?? null,
    getExtension,
  }
  return { gl, getExtension }
}

const NAVIGATOR = { deviceMemory: 8, hardwareConcurrency: 10, connection: { saveData: false } }
const noReducedData = () => ({ matches: false })

const probe = (input: Partial<ProbeInput>) =>
  probeSignals({ gl: fakeGl().gl, navigator: NAVIGATOR, matchMedia: noReducedData, ...input })

describe('probeSignals', () => {
  it('reads every signal from the context, navigator and matchMedia', () => {
    expect(probe({})).toEqual({
      webgl2: true,
      renderer: 'Apple M2',
      maxTextureSize: 16384,
      deviceMemoryGb: 8,
      cores: 10,
      saveData: false,
      prefersReducedData: false,
    })
  })

  it('reports no WebGL2 and unknown GPU signals without a context', () => {
    expect(probe({ gl: null })).toMatchObject({
      webgl2: false,
      renderer: null,
      maxTextureSize: null,
      cores: 10,
    })
  })

  it('never asks for the debug extension when RENDERER names the GPU', () => {
    const { gl, getExtension } = fakeGl({ renderer: 'Radeon R9 200 Series, or similar' })
    expect(probe({ gl }).renderer).toBe('Radeon R9 200 Series, or similar')
    expect(getExtension).not.toHaveBeenCalled()
  })

  it('uses the unmasked renderer when RENDERER is masked', () => {
    const { gl, getExtension } = fakeGl({
      renderer: 'WebKit WebGL',
      unmasked: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    })
    expect(probe({ gl }).renderer).toBe(
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    )
    expect(getExtension).toHaveBeenCalledWith('WEBGL_debug_renderer_info')
  })

  it('treats a masked renderer without a real name as unknown', () => {
    expect(probe({ gl: fakeGl({ renderer: 'webkit webgl', extension: false }).gl }).renderer).toBe(
      null,
    )
    expect(probe({ gl: fakeGl({ renderer: 'WebKit WebGL', unmasked: '' }).gl }).renderer).toBe(null)
    expect(probe({ gl: fakeGl({ renderer: 'WebKit WebGL', unmasked: 42 }).gl }).renderer).toBe(null)
  })

  it('leaves Firefox fingerprinting resistance alone', () => {
    const { gl, getExtension } = fakeGl({ renderer: 'Mozilla' })
    expect(probe({ gl }).renderer).toBe('Mozilla')
    expect(getExtension).not.toHaveBeenCalled()
  })

  it('treats a missing or blank RENDERER as unknown without asking for the extension', () => {
    const { gl, getExtension } = fakeGl({ renderer: null })
    expect(probe({ gl }).renderer).toBeNull()
    expect(probe({ gl: fakeGl({ renderer: '   ' }).gl }).renderer).toBeNull()
    expect(getExtension).not.toHaveBeenCalled()
  })

  it.each([0, -1, 4096.5, Number.NaN, Number.POSITIVE_INFINITY, '4096', null])(
    'treats MAX_TEXTURE_SIZE %s as unknown',
    (maxTextureSize) => {
      expect(probe({ gl: fakeGl({ maxTextureSize }).gl }).maxTextureSize).toBeNull()
    },
  )

  it('keeps fractional device memory but needs whole cores', () => {
    expect(probe({ navigator: { deviceMemory: 0.5, hardwareConcurrency: 4 } })).toMatchObject({
      deviceMemoryGb: 0.5,
      cores: 4,
    })
    expect(probe({ navigator: { deviceMemory: '8', hardwareConcurrency: 2.5 } })).toMatchObject({
      deviceMemoryGb: null,
      cores: null,
    })
    expect(probe({ navigator: { deviceMemory: 0, hardwareConcurrency: -2 } })).toMatchObject({
      deviceMemoryGb: null,
      cores: null,
    })
  })

  it('reads Save-Data only as a boolean on navigator.connection', () => {
    expect(probe({ navigator: { connection: { saveData: true } } }).saveData).toBe(true)
    expect(probe({ navigator: { connection: { saveData: 'yes' } } }).saveData).toBeNull()
    expect(probe({ navigator: { connection: null } }).saveData).toBeNull()
    expect(probe({ navigator: {} }).saveData).toBeNull()
  })

  it('is fully unknown without a navigator or matchMedia', () => {
    expect(probe({ navigator: undefined, matchMedia: undefined })).toMatchObject({
      deviceMemoryGb: null,
      cores: null,
      saveData: null,
      prefersReducedData: null,
    })
  })

  it('asks matchMedia for prefers-reduced-data', () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-data: reduce)',
    }))
    expect(probe({ matchMedia }).prefersReducedData).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-data: reduce)')
  })

  it('leaves a signal unknown when its probe step throws', () => {
    const throwing: ProbeGl = {
      RENDERER,
      MAX_TEXTURE_SIZE,
      getParameter: () => {
        throw new Error('context lost')
      },
      getExtension: () => null,
    }
    expect(
      probe({
        gl: throwing,
        matchMedia: () => {
          throw new Error('bad query')
        },
      }),
    ).toMatchObject({
      webgl2: true,
      renderer: null,
      maxTextureSize: null,
      prefersReducedData: null,
    })
  })
})
