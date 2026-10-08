/**
 * The landmark materials, shared by every landmark and level: one body material painted by
 * vertex colour (the city's surface shading, src/scene/shading.ts: the shared toon ramp today,
 * so tones step exactly like the rest of the city; S04h may switch it to lit), windows in
 * the same shading that glow lamp-warm at night through the shared night-glow uniform
 * (src/scene/lighting/nightGlow.ts, `'uniform'` source, never for an excluded category such as
 * a memorial), a back-face outline for the inverted hull, and a dimmed body for landmarks shown
 * muted. Four materials in all, however many landmarks are drawn.
 */
import {
  BackSide,
  MeshBasicMaterial,
  type IUniform,
  type MeshToonMaterial,
  type Texture,
} from 'three'
import { patchNightGlow } from '../lighting/nightGlow'
import { createSurfaceMaterial } from '../shading'
import type { LandmarkPalette } from './types'

export interface LandmarkMaterials {
  readonly body: MeshToonMaterial
  /** Glass by day (the window colour times the glass role); glows lamp-warm at night. */
  readonly windows: MeshToonMaterial
  /** Whether the windows were bound to the night glow. */
  readonly windowsGlow: boolean
  readonly outline: MeshBasicMaterial
  readonly dimmed: MeshToonMaterial
  /** Disposes the four materials; the ramp belongs to the caller and is left alone. */
  dispose(): void
}

/** `ramp` is the city's toon gradient (S04a createToonRamp), reused, never copied. */
export function createLandmarkMaterials(
  ramp: Texture,
  palette: LandmarkPalette,
  nightGlow?: { readonly uniform: IUniform<number>; readonly category?: string },
): LandmarkMaterials {
  const body = createSurfaceMaterial({ gradientMap: ramp, vertexColors: true })
  const windows = createSurfaceMaterial({
    gradientMap: ramp,
    vertexColors: true,
    color: palette.glass,
  })
  const windowsGlow =
    nightGlow !== undefined &&
    patchNightGlow(windows, 'uniform', {
      uniform: nightGlow.uniform,
      color: palette.window,
      ...(nightGlow.category === undefined ? {} : { category: nightGlow.category }),
    })
  const outline = new MeshBasicMaterial({ color: palette.outline, side: BackSide })
  const dimmed = createSurfaceMaterial({ gradientMap: ramp, color: palette.dimmed })
  return {
    body,
    windows,
    windowsGlow,
    outline,
    dimmed,
    dispose() {
      for (const material of [body, windows, outline, dimmed]) material.dispose()
    },
  }
}
