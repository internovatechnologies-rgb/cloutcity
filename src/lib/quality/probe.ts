/**
 * Reads the tier picker's device signals (src/lib/quality/tier.ts) from a WebGL2 context, the
 * navigator and matchMedia, all injected so the parsing is testable without a browser. Every
 * value is untrusted: anything missing, of the wrong type or out of range becomes unknown (null).
 *
 * The renderer comes from RENDERER. Only when the browser masks it (Chromium and Safari report a
 * generic "WebKit WebGL") is WEBGL_debug_renderer_info asked for the real name: Firefox already
 * reports a sanitised GPU name in RENDERER and logs a deprecation warning when the extension is
 * requested, which the e2e console guard would fail on.
 */
import type { TierSignals } from './tier'

/** The parts of a WebGL2 context the probe reads. */
export interface ProbeGl {
  readonly RENDERER: number
  readonly MAX_TEXTURE_SIZE: number
  getParameter(name: number): unknown
  getExtension(name: string): unknown
}

/** The parts of `navigator` the probe reads. */
export interface ProbeNavigator {
  readonly deviceMemory?: unknown
  readonly hardwareConcurrency?: unknown
  readonly connection?: unknown
}

export interface ProbeInput {
  /** A WebGL2 context, or null when none could be created. */
  readonly gl: ProbeGl | null
  readonly navigator: ProbeNavigator | undefined
  readonly matchMedia: ((query: string) => { readonly matches: boolean }) | undefined
}

/**
 * RENDERER values that name the browser instead of the GPU. Firefox's fingerprinting-resistance
 * value ("Mozilla") is left out on purpose: asking Firefox for the extension logs a warning, and
 * it withholds the real name in that mode anyway.
 */
const MASKED_RENDERERS = new Set(['webkit webgl'])

const DEBUG_RENDERER_INFO = 'WEBGL_debug_renderer_info'

/** A renderer string, trimmed and non-empty, or null. */
function rendererString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function positiveInteger(value: unknown): number | null {
  const number = positiveNumber(value)
  return number !== null && Number.isInteger(number) ? number : null
}

function unmaskedRenderer(gl: ProbeGl): string | null {
  const extension = gl.getExtension(DEBUG_RENDERER_INFO)
  if (typeof extension !== 'object' || extension === null) return null
  const name = (extension as { UNMASKED_RENDERER_WEBGL?: unknown }).UNMASKED_RENDERER_WEBGL
  return typeof name === 'number' ? rendererString(gl.getParameter(name)) : null
}

function readRenderer(gl: ProbeGl): string | null {
  const renderer = rendererString(gl.getParameter(gl.RENDERER))
  if (renderer === null || !MASKED_RENDERERS.has(renderer.toLowerCase())) return renderer
  // A masked name says nothing about the GPU, so without the real one the renderer is unknown.
  return unmaskedRenderer(gl)
}

function readSaveData(connection: unknown): boolean | null {
  if (typeof connection !== 'object' || connection === null) return null
  const saveData = (connection as { saveData?: unknown }).saveData
  return typeof saveData === 'boolean' ? saveData : null
}

function readReducedData(matchMedia: ProbeInput['matchMedia']): boolean | null {
  if (matchMedia === undefined) return null
  try {
    return matchMedia('(prefers-reduced-data: reduce)').matches
  } catch {
    return null
  }
}

/** The device signals; a probe step that throws leaves its signal unknown. */
export function probeSignals(input: ProbeInput): TierSignals {
  const { gl, navigator } = input
  let renderer: string | null = null
  let maxTextureSize: number | null = null
  if (gl !== null) {
    try {
      renderer = readRenderer(gl)
    } catch {
      renderer = null
    }
    try {
      maxTextureSize = positiveInteger(gl.getParameter(gl.MAX_TEXTURE_SIZE))
    } catch {
      maxTextureSize = null
    }
  }
  return {
    webgl2: gl !== null,
    renderer,
    maxTextureSize,
    deviceMemoryGb: positiveNumber(navigator?.deviceMemory),
    cores: positiveInteger(navigator?.hardwareConcurrency),
    saveData: readSaveData(navigator?.connection),
    prefersReducedData: readReducedData(input.matchMedia),
  }
}
