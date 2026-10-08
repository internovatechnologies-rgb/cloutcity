/**
 * Night glow (S04f): lit windows and landmark glow that fade in with the night. Every glowing
 * material reads ONE shared uniform, `uNightGlow` (0 by day, 1 at night), which the day/night
 * rig writes; changing it re-renders without recompiling anything.
 *
 * `patchNightGlow` adds the glow to a lit material (standard, physical, lambert, phong, toon) via
 * `onBeforeCompile`, after the emissive map:
 *
 *   totalEmissiveRadiance += glowColor * mask * uNightGlow
 *
 * The mask comes from one of three sources, each with its own fixed shader text and fixed
 * `customProgramCacheKey`, so all materials of a source share one compiled program:
 * - `'attribute'`: the `_EMISSIVE` vertex attribute (vec3, linear RGB; zero where nothing glows).
 *   GLTFLoader lowercases custom attribute names, so the geometry attribute is `_emissive`.
 * - `'mask'`: the red channel of a window mask texture (NoColorSpace), read with the mesh's `uv`.
 * - `'uniform'`: the whole material glows.
 *
 * Memorials never glow (CLAUDE.md: no effects at memorials), and neither does a muted material.
 */
import { createContext, useContext } from 'react'
import {
  Color,
  type ColorRepresentation,
  type IUniform,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three'

export type NightGlowSource = 'attribute' | 'mask' | 'uniform'

/** Name of the shared uniform in the shader. */
export const NIGHT_GLOW_UNIFORM = 'uNightGlow'

/** Geometry attribute the `'attribute'` source reads (glTF `_EMISSIVE` after GLTFLoader). */
export const NIGHT_GLOW_ATTRIBUTE = '_emissive'

/** One fixed program cache key per source. */
export const NIGHT_GLOW_PROGRAM_KEYS: Readonly<Record<NightGlowSource, string>> = {
  attribute: 'night-glow:attribute',
  mask: 'night-glow:mask',
  uniform: 'night-glow:uniform',
}

/** Landmark categories that never glow, whatever their data says. */
export const NIGHT_GLOW_EXCLUDED = ['memorial'] as const

export function isNightGlowExcluded(category: string | undefined): boolean {
  return category !== undefined && (NIGHT_GLOW_EXCLUDED as readonly string[]).includes(category)
}

/** The day/night values every scene material shares; the rig mutates `value` in place. */
export interface DayNightUniforms {
  /** Night glow, 0–1. */
  readonly uNightGlow: IUniform<number>
  /** Multiplier for unlit materials (water, lines, labels), in the working colour space. */
  readonly unlitTint: IUniform<Color>
}

/** Fresh uniforms at full day: no glow, no tint. */
export function createDayNightUniforms(): DayNightUniforms {
  return { uNightGlow: { value: 0 }, unlitTint: { value: new Color(1, 1, 1) } }
}

/**
 * Provided by the day/night rig (S04f part 1). The default (no provider: tests, the apartment
 * before it opts in) is a day that never changes.
 */
export const DayNightContext = createContext<DayNightUniforms>(createDayNightUniforms())

/** The shared `uNightGlow` uniform, to hand to `patchNightGlow`. */
export function useNightGlow(): IUniform<number> {
  return useContext(DayNightContext).uNightGlow
}

export interface NightGlowOptions {
  /** The shared uniform from `useNightGlow()` (or the rig's uniforms). */
  readonly uniform: IUniform<number>
  /** Glow colour; for `'attribute'` it multiplies the vertex colour. Default white. */
  readonly color?: ColorRepresentation
  /** The window mask; required for `'mask'`. */
  readonly mask?: Texture
  /** A muted material (a muted pin) never glows. */
  readonly muted?: boolean
  /** Landmark category; one in NIGHT_GLOW_EXCLUDED never glows. */
  readonly category?: string
}

const SHADER_TEXT: Readonly<
  Record<
    NightGlowSource,
    { vertexHead: string; vertexBody: string; fragmentHead: string; mask: string }
  >
> = {
  attribute: {
    vertexHead: `attribute vec3 ${NIGHT_GLOW_ATTRIBUTE};\nvarying vec3 vNightGlowMask;`,
    vertexBody: `vNightGlowMask = ${NIGHT_GLOW_ATTRIBUTE};`,
    fragmentHead: 'varying vec3 vNightGlowMask;',
    mask: 'vNightGlowMask',
  },
  mask: {
    vertexHead: 'varying vec2 vNightGlowUv;',
    vertexBody: 'vNightGlowUv = uv;',
    fragmentHead: 'varying vec2 vNightGlowUv;\nuniform sampler2D uNightGlowMask;',
    mask: 'texture( uNightGlowMask, vNightGlowUv ).r',
  },
  uniform: { vertexHead: '', vertexBody: '', fragmentHead: '', mask: '1.0' },
}

const COMMON = '#include <common>'
const BEGIN_VERTEX = '#include <begin_vertex>'
const EMISSIVE_MAP = '#include <emissivemap_fragment>'

/** Inserts `text` after `anchor`, failing loudly if a three upgrade moved the chunk. */
function after(shader: string, anchor: string, text: string): string {
  if (!shader.includes(anchor)) throw new Error(`nightGlow: shader has no "${anchor}"`)
  return text === '' ? shader : shader.replace(anchor, `${anchor}\n${text}`)
}

/** The shader rewrite of one source, exported for tests. */
export function injectNightGlow(
  shader: { vertexShader: string; fragmentShader: string },
  source: NightGlowSource,
): { vertexShader: string; fragmentShader: string } {
  const text = SHADER_TEXT[source]
  const vertexShader = after(
    after(shader.vertexShader, COMMON, text.vertexHead),
    BEGIN_VERTEX,
    text.vertexBody,
  )
  const fragmentShader = after(
    after(
      shader.fragmentShader,
      COMMON,
      `uniform float ${NIGHT_GLOW_UNIFORM};\nuniform vec3 uNightGlowColor;\n${text.fragmentHead}`,
    ),
    EMISSIVE_MAP,
    `totalEmissiveRadiance += uNightGlowColor * ${text.mask} * ${NIGHT_GLOW_UNIFORM};`,
  )
  return { vertexShader, fragmentShader }
}

const patched = new WeakMap<Material, NightGlowSource>()

/** The source a material was patched with, if any. */
export function nightGlowSource(material: Material): NightGlowSource | undefined {
  return patched.get(material)
}

/**
 * Adds night glow to a lit material. Returns false, leaving the material untouched, when it
 * must not glow (muted, or an excluded category). Patching the same material again with the
 * same source is a no-op; with another source it throws.
 */
export function patchNightGlow(
  material: Material,
  source: NightGlowSource,
  options: NightGlowOptions,
): boolean {
  if (options.muted === true || isNightGlowExcluded(options.category)) return false
  const already = patched.get(material)
  if (already !== undefined) {
    if (already === source) return true
    throw new Error(`nightGlow: material already glows from "${already}", not "${source}"`)
  }
  if (!('emissive' in material)) {
    throw new Error(`nightGlow: ${material.type} has no emissive term to add the glow to`)
  }
  const mask = options.mask
  if (source === 'mask' && mask === undefined) {
    throw new Error('nightGlow: the "mask" source needs a mask texture')
  }

  const glowColor: IUniform<Color> = { value: new Color(options.color ?? 0xffffff) }
  const previousCompile = material.onBeforeCompile.bind(material)
  const previousKey = Object.hasOwn(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey.bind(material)
    : undefined

  material.onBeforeCompile = (parameters: WebGLProgramParametersWithUniforms, renderer) => {
    previousCompile(parameters, renderer)
    const shader = injectNightGlow(parameters, source)
    parameters.vertexShader = shader.vertexShader
    parameters.fragmentShader = shader.fragmentShader
    // The same object for every material: one write of the rig reaches them all.
    parameters.uniforms[NIGHT_GLOW_UNIFORM] = options.uniform
    parameters.uniforms.uNightGlowColor = glowColor
    if (mask !== undefined) parameters.uniforms.uNightGlowMask = { value: mask }
  }
  const key = NIGHT_GLOW_PROGRAM_KEYS[source]
  material.customProgramCacheKey =
    previousKey === undefined ? () => key : () => `${previousKey()}|${key}`
  material.needsUpdate = true
  patched.set(material, source)
  return true
}
