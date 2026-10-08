/**
 * The city's surface shading, in one place (S04a's toon ramp today). S04h chooses the material
 * model from its showcase (toon ramp or standard lit); every surface the city builds (district
 * buildings, blocks, landmark models) gets its material from here, so that switch is one change.
 */
import { MeshToonMaterial, type ColorRepresentation, type Texture } from 'three'

export type SurfaceShading = 'toon'

/** The shading every city surface uses until S04h rules. */
export const SURFACE_SHADING: SurfaceShading = 'toon'

export interface SurfaceOptions {
  /** The city's shared toon gradient (S04a createToonRamp), reused, never copied. */
  readonly gradientMap: Texture
  readonly color?: ColorRepresentation
  readonly vertexColors?: boolean
}

export function createSurfaceMaterial(options: SurfaceOptions): MeshToonMaterial {
  return new MeshToonMaterial({
    gradientMap: options.gradientMap,
    vertexColors: options.vertexColors ?? false,
    ...(options.color === undefined ? {} : { color: options.color }),
  })
}
