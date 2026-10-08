/**
 * The device probe the shell runs before the 3D canvas mounts (S04b): whether this browser can
 * create a WebGL2 context, and the tier picker's signals from that context, the navigator and
 * matchMedia. A device without WebGL goes straight to the fallback instead of failing inside the
 * renderer.
 *
 * The probe context is only dropped, not lost with WEBGL_lose_context: Chromium logs a console
 * warning for loseContext(), and the garbage collector releases the context anyway.
 */
import type { TierPicker } from '@/lib/data/schemas/config'
import { probeSignals } from '@/lib/quality/probe'
import { dataSaverRequested, pickTier, type TierPick, type TierSignals } from '@/lib/quality/tier'

export interface DeviceProbe {
  readonly signals: TierSignals
  readonly pick: TierPick
  /** A Save-Data or prefers-reduced-data request: forces the low tier. */
  readonly dataSaver: boolean
}

function webgl2Context(): WebGL2RenderingContext | null {
  try {
    return document.createElement('canvas').getContext('webgl2')
  } catch {
    return null
  }
}

/** Whether this browser can create a WebGL2 context (the apartment's mount checks it, S16). */
export function webgl2Available(): boolean {
  return webgl2Context() !== null
}

/** Probes the device and picks its tier with the configured thresholds. */
export function probeDevice(picker: TierPicker): DeviceProbe {
  const signals = probeSignals({
    gl: webgl2Context(),
    navigator: window.navigator,
    matchMedia:
      typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined,
  })
  return { signals, pick: pickTier(signals, picker), dataSaver: dataSaverRequested(signals) }
}
