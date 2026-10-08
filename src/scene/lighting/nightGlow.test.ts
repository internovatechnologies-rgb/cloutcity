import {
  DataTexture,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  ShaderLib,
  type Material,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three'
import { describe, expect, it } from 'vitest'
import {
  NIGHT_GLOW_ATTRIBUTE,
  NIGHT_GLOW_EXCLUDED,
  NIGHT_GLOW_PROGRAM_KEYS,
  createDayNightUniforms,
  isNightGlowExcluded,
  nightGlowSource,
  patchNightGlow,
  type NightGlowSource,
} from './nightGlow'

function shaderSource(name: 'toon' | 'lambert' | 'standard') {
  const shader = ShaderLib[name]
  if (shader === undefined) throw new Error(`three has no ${name} shader`)
  return shader
}

/** Runs the material's onBeforeCompile on its real three shader, as WebGLRenderer would. */
function compile(material: Material, name: 'toon' | 'lambert' | 'standard') {
  const shader = shaderSource(name)
  const parameters = {
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
    uniforms: {},
  } as unknown as WebGLProgramParametersWithUniforms
  material.onBeforeCompile(parameters, {} as WebGLRenderer)
  return parameters
}

const mask = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1)

describe('patchNightGlow', () => {
  it.each(['attribute', 'mask', 'uniform'] as const)(
    'gives every "%s" material the same fixed program key',
    (source: NightGlowSource) => {
      const { uNightGlow } = createDayNightUniforms()
      const a = new MeshToonMaterial()
      const b = new MeshToonMaterial({ color: 0xff0000 })
      expect(patchNightGlow(a, source, { uniform: uNightGlow, mask })).toBe(true)
      expect(patchNightGlow(b, source, { uniform: uNightGlow, mask, color: '#ffcc66' })).toBe(true)
      expect(a.customProgramCacheKey()).toBe(NIGHT_GLOW_PROGRAM_KEYS[source])
      expect(b.customProgramCacheKey()).toBe(a.customProgramCacheKey())
      expect(compile(a, 'toon').fragmentShader).toBe(compile(b, 'toon').fragmentShader)
      expect(compile(a, 'toon').vertexShader).toBe(compile(b, 'toon').vertexShader)
      expect(nightGlowSource(a)).toBe(source)
    },
  )

  it('uses a different key per source', () => {
    expect(new Set(Object.values(NIGHT_GLOW_PROGRAM_KEYS)).size).toBe(3)
  })

  it('shares one uNightGlow uniform object across materials', () => {
    const { uNightGlow } = createDayNightUniforms()
    const toon = new MeshToonMaterial()
    const standard = new MeshStandardMaterial()
    patchNightGlow(toon, 'uniform', { uniform: uNightGlow })
    patchNightGlow(standard, 'attribute', { uniform: uNightGlow })
    const a = compile(toon, 'toon')
    const b = compile(standard, 'standard')
    expect(a.uniforms.uNightGlow).toBe(uNightGlow)
    expect(b.uniforms.uNightGlow).toBe(uNightGlow)
    uNightGlow.value = 0.75
    expect(a.uniforms.uNightGlow?.value).toBe(0.75)
    // The glow colour is each material's own.
    expect(a.uniforms.uNightGlowColor).not.toBe(b.uniforms.uNightGlowColor)
  })

  it('adds the glow after the emissive map, for each source', () => {
    const { uNightGlow } = createDayNightUniforms()
    const attribute = new MeshLambertMaterial()
    patchNightGlow(attribute, 'attribute', { uniform: uNightGlow })
    const a = compile(attribute, 'lambert')
    expect(a.vertexShader).toContain(`attribute vec3 ${NIGHT_GLOW_ATTRIBUTE};`)
    expect(a.vertexShader).toMatch(/#include <begin_vertex>\nvNightGlowMask = _emissive;/)
    expect(a.fragmentShader).toMatch(
      /#include <emissivemap_fragment>\ntotalEmissiveRadiance \+= uNightGlowColor \* vNightGlowMask \* uNightGlow;/,
    )
    expect(a.fragmentShader).toContain('uniform float uNightGlow;')

    const masked = new MeshToonMaterial()
    patchNightGlow(masked, 'mask', { uniform: uNightGlow, mask })
    const m = compile(masked, 'toon')
    expect(m.vertexShader).toContain('vNightGlowUv = uv;')
    expect(m.fragmentShader).toContain('uniform sampler2D uNightGlowMask;')
    expect(m.fragmentShader).toContain(
      'totalEmissiveRadiance += uNightGlowColor * texture( uNightGlowMask, vNightGlowUv ).r * uNightGlow;',
    )
    expect(m.uniforms.uNightGlowMask?.value).toBe(mask)

    const whole = new MeshToonMaterial()
    patchNightGlow(whole, 'uniform', { uniform: uNightGlow })
    const w = compile(whole, 'toon')
    expect(w.vertexShader).toBe(shaderSource('toon').vertexShader)
    expect(w.fragmentShader).toContain(
      'totalEmissiveRadiance += uNightGlowColor * 1.0 * uNightGlow;',
    )
  })

  it('keeps an earlier onBeforeCompile and program key', () => {
    const { uNightGlow } = createDayNightUniforms()
    const material = new MeshToonMaterial()
    material.onBeforeCompile = (parameters) => {
      parameters.uniforms.uEarlier = { value: 1 }
    }
    material.customProgramCacheKey = () => 'earlier'
    patchNightGlow(material, 'uniform', { uniform: uNightGlow })
    const parameters = compile(material, 'toon')
    expect(parameters.uniforms.uEarlier?.value).toBe(1)
    expect(parameters.uniforms.uNightGlow).toBe(uNightGlow)
    expect(material.customProgramCacheKey()).toBe(`earlier|${NIGHT_GLOW_PROGRAM_KEYS.uniform}`)
  })

  it('never patches a muted material or an excluded category', () => {
    const { uNightGlow } = createDayNightUniforms()
    const muted = new MeshToonMaterial()
    const keyBefore = muted.customProgramCacheKey()
    const compileBefore = muted.onBeforeCompile
    expect(patchNightGlow(muted, 'uniform', { uniform: uNightGlow, muted: true })).toBe(false)
    expect(muted.customProgramCacheKey()).toBe(keyBefore)
    expect(muted.onBeforeCompile).toBe(compileBefore)
    expect(nightGlowSource(muted)).toBeUndefined()

    const memorial = new MeshToonMaterial()
    expect(
      patchNightGlow(memorial, 'mask', { uniform: uNightGlow, mask, category: 'memorial' }),
    ).toBe(false)
    expect(nightGlowSource(memorial)).toBeUndefined()
    expect(NIGHT_GLOW_EXCLUDED).toEqual(['memorial'])
    expect(isNightGlowExcluded('memorial')).toBe(true)
    expect(isNightGlowExcluded('bridge')).toBe(false)
    expect(isNightGlowExcluded(undefined)).toBe(false)
  })

  it('patches once: same source again is a no-op, another source throws', () => {
    const { uNightGlow } = createDayNightUniforms()
    const material = new MeshToonMaterial()
    patchNightGlow(material, 'uniform', { uniform: uNightGlow })
    const compileOnce = material.onBeforeCompile
    expect(patchNightGlow(material, 'uniform', { uniform: uNightGlow })).toBe(true)
    expect(material.onBeforeCompile).toBe(compileOnce)
    expect(() => patchNightGlow(material, 'attribute', { uniform: uNightGlow })).toThrow(
      /already glows/,
    )
  })

  it('refuses materials without an emissive term, and a mask source without a mask', () => {
    const { uNightGlow } = createDayNightUniforms()
    expect(() =>
      patchNightGlow(new MeshBasicMaterial(), 'uniform', { uniform: uNightGlow }),
    ).toThrow(/no emissive/)
    expect(() => patchNightGlow(new MeshToonMaterial(), 'mask', { uniform: uNightGlow })).toThrow(
      /needs a mask/,
    )
  })

  it('starts the shared uniforms at full day', () => {
    const uniforms = createDayNightUniforms()
    expect(uniforms.uNightGlow.value).toBe(0)
    expect(uniforms.unlitTint.value.getHex()).toBe(0xffffff)
    expect(createDayNightUniforms().uNightGlow).not.toBe(uniforms.uNightGlow)
  })
})
